import { iterationsFor } from './pbkdf2';
/**
 * A key that belongs to this browser profile and cannot be read out of it.
 *
 * The app keeps the account password in localStorage so it can sign in again on launch. That blob used to
 * be "encrypted" with a key derived from a fingerprint: the user agent, the screen size, the time zone,
 * the canvas hash, the WebGL renderer. Every one of those values is available to any code running on the
 * origin, so the encryption proved only that the file had not been moved to a different kind of machine -
 * which is a much weaker claim than it looks, and much easier to mistake for a real one.
 *
 * What is used instead is a non-extractable key held in IndexedDB. WebCrypto will hand it back for use and
 * will never hand it back as bytes: it cannot be exported, so it cannot be copied out of the profile and
 * used anywhere else, and it is bound to the origin the browser gave it to. Reading the password now
 * requires running code on this origin in this browser, which is the same trust boundary the rest of the
 * session state already lives inside - and it is a boundary that actually holds, rather than one that is
 * reconstructed from four browser properties every time.
 *
 * What this does not do: stop anything running on this origin. A script injected into the page can ask
 * WebCrypto to decrypt the blob just as easily as it could read a fingerprint. That is not fixable from
 * here - it is what a Content-Security-Policy and a server that never serves third-party script are for.
 * What it does do is mean a stolen profile, a backup, or a shared machine's disk is not a plaintext
 * password.
 */

const DB_NAME = 'wn-device';
const STORE = 'keys';
const WRAP_KEY_ID = 'auth-wrap-v1';
const LEGACY_SALT_KEY = 'wn_fingerprint_salt';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function indexedDbFactory(): IDBFactory | null {
  try {
    const f = (globalThis as any).indexedDB;
    return f && typeof f.open === 'function' ? (f as IDBFactory) : null;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const factory = indexedDbFactory();
  if (!factory) return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A browser in private mode, or with storage disabled, refuses to open the database. That is not a
    // failure worth breaking sign-in over: the fallback below keeps the old behaviour.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function idbGet<T>(key: string): Promise<T | null> {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise<T | null>((resolve) => {
      let request: IDBRequest;
      try {
        request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
    });
  });
}

function idbPut(key: string, value: unknown): Promise<boolean> {
  return openDb().then((db) => {
    if (!db) return false;
    return new Promise<boolean>((resolve) => {
      let request: IDBRequest;
      try {
        request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
      } catch {
        resolve(false);
        return;
      }
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
    });
  });
}

function idbDelete(key: string): Promise<void> {
  return openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    } catch { /* nothing to remove */ }
  });
}

let cached: CryptoKey | null = null;

/**
 * The wrapping key, created once per profile.
 *
 * Non-extractable, so this is the only copy that will ever exist: asking WebCrypto for the raw bytes
 * throws rather than returning them.
 */
async function deviceKey(): Promise<CryptoKey | null> {
  if (cached) return cached;
  const existing = await idbGet<CryptoKey>(WRAP_KEY_ID);
  if (existing) {
    cached = existing;
    return existing;
  }
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (!(await idbPut(WRAP_KEY_ID, key))) return null;
    cached = key;
    return key;
  } catch {
    return null;
  }
}

/** Whether this browser can hold a real device-bound key, as opposed to falling back. */
export async function deviceKeyAvailable(): Promise<boolean> {
  return (await deviceKey()) !== null;
}

const PBKDF2_ITER = iterationsFor('deviceCredentials');

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

/* ------------------------------------------------------------------ *
 * The fallback, kept only for browsers that cannot hold a device key.
 * ------------------------------------------------------------------ */

async function fingerprintSalt(): Promise<Uint8Array> {
  const KEY = 'wn_fingerprint_salt';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) {
      const bytes = new Uint8Array(base64ToBuf(existing));
      if (bytes.length === 16) return bytes;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    localStorage.setItem(KEY, bufToBase64(salt.buffer as ArrayBuffer));
    return salt;
  } catch {
    return new Uint8Array(16);
  }
}

/**
 * The old fingerprint, in full.
 *
 * Kept so an installation signed in under the old scheme is not signed out by the upgrade, and so the
 * value can be removed once a successful sign-in has rewritten the blob. The high-entropy values the old
 * version asked for are no longer requested: there is nothing to gain by spending a round trip on them.
 */
async function legacyFingerprint(): Promise<string> {
  const parts: string[] = [];
  parts.push(navigator.userAgent);
  parts.push(screen.colorDepth.toString());
  parts.push(`${screen.width}x${screen.height}`);
  parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  parts.push(navigator.language);
  parts.push(navigator.hardwareConcurrency?.toString() || '0');
  parts.push((navigator as any).deviceMemory?.toString() || '0');
  parts.push(navigator.platform);
  parts.push(navigator.maxTouchPoints?.toString() || '0');
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('wn', 2, 2);
      parts.push(canvas.toDataURL().slice(0, 100));
    }
  } catch { /* a browser that refuses to draw simply contributes less */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg && gl) parts.push(String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)));
  } catch { /* as above */ }
  try {
    parts.push(screen.pixelDepth.toString());
  } catch { /* as above */ }
  return parts.join('|||');
}

async function legacyKey(): Promise<CryptoKey> {
  const fingerprint = await legacyFingerprint();
  const salt = await fingerprintSalt();
  const passKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(fingerprint), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/* ------------------------------------------------------------------ *
 * The box
 * ------------------------------------------------------------------ */

export interface StoredAuth {
  v: number;
  /** `device` is a non-extractable IndexedDB key; `fingerprint` is the old scheme, read-only. */
  scheme: 'device' | 'fingerprint';
  iv: string;
  data: string;
}

async function seal(key: CryptoKey, scheme: StoredAuth['scheme'], plaintext: string): Promise<StoredAuth> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)
  );
  return { v: 1, scheme, iv: bufToBase64(iv.buffer), data: bufToBase64(data) };
}

async function unseal(key: CryptoKey, stored: StoredAuth): Promise<string | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(stored.iv)) },
      key,
      base64ToBuf(stored.data)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function parse(raw: unknown): StoredAuth | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as any;
  if (typeof o.iv !== 'string' || typeof o.data !== 'string') return null;
  // anything without a scheme marker predates both schemes and is treated as the fingerprint one
  const scheme: StoredAuth['scheme'] = o.scheme === 'device' ? 'device' : 'fingerprint';
  return { v: typeof o.v === 'number' ? o.v : 1, scheme, iv: o.iv, data: o.data };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Writes the sign-in blob under the device key, or under the fallback when there is none. */
export async function storePassword(nickname: string, password: string): Promise<boolean> {
  const s = storage();
  if (!s) return false;
  try {
    const key = await deviceKey();
    const stored = key
      ? await seal(key, 'device', JSON.stringify({ nickname, password }))
      : await seal(await legacyKey(), 'fingerprint', JSON.stringify({ nickname, password }));
    s.setItem('wn_auth', JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the sign-in blob back.
 *
 * The old scheme is tried as well as the new one, so an upgrade does not sign everybody out. When the old
 * one is what opens, the blob is rewritten immediately in the new scheme - which is the point at which the
 * fingerprint stops being the thing standing between the file and the password.
 */
export async function readStoredAuth(): Promise<{ nickname: string; password: string; upgraded: boolean } | null> {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem('wn_auth');
  if (!raw) return null;

  let stored: StoredAuth | null = null;
  try {
    stored = parse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!stored) return null;

  if (stored.scheme === 'device') {
    const key = await deviceKey();
    if (!key) return null;
    const plaintext = await unseal(key, stored);
    if (!plaintext) return null;
    return normalise(plaintext, false);
  }

  const plaintext = await unseal(await legacyKey(), stored);
  if (!plaintext) return null;
  // it opened under the old scheme, so rewrite it under the real one
  const result = normalise(plaintext, true);
  if (result) await storePassword(result.nickname, result.password);
  return result;
}

function normalise(plaintext: string, upgraded: boolean): { nickname: string; password: string; upgraded: boolean } | null {
  try {
    const parsed = JSON.parse(plaintext);
    // the very first version stored the nickname beside the blob rather than inside it
    if (parsed && typeof parsed.password === 'string' && typeof parsed.nickname === 'string') {
      return { nickname: parsed.nickname, password: parsed.password, upgraded };
    }
    if (typeof parsed === 'string') return { nickname: '', password: parsed, upgraded };
  } catch { /* not json */ }
  return null;
}

/** Forgets the stored password, so the next launch asks for it again. */
export function clearStoredAuth(): void {
  try { storage()?.removeItem('wn_auth'); } catch { /* nothing stored */ }
}

/**
 * Checks a password against the sign-in blob actually on disk.
 *
 * A password change has to know the current one is right before it re-wraps anything under a new one, and
 * the honest check is opening the stored blob with it. Comparing against a copy the page is already
 * holding would only prove the field was typed twice; comparing to a blob freshly sealed with the
 * candidate would prove nothing at all, since that seals and opens under anything.
 *
 * Returns why it failed rather than a bare false, because "wrong password" and "this device has no
 * stored credentials" call for different things from the person in front of it.
 */
export async function verifyStoredAuth(candidate: string): Promise<{ ok: true } | { ok: false; reason: 'none' | 'wrong' }> {
  const stored = await readStoredAuth();
  if (!stored) return { ok: false, reason: 'none' };
  // a plain string comparison rather than a constant-time one: the value is already in this tab's memory
  // in the clear, so timing an attacker would learn nothing they do not have
  return stored.password === candidate ? { ok: true } : { ok: false, reason: 'wrong' };
}

/**
 * Drops the fallback material.
 *
 * Called once the sign-in blob is known to be under the device key, so the fingerprint is not left lying
 * around in the profile describing the machine to anything that reads it.
 */
export async function retireLegacyFingerprint(): Promise<void> {
  try {
    const s = storage();
    if (!s) return;
    if (s.getItem('wn_auth')) {
      const parsed = parse(JSON.parse(s.getItem('wn_auth') || 'null'));
      if (parsed?.scheme === 'device') {
        s.removeItem(LEGACY_SALT_KEY);
        s.removeItem('wn_fingerprint_salt');
      }
    }
  } catch { /* nothing to retire */ }
}

/** Forgets the device key itself. Used by "clear local data". */
export async function destroyDeviceKey(): Promise<void> {
  cached = null;
  await idbDelete(WRAP_KEY_ID);
}
