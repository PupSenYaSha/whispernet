import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPair, SessionState } from './types';
import { MAX_SKIP, MAX_SKIPPED_MESSAGE_KEYS, MAX_SESSIONS } from './constants';

const INFO_ROOT = new TextEncoder().encode('WhisperNetRoot');

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
  };
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

export function ratchetStep(
  state: SessionState,
  remoteRatchetPublicKey: Uint8Array
): Uint8Array {
  if (!state.sendingRatchetKey) throw new Error('No sending ratchet key');

  state.previousSendingChainLength = state.sendingMessageNumber;
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
