import { PreKeyManager } from './prekey';
import { SessionManager } from './session';
import type { PreKeyBundle, KeyPair, SignalPreKeyMessage } from './types';

const preKeyManager = new PreKeyManager();
const sessionManager = new SessionManager();

/**
 * The account whose key material the two managers currently hold, and the reason the stores are namespaced.
 *
 * Both managers are module singletons, so a second sign-in in the same tab re-initialises the same objects.
 * Without an account id they would look at the same two `localStorage` keys whatever account was signed in,
 * which is how a second account's sign-in ended up deleting the first account's session store and
 * publishing the first account's identity key. Recorded here only for the comment's sake; the managers carry
 * their own.
 */
let accountId = '';

export async function initSessionManager(password: string, forAccountId = accountId): Promise<void> {
  accountId = forAccountId;
  await sessionManager.init(password, forAccountId);
  sessionManager.startCleanupTimer();
}

/**
 * Writes pending key state out at once.
 *
 * Both managers debounce their writes, which is right while the app runs but means a tab closed inside
 * the window loses the session. That loss is unrecoverable for a ratchet - the messages already sent
 * under the discarded key can never be opened again by anybody - so every way of leaving goes through
 * here: closing the tab, losing the connection, and the page going away.
 */
export function flushSignalState(): void {
  try { sessionManager.flush(); } catch { /* nothing worth failing a page exit over */ }
  try { preKeyManager.flush?.(); } catch { /* as above */ }
}

/**
 * Moves both stores onto a new account password.
 *
 * Every piece of state this device holds that is keyed by the password has to move at once. Doing it for
 * the sessions alone would leave the prekeys under the old one, and then the next launch could open one
 * store and not the other - which reads as a corrupt install rather than as a bad password.
 */
export async function rekeySignalState(newPassword: string): Promise<void> {
  await sessionManager.rekey(newPassword);
  await preKeyManager.rekey(newPassword);
}

/** Installs the listeners. Called once, after the managers are ready. */
let removeFlushHandlers: (() => void) | null = null;

export function installSignalFlushHandlers(): () => void {
  if (typeof window === 'undefined') return () => {};
  // one set at a time: a second sign-in in the same tab used to leave the first set attached, so every
  // page exit wrote the state twice
  removeFlushHandlers?.();
  const onLeave = () => flushSignalState();
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('beforeunload', onLeave);
  window.addEventListener('blur', onLeave);
  document.addEventListener('visibilitychange', onLeave);
  removeFlushHandlers = () => {
    window.removeEventListener('pagehide', onLeave);
    window.removeEventListener('beforeunload', onLeave);
    window.removeEventListener('blur', onLeave);
    document.removeEventListener('visibilitychange', onLeave);
    if (removeFlushHandlers === uninstall) removeFlushHandlers = null;
  };
  const uninstall = removeFlushHandlers;
  return uninstall;
}

/**
 * Stops the managers writing anything at all.
 *
 * For "turn every key off", which is not the same as signing out. The flush handlers exist so that a tab
 * closed inside the write debounce does not lose ratchet state - unrecoverable, since the messages already
 * sent under the discarded key can never be opened again by anybody. But they fire on `pagehide`, which is
 * exactly what happens next in the recovery path: delete the keys, then reload. The flush cancelled the
 * debounce, ran the write out at once with the live key still in hand, and put the whole identity key and
 * every chain key straight back into localStorage, milliseconds after they had been deleted. Whether it
 * won that race was down to how fast the browser got to the event.
 *
 * So the listeners come off first and the managers are told there is nothing to save. Anything that wants
 * to write after this gets nothing written.
 */
export function stopSignalState(): void {
  removeFlushHandlers?.();
  removeFlushHandlers = null;
  sessionManager.stopCleanupTimer();
  sessionManager.destroy();
  preKeyManager.destroy();
}

export async function initPreKeyManager(password: string): Promise<void> {
  await preKeyManager.init(password);
}

export function initializeSignal(): void {
  preKeyManager.initialize();
}

export function getMyIdentityKeyBase64(): string | null {
  const ik = preKeyManager.getIdentityKeyPair();
  return ik ? arrayToBase64(ik.publicKey) : null;
}

export function base64ToBytes(b64: string): Uint8Array {
  return base64ToArray(b64);
}

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

export async function getPreKeyBundleForServer() {
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

/**
 * A one-time prekey borrowed for a handshake that has not authenticated yet.
 *
 * Held here rather than spent on arrival, because spending it is irreversible: a body that turns out to
 * be forged must not cost the account a key. `commitResponderPreKey` spends it, and it is only called
 * once the first message has actually opened.
 *
 * Keyed by conversation, not kept in one slot. It used to be a single variable, so two handshakes in
 * flight at once - which happens whenever two people who have never written to each other both send their
 * first message, and neither has opened it - overwrote each other. The first conversation to be committed
 * then spent the second one's key, marking a prekey consumed that its own handshake had never borrowed,
 * and leaving its own key marked available for a replay.
 */
const pendingOneTimePreKeys = new Map<string, number>();

export function createResponderSession(
  myId: string,
  remoteId: string,
  x3dhMessage: SignalPreKeyMessage,
  aliceRatchetPublicKey: Uint8Array
): boolean {
  const ik = preKeyManager.getIdentityKeyPair();
  if (!ik) return false;

  // the key the handshake was actually built against, which is not necessarily the current one: a
  // rotation between the bundle being fetched and this arriving would otherwise produce a secret
  // neither end shares, and the conversation would be dead on arrival
  const spkRecord = preKeyManager.getSignedPreKeyById(x3dhMessage.signedPreKey?.keyId);
  if (!spkRecord) return false;

  const identityKey: KeyPair = { privateKey: ik.privateKey, publicKey: ik.publicKey };
  const signedPreKey: KeyPair = {
    privateKey: spkRecord.keyPair.privateKey,
    publicKey: spkRecord.keyPair.publicKey,
  };

  let oneTimePreKey: KeyPair | null = null;
  const sessionId = sessionManager.getSessionId(myId, remoteId);
  if (x3dhMessage.oneTimePreKey) {
    const borrowed = preKeyManager.peekOneTimePreKey(x3dhMessage.oneTimePreKey.keyId);
    if (borrowed) {
      oneTimePreKey = { privateKey: borrowed.keyPair.privateKey, publicKey: borrowed.keyPair.publicKey };
      pendingOneTimePreKeys.set(sessionId, borrowed.keyId);
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

/**
 * Spends the borrowed one-time prekey for a conversation, now that a message has opened under it.
 *
 * Until this runs the key is still in the account's supply, so a server replaying captured handshakes
 * gains nothing: each replay borrows a key, fails to produce a message that opens, and gives it back.
 *
 * Takes the conversation because the borrow belongs to it. With a single slot shared by every handshake,
 * two conversations waiting to be committed would spend each other's keys - one prekey marked consumed that
 * no message ever used, and one still available for a replay.
 */
export function commitResponderPreKey(sessionId: string): void {
  const id = pendingOneTimePreKeys.get(sessionId);
  if (id == null) return;
  pendingOneTimePreKeys.delete(sessionId);
  preKeyManager.consumeOneTimePreKey(id);
}

/** Gives a borrowed key back when the handshake it was borrowed for did not open. */
export function releaseResponderPreKey(sessionId: string): void {
  pendingOneTimePreKeys.delete(sessionId);
}

/** The identity key the far end was pinned to when this session was created, if there is one. */
export function getPinnedIdentityKey(sessionId: string): Uint8Array | null {
  const pinned = sessionManager.getSession(sessionId)?.state.remoteIdentityKey;
  return pinned ? pinned.slice() : null;
}

export function getSessionId(userId1: string, userId2: string): string {
  return sessionManager.getSessionId(userId1, userId2);
}

export function resetSession(userId1: string, userId2: string): void {
  sessionManager.deleteSession(sessionManager.getSessionId(userId1, userId2));
}

export async function encryptWithSignal(
  sessionId: string,
  plaintext: string
): Promise<{ ciphertext: string; ratchetPublicKey: string; messageNumber: number }> {
  // The header comes from the seal itself. It used to be read back off the session afterwards, which put
  // the number on the wire at the mercy of anything that moved the counter in the meantime: a rekey from
  // the cleanup timer reset it to zero, and the frame went out numbered -1 and was refused as out of order.
  // Two sends racing - the device fan-out does exactly that - could also report each other's number.
  const { ciphertext, messageNumber, ratchetPublicKey } = await sessionManager.encryptMessage(sessionId, plaintext);

  return {
    ciphertext: arrayToBase64(ciphertext),
    ratchetPublicKey: arrayToBase64(ratchetPublicKey),
    messageNumber,
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
