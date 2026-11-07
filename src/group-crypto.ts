const ALGO_AES = { name: 'AES-GCM', length: 256 };
const ALGO_RSA = { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** One symmetric key per group. One encrypted body per message, no matter how many members or devices. */
export interface GroupKey {
  id: string;
  /** Raw 32-byte AES key, held in memory only. */
  rawKey: ArrayBuffer;
  /** The wrapped copy the server handed this account, to re-import on next sign-in. */
  wrappedKey?: string;
}

export async function generateGroupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt']);
}

export async function exportGroupKeyRaw(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key);
}

export async function importGroupKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, ALGO_AES, false, ['encrypt', 'decrypt']);
}

export async function encryptGroupMessage(key: CryptoKey, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: bufToBase64(ct), iv: bufToBase64(iv.buffer) };
}

export async function decryptGroupMessage(key: CryptoKey, ciphertext: string, iv: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(iv) }, key, base64ToBuf(ciphertext));
  return new TextDecoder().decode(pt);
}

/**
 * Wraps a group key for one recipient's long-lived RSA key.
 *
 * The server never sees the raw key: it only stores and relays the wrapped copy. The recipient unwraps
 * it with their private key, which never leaves their device.
 */
export async function wrapGroupKeyFor(rawKey: ArrayBuffer, recipientPublicKey: JsonWebKey): Promise<string> {
  const pub = await crypto.subtle.importKey('jwk', recipientPublicKey, ALGO_RSA, false, ['encrypt']);
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, rawKey);
  return bufToBase64(wrapped);
}

/**
 * Unwraps a group key that the server handed this account.
 *
 * Called on sign-in and whenever the group rotates its key (member joined / left).
 */
export async function unwrapGroupKey(wrappedB64: string, privateKeyJwk: JsonWebKey): Promise<ArrayBuffer> {
  const priv = await crypto.subtle.importKey('jwk', privateKeyJwk, ALGO_RSA, false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, base64ToBuf(wrappedB64));
}

/**
 * A sealed sender envelope carried inside the encrypted group plaintext.
 *
 * The server never sees the sender's name - only the recipient devices do, after decrypting the group key.
 */
export interface GroupSenderEnvelope {
  senderKey: string;
  senderNickname: string;
  text: string;
}

export function wrapGroupSenderPlaintext(text: string, senderKeyB64: string, senderNickname: string): string {
  const envelope: GroupSenderEnvelope = { senderKey: senderKeyB64, senderNickname: senderNickname, text };
  return JSON.stringify(envelope);
}

import { stripPadding } from './padding';

export function unwrapGroupSenderPlaintext(decrypted: string): { senderKey?: string; senderNickname?: string; text: string } {
  const trimmed = stripPadding(decrypted);
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string' && typeof parsed.senderKey === 'string') {
      return { senderKey: parsed.senderKey, senderNickname: parsed.senderNickname, text: stripPadding(parsed.text) };
    }
  } catch { /* legacy plaintext */ }
  return { text: trimmed };
}
