import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeyPair, PreKeyBundle, SignalPreKeyMessage } from './types';
import { generateKeyPair } from './keys';

const INFO_X3DH = new TextEncoder().encode('WhisperNetX3DH');
const INFO_TRANSCRIPT = new TextEncoder().encode('WhisperNetX3DHTranscript');

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
  remoteBundle: PreKeyBundle,
  ratchetPublicKey: Uint8Array
): X3DHInitResult {
  const valid = ed25519.verify(
    remoteBundle.signedPreKey.signature,
    remoteBundle.signedPreKey.publicKey,
    remoteBundle.ed25519PublicKey
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
    oneTimePreKey: remoteBundle.oneTimePreKey
      ? { keyId: remoteBundle.oneTimePreKey.keyId, publicKey: remoteBundle.oneTimePreKey.publicKey }
      : undefined,
    message: {
      ciphertext: new Uint8Array(0),
      ratchetPublicKey,
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

function lengthPrefixed(...parts: (Uint8Array | null | undefined)[]): Uint8Array<ArrayBuffer> {
  const present = parts.filter((p): p is Uint8Array => !!p && p.length > 0);
  let total = 0;
  for (const p of present) total += 4 + p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of present) {
    new DataView(out.buffer).setUint32(at, p.length, false);
    at += 4;
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A digest of everything the handshake was built out of, which both ends compute the same way.
 *
 * The initiator knows all of it before it sends anything; the responder has all of it in the message it
 * was sent. Binding it into every message afterwards means a ciphertext is only ever accepted inside
 * the conversation it was made for - it cannot be lifted into another one, and it cannot be presented as
 * the opening message of a handshake that never happened.
 */
export function x3dhTranscriptHash(
  initiatorIdentityKey: Uint8Array,
  responderIdentityKey: Uint8Array,
  baseKey: Uint8Array,
  signedPreKey: Uint8Array | null | undefined,
  oneTimePreKey: Uint8Array | null | undefined
): Uint8Array {
  const body = new Uint8Array([
    ...INFO_TRANSCRIPT,
    ...lengthPrefixed(
      initiatorIdentityKey,
      responderIdentityKey,
      baseKey,
      signedPreKey ?? null,
      oneTimePreKey ?? null
    ),
  ]);
  return sha256(body);
}

function deriveMessageKeys(sharedSecret: Uint8Array): Uint8Array[] {
  const keys: Uint8Array[] = [];
  for (let i = 0; i < 3; i++) {
    const info = new TextEncoder().encode(`msg_key_${i}`);
    keys.push(hkdf(sha256, sharedSecret, new Uint8Array(32), info, 32));
  }
  return keys;
}
