import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPair, SessionState } from './types';

const INFO_ROOT = new TextEncoder().encode('WhisperNetRoot');
const INFO_MSGKEY = new TextEncoder().encode('WhisperNetMsgKey');
const MAX_SKIP = 2000;

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
    return state.skippedMessageKeys.get(messageNumber) || null;
  }

  const skipCount = messageNumber - state.receivingMessageNumber;
  if (skipCount > MAX_SKIP) throw new Error('Too many skipped messages');

  while (state.receivingMessageNumber < messageNumber) {
    const { nextChainKey, messageKey } = chainKDF(state.receivingChainKey);
    state.skippedMessageKeys.set(state.receivingMessageNumber, messageKey);
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

export async function encryptWithMessageKey(
  messageKey: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    messageKey.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext.buffer as ArrayBuffer
  );
  const result = new Uint8Array(4 + iv.length + buf.byteLength);
  result[0] = iv.length;
  result.set(iv, 1);
  result.set(new Uint8Array(buf), 1 + iv.length);
  return result;
}

export async function decryptWithMessageKey(
  messageKey: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const ivLength = ciphertext[0];
  const iv = ciphertext.slice(1, 1 + ivLength);
  const data = ciphertext.slice(1 + ivLength);

  const key = await crypto.subtle.importKey(
    'raw',
    messageKey.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return new Uint8Array(decrypted);
}

function dhRatchet(
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
  const msgKeyInput = new Uint8Array(33);
  msgKeyInput.set(chainKey);
  msgKeyInput[32] = 0x01;

  const nextChainInput = new Uint8Array(33);
  nextChainInput.set(chainKey);
  nextChainInput[32] = 0x02;

  const msgKey = hkdf(sha256, msgKeyInput, new Uint8Array(32), INFO_MSGKEY, 32);
  const nextChainKey = hkdf(sha256, nextChainInput, new Uint8Array(32), INFO_MSGKEY, 32);

  return { nextChainKey, messageKey: msgKey };
}

function generateRatchetKeyPair(): KeyPair {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}
