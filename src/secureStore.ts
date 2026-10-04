import { iterationsFor } from './pbkdf2';
/**
 * A small encrypted box in the browser, keyed by the account password.
 *
 * The identity keys and the ratchet sessions are already stored this way. This exists for the handful of
 * values that used to sit in `localStorage` in the clear - most of all the plaintext of the private
 * messages this account sent, kept so the sender could read its own messages back. That cache is the
 * one place where the promise the rest of the app makes, that the words of a private message are not on
 * disk anywhere, was quietly untrue: the browser profile held three hundred of them in the clear, and
 * signing out did not touch it.
 *
 * The key is derived from the password with the same cost the key bundle uses, so the box is no weaker
 * than the private key sitting beside it, and it is unusable without the password.
 */

const PBKDF2_ITER = iterationsFor('localStore');
const SALT_BYTES = 16;
const IV_BYTES = 12;

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(bin);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/**
 * Overwrites a buffer that is finished with.
 *
 * Worth being exact about what this does and does not buy. The keys themselves are `CryptoKey` objects
 * marked `extractable: false`, so there is no key material here to wipe — that part of the concern does
 * not apply to this codebase and no amount of zeroing would change it.
 *
 * What *is* here is the plaintext of the box, briefly, in a typed array. Zeroing it means a later heap dump
 * cannot read it back out of a buffer that happened to survive, and it is free. What it cannot do is reach
 * the copies the engine made on its own: `bufToBase64` above builds an ordinary JavaScript string, strings
 * are immutable and cannot be wiped, and V8 is free to copy a buffer while working with it. So this is
 * hygiene, not a boundary. The boundary is that the box is sealed under the account password and the
 * process has to be unlocked to derive anything at all.
 */
function wipe(buf: ArrayBuffer | Uint8Array): void {
  try {
    (buf instanceof Uint8Array ? buf : new Uint8Array(buf)).fill(0);
  } catch { /* a detached buffer is already gone, which is the outcome being asked for */ }
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * One key per account and box, derived once and held for the life of the tab.
 *
 * Held rather than re-derived on every write: PBKDF2 at six hundred thousand iterations is deliberately
 * slow, and the own-message cache is written on every send.
 */
const derived = new Map<string, Promise<CryptoKey>>();

function saltFor(storage: Storage, key: string): Uint8Array {
  const saltKey = `${key}__salt`;
  const existing = storage.getItem(saltKey);
  if (existing) {
    try {
      const bytes = new Uint8Array(base64ToBuf(existing));
      if (bytes.length === SALT_BYTES) return bytes;
    } catch { /* unreadable salt, so a fresh one is written below */ }
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  try { storage.setItem(saltKey, bufToBase64(salt.buffer as ArrayBuffer)); } catch { /* private mode */ }
  return salt;
}

function keyFor(storage: Storage, password: string, key: string): Promise<CryptoKey> {
  const cacheKey = `${key}:${password.length}:${saltFor(storage, key).join(',')}`;
  const existing = derived.get(cacheKey);
  if (existing) return existing;
  const salt = saltFor(storage, key);
const promise = (async () => {
    // the account password, in a typed array, for as short a time as the import allows. This is the most
    // sensitive buffer in the file: everything else here is either ciphertext or the plaintext of something
    // already sealed under this password, while this *is* the password.
    const passBytes = new TextEncoder().encode(password);
    let passKey: CryptoKey;
    try {
      passKey = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveKey']);
    } finally {
      wipe(passBytes);
    }
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
      passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  })();
  derived.set(cacheKey, promise);
  return promise;
}

/**
 * Forgets every derived key.
 *
 * Called when the account is signed out, so a later sign-in under a different password cannot be served
 * a key derived from the previous one.
 */
export function forgetSecureKeys(): void {
  derived.clear();
}

/** Writes a value as `{iv, data}` under the key. Silent about failure: a full disk is not worth an error. */
export async function secureSet(key: string, password: string, value: unknown): Promise<void> {
  const storage = safeStorage();
  if (!storage || !password) return;
try {
    const cryptoKey = await keyFor(storage, password, key);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    let data: ArrayBuffer;
    try {
      data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    } finally {
      wipe(encoded);
    }
    storage.setItem(key, JSON.stringify({ v: 1, iv: bufToBase64(iv.buffer), data: bufToBase64(data) }));
  } catch {
    /* a storage failure must not break sending */
  }
}

/** Reads a value back, or null when there is nothing, the password is wrong, or the bytes were altered. */
export async function secureGet<T>(key: string, password: string): Promise<T | null> {
  const storage = safeStorage();
  if (!storage || !password) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.data !== 'string') return null;
const cryptoKey = await keyFor(storage, password, key);
    const dataBuf = base64ToBuf(parsed.data);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(parsed.iv)) },
        cryptoKey,
        dataBuf
      );
    } finally {
      wipe(dataBuf);
    }
    // decoded and parsed before the wipe rather than after: the decoded string is a copy that zeroing the
    // buffer cannot reach, so there is nothing to be gained by holding the plaintext bytes longer than the
    // parse takes
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}

export function secureRemove(key: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(key);
    storage.removeItem(`${key}__salt`);
  } catch { /* nothing to clean up */ }
}
