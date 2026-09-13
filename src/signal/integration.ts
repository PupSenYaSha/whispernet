import { PreKeyManager } from './prekey';
import { SessionManager } from './session';
import type { PreKeyBundle, KeyPair, SignalPreKeyMessage } from './types';

const preKeyManager = new PreKeyManager();
const sessionManager = new SessionManager();

export async function initSessionManager(password: string): Promise<void> {
  await sessionManager.init(password);
  sessionManager.startCleanupTimer();
}

export async function initPreKeyManager(password: string): Promise<void> {
  await preKeyManager.init(password);
}

export function initializeSignal(): void {
  preKeyManager.initialize();
}

export function getMyIdentityKeyPair(): KeyPair | null {
  const ik = preKeyManager.getIdentityKeyPair();
  if (!ik) return null;
  return { privateKey: ik.privateKey, publicKey: ik.publicKey };
}

// The X3DH identity key (public half) as a base64 string; used for safety
// number derivation and identity-change detection.
export function getMyIdentityKeyBase64(): string | null {
  const ik = preKeyManager.getIdentityKeyPair();
  return ik ? arrayToBase64(ik.publicKey) : null;
}

// Self-contained byte-array base64 codec so callers do not need to duplicate it.
export function bytesToBase64(bytes: Uint8Array): string {
  return arrayToBase64(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
  return base64ToArray(b64);
}

// Server-stored bundles are JSON objects whose identity/pre-key fields are
// base64 strings (see getPublicKeyForServer). Convert them into the in-memory
// PreKeyBundle shape (Uint8Array) before feeding the X3DH/Double-Ratchet code.
export function decodeServerBundle(raw: any): PreKeyBundle | null {
  if (!raw || typeof raw !== 'object') return null;
  const ik = toBytes(raw.identityKey);
  const ed = toBytes(raw.ed25519PublicKey);
  const spk = raw.signedPreKey;
  if (!ik || !ed || !spk) return null;
  const spkPub = toBytes(spk.publicKey);
  const spkSig = toBytes(spk.signature);
  if (!spkPub || !spkSig || spkSig.length === 0) return null;
  const bundle: PreKeyBundle = {
    bundleVersion: typeof raw.bundleVersion === 'number' ? raw.bundleVersion : 1,
    registrationId: typeof raw.registrationId === 'number' ? raw.registrationId : 1,
    identityKey: ik,
    ed25519PublicKey: ed,
    signedPreKey: {
      keyId: spk.keyId ?? 0,
      publicKey: spkPub,
      signature: spkSig,
      createdAt: typeof spk.createdAt === 'number' ? spk.createdAt : 0,
    },
  };
  const opk = raw.oneTimePreKey;
  if (opk && typeof opk.keyId === 'number') {
    const opkPub = toBytes(opk.publicKey);
    if (opkPub) {
      bundle.oneTimePreKey = { keyId: opk.keyId, publicKey: opkPub };
    }
  }
  return bundle;
}

// The peer's identity key from a server-stored bundle, normalized to base64.
export function getPeerIdentityKeyBase64(bundle: any): string | null {
  if (!bundle) return null;
  if (typeof bundle.identityKey === 'string') return bundle.identityKey;
  const bytes = toBytes(bundle.identityKey);
  return bytes ? arrayToBase64(bytes) : null;
}

// X3DH handshake messages travel over JSON; byte arrays must become plain
// arrays on the wire and back to Uint8Array on the receiving side.
export function serializeX3dhMessage(msg: any): any {
  if (!msg) return msg;
  return {
    identityKey: arrOf(msg.identityKey),
    signedPreKey: msg.signedPreKey
      ? { keyId: msg.signedPreKey.keyId, publicKey: arrOf(msg.signedPreKey.publicKey) }
      : undefined,
    baseKey: arrOf(msg.baseKey),
    oneTimePreKey: msg.oneTimePreKey
      ? { keyId: msg.oneTimePreKey.keyId, publicKey: arrOf(msg.oneTimePreKey.publicKey) }
      : undefined,
    message: msg.message
      ? { ciphertext: arrOf(msg.message.ciphertext), ratchetPublicKey: arrOf(msg.message.ratchetPublicKey), previousChainLength: msg.message.previousChainLength, messageNumber: msg.message.messageNumber }
      : undefined,
  };
}

export function deserializeX3dhMessage(raw: any): SignalPreKeyMessage | null {
  if (!raw || !raw.identityKey) return null;
  const identityKey = toBytes(raw.identityKey);
  const baseKey = toBytes(raw.baseKey);
  if (!identityKey || !baseKey) return null;
  const signedPreKey = raw.signedPreKey ? {
    keyId: raw.signedPreKey.keyId ?? 0,
    publicKey: toBytes(raw.signedPreKey.publicKey) || new Uint8Array(0),
  } : undefined;
  const oneTimePreKey = raw.oneTimePreKey ? {
    keyId: raw.oneTimePreKey.keyId ?? 0,
    publicKey: toBytes(raw.oneTimePreKey.publicKey) || new Uint8Array(0),
  } : undefined;
  return {
    identityKey,
    signedPreKey,
    baseKey,
    oneTimePreKey,
    message: raw.message
      ? {
          ciphertext: toBytes(raw.message.ciphertext) || new Uint8Array(0),
          ratchetPublicKey: toBytes(raw.message.ratchetPublicKey) || new Uint8Array(0),
          previousChainLength: raw.message.previousChainLength ?? 0,
          messageNumber: raw.message.messageNumber ?? 0,
        }
      : undefined,
  } as SignalPreKeyMessage;
}

function toBytes(value: any): Uint8Array | null {
  if (value == null) return null;
  if (typeof value === 'string') return base64ToArray(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  // JSON round-trips Uint8Array into a {0:..,1:..} integer-map object.
  if (typeof value === 'object') {
    const n = Object.keys(value).length;
    if (n === 0) return new Uint8Array(0);
    const arr = new Uint8Array(n);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const v = value[String(i)];
      if (typeof v !== 'number') { ok = false; break; }
      arr[i] = v;
    }
    return ok ? arr : null;
  }
  return null;
}

function arrOf(v: any): number[] | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return Array.from(base64ToArray(v));
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map((x: any) => Number(x));
  return Array.from(toBytes(v) || new Uint8Array(0));
}

export function getPreKeyBundleForServer() {
  return preKeyManager.getPublicKeyForServer();
}

export function getPreKeyBundle() {
  return preKeyManager.generatePreKeyBundle();
}

export function createSessionWithRemote(
  myId: string,
  remoteId: string,
  remoteBundle: PreKeyBundle
): { x3dhMessage: SignalPreKeyMessage; ratchetPublicKey: Uint8Array } | null {
  const ik = preKeyManager.getIdentityKeyPair();
  if (!ik) return null;

  const identityKey: KeyPair = { privateKey: ik.privateKey, publicKey: ik.publicKey };
  const result = sessionManager.createInitiatorSession(myId, remoteId, identityKey, remoteBundle);

  return {
    x3dhMessage: result.x3dhMessage,
    ratchetPublicKey: result.ratchetPublicKey,
  };
}

export function createResponderSession(
  myId: string,
  remoteId: string,
  x3dhMessage: SignalPreKeyMessage,
  aliceRatchetPublicKey: Uint8Array
): boolean {
  const ik = preKeyManager.getIdentityKeyPair();
  const spk = preKeyManager.getSignedPreKey();
  if (!ik || !spk) return false;

  const identityKey: KeyPair = { privateKey: ik.privateKey, publicKey: ik.publicKey };
  const signedPreKey: KeyPair = { privateKey: spk.keyPair.privateKey, publicKey: spk.keyPair.publicKey };

  let oneTimePreKey: KeyPair | null = null;
  if (x3dhMessage.oneTimePreKey) {
    const consumed = preKeyManager.consumeOneTimePreKey(x3dhMessage.oneTimePreKey.keyId);
    if (consumed) {
      oneTimePreKey = { privateKey: consumed.keyPair.privateKey, publicKey: consumed.keyPair.publicKey };
    }
  }

  sessionManager.createResponderSessionFromMessage(
    myId,
    remoteId,
    identityKey,
    signedPreKey,
    oneTimePreKey,
    x3dhMessage,
    aliceRatchetPublicKey,
    new Uint8Array(0),
    0
  );

  return true;
}

export function getSessionId(userId1: string, userId2: string): string {
  return sessionManager.getSessionId(userId1, userId2);
}

// Drop the local Double-Ratchet session for a peer pair. The next exchanged
// message re-establishes a fresh session via X3DH (used to heal sessions that
// failed their initial handshake).
export function resetSession(userId1: string, userId2: string): void {
  sessionManager.deleteSession(sessionManager.getSessionId(userId1, userId2));
}

export async function encryptWithSignal(
  sessionId: string,
  plaintext: string
): Promise<{ ciphertext: string; ratchetPublicKey: string; messageNumber: number }> {
  const ciphertext = await sessionManager.encryptMessage(sessionId, plaintext);
  const session = sessionManager.getSession(sessionId);
  if (!session) throw new Error('No session');

  return {
    ciphertext: arrayToBase64(ciphertext),
    ratchetPublicKey: arrayToBase64(session.state.currentRatchetPublicKey || new Uint8Array(0)),
    messageNumber: session.state.sendingMessageNumber - 1,
  };
}

export async function decryptWithSignal(
  sessionId: string,
  ciphertext: string,
  ratchetPublicKey: string,
  messageNumber: number
): Promise<string> {
  return sessionManager.decryptMessage(
    sessionId,
    base64ToArray(ciphertext),
    messageNumber,
    base64ToArray(ratchetPublicKey)
  );
}

export function hasSession(userId1: string, userId2: string): boolean {
  const id = sessionManager.getSessionId(userId1, userId2);
  return !!sessionManager.getSession(id);
}

function arrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToArray(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function consumeOneTimePreKey() {
  return preKeyManager.consumeOneTimePreKey();
}
