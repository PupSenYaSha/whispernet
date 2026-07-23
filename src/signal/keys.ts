import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import type { KeyPair, IdentityKeyPair, PreKeyRecord, SignedPreKeyRecord } from './types';

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function generateKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const kp = generateKeyPair();
  const registrationId = randomUint16();
  const ed25519KP = ed25519.keygen();
  return {
    ...kp,
    registrationId,
    ed25519PublicKey: ed25519KP.publicKey,
    ed25519PrivateKey: ed25519KP.secretKey,
  };
}

export function generatePreKeyRecord(startId: number): PreKeyRecord {
  return {
    keyId: startId,
    keyPair: generateKeyPair(),
  };
}

export function generateSignedPreKeyRecord(
  ed25519PrivateKey: Uint8Array,
  keyId: number
): SignedPreKeyRecord {
  const keyPair = generateKeyPair();
  const signature = ed25519.sign(keyPair.publicKey, ed25519PrivateKey);
  return {
    keyId,
    keyPair,
    signature,
    createdAt: Date.now(),
  };
}

export function generateOneTimePreKeys(startId: number, count: number): PreKeyRecord[] {
  const keys: PreKeyRecord[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(generatePreKeyRecord(startId + i));
  }
  return keys;
}

export function signKey(identityKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return ed25519.sign(publicKey, identityKey);
}

export function verifyKey(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array
): boolean {
  return ed25519.verify(signature, message, publicKey);
}

function randomUint16(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0];
}

export function encodeKeyPair(kp: KeyPair): string {
  return JSON.stringify({
    privateKey: Array.from(kp.privateKey),
    publicKey: Array.from(kp.publicKey),
  });
}

export function decodeKeyPair(data: string): KeyPair {
  const obj = JSON.parse(data);
  return {
    privateKey: new Uint8Array(obj.privateKey),
    publicKey: new Uint8Array(obj.publicKey),
  };
}
