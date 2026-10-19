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

/**
 * The identifier a bundle is published under.
 *
 * Never zero: it is what tells one bundle from another in the protocol, so a zero would be
 * indistinguishable from "not set" and is avoided rather than merely being unlikely.
 */
function randomRegistrationId(): number {
  const n = randomUint16();
  return n === 0 ? 1 : n;
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const kp = generateKeyPair();
  const registrationId = randomRegistrationId();
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

function randomUint16(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0];
}
