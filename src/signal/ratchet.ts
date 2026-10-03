import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPair, SessionState } from './types';
import { MAX_SKIP, MAX_SKIPPED_MESSAGE_KEYS, MAX_SESSIONS } from './constants';

const INFO_ROOT = new TextEncoder().encode('WhisperNetRoot');

/**
 * The header a message key is bound to.
 *
 * Encrypting with the message key alone leaves the header unauthenticated, and the header is what says
 * which chain and which position on it a ciphertext belongs to. Without this in the AEAD's associated
 * data a server can hand the same body back under a different ratchet key or a different message
 * number, and the receiving side has no way to notice: the ciphertext still opens. Binding the
 * transcript and the header means a substituted header fails to authenticate and is discarded.
 *
 * The framing is length-prefixed throughout, so no two distinct headers can produce the same bytes.
 */
export const HEADER_INFO = new TextEncoder().encode('WhisperNetRatchetHeader');

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

function lengthPrefixed(...parts: (Uint8Array | null | undefined)[]): Uint8Array<ArrayBuffer> {
  const present = parts.filter((p): p is Uint8Array => !!p);
  let total = 0;
  for (const p of present) total += 4 + p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of present) {
    out.set(u32(p.length), at);
    at += 4;
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function buildHeader(transcriptHash: Uint8Array, ratchetPublicKey: Uint8Array, messageNumber: number): Uint8Array<ArrayBuffer> {
  const num = new Uint8Array(4);
  new DataView(num.buffer).setUint32(0, messageNumber >>> 0, false);
  return new Uint8Array([
    ...HEADER_INFO,
    ...lengthPrefixed(transcriptHash, ratchetPublicKey),
    ...num,
  ]);
}

export function createRatchetState(): SessionState {
  return {
    version: 3,
    registrationId: 0,
    currentRatchetPublicKey: null,
    rootKey: new Uint8Array(32),
    sendingChainKey: null,
    receivingChainKey: null,
    sendingRatchetKey: null,
    receivingRatchetPublicKey: null,
    previousSendingChainLength: 0,
    sendingMessageNumber: 0,
    receivingMessageNumber: 0,
    skippedMessageKeys: new Map(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    // a fresh state has no transcript, so it can only be used once one has been bound; see bindTranscript
    transcriptHash: null,
    remoteIdentityKey: null,
    previousSendingRatchetPublicKey: null,
    previousSendingSkippedKeys: new Map(),
    sentMessageKeys: new Map(),
  };
}

/**
 * A copy of the state, deep enough that nothing a failed decryption touched survives it.
 *
 * Advancing a chain is destructive: the chain key moves on and the spent message keys are dropped. A
 * server that hands over a body which does not authenticate must not be able to leave the session
 * rewound or advanced past a message nobody ever read, so the work is done on a copy and only adopted
 * once the plaintext is in hand.
 */
export function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    rootKey: state.rootKey.slice(),
    sendingChainKey: state.sendingChainKey ? state.sendingChainKey.slice() : null,
    receivingChainKey: state.receivingChainKey ? state.receivingChainKey.slice() : null,
    sendingRatchetKey: state.sendingRatchetKey
      ? { privateKey: state.sendingRatchetKey.privateKey.slice(), publicKey: state.sendingRatchetKey.publicKey.slice() }
      : null,
    currentRatchetPublicKey: state.currentRatchetPublicKey ? state.currentRatchetPublicKey.slice() : null,
    receivingRatchetPublicKey: state.receivingRatchetPublicKey ? state.receivingRatchetPublicKey.slice() : null,
    transcriptHash: state.transcriptHash ? state.transcriptHash.slice() : null,
    remoteIdentityKey: state.remoteIdentityKey ? state.remoteIdentityKey.slice() : null,
    previousSendingRatchetPublicKey: state.previousSendingRatchetPublicKey
      ? state.previousSendingRatchetPublicKey.slice()
      : null,
    skippedMessageKeys: new Map(
      [...state.skippedMessageKeys.entries()].map(([n, k]) => [n, k.slice()])
    ),
    previousSendingSkippedKeys: new Map(
      [...state.previousSendingSkippedKeys.entries()].map(([n, k]) => [n, k.slice()])
    ),
    sentMessageKeys: new Map(
      [...state.sentMessageKeys.entries()].map(([n, k]) => [n, k.slice()])
    ),
  };
}

/**
 * How many of this chain's message keys are held.
 *
 * A ratchet step can abandon a chain with messages still travelling, and the specification holds a
 * window of them for exactly that. Beyond the window a message is treated as lost, which is the right
 * answer: the envelope copy of the same message is still readable, and holding ratchet state for every
 * message ever sent would be holding the keys that open them.
 */
export const MAX_SENT_KEYS_RETAINED = 2000;

/** Records the key used for a message on the chain currently being sent on. */
export function recordSentMessageKey(state: SessionState, messageNumber: number, messageKey: Uint8Array): void {
  state.sentMessageKeys.set(messageNumber, messageKey);
  if (state.sentMessageKeys.size > MAX_SENT_KEYS_RETAINED) {
    for (const n of state.sentMessageKeys.keys()) {
      if (state.sentMessageKeys.size <= MAX_SENT_KEYS_RETAINED) break;
      if (n < messageNumber - MAX_SENT_KEYS_RETAINED) state.sentMessageKeys.delete(n);
    }
    // a pathological chain key numbering could leave it over the ceiling; trim from the front
    while (state.sentMessageKeys.size > MAX_SENT_KEYS_RETAINED) {
      const oldest = state.sentMessageKeys.keys().next().value;
      if (oldest == null) break;
      state.sentMessageKeys.delete(oldest);
    }
  }
}

export function initializeRatchetAsSender(
  sharedSecret: Uint8Array,
  remoteRatchetPublicKey: Uint8Array
): { state: SessionState; chainKey: Uint8Array } {
  const ratchetKeyPair = generateRatchetKeyPair();

  const { rootKey, chainKey } = dhRatchet(
    sharedSecret,
    ratchetKeyPair.privateKey,
    remoteRatchetPublicKey
  );

  const state = createRatchetState();
  state.rootKey = rootKey;
  state.currentRatchetPublicKey = ratchetKeyPair.publicKey;
  state.sendingRatchetKey = ratchetKeyPair;
  state.receivingRatchetPublicKey = remoteRatchetPublicKey;
  state.sendingChainKey = chainKey;
  state.sendingMessageNumber = 0;

  return { state, chainKey };
}

export function initializeRatchetAsReceiver(
  sharedSecret: Uint8Array,
  remoteRatchetPublicKey: Uint8Array,
  ratchetKeyPair?: KeyPair
): { state: SessionState; chainKey: Uint8Array } {
  const kp = ratchetKeyPair || generateRatchetKeyPair();

  const { rootKey, chainKey } = dhRatchet(
    sharedSecret,
    kp.privateKey,
    remoteRatchetPublicKey
  );

  const state = createRatchetState();
  state.rootKey = rootKey;
  state.currentRatchetPublicKey = kp.publicKey;
  state.sendingRatchetKey = kp;
  state.receivingRatchetPublicKey = remoteRatchetPublicKey;
  state.receivingChainKey = chainKey;
  state.receivingMessageNumber = 0;

  return { state, chainKey };
}

export function advanceSendingChain(state: SessionState): Uint8Array {
  if (!state.sendingChainKey) throw new Error('No sending chain key');

  const { nextChainKey, messageKey } = chainKDF(state.sendingChainKey);

  state.sendingChainKey = nextChainKey;
  state.sendingMessageNumber++;

  return messageKey;
}

export function advanceReceivingChain(
  state: SessionState,
  messageNumber: number
): Uint8Array | null {
  if (!state.receivingChainKey) return null;

  if (messageNumber < state.receivingMessageNumber) {
    const key = state.skippedMessageKeys.get(messageNumber);
    if (key) state.skippedMessageKeys.delete(messageNumber);
    return key || null;
  }

  const skipCount = messageNumber - state.receivingMessageNumber;
  if (skipCount > MAX_SKIP) throw new Error('Too many skipped messages');

  while (state.receivingMessageNumber < messageNumber) {
    const { nextChainKey, messageKey } = chainKDF(state.receivingChainKey);
    state.skippedMessageKeys.set(state.receivingMessageNumber, messageKey);
    if (state.skippedMessageKeys.size > MAX_SKIPPED_MESSAGE_KEYS) {
      const oldestKey = state.skippedMessageKeys.keys().next().value;
      if (oldestKey != null) state.skippedMessageKeys.delete(oldestKey);
    }
    state.receivingChainKey = nextChainKey;
    state.receivingMessageNumber++;
  }

  const { nextChainKey, messageKey } = chainKDF(state.receivingChainKey);
  state.receivingChainKey = nextChainKey;
  state.receivingMessageNumber++;

  return messageKey;
}

/**
 * How many keys of the chain being stepped off are worth keeping.
 *
 * Bounded because they are held in memory: a hundred sessions each keeping this many would be a hundred
 * megabytes of ratchet state. A message delayed by more than this many others behind it is not worth
 * holding memory for, and the envelope copy of the same message is readable regardless.
 */
export function ratchetStep(
  state: SessionState,
  remoteRatchetPublicKey: Uint8Array
): Uint8Array {
  if (!state.sendingRatchetKey) throw new Error('No sending ratchet key');

  // What this side has already sent on the chain it is stepping off becomes the window of keys that can
  // still open a message in transit. Taken over whole rather than re-derived: the chain key has already
  // advanced past them, so there is nothing left to derive from.
  state.previousSendingChainLength = state.sendingMessageNumber;
  state.previousSendingSkippedKeys = state.sentMessageKeys;
  state.previousSendingRatchetPublicKey = state.currentRatchetPublicKey
    ? state.currentRatchetPublicKey.slice()
    : null;
  state.sentMessageKeys = new Map();

  state.sendingMessageNumber = 0;
  state.receivingMessageNumber = 0;
  state.skippedMessageKeys.clear();

  const { rootKey, chainKey } = dhRatchet(
    state.rootKey,
    state.sendingRatchetKey.privateKey,
    remoteRatchetPublicKey
  );

  state.rootKey = rootKey;
  state.receivingChainKey = chainKey;
  state.receivingRatchetPublicKey = remoteRatchetPublicKey;

  const newRatchetKeyPair = generateRatchetKeyPair();
  const { rootKey: newRootKey, chainKey: newSendingChain } = dhRatchet(
    state.rootKey,
    newRatchetKeyPair.privateKey,
    remoteRatchetPublicKey
  );

  state.rootKey = newRootKey;
  state.sendingChainKey = newSendingChain;
  state.currentRatchetPublicKey = newRatchetKeyPair.publicKey;
  state.sendingRatchetKey = newRatchetKeyPair;

  return chainKey;
}

/**
 * The message key for a body that belongs to the chain this side stepped off.
 *
 * Only handed out when the header names that chain, so it cannot be used to read anything from the chain
 * currently in use, and it is deleted on the way out so the same body cannot open twice.
 */
export function takePreviousChainKey(
  state: SessionState,
  ratchetPublicKey: Uint8Array,
  messageNumber: number
): Uint8Array | null {
  const previous = state.previousSendingRatchetPublicKey;
  if (!previous || messageNumber < 0 || messageNumber >= state.previousSendingChainLength) return null;
  if (previous.length !== ratchetPublicKey.length) return null;
  if (!previous.every((v, i) => v === ratchetPublicKey[i])) return null;
  const key = state.previousSendingSkippedKeys.get(messageNumber);
  if (!key) return null;
  state.previousSendingSkippedKeys.delete(messageNumber);
  return key;
}

export function dhRatchet(
  rootKey: Uint8Array,
  privateKey: Uint8Array,
  remotePublicKey: Uint8Array
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const dh = x25519.getSharedSecret(privateKey, remotePublicKey);
  const derived = hkdf(sha256, dh, rootKey, INFO_ROOT, 64);

  return {
    rootKey: derived.slice(0, 32),
    chainKey: derived.slice(32, 64),
  };
}

function chainKDF(chainKey: Uint8Array): { nextChainKey: Uint8Array; messageKey: Uint8Array } {
  const messageKey = hmac.create(sha256, chainKey).update(new Uint8Array([0x01])).digest();
  const nextChainKey = hmac.create(sha256, chainKey).update(new Uint8Array([0x02])).digest();
  return { nextChainKey, messageKey };
}

function generateRatchetKeyPair(): KeyPair {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export { MAX_SESSIONS };
