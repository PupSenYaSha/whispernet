import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPair, PreKeyBundle, SignalPreKeyMessage } from './types';
import { generateKeyPair } from './keys';

const INFO_X3DH = new TextEncoder().encode('WhisperNetX3DH');

export interface X3DHResult {
  sharedSecret: Uint8Array;
  message: SignalPreKeyMessage;
}

export interface X3DHInitResult {
  sharedSecret: Uint8Array;
  messageKeys: Uint8Array[];
  message: SignalPreKeyMessage;
}

export function x3dhInit(
  identityKey: KeyPair,
  remoteBundle: PreKeyBundle
): X3DHInitResult {
  const valid = ed25519.verify(
    remoteBundle.signedPreKey.signature,
    remoteBundle.signedPreKey.publicKey,
    remoteBundle.identityKey
  );
  if (!valid) throw new Error('Invalid signed pre-key signature');

  const baseKey = generateKeyPair();

  const dh1 = x25519.getSharedSecret(baseKey.privateKey, remoteBundle.identityKey);
  const dh2 = x25519.getSharedSecret(identityKey.privateKey, remoteBundle.signedPreKey.publicKey);
  const dh3 = x25519.getSharedSecret(baseKey.privateKey, remoteBundle.signedPreKey.publicKey);

  let dh4: Uint8Array;
  if (remoteBundle.oneTimePreKey) {
    dh4 = x25519.getSharedSecret(baseKey.privateKey, remoteBundle.oneTimePreKey.publicKey);
  } else {
    dh4 = new Uint8Array(32);
  }

  const sharedSecret = deriveX3DHSecret(dh1, dh2, dh3, dh4);

  const messageKeys = deriveMessageKeys(sharedSecret);

  const message: SignalPreKeyMessage = {
    identityKey: identityKey.publicKey,
    signedPreKey: {
      keyId: remoteBundle.signedPreKey.keyId,
      publicKey: remoteBundle.signedPreKey.publicKey,
    },
    baseKey: baseKey.publicKey,
    message: {
      ciphertext: new Uint8Array(0),
      ratchetPublicKey: baseKey.publicKey,
      previousChainLength: 0,
      messageNumber: 0,
    },
  };

  return { sharedSecret, messageKeys, message };
}

export function x3dhRespond(
  identityKey: KeyPair,
  signedPreKey: KeyPair,
  oneTimePreKey: KeyPair | null,
  preKeyMessage: SignalPreKeyMessage
): Uint8Array {
  const dh1 = x25519.getSharedSecret(identityKey.privateKey, preKeyMessage.baseKey);
  const dh2 = x25519.getSharedSecret(signedPreKey.privateKey, preKeyMessage.identityKey);
  const dh3 = x25519.getSharedSecret(signedPreKey.privateKey, preKeyMessage.baseKey);

  let dh4: Uint8Array;
  if (oneTimePreKey && preKeyMessage.oneTimePreKey) {
    dh4 = x25519.getSharedSecret(oneTimePreKey.privateKey, preKeyMessage.baseKey);
  } else {
    dh4 = new Uint8Array(32);
  }

  return deriveX3DHSecret(dh1, dh2, dh3, dh4);
}

function deriveX3DHSecret(
  dh1: Uint8Array,
  dh2: Uint8Array,
  dh3: Uint8Array,
  dh4: Uint8Array
): Uint8Array {
  const input = new Uint8Array(dh1.length + dh2.length + dh3.length + dh4.length);
  input.set(dh1, 0);
  input.set(dh2, dh1.length);
  input.set(dh3, dh1.length + dh2.length);
  input.set(dh4, dh1.length + dh2.length + dh3.length);

  return hkdf(sha256, input, new Uint8Array(32), INFO_X3DH, 32);
}

function deriveMessageKeys(sharedSecret: Uint8Array): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (let i = 0; i < 3; i++) {
    const info = new TextEncoder().encode(`msg_key_${i}`);
    keys.push(hkdf(sha256, sharedSecret, new Uint8Array(32), info, 32));
  }
  return keys;
}
