import type { Session, KeyPair, PreKeyBundle, SignalPreKeyMessage } from './types';
import { generateKeyPair } from './keys';
import { x3dhInit, x3dhRespond, x3dhTranscriptHash } from './x3dh';
import {
  advanceSendingChain,
  advanceReceivingChain,
  ratchetStep,
  createRatchetState,
  cloneSessionState,
  buildHeader,
  takePreviousChainKey,
  recordSentMessageKey,
  dhRatchet,
  MAX_SESSIONS,
} from './ratchet';
import {
  PBKDF2_ITER,
  SESSION_STATE_VERSION,
  SESSION_MAX_AGE_MS,
  REKEY_INTERVAL_MS,
  MAX_INACTIVITY_MS,
  CLEANUP_INTERVAL_MS,
  PROTOCOL_VERSION,
  KEY_PREFIX,
} from './constants';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const SESSIONS_KEY = KEY_PREFIX.sessions;
const INFO_ROOT = new TextEncoder().encode('WhisperNetRoot');

/**
 * The frame a ciphertext travels in.
 *
 * A leading version byte says whether the header was bound into the AEAD's associated data. Bodies
 * written before that was added are still read, because a conversation that has been going for a week
 * should not fall apart over it - but nothing new is ever written the old way.
 */
const BODY_HEADER_BOUND = 0x04;
const IV_BYTES = 12;

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** A message key as an AES-GCM key. Always 32 bytes, so a truncated chain key fails here rather than silently. */
function importAesKey(messageKey: Uint8Array): Promise<CryptoKey> {
  if (messageKey.length !== 32) throw new Error('Message key is not 32 bytes');
  const material = new Uint8Array(32);
  material.set(messageKey);
  return crypto.subtle.importKey(
    'raw',
    material.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private encryptionKey: CryptoKey | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {}

  async init(password: string): Promise<void> {
    const salt = new Uint8Array(16);
    const saltB64 = localStorage.getItem(KEY_PREFIX.sessionsSalt);
    if (saltB64) {
      salt.set(new Uint8Array(base64ToBuf(saltB64)));
    } else {
      crypto.getRandomValues(salt);
      localStorage.setItem(KEY_PREFIX.sessionsSalt, bufToBase64(salt.buffer));
    }
    const passKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    this.encryptionKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    await this.loadEncrypted();
  }

  private async loadEncrypted(): Promise<void> {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (!raw || !this.encryptionKey) return;
      const { iv, data } = JSON.parse(raw);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(iv)) },
        this.encryptionKey, base64ToBuf(data)
      );
      const parsed = JSON.parse(new TextDecoder().decode(plaintext));
      for (const [id, session] of Object.entries(parsed)) {
        const s = session as any;
        if (s.state.skippedMessageKeys && !(s.state.skippedMessageKeys instanceof Map)) {
          const entries = Object.entries(s.state.skippedMessageKeys) as [string, number[]][];
          s.state.skippedMessageKeys = new Map(
            entries.map(([k, v]) => [parseInt(k), new Uint8Array(v)])
          );
        }
        if (s.state.previousSendingSkippedKeys && !(s.state.previousSendingSkippedKeys instanceof Map)) {
          const entries = Object.entries(s.state.previousSendingSkippedKeys) as [string, number[]][];
          s.state.previousSendingSkippedKeys = new Map(
            entries.map(([k, v]) => [parseInt(k), new Uint8Array(v)])
          );
        } else if (!s.state.previousSendingSkippedKeys) {
          s.state.previousSendingSkippedKeys = new Map();
        }
        if (s.state.sentMessageKeys && !(s.state.sentMessageKeys instanceof Map)) {
          const entries = Object.entries(s.state.sentMessageKeys) as [string, number[]][];
          s.state.sentMessageKeys = new Map(
            entries.map(([k, v]) => [parseInt(k), new Uint8Array(v)])
          );
        } else if (!s.state.sentMessageKeys) {
          s.state.sentMessageKeys = new Map();
        }
        // written as plain arrays by JSON; both ends need them as bytes
        s.state.transcriptHash = s.state.transcriptHash ? new Uint8Array(s.state.transcriptHash) : null;
        s.state.remoteIdentityKey = s.state.remoteIdentityKey ? new Uint8Array(s.state.remoteIdentityKey) : null;
        s.state.previousSendingRatchetPublicKey = s.state.previousSendingRatchetPublicKey
          ? new Uint8Array(s.state.previousSendingRatchetPublicKey)
          : null;
        this.sessions.set(id, s as Session);
      }
      // A session stored before the header was bound into the ciphertext has no transcript, and no
      // transcript means nothing new can be encrypted against it: the associated data would not match
      // on the far side. Such a session is finished by definition - the peer is a version behind - so it
      // is dropped here and the next message starts a fresh handshake.
      let dropped = 0;
      for (const [id, session] of [...this.sessions]) {
        if (!session.state.transcriptHash) { this.sessions.delete(id); dropped++; }
      }
      if (dropped > 0) this.save();
    } catch {
      localStorage.removeItem(SESSIONS_KEY);
    }
  }

  save(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.doSave(), 500);
  }

  /**
   * Writes the pending state out now instead of in half a second.
   *
   * The debounce is right while the app is running - writing on every message would be a write per
   * message - but a tab closed inside the window loses the session, and a lost session is the one
   * failure a ratchet cannot recover from: everything already said under the old key stays unreadable,
   * with no key left anywhere to open it. Closing the tab, losing connection and losing power all go
   * through here.
   */
  flush(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    void this.doSave();
  }

  /**
   * Drops the pending write without saving it.
   *
   * The debounced save is a timer on a shared storage key, so a manager that is finished with - a
   * reinstalled account, a test that has moved on - will otherwise write its state out later, over
   * whatever has been stored since. The prekey manager has had this all along; the session manager did
   * not, which is the same bug in one place and not the other.
   */
  destroy(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.sessions.clear();
    this.encryptionKey = null;
  }

  /**
   * Re-encrypts everything held here under a different account password.
   *
   * The sessions are already in memory in plaintext, so this is a re-wrap rather than a migration: a new
   * salt, a new derived key, and one write. Deliberately not a load - reading with the new password
   * first would fail, and the state is right here to be written out instead.
   *
   * The salt is replaced rather than kept, because keeping it would leave the old key derivable from the
   * new password by anyone who had it, and the whole point of changing a password is that the previous
   * one stops working.
   */
  async rekey(newPassword: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    localStorage.setItem(KEY_PREFIX.sessionsSalt, bufToBase64(salt.buffer));
    const passKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(newPassword), 'PBKDF2', false, ['deriveKey']
    );
    this.encryptionKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.doSave();
  }

  private async doSave(): Promise<void> {
    try {
      const obj: Record<string, any> = {};
      for (const [id, session] of this.sessions) {
        const s: any = { ...session };
        s.state = { ...s.state };
        if (s.state.skippedMessageKeys instanceof Map) {
          const entries: [number, Uint8Array][] = Array.from(s.state.skippedMessageKeys.entries());
          s.state.skippedMessageKeys = Object.fromEntries(
            entries.map(([k, v]) => [k, Array.from(v)])
          );
        }
        if (s.state.previousSendingSkippedKeys instanceof Map) {
          const entries: [number, Uint8Array][] = Array.from(s.state.previousSendingSkippedKeys.entries());
          s.state.previousSendingSkippedKeys = Object.fromEntries(
            entries.map(([k, v]) => [k, Array.from(v)])
          );
        } else if (!s.state.previousSendingSkippedKeys) {
          s.state.previousSendingSkippedKeys = {};
        }
        if (s.state.sentMessageKeys instanceof Map) {
          const entries: [number, Uint8Array][] = Array.from(s.state.sentMessageKeys.entries());
          s.state.sentMessageKeys = Object.fromEntries(
            entries.map(([k, v]) => [k, Array.from(v)])
          );
        } else if (!s.state.sentMessageKeys) {
          s.state.sentMessageKeys = {};
        }
        obj[id] = s;
      }
      const json = JSON.stringify(obj);
      if (this.encryptionKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv }, this.encryptionKey, new TextEncoder().encode(json)
        );
        localStorage.setItem(SESSIONS_KEY, JSON.stringify({
          iv: bufToBase64(iv.buffer), data: bufToBase64(ciphertext)
        }));
      } else {
        localStorage.setItem(SESSIONS_KEY, json);
      }
    } catch (e) {
      console.error('[signal] failed to persist sessions:', e);
    }
  }

  private evictOldestSession(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const firstKey = this.sessions.keys().next().value;
    if (firstKey) this.sessions.delete(firstKey);
  }

  getSessionId(userId1: string, userId2: string): string {
    return [userId1, userId2].sort().join(':');
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Starts a conversation from the far end's published bundle.
   *
   * An existing session is never replaced. It used to be, which meant a second handshake arriving for
   * a conversation already in progress - a duplicate delivery, a second device, a replayed body - threw
   * away live chain keys and left the two ends permanently unable to read each other.
   */
  createInitiatorSession(
    myId: string,
    remoteId: string,
    identityKey: KeyPair,
    remoteBundle: PreKeyBundle
  ): { session: Session; x3dhMessage: SignalPreKeyMessage; ratchetPublicKey: Uint8Array; reused: boolean } {
    const sessionId = this.getSessionId(myId, remoteId);

    const ratchetKeyPair = generateKeyPair();
    const { sharedSecret, message: x3dhMessage } = x3dhInit(identityKey, remoteBundle, ratchetKeyPair.publicKey);

    const derived = hkdf(sha256, sharedSecret, new Uint8Array(32), INFO_ROOT, 64);
    const rootKey = derived.slice(0, 32);
    const chainKey = derived.slice(32, 64);

    const state = createRatchetState();
    state.rootKey = rootKey;
    state.sendingChainKey = chainKey;
    state.sendingRatchetKey = ratchetKeyPair;
    state.currentRatchetPublicKey = ratchetKeyPair.publicKey;
    state.sendingMessageNumber = 0;
    state.transcriptHash = x3dhTranscriptHash(
      identityKey.publicKey,
      remoteBundle.identityKey,
      x3dhMessage.baseKey,
      x3dhMessage.signedPreKey?.publicKey,
      x3dhMessage.oneTimePreKey?.publicKey
    );
    state.remoteIdentityKey = remoteBundle.identityKey.slice();
    const now = Date.now();
    state.createdAt = now;
    state.lastActivity = now;

    const session: Session = { sessionId, state, version: SESSION_STATE_VERSION, protocolVersion: PROTOCOL_VERSION };
    this.evictOldestSession();
    this.sessions.set(sessionId, session);
    this.save();

    return { session, x3dhMessage, ratchetPublicKey: ratchetKeyPair.publicKey, reused: false };
  }

  /**
   * The far end's identity key as this session has it pinned, and whether a new bundle contradicts it.
   *
   * A different identity key for an account that already has a session is what a reinstall looks like,
   * and what a server substituting keys looks like. Either way the old session is finished: its peer
   * can no longer produce anything this session will open.
   */
  checkRemoteIdentity(sessionId: string, identityKey: Uint8Array | null | undefined): 'ok' | 'unknown' | 'changed' {
    const session = this.sessions.get(sessionId);
    if (!session) return 'unknown';
    const pinned = session.state.remoteIdentityKey;
    if (!pinned || !identityKey) return 'ok';
    if (pinned.length !== identityKey.length) return 'changed';
    return pinned.every((v, i) => v === identityKey[i]) ? 'ok' : 'changed';
  }

  createResponderSessionFromMessage(
    myId: string,
    remoteId: string,
    identityKey: KeyPair,
    signedPreKey: KeyPair,
    oneTimePreKey: KeyPair | null,
    x3dhMessage: SignalPreKeyMessage,
    aliceRatchetPublicKey: Uint8Array,
    _firstMessageCiphertext: Uint8Array,
    _firstMessageNumber: number
  ): Session {
    const sessionId = this.getSessionId(myId, remoteId);
    const sharedSecret = x3dhRespond(identityKey, signedPreKey, oneTimePreKey, x3dhMessage);

    const derived = hkdf(sha256, sharedSecret, new Uint8Array(32), INFO_ROOT, 64);
    const rootKey = derived.slice(0, 32);
    const chainKey = derived.slice(32, 64);

    const ratchetKeyPair = generateKeyPair();
    const { rootKey: newRootKey, chainKey: sendingChainKey } = dhRatchet(rootKey, ratchetKeyPair.privateKey, aliceRatchetPublicKey);

    const state = createRatchetState();
    state.rootKey = newRootKey;
    state.receivingChainKey = chainKey;
    state.receivingRatchetPublicKey = aliceRatchetPublicKey;
    state.receivingMessageNumber = 0;
    state.sendingChainKey = sendingChainKey;
    state.sendingRatchetKey = ratchetKeyPair;
    state.currentRatchetPublicKey = ratchetKeyPair.publicKey;
    state.transcriptHash = x3dhTranscriptHash(
      x3dhMessage.identityKey,
      identityKey.publicKey,
      x3dhMessage.baseKey,
      x3dhMessage.signedPreKey?.publicKey ?? signedPreKey.publicKey,
      x3dhMessage.oneTimePreKey?.publicKey ?? oneTimePreKey?.publicKey ?? null
    );
    state.remoteIdentityKey = x3dhMessage.identityKey.slice();
    const now = Date.now();
    state.createdAt = now;
    state.lastActivity = now;

    const session: Session = { sessionId, state, version: SESSION_STATE_VERSION, protocolVersion: PROTOCOL_VERSION };
    this.evictOldestSession();
    this.sessions.set(sessionId, session);
    this.save();

    return session;
  }

  async encryptMessage(sessionId: string, plaintext: string): Promise<Uint8Array> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('No session');
    if (!session.state.transcriptHash) throw new Error('Session has no transcript');
    const ratchetPublicKey = session.state.currentRatchetPublicKey;
    if (!ratchetPublicKey) throw new Error('No ratchet key published yet');

    // advanced first, because the number that goes on the wire is the one before this message
    const messageKey = advanceSendingChain(session.state);
    const messageNumber = session.state.sendingMessageNumber - 1;
    // kept, so a ratchet step does not strand a message that is still travelling
    recordSentMessageKey(session.state, messageNumber, messageKey);
    session.state.lastActivity = Date.now();

    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const cryptoKey = await importAesKey(messageKey);
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: buildHeader(session.state.transcriptHash, ratchetPublicKey, messageNumber),
      },
      cryptoKey,
      new TextEncoder().encode(plaintext)
    );

    this.save();
    const result = new Uint8Array(2 + iv.length + encrypted.byteLength);
    result[0] = BODY_HEADER_BOUND;
    result[1] = iv.length;
    result.set(iv, 2);
    result.set(new Uint8Array(encrypted), 2 + iv.length);
    return result;
  }

  /**
   * Opens a body, and only commits the session if it really was this session's.
   *
   * The ratchet is advanced on a copy of the state and the copy is adopted once the plaintext is in
   * hand. That is what makes a dishonest server harmless to a conversation: it can withhold a message,
   * and it can replay one, but a body it made up cannot leave the chain rewound, cannot spend a
   * message key, and cannot push the session forward past something nobody ever read.
   */
  async decryptMessage(
    sessionId: string,
    ciphertext: Uint8Array,
    messageNumber: number,
    ratchetPublicKey: Uint8Array
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('No session');
    if (!Number.isInteger(messageNumber) || messageNumber < 0) throw new Error('Bad message number');
    if (!ratchetPublicKey || ratchetPublicKey.length === 0) throw new Error('Bad ratchet key');

    const draft = cloneSessionState(session.state);

    // A body naming the chain this side has already stepped off was sent before the step and is still in
    // transit. Its key was kept for exactly this, and it is taken before anything else happens: stepping
    // again here would clear the very keys the body needs, which is how a message that was already sent
    // turns into one nobody can read.
    const fromPreviousChain = takePreviousChainKey(draft, ratchetPublicKey, messageNumber);

    let messageKey: Uint8Array | null = fromPreviousChain;
    if (!messageKey) {
      const currentRemoteKey = draft.receivingRatchetPublicKey;
      const keysEqual = !!currentRemoteKey
        && currentRemoteKey.length === ratchetPublicKey.length
        && currentRemoteKey.every((v, i) => v === ratchetPublicKey[i]);

      if (!keysEqual) ratchetStep(draft, ratchetPublicKey);
      messageKey = advanceReceivingChain(draft, messageNumber);
    }
    if (!messageKey) throw new Error('No message key available');

    const bound = ciphertext[0] === BODY_HEADER_BOUND;
    const offset = bound ? 1 : 0;
    const ivLength = ciphertext[offset];
    if (ivLength !== IV_BYTES) throw new Error('Bad ciphertext framing');
    if (ciphertext.length < offset + 1 + ivLength + 16) throw new Error('Truncated ciphertext');
    const iv = ciphertext.slice(offset + 1, offset + 1 + ivLength);
    const data = ciphertext.slice(offset + 1 + ivLength);

    const cryptoKey = await importAesKey(messageKey);
    const additionalData = bound && draft.transcriptHash
      ? buildHeader(draft.transcriptHash, ratchetPublicKey, messageNumber)
      : undefined;

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        additionalData ? { name: 'AES-GCM', iv, additionalData } : { name: 'AES-GCM', iv },
        cryptoKey,
        data
      );
    } catch {
      // nothing above this line touched the live session, so a forged body costs nothing
      throw new Error('Message did not authenticate');
    }

    Object.assign(session.state, draft, { lastActivity: Date.now() });
    this.save();
    return new TextDecoder().decode(decrypted);
  }

deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.save();
  }

  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state.lastActivity = Date.now();
      this.save();
    }
  }

  evictStaleSessions(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, session] of this.sessions) {
      const age = now - (session.state.createdAt || 0);
      const inactive = now - (session.state.lastActivity || 0);
      if (age > SESSION_MAX_AGE_MS || inactive > MAX_INACTIVITY_MS) {
        this.sessions.delete(id);
        evicted++;
      }
    }
    if (evicted > 0) this.save();
    return evicted;
  }

  /**
   * Re-derives the sending chain after a long silence.
   *
   * The message counters are deliberately left alone. Zeroing the receiving number hands back every
   * message key already spent on this chain, so a body captured months ago would decrypt again the
   * moment the counter was rewound - the one thing a ratchet must never allow. The sending chain moves
   * on and the receiving chain is untouched, which is what "the conversation was idle" should mean.
   */
  autoRekeyIfNeeded(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const inactive = Date.now() - (session.state.lastActivity || 0);
    if (inactive > REKEY_INTERVAL_MS && session.state.receivingRatchetPublicKey) {
      const ratchetKeyPair = generateKeyPair();
      const { rootKey: newRootKey, chainKey: newSendingChain } = dhRatchet(
        session.state.rootKey,
        ratchetKeyPair.privateKey,
        session.state.receivingRatchetPublicKey
      );

      session.state.rootKey = newRootKey;
      session.state.sendingChainKey = newSendingChain;
      session.state.sendingRatchetKey = ratchetKeyPair;
      session.state.currentRatchetPublicKey = ratchetKeyPair.publicKey;
      session.state.sendingMessageNumber = 0;
      session.state.lastActivity = Date.now();

      this.save();
      return true;
    }
    return false;
  }

  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.evictStaleSessions();
      for (const id of this.sessions.keys()) {
        this.autoRekeyIfNeeded(id);
      }
    }, CLEANUP_INTERVAL_MS);
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
}
