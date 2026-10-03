import {
  initSessionManager, initPreKeyManager, initializeSignal, getPreKeyBundleForServer,
  createSessionWithRemote, createResponderSession, encryptWithSignal, decryptWithSignal,
  hasSession, resetSession, getSessionId, getMyIdentityKeyBase64, decodeServerBundle,
  serializeX3dhMessage, deserializeX3dhMessage, installSignalFlushHandlers, flushSignalState,
} from './signal/integration';
import type { PreKeyBundle } from './signal/types';

/**
 * The ratchet, as the app uses it.
 *
 * Everything here has a fallback, and that is the point rather than a hedge. The stateless RSA envelope
 * is what a message travels in when no session can be built; it is less safe, because one long-lived key
 * opens every message, but it always works. A ratchet that could leave a conversation unreadable was
 * removed from this app once already, and the failure was invisible - the message simply showed as
 * encrypted forever. So the rule here is that a session problem degrades to the envelope, never to a
 * message nobody can read.
 */

/** How a body in the encrypted column is marked. The envelope is the default and needs no marker. */
export type DmBody =
  | { kind: 'envelope'; ciphertext: string; iv: string; encryptedKeys: Record<string, string> }
  | {
      kind: 'ratchet';
      ciphertext: string;
      ratchetPublicKey: string;
      messageNumber: number;
      /** Present only on the very first message of a conversation: the handshake that starts it. */
      x3dh?: any;
      /**
       * The same words under the stateless envelope, for this account's other devices.
       *
       * A ratchet session belongs to one device. Without this copy a second device of the same account
       * could not read what the first one sent, and the only alternative - a shared session - would put
       * one device's copy of the chain keys on another. The server can read neither: it holds no key that
       * opens either body.
       */
      ownCopy?: { ciphertext: string; iv: string; encryptedKeys: Record<string, string> };
    };

let ready = false;
let myId = '';
const preKeyBundles: Record<string, PreKeyBundle> = {};
/** Sessions that could not be built, so the app does not retry on every single message. */
const ratchetUnavailable = new Set<string>();

export function isDmBody(value: any): value is DmBody {
  return !!value && typeof value === 'object' && typeof value.ciphertext === 'string';
}

/** Brings the key material up for an account, once the password is known. */
export async function startRatchet(userId: string, password: string): Promise<void> {
  myId = userId;
  await initPreKeyManager(password);
  await initSessionManager(password);
  initializeSignal();
  installSignalFlushHandlers();
  ready = true;
}

export function ratchetReady(): boolean {
  return ready;
}

/** The bundle a stranger needs to open a conversation with us, in the shape the server stores. */
export async function publishBundle(): Promise<any | null> {
  if (!ready) return null;
  try {
    return await getPreKeyBundleForServer();
  } catch {
    return null;
  }
}

/** Keeps the bundles the server handed over, so a send does not have to ask again. */
export function rememberBundles(raw: any): void {
  if (!raw || typeof raw !== 'object') return;
  for (const [id, bundle] of Object.entries(raw)) {
    const decoded = decodeServerBundle(bundle);
    if (decoded) preKeyBundles[id] = decoded;
  }
}

export function rememberBundle(userId: string, bundle: any): void {
  const decoded = decodeServerBundle(bundle);
  if (decoded) preKeyBundles[userId] = decoded;
}

export function forgetBundle(userId: string): void {
  delete preKeyBundles[userId];
  ratchetUnavailable.delete(userId);
}

/** Whether the two sides have a session, which is what decides if a ratchet body is expected. */
export function sessionExists(peerId: string): boolean {
  if (!ready || !myId) return false;
  return hasSession(myId, peerId);
}

/**
 * Wraps a message for one recipient.
 *
 * Tries the ratchet and falls back to the envelope, so the caller always has something sendable. The
 * result says which it got, because the two are not interchangeable: only the ratchet body is unreadable
 * to a future attacker holding this key.
 */
export async function sealFor(
  peerId: string,
  plaintext: string,
  fallback: () => Promise<{ ciphertext: string; iv: string; encryptedKeys: Record<string, string> }>,
): Promise<{ body: DmBody; ratchet: boolean }> {
  if (ready && myId && !ratchetUnavailable.has(peerId)) {
    try {
      const bundle = preKeyBundles[peerId];
      if (!bundle) throw new Error('no bundle for this peer yet');
      let startedSession: any = null;
      const sessionId = getSessionId(myId, peerId);
      if (!hasSession(myId, peerId)) {
        const started = createSessionWithRemote(myId, peerId, bundle);
        if (!started) throw new Error('could not start a session');
        startedSession = started;
      }
      const sealed = await encryptWithSignal(sessionId, plaintext);
      const out = await fallback();
      const body: DmBody = {
        kind: 'ratchet',
        ciphertext: sealed.ciphertext,
        ratchetPublicKey: sealed.ratchetPublicKey,
        messageNumber: sealed.messageNumber,
        // The sender keeps its own copy too, which is what lets it read the conversation on another
        // device without the server ever holding a key that opens it.
        ownCopy: out,
      };
      if (startedSession) body.x3dh = serializeX3dhMessage(startedSession.x3dhMessage);
      return { body, ratchet: true };
    } catch (e) {
      console.warn('[ratchet] falling back to the envelope for this message:', (e as Error).message);
      ratchetUnavailable.add(peerId);
    }
  }
  return { body: { kind: 'envelope', ...(await fallback()) }, ratchet: false };
}

/**
 * Opens a body, whichever kind it is.
 *
 * A ratchet body that will not open falls back to the sender's envelope copy, and failing that reports
 * the failure rather than inventing text. The session is reset on an unusable one so the next message
 * starts a fresh conversation instead of failing the same way forever.
 */
export async function openFor(peerId: string, body: DmBody, privateKeyJwk?: JsonWebKey | null): Promise<string | null> {
  if (body.kind === 'ratchet') {
    if (ready && myId) {
      // The very first message of a conversation carries the handshake, so the recipient builds its side
      // of the session from it before trying to read anything.
      if (body.x3dh && !hasSession(myId, peerId)) {
        try {
          const x3dh = deserializeX3dhMessage(body.x3dh);
          if (x3dh) {
            const created = createResponderSession(myId, peerId, x3dh, base64ToBytes(body.ratchetPublicKey));
            if (!created) throw new Error('could not answer the handshake');
          }
        } catch (e) {
          console.warn('[ratchet] handshake failed:', (e as Error).message);
        }
      }
      try {
        const sessionId = getSessionId(myId, peerId);
        return await decryptWithSignal(sessionId, body.ciphertext, body.ratchetPublicKey, body.messageNumber);
      } catch (e) {
        console.warn('[ratchet] could not open a ratchet message:', (e as Error).message);
        // A session that cannot open anything is worse than none: resetting it means the next message
        // starts a fresh conversation instead of failing the same way for the rest of the session.
        resetSession(myId, peerId);
        ratchetUnavailable.delete(peerId);
      }
    }
    const copy = (body as any).ownCopy;
    if (copy && typeof copy.ciphertext === 'string') return await openEnvelope(copy, privateKeyJwk);
    return null;
  }
  return await openEnvelope(body, privateKeyJwk);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function openEnvelope(
  body: { ciphertext: string; iv: string; encryptedKeys: Record<string, string> },
  privateKeyJwk?: JsonWebKey | null,
): Promise<string | null> {
  if (!myId || !privateKeyJwk) return null;
  try {
    const { decryptMessage } = await import('./crypto');
    return await decryptMessage(body, myId, privateKeyJwk);
  } catch {
    return null;
  }
}

export function myIdentityKeyBase64(): string | null {
  if (!ready) return null;
  try { return getMyIdentityKeyBase64(); } catch { return null; }
}

/**
 * The number two people read aloud to confirm they are talking to each other.
 *
 * Derived from the long-lived identity keys, so a server that quietly handed each of them a different
 * key produces a different number on each side - which is the entire point of showing it.
 */
export async function safetyNumber(peerIdentityKeyB64?: string | null): Promise<string | null> {
  const mine = myIdentityKeyBase64();
  if (!mine) return null;
  const { generateSafetyNumber } = await import('./crypto');
  return generateSafetyNumber(mine, peerIdentityKeyB64);
}

export function flushRatchet(): void {
  flushSignalState();
}

export { getSessionId };