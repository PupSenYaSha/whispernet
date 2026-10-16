import { iterationsFor } from './pbkdf2';
const PBKDF2_ITERATIONS = iterationsFor('localStore');
const SALT_LEN = 16;
const IV_LEN = 12;

function bufToBase64(buf: ArrayBuffer): string {
  // Chunked, like every other base64 helper in this project. The spread form passes one argument per byte,
  // which overflows the call stack on anything larger than the engine's argument limit - and the RSA
  // private key this is used on is a few kilobytes, so it is not a theoretical size.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/**
 * The most iterations a stored envelope may ask for.
 *
 * The count is read back out of the blob rather than taken from this module, so it is attacker-controlled
 * in the one case that matters: a key backup somebody sent you. Without a ceiling, `"iterations": 4e9`
 * hangs the tab that imports it, which is a denial of service delivered as a file.
 */
const MAX_STORED_ITERATIONS = 10_000_000;

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations, hash: 'SHA-256' },
    passKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * How many iterations to use to open an envelope.
 *
 * Absent means the envelope was written before the count was recorded, and the constant is the only thing
 * left to go on - that is the whole reason for reading the field at all. Everything else is bounded: a
 * floor, so a hand-edited blob cannot turn a password into a single hash, and a ceiling, so it cannot
 * ask for an unbounded amount of work.
 */
function iterationsForBundle(bundle: EncryptedKeyBundle): number {
  const stored = (bundle as { iterations?: unknown }).iterations;
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return PBKDF2_ITERATIONS;
  // Floored at the value this build uses, not at 1. A floor of 1 is no floor at all: a backup somebody sent
  // you containing `"iterations": 1` derives its wrapping key from a single hash and opens successfully,
  // and the user is told their password is correct and handed a private key anyone can take offline in
  // seconds. The field exists for backwards compatibility with older blobs, so the only inputs that can
  // legitimately arrive here are ones this build wrote - and those are never below the constant.
  return Math.min(Math.max(PBKDF2_ITERATIONS, Math.floor(stored)), MAX_STORED_ITERATIONS);
}

export interface EncryptedKeyBundle {
  v: number;
  salt: string;
  iv: string;
  data: string;
  /**
   * The PBKDF2 work factor this envelope was written at.
   *
   * Recorded because nothing else records it. `src/pbkdf2.ts` centralises these counts precisely so they
   * can be raised, and a test asserts the shipping numbers - so raising one is obviously the intent - and
   * until this field existed the raise silently destroyed everything: every `wn_pk_<nick>` RSA bundle, every
   * exported `.json` backup a user had saved, and the drafts and own-message boxes beside them. All of them
   * read the count back from the module constant, so a new build derived a different key and each one
   * answered with a null or a catch instead of an error. A key backup is the worst of the four: the user
   * holds the file, types the right password, and is told it is wrong.
   *
   * Optional in the type because every bundle already on disk lacks it, and rejecting those outright would
   * lock out exactly the users this is protecting.
   */
  iterations?: number;
  publicKey: JsonWebKey;
}

export async function encryptPrivateKey(
  privateKey: JsonWebKey,
  password: string
): Promise<EncryptedKeyBundle> {
const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(privateKey));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    v: 1,
    salt: bufToBase64(salt.buffer),
    iv: bufToBase64(iv.buffer),
    data: bufToBase64(ciphertext),
    // written, not assumed on the way back in: see the field's own note
    iterations: PBKDF2_ITERATIONS,
    publicKey: {} as JsonWebKey,
  };
}

/**
 * Opens a stored or exported private key.
 *
 * The salt and the iv are length-checked before anything is derived, and that is a change in behaviour
 * rather than a tidy-up: `bundle.salt` was base64-decoded with no check at all, so a hand-crafted backup
 * carrying `"salt": ""` got the wrapping key out of an *empty* PBKDF2 salt - a derivation with no salt
 * anywhere in it. `isEncryptedBundle` accepted that too, so the import path took it, and the person
 * importing a backup somebody sent them got a materially weaker KDF than the one their own export writes,
 * with nothing on screen to say so. An iv of the wrong length fails inside WebCrypto anyway; checking it
 * here means the failure names itself.
 *
 * This is a rejection, not a silent acceptance: a backup whose salt is short now fails loudly rather than
 * opening under weaker parameters. That is the intent - the alternative is quietly deriving weaker keys.
 */
export async function decryptPrivateKey(
  bundle: EncryptedKeyBundle,
  password: string
): Promise<JsonWebKey> {
  const salt = new Uint8Array(base64ToBuf(bundle.salt));
  if (salt.length < SALT_LEN) throw new Error('Key backup salt is missing or too short');
  const iv = new Uint8Array(base64ToBuf(bundle.iv));
  if (iv.length !== IV_LEN) throw new Error('Key backup iv is the wrong length');
  const key = await deriveKey(password, salt, iterationsForBundle(bundle));
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBuf(bundle.data));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function isEncryptedBundle(data: unknown): data is EncryptedKeyBundle {
  return (
    typeof data === 'object' &&
    data !== null &&
    'v' in data &&
    'salt' in data &&
    'iv' in data &&
    'data' in data &&
    (data as any).v === 1
  );
}

/** The shape of the file the app writes out and reads back for key export and import. */
export interface KeyBackup {
  version: number;
  type: 'whispernet-key-backup';
  createdAt: string;
  nickname: string;
  publicKey: JsonWebKey;
  encryptedPrivateKey: EncryptedKeyBundle;
}

export function isKeyBackup(data: unknown): data is KeyBackup {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as any).type === 'whispernet-key-backup' &&
    'encryptedPrivateKey' in data
  );
}
