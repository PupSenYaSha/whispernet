import type { Session, SessionState, KeyPair, PreKeyBundle, SignalPreKeyMessage } from './types';
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
  MAX_SENT_KEYS_RETAINED,
} from './ratchet';
import {
  PBKDF2_ITER,
  SESSION_STATE_VERSION,
  SESSION_MAX_AGE_MS,
  REKEY_INTERVAL_MS,
  MAX_INACTIVITY_MS,
  CLEANUP_INTERVAL_MS,
  PROTOCOL_VERSION,
  MAX_SKIPPED_MESSAGE_KEYS,
  MAX_PREVIOUS_RECEIVING_KEYS,
  KEY_PREFIX,
} from './constants';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { wipe, wipeAll } from './wipe';
import { takePreviousReceivingKey } from './ratchet';
import { storageKey, SESSION_STATE_VERSION_LEGACY } from './constants';

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

/**
 * Base64 in slices.
 *
 * `String.fromCharCode(...bytes)` throws once the array is long enough to exceed the argument limit,
 * which for this file is the entire encrypted session store - one call, over every conversation on the
 * account. The throw landed inside the `catch` that wraps the save, so the write simply never happened
 * and nothing said so.
 */
const B64_CHUNK = 0x8000;
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + B64_CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/**
 * A message key as an AES-GCM key. Always 32 bytes, so a truncated chain key fails here rather than silently.
 *
 * WebCrypto's `importKey` does not take a `Uint8Array` view, so the key is copied into a fresh buffer
 * first - and that copy is a second live copy of the key, alive for as long as the returned promise is.
 * It is wiped as soon as the import resolves, which leaves only the `CryptoKey` (non-extractable) and the
 * caller's own reference. Same reasoning as the password buffer in `init`.
 */
async function importAesKey(messageKey: Uint8Array): Promise<CryptoKey> {
  if (messageKey.length !== 32) throw new Error('Message key is not 32 bytes');
  const material = new Uint8Array(32);
  material.set(messageKey);
  try {
    return await crypto.subtle.importKey(
      'raw',
      material.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } finally {
    wipe(material);
  }
}

/**
 * Bytes to a plain array of numbers, for JSON.
 *
 * Every byte field goes through this. `JSON.stringify` does not understand a typed array: it emits an
 * object with a key per index - `{"0":1,"1":2}` - and reading that back does not throw either, it just
 * produces something that is not bytes. `new Uint8Array({"0":1})` has length 0, so the failure is silent:
 * a root key came back as a plain object and every later use of it threw, and a transcript hash came back
 * as an empty array, which is truthy and so sailed past the check that is supposed to retire a session
 * without one. Between them they meant a reload left every conversation on the account unreadable and the
 * app quietly reset each one in turn.
 */
function bytesToJson(value: Uint8Array | null | undefined): number[] | null {
  return value ? Array.from(value) : null;
}

/**
 * The other direction, and it insists on the result really being bytes.
 *
 * A stored value that is not an array of numbers returns null rather than an empty array, so the caller
 * can tell "absent" from "present but unreadable" - which is the difference between a field that is
 * allowed to be null and a session that cannot be used at all.
 */
function bytesFromJson(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const b = value[i];
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    out[i] = b;
  }
  return out;
}

/** The three maps of message keys, which JSON turns into objects and which have to be Maps again. */
function keysToJson(map: Map<number, Uint8Array> | undefined): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!(map instanceof Map)) return out;
  for (const [k, v] of map.entries()) {
    if (v instanceof Uint8Array) out[String(k)] = Array.from(v);
  }
  return out;
}

/**
 * The message-key maps, back from JSON and *bounded on the way in*.
 *
 * The writers cap these; the reader did not, so a store written by a build with a larger cap (or a
 * hand-edited one) came back holding every entry, and then every subsequent save serialised all of it -
 * which is how a single account could grow past the `localStorage` quota and stop persisting at all. The
 * bound is applied here as well so the cap holds for the whole life of the state rather than only from
 * the first message sent on it.
 *
 * The oldest entries are the ones dropped, by insertion order, which for these maps is message number
 * order: they are the ones furthest behind the counter and the least likely to still be in transit.
 */
function keysFromJson(raw: unknown, max: number): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(k);
    if (!Number.isInteger(n)) continue;
    const bytes = bytesFromJson(v);
    if (!bytes) continue;
    out.set(n, bytes);
    while (out.size > max) {
      const oldest = out.keys().next().value;
      if (oldest == null) break;
      out.delete(oldest);
    }
  }
  return out;
}

/**
 * One session as JSON.
 *
 * Written field by field rather than by spreading the state, because a spread copies whatever happens to
 * be there today: a field added later would be serialised as a typed array and read back as an object,
 * which is the bug above all over again and with none of the noise to point at it. Being explicit also
 * means an unreadable state is caught on the way in rather than on the way to the curve arithmetic.
 */
function sessionToJson(session: Session): Record<string, unknown> {
  const s = session.state;
  const ratchetKey = s.sendingRatchetKey;
  return {
    sessionId: session.sessionId,
    version: session.version,
    protocolVersion: session.protocolVersion,
    state: {
      version: s.version,
      registrationId: s.registrationId,
      rootKey: bytesToJson(s.rootKey),
      sendingChainKey: bytesToJson(s.sendingChainKey),
      receivingChainKey: bytesToJson(s.receivingChainKey),
      sendingRatchetKey: ratchetKey
        ? { privateKey: bytesToJson(ratchetKey.privateKey), publicKey: bytesToJson(ratchetKey.publicKey) }
        : null,
      currentRatchetPublicKey: bytesToJson(s.currentRatchetPublicKey),
      receivingRatchetPublicKey: bytesToJson(s.receivingRatchetPublicKey),
      previousSendingRatchetPublicKey: bytesToJson(s.previousSendingRatchetPublicKey),
      previousSendingChainLength: s.previousSendingChainLength,
      previousSendingSkippedKeys: keysToJson(s.previousSendingSkippedKeys),
      sentMessageKeys: keysToJson(s.sentMessageKeys),
      sendingMessageNumber: s.sendingMessageNumber,
      receivingMessageNumber: s.receivingMessageNumber,
      skippedMessageKeys: keysToJson(s.skippedMessageKeys),
      previousReceivingRatchetPublicKey: bytesToJson(s.previousReceivingRatchetPublicKey),
      previousReceivingChainLength: s.previousReceivingChainLength,
      previousReceivingSkippedKeys: keysToJson(s.previousReceivingSkippedKeys),
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      transcriptHash: bytesToJson(s.transcriptHash),
      remoteIdentityKey: bytesToJson(s.remoteIdentityKey),
    },
  };
}

/**
 * One session back, or null when it cannot be trusted.
 *
 * The root key is the one thing that cannot be missing: without it the conversation cannot be opened,
 * advanced or closed, so a state without one is discarded here rather than handed back to the caller as
 * a session. The transcript hash is held to the same standard from the other side - an empty one is no
 * better than a missing one, and treating it as present is what let a reload past the check below.
 */
function sessionFromJson(id: string, raw: unknown): Session | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, any>;
  const src = entry.state;
  if (!src || typeof src !== 'object') return null;

  // The shape this build knows how to read.
  //
  // Both tags were read into locals and dropped, so the version number protected nothing: a state written
  // by a build whose layout differed was parsed field by field against a reader that had never heard of
  // it. That was survivable only because the content checks below do the real work - a `rootKey` that is
  // not 32 bytes, or a transcript that is not there, are refused whatever the tag says. Those checks are
  // why this is a hardening change rather than a fix for something that was visibly broken, and they are
  // also why refusing an unknown version cannot cost anybody a conversation: anything genuinely unreadable
  // was already being dropped.
  const version = entry.version ?? src.version;
  if (version !== SESSION_STATE_VERSION && version !== SESSION_STATE_VERSION_LEGACY) return null;

  const rootKey = bytesFromJson(src.rootKey);
  if (!rootKey || rootKey.length !== 32) return null;
  const transcriptHash = bytesFromJson(src.transcriptHash);
  if (!transcriptHash || transcriptHash.length === 0) return null;
  // The identity key the far end was pinned to is what catches a substitution or a reinstall, so it is
  // held to the same standard as the transcript. It was optional, and `bytesFromJson` answers `null` both
  // for "absent" and for "present but unreadable" - so a state whose pinned key could not be parsed came
  // back with the check silently switched off rather than with a session that was dropped. That is the
  // wrong way round: an unreadable key should cost the session, not the protection.
  const remoteIdentityKey = bytesFromJson(src.remoteIdentityKey);
  if (!remoteIdentityKey || remoteIdentityKey.length === 0) return null;

  const rk = src.sendingRatchetKey;
  const sendingRatchetKey = rk && typeof rk === 'object'
    ? { privateKey: bytesFromJson(rk.privateKey), publicKey: bytesFromJson(rk.publicKey) }
    : null;
  if (sendingRatchetKey && (!sendingRatchetKey.privateKey || !sendingRatchetKey.publicKey)) return null;

  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const state: SessionState = {
    version: SESSION_STATE_VERSION,
    registrationId: num(src.registrationId, 0),
    rootKey,
    sendingChainKey: bytesFromJson(src.sendingChainKey),
    receivingChainKey: bytesFromJson(src.receivingChainKey),
    sendingRatchetKey: sendingRatchetKey as KeyPair | null,
    currentRatchetPublicKey: bytesFromJson(src.currentRatchetPublicKey),
    receivingRatchetPublicKey: bytesFromJson(src.receivingRatchetPublicKey),
    previousSendingRatchetPublicKey: bytesFromJson(src.previousSendingRatchetPublicKey),
    previousSendingChainLength: num(src.previousSendingChainLength, 0),
    previousSendingSkippedKeys: keysFromJson(src.previousSendingSkippedKeys, MAX_SENT_KEYS_RETAINED),
    sentMessageKeys: keysFromJson(src.sentMessageKeys, MAX_SENT_KEYS_RETAINED),
    sendingMessageNumber: num(src.sendingMessageNumber, 0),
    receivingMessageNumber: num(src.receivingMessageNumber, 0),
    skippedMessageKeys: keysFromJson(src.skippedMessageKeys, MAX_SKIPPED_MESSAGE_KEYS),
    // Absent on a state from before this field existed, which is the whole reason `SESSION_STATE_VERSION`
    // exists: a version 3 state has no previous-receiving window, so it gets an empty one and starts
    // collecting at its next ratchet step. Read as a field-by-field parse it would have produced a
    // `Map` of the wrong shape - or nothing at all - and the version check above is what makes the
    // difference between "migrated" and "unreadable" explicit.
    previousReceivingRatchetPublicKey: bytesFromJson(src.previousReceivingRatchetPublicKey),
    previousReceivingChainLength: num(src.previousReceivingChainLength, 0),
    previousReceivingSkippedKeys: keysFromJson(src.previousReceivingSkippedKeys, MAX_PREVIOUS_RECEIVING_KEYS),
    // Defaulted to now rather than to zero. Zero is the epoch, so a state written before `createdAt`
    // existed read as fifty-six years old and `evictStaleSessions` deleted every session on the account on
    // its first daily tick. A store cannot know when a session really started; pretending it was just
    // created is the one answer that costs nothing.
    createdAt: num(src.createdAt, Date.now()),
    lastActivity: num(src.lastActivity, Date.now()),
    transcriptHash,
    remoteIdentityKey,
  };

  return {
    sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : id,
    state,
    version: SESSION_STATE_VERSION,
    protocolVersion: num(entry.protocolVersion, PROTOCOL_VERSION),
  };
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private encryptionKey: CryptoKey | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * The account this manager's store belongs to, which is what the storage keys are namespaced by.
   *
   * Empty means the bare legacy key, which is only ever true for a manager built outside the app - a
   * test, or `startRatchet` being given an empty id. See `storageKey`.
   */
  private accountId = '';

  /** Resolved storage keys for `accountId`. Set in `init`, read everywhere else. */
  private sessionsKey: string = KEY_PREFIX.sessions;
  private sessionsSaltKey: string = KEY_PREFIX.sessionsSalt;

  /**
   * Bumped whenever this manager stops being the manager it was.
   *
   * `destroy()` can only cancel what is still sitting in a timer. It cannot reach a promise that has already
   * passed its first `await`, and both `doSave` and `loadEncrypted` do exactly that: the encryption or
   * decryption is in flight while `destroy()` runs, and the continuation then carries on against whatever
   * the object has become by the time it resumes.
   *
   * That is not merely untidy, and in one direction it is this file's own code doing the damage. A `doSave`
   * that resumes after `destroy()` has cleared the key takes the fail-closed path and **deletes** the store -
   * and by then the store belongs to whatever comes next. In a test suite sharing one mocked `localStorage`
   * that is the following test's data, quietly removed by the previous test's pending write. In the app it is
   * the next account's, or a fresh install's.
   *
   * So each asynchronous read and write records the generation it began in and touches nothing if it has
   * moved on. That makes the failure impossible rather than unlikely, which is the difference between a
   * hygiene measure and a fix.
   */
  private generation = 0;

  /**
   * Bumped every time a message is sealed, so a decrypt that started earlier can tell.
   *
   * `decryptMessage` works on a copy of the state and adopts it only once the plaintext is in hand, which
   * is what keeps a forged or withheld body from moving the session. But the copy is taken before two
   * `await`s - the key import and the AEAD - and in that window another send can run: the device fan-out
   * seals one body per device, and those are concurrent.
   *
   * Adopting the whole copy would then rewind the *sending* side to where it was before the decrypt began:
   * the chain key would move back, the counter with it, and the next send would emit a number already used.
   * Two different ciphertexts under the same message key, and a duplicate number on the wire. The receiving
   * half of the copy is always correct to adopt - that is the whole point of the draft - so only the
   * sending half is withheld, and only when something has actually moved it.
   *
   * Held here rather than on the state because it says nothing about the protocol and has no business being
   * written to disk: a fresh manager starts at zero with nothing in flight, which is exactly right.
   */
  private readonly sendEpoch = new Map<string, number>();

  /**
   * One decryption at a time per session, and this is what enforces it.
   *
   * A tail of promises, one per session id, each entry replaced by the next caller to arrive. Held here
   * rather than on the state because it is a property of the *manager*: two different sessions are
   * genuinely independent and are not serialised against each other, which is what keeps the device
   * fan-out - one body per device, all in flight at once - as fast as it was.
   *
   * ## What it protects, and why `sendEpoch` is not enough on its own
   *
   * `decryptMessage` clones the state, awaits twice, and adopts. Two decrypts of one session that clone the
   * same state and advance it by different amounts both believe they are right, and the last to finish wins -
   * which may be the one that advanced *less*. Concretely, with messages n..n+2 decrypted concurrently from a
   * live `receivingMessageNumber = n`: all three drafts clone at n, the drafts for n+1 and n+2 each put
   * `skippedMessageKeys[n] = k_n` in their own copy, and the last adopter lands at `receivingMessageNumber =
   * n+2`. `k_n` was already opened and is now live in the skipped map, so the
   * `messageNumber < receivingMessageNumber` branch of `advanceReceivingChain` hands it out again - and the
   * associated data is byte-identical, because it is the *same* message number and ratchet key. The body
   * authenticates. A server that captured it inside a concurrent batch can replay it under a fresh message
   * id indefinitely and it renders as new. That is the replay window the README's claim at lines 107-111 is
   * about, and the per-call transactional property does not close it: both decrypts *succeed*.
   *
   * The same interleaving also clobbers `previousSendingRatchetPublicKey` with `null` when the winning draft
   * did not step, stranding every message still travelling on the sending chain this side has stepped off -
   * the exact failure `previousSendingSkippedKeys` exists to prevent. Then `save()` persists the rolled-back
   * state.
   *
   * `sendEpoch` guards the *sending* half against this same class of race and says nothing about that one: it
   * is incremented by `encryptMessage` and never by another decrypt, so two concurrent decrypts leave it
   * untouched and both still adopt whole. It is kept, because it is what protects a decrypt against a
   * concurrent *send* - which this lock deliberately does not cover, because the fan-out relies on sends
   * being concurrent.
   *
   * Entries are removed as the chain drains so the map does not grow with conversations over the life of the
   * tab, and a failed or rejected decrypt releases its own slot on the way out.
   */
  private decryptTails = new Map<string, Promise<unknown>>();

  /** Runs `fn` holding exclusive access to one session's clone-and-adopt window. */
  private async withSessionDecryptLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.decryptTails.get(sessionId) ?? Promise.resolve();
    // A gate the next caller waits on, resolved when this one finishes. Built by hand rather than with
    // `.finally` so a `fn` that throws still releases the next caller instead of wedging the queue.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate, () => gate);
    this.decryptTails.set(sessionId, tail);

    try {
      // A predecessor that threw must not stop this one running: the queue is about ordering, not success.
      await previous.catch(() => {});
      return await fn();
    } finally {
      release();
      // Only the tail that is still current may be dropped. If somebody arrived while `fn` ran, the entry is
      // theirs now, and deleting it would let a third caller run alongside them.
      if (this.decryptTails.get(sessionId) === tail) this.decryptTails.delete(sessionId);
    }
  }

  constructor() {}

  async init(password: string, accountId?: string): Promise<void> {
    // Anything in flight belongs to the previous life of this object and stops being valid here. Taken as a
    // number rather than as `this.generation++` because the awaits below have to be checked against *this*
    // call: without that, an `init()` that is destroyed midway goes on to assign a key and read a store,
    // resurrecting a manager that was explicitly torn down.
    const generation = this.generation + 1;
    this.generation = generation;
    // Resolved before anything is read or written, so there is no window in which this manager reads one
    // account's storage and writes another's.
    this.accountId = accountId ?? '';
    this.sessionsKey = storageKey(KEY_PREFIX.sessions, this.accountId);
    this.sessionsSaltKey = storageKey(KEY_PREFIX.sessionsSalt, this.accountId);
    const salt = new Uint8Array(16);
    const saltB64 = localStorage.getItem(this.sessionsSaltKey);
    if (saltB64) {
      salt.set(new Uint8Array(base64ToBuf(saltB64)));
    } else {
      crypto.getRandomValues(salt);
      localStorage.setItem(this.sessionsSaltKey, bufToBase64(salt.buffer));
    }
    // The password as bytes, cleared as soon as the import has it. `secureStore.ts` clears its identical
    // buffer and this did not, which makes the omission a difference between two copies of one habit rather
    // than a decision. It cannot rescue a password still held in a `string` - see ./wipe - but it does stop
    // a second copy sitting in the heap for the life of the tab.
    const passwordBytes = new TextEncoder().encode(password);
    let passKey: CryptoKey;
    try {
      passKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    } finally {
      wipe(passwordBytes);
    }
    // PBKDF2 at six hundred thousand iterations takes long enough for a `destroy()` to land in the middle of
    // it. Checking here stops a torn-down manager being handed a key again, which is what would otherwise let
    // the load below populate it.
    if (generation !== this.generation) return;
    this.encryptionKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    if (generation !== this.generation) return;
    await this.loadEncrypted();
  }

  private async loadEncrypted(): Promise<void> {
    const generation = this.generation;
    try {
      const raw = localStorage.getItem(this.sessionsKey);
      if (!raw || !this.encryptionKey) return;
      const envelope = JSON.parse(raw) as { iv?: unknown; data?: unknown };
      // Anything that is not an encrypted envelope is a store written by a build that fell back to
      // plaintext, and it is holding every conversation's chain key unencrypted. It cannot be opened - it
      // has no ciphertext - so there is nothing to salvage, and leaving it in place would mean a key that
      // outlives the fix by however long nobody opens this app. Deleted on sight.
      if (typeof envelope?.iv !== 'string' || typeof envelope?.data !== 'string') {
        console.warn('[signal] found an unencrypted session store; removing it');
        localStorage.removeItem(this.sessionsKey);
        return;
      }
      const { iv, data } = envelope;
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(iv)) },
        this.encryptionKey, base64ToBuf(data)
      );
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(new TextDecoder().decode(plaintext));
      } finally {
        // Decrypted ratchet state for every conversation. The parsed object is a string copy by now and
        // cannot be cleared, so this is not the end of it - but it is the part that would otherwise sit in
        // the heap for the life of the tab. See ./wipe.
        wipe(plaintext);
      }
      let dropped = 0;
      // Same guard as the write: this read began under one identity and must not populate another.
      if (generation !== this.generation) return;
      for (const [id, entry] of Object.entries(parsed)) {
        const session = sessionFromJson(id, entry);
        if (session) this.sessions.set(id, session);
        else dropped++;
      }
      // Two different failures are handled here, and they are not the same decision.
      //
      // A session stored before the header was bound into the ciphertext has no transcript, and no
      // transcript means nothing new can be encrypted against it: the associated data would not match on
      // the far side. Such a session is finished by definition - the peer is a version behind - so the
      // next message starts a fresh handshake. Anything else `sessionFromJson` refused was unreadable
      // rather than old, and it leaves the sessions that did load completely alone.
      if (dropped > 0) this.save();
    } catch {
      // Two failures look identical here and must not be given the same answer: a truncated write, and a key
      // that no longer opens this blob. A single bad *entry* inside a readable store is dealt with per session
      // above, because discarding every conversation on the account to dispose of one of them is the worst
      // answer available - and a lost session cannot be recovered by construction, since that is exactly what
      // forward secrecy means.
      //
      // The deletion is therefore conditional on there being nothing to protect. This manager holds no
      // sessions when the load failed, which used to make it unconditional and therefore catastrophic: with
      // one un-namespaced store per browser profile, a second account signing in derived a key from *its*
      // password, failed to decrypt the first account's store, and deleted every conversation the first
      // account had on this device - including anything it had sent but not yet opened, which is
      // permanently undecryptable once its chain key is gone.
      //
      // Left in place it is inert: it is ciphertext under a key that does not exist for this account, it
      // cannot be opened by anything, and the namespacing means the rightful owner reads it again on their
      // next sign-in. Unreadable is not the same as dangerous.
      if (this.sessions.size === 0) localStorage.removeItem(this.sessionsKey);
    }
  }

  /**
   * One write at a time.
   *
   * Chain advances save immediately rather than on a timer, which means two sends in flight can both reach
   * `doSave`. Without this they would encrypt the same store concurrently and race to `setItem`, and the
   * *older* snapshot could land last - which is a session rolling backwards by exactly the margin between
   * the two calls. Cheap to prevent: the second caller waits for the first and then writes the state as it
   * is at that point, which is the newer one.
   */
  private saveTail: Promise<void> = Promise.resolve();

  /** The debounced write. For touches that lose nothing if the tab goes first. */
  save(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => { void this.doSave(); }, 500);
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
    // Invalidates the promise chain rather than the timers. See `generation`.
    this.generation++;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    // the cleanup sweep as well. It used to survive, and `startCleanupTimer` returns early when a timer is
    // already set, so a manager that was destroyed and then re-initialised kept the *old* interval running
    // against the new state for the life of the page.
    this.stopCleanupTimer();
    this.sessions.clear();
    this.sendEpoch.clear();
    // Queued decrypts belong to the previous life of this manager. Dropped rather than drained: the callers
    // waiting on them get their rejection from `getSession` returning nothing, which is the truth.
    this.decryptTails.clear();
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
    const SALT = this.sessionsSaltKey;
    const STORE = this.sessionsKey;
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // Snapshot first, commit the salt last, and put everything back if any step fails. See the note in the
    // prekey manager's `rekey`, which has the same ordering hazard with worse consequences: a new salt over
    // a blob sealed under the old key means the next launch cannot derive the key that opens it.
    const oldSalt = localStorage.getItem(SALT);
    const oldValue = localStorage.getItem(STORE);
    const previousKey = this.encryptionKey;

    try {
      const passwordBytes = new TextEncoder().encode(newPassword);
      let passKey: CryptoKey;
      try {
        passKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
      } finally {
        // Same reason as in `init`: the bytes stop being needed the moment the key exists.
        wipe(passwordBytes);
      }
      const newKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
        passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      this.encryptionKey = newKey;
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      await this.doSave();

      // Read it back by decrypting, not by looking at the shape. `doSave` swallows a write failure of its own
      // accord, and the *old* ciphertext has exactly the same `{ iv, data }` shape as the new one - so a
      // shape check would pass on a store that was never rewritten, and the salt would then move out from
      // under data it no longer opens.
      const written = localStorage.getItem(STORE);
      if (written === null) throw new Error('the rewrapped session store was not written at all');
      const envelope = JSON.parse(written) as { iv?: unknown; data?: unknown };
      if (typeof envelope?.iv !== 'string' || typeof envelope?.data !== 'string') {
        throw new Error('the rewrapped session store is not an envelope');
      }
      const roundTrip = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(envelope.iv)) },
        this.encryptionKey, base64ToBuf(envelope.data)
      );
      JSON.parse(new TextDecoder().decode(roundTrip));

      localStorage.setItem(SALT, bufToBase64(salt.buffer as ArrayBuffer));
    } catch (e) {
      this.encryptionKey = previousKey;
      if (oldValue === null) localStorage.removeItem(STORE);
      else localStorage.setItem(STORE, oldValue);
      if (oldSalt === null) localStorage.removeItem(SALT);
      else localStorage.setItem(SALT, oldSalt);
      throw e;
    }
  }

  /**
   * The store this manager would write, as `[key, value]` pairs, or null for a key that is absent.
   *
   * Exposed for `rekeySignalState`, which has to treat the two stores as one transaction: a manager's own
   * `rekey` rolls *its* half back if *it* fails, which says nothing about the other half having already
   * committed. Without a way to read both sets of bytes out, "roll both back" is not expressible.
   */
  storageSnapshot(): [string, string | null][] {
    return [
      [this.sessionsSaltKey, localStorage.getItem(this.sessionsSaltKey)],
      [this.sessionsKey, localStorage.getItem(this.sessionsKey)],
    ];
  }

  /** Puts back a `storageSnapshot`, key by key, including removing keys that were not there. */
  restoreStorage(snapshot: [string, string | null][]): void {
    for (const [key, value] of snapshot) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }

  /**
   * Whether a write failed because storage was full rather than for any other reason.
   *
   * Only a quota error is worth responding to by making the state smaller; every other failure means the
   * write did not happen for a reason pruning cannot fix, and retrying it would just fail again.
   */
  private isQuotaError(e: unknown): boolean {
    if (!e || typeof e !== 'object') return false;
    const err = e as { name?: unknown; code?: unknown };
    // Firefox and older WebKit report the DOM code rather than the name.
    return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || err.code === 22 || err.code === 1014;
  }

  /**
   * Throws away the oldest retained message keys, hardest-hit map first.
   *
   * The maps are ordered by what they cost to lose. `previousSendingSkippedKeys` and
   * `previousReceivingSkippedKeys` cover chains already stepped off, so their keys can only open a message
   * that is late by more than a ratchet step - and `skippedMessageKeys` covers the chain in use, where the
   * same key may still be needed by something a few seconds behind. So the previous-chain maps go first
   * and the live one only if the quota is still not satisfied.
   *
   * Everything a lost key would have opened is still readable through the stateless envelope copy of the
   * same message, which is what `sealForDevices` falls back to. What is *not* recoverable is the chain key
   * itself, so the alternative to dropping these is dropping the save.
   */
  private pruneForQuota(): void {
    for (const session of this.sessions.values()) {
      // Oldest half of each, by insertion order, which is message-number order.
      this.halveMap(session.state.previousSendingSkippedKeys);
      this.halveMap(session.state.previousReceivingSkippedKeys);
      this.halveMap(session.state.skippedMessageKeys);
    }
  }

  private doSave(): Promise<void> {
    const run = this.saveTail.then(() => this.writeOnce(), () => this.writeOnce());
    // The tail swallows its own outcome: a failed write must not reject the next caller's chain.
    this.saveTail = run.catch(() => {});
    return run;
  }

  /** One queued save: the body that actually decides whether anything reaches storage. */
  private async writeOnce(): Promise<void> {
    const generation = this.generation;
    try {
      try {
        await this.writeStore(generation);
      } catch (e) {
        // A failed save here is not a small thing to log and move past.
        //
        // Everything sent since the last good write is undecryptable by construction once this tab goes:
        // its chain key was derived from a key that no longer exists anywhere, and a ratchet is a one-way
        // door. `openOne` answers a body it cannot open by resetting the session, so the next launch does
        // not merely fail to read those messages, it throws the conversation away.
        //
        // The realistic cause is size. Every key is ~135 bytes of JSON, the whole account is one blob, and
        // `localStorage` is 5-10 MB, so the honest response to a quota error is to make the blob smaller -
        // not to keep writing something that will not fit.
        if (!this.isQuotaError(e)) throw e;
        this.pruneForQuota();
        // One retry. If this also fails there is nothing more to give up except sessions themselves, and
        // dropping those would convert a storage problem into a destroyed conversation.
        await this.writeStore(generation);
      }
    } catch (e) {
      console.error('[signal] failed to persist sessions:', e);
    }
  }

  /** One attempt at writing the whole store. Throws, rather than swallowing, so the caller can decide. */
  private async writeStore(generation: number): Promise<void> {
    const obj: Record<string, unknown> = {};
    for (const [id, session] of this.sessions) obj[id] = sessionToJson(session);
    const json = JSON.stringify(obj);
    if (!this.encryptionKey) {
        // Refused rather than written in the clear. This used to fall through to
        // `localStorage.setItem(SESSIONS_KEY, json)`, which would have put every conversation's chain key,
        // root key and message counter on disk unencrypted.
        //
        // It was not reachable as the code stood: `destroy()` drops the key and empties `this.sessions` in
        // one synchronous block, and it cancels the pending write, so there was never a moment with key
        // absent and state present. What made it worth changing is how close it is. Clearing only the key,
        // or calling `initialize()` before `init()` - both one line away, and the prekey manager really does
        // expose that second shape - turns a ratchet dump onto disk with no passcode in front of it. Losing
        // the persisted sessions is a conversation that starts over; publishing the keys that open them is
        // not a trade worth naming. Cheap to refuse, and it refuses on the failure nobody thought about.
        //
        // Scoped to this account's own key, for the same reason the load is: an unconditional delete here
        // would remove whichever store this namespace names, and a manager that was never initialised has
        // no claim on any of them.
        localStorage.removeItem(this.sessionsKey);
        return;
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // Every chain key and root key for every conversation, in one buffer, encoded to encrypt it. Cleared as
      // soon as the encryption is done - see ./wipe for what that does and does not achieve. The string
      // `json` is a copy that cannot be cleared at all, which is exactly why this is hygiene and not a
      // boundary, and why nothing in the crypto may rely on it.
      const encoded = new TextEncoder().encode(json);
      let ciphertext: ArrayBuffer;
      try {
        ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.encryptionKey, encoded);
      } finally {
        wipe(encoded);
      }
      // Destroyed, or re-initialised, while the encryption was in flight. Whoever is here now did not ask
      // for these sessions and must not have them written over its own.
      if (generation !== this.generation) return;
      localStorage.setItem(this.sessionsKey, JSON.stringify({
        iv: bufToBase64(iv.buffer), data: bufToBase64(ciphertext)
      }));
  }

  /**
   * Makes room by giving up the least useful retained message keys.
   *
   * See `pruneForQuota` for which keys go and why. Deliberately does *not* drop sessions: the ceiling on
   * `MAX_SESSIONS` is the only thing here that is allowed to end a conversation, and that is a deliberate
   * policy decision rather than the side effect of a storage error.
   */
  private evictOldestSession(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    // By `lastActivity`, not by insertion order.
    //
    // Insertion order is meaningless here. Before a reload it happens to be creation order, but after one
    // it is `Object.entries` order of the persisted blob - which is whatever order the JSON keys came out
    // in, unrelated to when the conversation was last used. So the 200-session ceiling evicted an arbitrary
    // conversation, frequently one in daily use, and its chain keys went with it: every message it had sent
    // and not yet had opened became permanently unreadable. The field that actually says how much a session
    // matters is `lastActivity`, and it is maintained for exactly this sort of decision.
    let oldestKey: string | null = null;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [id, session] of this.sessions) {
      const activity = session.state.lastActivity || 0;
      if (activity < oldestActivity) {
        oldestActivity = activity;
        oldestKey = id;
      }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }

/**
 * The name a conversation is filed under, from both ends.
 *
 * A naive `sort().join(':')` would be ambiguous for ids that contain a colon: `a:b` + `c` and `a` + `b:c`
 * both give `a:b:c`. That cannot happen here - account ids are server-generated UUIDs - and the separator is
 * left alone deliberately: the string is also the key sessions are persisted under on every device, so
 * changing it would orphan every existing session and force a fresh handshake for every conversation in
 * the install, to defend against ids that the server does not generate. If ids ever stop being UUIDs, fix
 * the id format rather than this function.
 */
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
    // `derived` and `sharedSecret` are the whole session secret before it is split; the two halves below are
    // independent copies and stay alive in the session state, so these are not the only ones. Still worth
    // clearing: these two are the ones that would sit in the heap untouched for the life of the tab.
    // See ./wipe for why this is hygiene and not a guarantee.
    wipeAll([derived, sharedSecret]);

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
    // As in the initiator: these are the pre-split values, and the halves taken above are copies that go on
    // living in the session. See ./wipe for what clearing does and does not buy.
    wipeAll([derived, sharedSecret]);

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

  /**
 * Seals one message, and reports the header the far end needs to open it.
 *
 * The number and the ratchet key come back from here rather than being read off the session afterwards.
 * That is not a style preference: `encryptWithSignal` used to send
 * `session.state.sendingMessageNumber - 1`, which it computed itself one or more microtask turns after this
 * returned. Anything that moved the counter in between - and the cleanup timer does exactly that, when it
 * decides a session is due a rekey - made the number on the wire disagree with the number inside the
 * ciphertext's associated data. The receiver then refuses the body as out of order and the conversation
 * resets. Two concurrent sends, which is what the device fan-out does, could also report each other's
 * number. Both ends of the header are decided here, at the same moment as the key they belong to.
 */
async encryptMessage(
    sessionId: string,
    plaintext: string
  ): Promise<{ ciphertext: Uint8Array; messageNumber: number; ratchetPublicKey: Uint8Array }> {
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
    // a decrypt that opened a draft before this point must not roll the chain back over it
    const epoch = (this.sendEpoch.get(sessionId) ?? 0) + 1;
    this.sendEpoch.set(sessionId, epoch);

    // Captured before the first await, and put back if the seal fails: the chain key has already moved, so
    // a failure here would otherwise leave a permanent hole in the sending chain. The receiver would hold
    // the missing number as a skipped key and the message would simply be lost, with nothing to show for
    // it. The receive side goes to some lengths to avoid exactly this.
    const restore = {
      sendingChainKey: session.state.sendingChainKey,
      sendingMessageNumber: session.state.sendingMessageNumber,
      sentMessageKeys: session.state.sentMessageKeys,
    };

    let ivBytes: Uint8Array;
    let encrypted: ArrayBuffer;
    try {
      ivBytes = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const cryptoKey = await importAesKey(messageKey);
      encrypted = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: ivBytes as unknown as BufferSource,
          additionalData: buildHeader(session.state.transcriptHash, ratchetPublicKey, messageNumber),
        },
        cryptoKey,
        new TextEncoder().encode(plaintext)
      );
    } catch (e) {
      // Only if nothing has moved the chain on since. Two sends can be in flight on one session - the device
      // fan-out does exactly that - and the restore is unconditional, so a failing send whose seal rejects
      // *after* another send has already advanced to the next number would wind the chain back over it: the
      // next send would derive mk(n+1) a second time, and two different plaintexts would be sealed under
      // one message key. With a 96-bit random IV that is a nonce-reuse exposure in a stream-cipher mode, not
      // merely a duplicated counter.
      //
      // So the snapshot is put back only while it is still the newest thing to have happened. Otherwise the
      // chain has moved on and the right answer is to leave it alone: this send never produced a body, so
      // its number is a gap the receiver will hold a skipped key for, which is exactly what the skipped-key
      // map is for. A hole in the chain costs one lost message; a rewound chain costs two messages under one
      // key.
      if ((this.sendEpoch.get(sessionId) ?? 0) === epoch) {
        session.state.sendingChainKey = restore.sendingChainKey;
        session.state.sendingMessageNumber = restore.sendingMessageNumber;
        session.state.sentMessageKeys = restore.sentMessageKeys;
      }
      throw e;
    }

    // Immediate, for the same reason the decrypt side is: the sending chain has just consumed a key, and if
    // this tab dies before the debounce fires that key is gone for good while the message it just sealed
    // exists on a server waiting to be opened. Nothing here is a `lastActivity`-style touch that loses
    // nothing if it does not land.
    await this.doSave();
    const result = new Uint8Array(2 + ivBytes.length + encrypted.byteLength);
    result[0] = BODY_HEADER_BOUND;
    result[1] = ivBytes.length;
    result.set(ivBytes, 2);
    result.set(new Uint8Array(encrypted), 2 + ivBytes.length);
    return { ciphertext: result, messageNumber, ratchetPublicKey };
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
    // Taken *here*, before the lock is taken rather than inside it, and that placement is load-bearing.
    // `withSessionDecryptLock` awaits its predecessor even when there is none, so `fn` starts a microtask
    // later than this call returns: a send issued in between has already advanced the epoch by the time the
    // snapshot below would be read, the snapshot would match, and the draft would be adopted whole - rolling
    // the sending chain back over the message that had just gone out. `ratchetStep` sets
    // `sendingMessageNumber = 0`, so that rewind is not a small one: the next send derives `mk(n)` a second
    // time and seals a second plaintext under the key the first one already used.
    const epochAtStart = this.sendEpoch.get(sessionId) ?? 0;

    // One at a time per session. This is not an optimisation for the single-message case: the window
    // between the clone and the adoption is where two *successful* decrypts undo each other's work, and it
    // is the ordinary path rather than a corner of it. `App.tsx` decrypts a whole page of history with
    // `Promise.all(messages.map(...))`, so every entry of a page hits one session concurrently, and
    // `ws.onmessage` is `async`, so two back-to-back frames interleave at their first `await`. See
    // `withSessionDecryptLock` for the full account of what goes wrong without it.
    return this.withSessionDecryptLock(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error('No session');
      if (!Number.isInteger(messageNumber) || messageNumber < 0) throw new Error('Bad message number');
      if (!ratchetPublicKey || ratchetPublicKey.length === 0) throw new Error('Bad ratchet key');

      // Cloned here, after the lock, but the epoch above was taken before it: a send that lands while this
      // decrypt waits for its turn is inside the window and must not be rolled back.
      const draft = cloneSessionState(session.state);

      // Two "chains this side has already stepped off", checked in this order and both before anything moves.
      //
      // The first is the sending chain: a body naming it was sealed before a step this side performed, and is
      // still in transit. The second is the receiving chain, whose keys are the ones a step used to clear:
      // a peer that got ahead and then ratcheted would otherwise leave its own earlier messages permanently
      // unreadable, and `openOne` answers an unreadable body by resetting the session. Taking both before
      // stepping matters - a step overwrites the windows it is leaving.
      const fromPreviousChain = takePreviousChainKey(draft, ratchetPublicKey, messageNumber);
      const fromPreviousReceivingChain = fromPreviousChain
        ? null
        : takePreviousReceivingKey(draft, ratchetPublicKey, messageNumber);

      let messageKey: Uint8Array | null = fromPreviousChain ?? fromPreviousReceivingChain;
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

      this.adoptDecryptedState(sessionId, session.state, draft, epochAtStart);
      // Written out immediately rather than debounced. A chain advanced here is gone the moment this tab
      // goes, and `flush()` - which the page-exit handlers call - only cancels the timer and fires a promise
      // that a `window.close()` or an OS kill will not wait for. The blur handlers are what make the debounce
      // survivable most of the time, and "most of the time" is a crash or a power cut away from losing every
      // message sent since the last good write.
      await this.doSave();
      return new TextDecoder().decode(decrypted);
    });
  }

  /**
   * Takes the decrypted draft, but leaves the sending half alone if a message went out while it was opening.
   *
   * Everything the draft changed on the receiving side is adopted unconditionally. On the sending side the
   * two cases differ: nothing was sent while the decrypt was in flight, so the draft is the newer truth and
   * is adopted whole; or something was, in which case the live values are further along than the draft and
   * copying the draft over them would rewind the chain.
   */
  private adoptDecryptedState(
    sessionId: string,
    live: SessionState,
    draft: SessionState,
    epochAtStart: number
  ): void {
    if ((this.sendEpoch.get(sessionId) ?? 0) === epochAtStart) {
      Object.assign(live, draft);
      return;
    }
    live.rootKey = draft.rootKey;
    live.receivingChainKey = draft.receivingChainKey;
    live.receivingRatchetPublicKey = draft.receivingRatchetPublicKey;
    live.receivingMessageNumber = draft.receivingMessageNumber;
    live.skippedMessageKeys = draft.skippedMessageKeys;
    // the keys still travelling on the chain this side is sending on, which the step below moved across
    live.previousSendingRatchetPublicKey = draft.previousSendingRatchetPublicKey;
    live.previousSendingChainLength = draft.previousSendingChainLength;
    live.previousSendingSkippedKeys = draft.previousSendingSkippedKeys;
    // and the receiving-side window, for the same reason: the receiving chain key above is the draft's, so
    // leaving the old window behind would pair a new chain with the keys of the one just left
    live.previousReceivingRatchetPublicKey = draft.previousReceivingRatchetPublicKey;
    live.previousReceivingChainLength = draft.previousReceivingChainLength;
    live.previousReceivingSkippedKeys = draft.previousReceivingSkippedKeys;
  }

deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    // a fresh handshake on the same pair starts from nothing, and so does its send history
    this.sendEpoch.delete(sessionId);
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
   * Drops the oldest half of a message-key map, oldest meaning furthest behind the counter.
   *
   * Insertion order is message-number order for all three maps, so the first entries are the ones furthest
   * from where the chain is now.
   */
  private halveMap(map: Map<number, Uint8Array>): void {
    const drop = Math.floor(map.size / 2);
    for (let i = 0; i < drop; i++) {
      const oldest = map.keys().next().value;
      if (oldest == null) break;
      map.delete(oldest);
    }
  }

  /**
   * Re-derives the sending chain after a long silence.
   *
   * The *receiving* counters are deliberately left alone. Zeroing the receiving number hands back every
   * message key already spent on this chain, so a body captured months ago would decrypt again the moment
   * the counter was rewound - the one thing a ratchet must never allow. The sending chain moves on and the
   * receiving chain is untouched, which is what "the conversation was idle" should mean.
   *
   * What the old chain's spent keys are doing has to move with it, though. The rekey rewinds the sending
   * counter to zero while leaving `sentMessageKeys` where it was, so the very next message overwrites index
   * zero and indices one to n still hold keys from a chain that is now gone. When the peer finally answers
   * with a new key, `ratchetStep` takes that map wholesale as the window of keys that can still open a
   * message in transit - under the *new* ratchet key, which is not the one those messages were sealed
   * against, so the header will not match and the genuine pre-rekey messages become unreadable. That is
   * the exact failure the window exists to prevent, so the keys are handed over as the previous chain
   * before the counter moves, exactly as a step would.
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

      // the chain being left behind, and the keys already sent on it that may still be in transit
      if (session.state.sentMessageKeys.size > 0) {
        session.state.previousSendingRatchetPublicKey = session.state.currentRatchetPublicKey
          ? session.state.currentRatchetPublicKey.slice()
          : null;
        session.state.previousSendingChainLength = session.state.sendingMessageNumber;
        session.state.previousSendingSkippedKeys = session.state.sentMessageKeys;
      }

      session.state.rootKey = newRootKey;
      session.state.sendingChainKey = newSendingChain;
      session.state.sendingRatchetKey = ratchetKeyPair;
      session.state.currentRatchetPublicKey = ratchetKeyPair.publicKey;
      session.state.sentMessageKeys = new Map();
      session.state.sendingMessageNumber = 0;
      session.state.lastActivity = Date.now();
      // whatever was in flight is now under the old key, and this send history is a fresh chain's
      this.sendEpoch.set(sessionId, (this.sendEpoch.get(sessionId) ?? 0) + 1);

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
