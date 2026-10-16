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

/**
 * The most iterations a stored box may ask for.
 *
 * The count is read back out of the envelope, so it is attacker-controlled to the same degree `src/appLock.ts`
 * treats its own as attacker-controlled: a hand-edited localStorage entry carrying `"iterations": 4e9` is a
 * tab that never comes back. That file answers an out-of-range figure with `damaged` rather than clamping;
 * here the honest answer is to clamp, because this box holds drafts and the sender's own outgoing text and
 * refusing to open it would throw away somebody's unsent work over a bad number.
 */
const MAX_STORED_ITERATIONS = 10_000_000;

/**
 * How many iterations to use for one envelope.
 *
 * Absent means the box was written before the count was recorded, and the constant is all there is to go
 * on. Anything present is honoured - floor first, so an edited blob cannot reduce a password to a single
 * hash, ceiling second, so it cannot ask for unbounded work.
 *
 * Without reading this back at all, raising `localStore` in `src/pbkdf2.ts` - which is what that module is
 * for, and which `tests/unit/pbkdf2-iterations.test.ts` exists to police - would leave every `wn_drafts`
 * and `wn_own_dm_text` box sealed under a key nothing can derive again, and the failure is a `null`. The
 * drafts are the worse half: they are the text of messages that were never sent.
 */
function iterationsFromEnvelope(stored: unknown): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return PBKDF2_ITER;
  // Floored at the constant this build uses, not at 1. A floor of 1 is no floor: an edited entry carrying
  // `"iterations": 1` opens with a single hash, so the drafts and the sender's own message text come out
  // under a key anybody can brute-force offline. The field exists for boxes written before the count was
  // recorded, so the only values that can legitimately arrive are ones this build wrote - never below the
  // constant. Same correction as the one in `crypto-keys.ts`.
  return Math.min(Math.max(PBKDF2_ITER, Math.floor(stored)), MAX_STORED_ITERATIONS);
}

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

/**
 * The derived key for one box under one password, derived at most once each.
 *
 * The cache is identified by the password itself, and this is the whole reason it works. It used to be
 * identified by the password's *length*, which is not the same password: change from one to another of the
 * same length - `correct-horse-1` to `correct-horse-2`, or any of the pairs a person makes when they are
 * fixing a typo - and the cache handed back the key derived from the old one.
 *
 * Two things then go wrong at once, and neither is loud. The box is written with that old key, so the
 * previous password carries on opening it, which is the one thing changing a password is supposed to
 * achieve. And on the next page load the cache is empty, PBKDF2 derives the right key from the new
 * password, and the box no longer opens at all - so the own-message cache and every draft are silently
 * gone.
 *
 * The ratchet stores never hit this, which is why it survived so long: their rekey writes a fresh salt,
 * and the salt is part of the cache identity. These two boxes keep theirs, so the password has to be.
 *
 * The password sits in a Map key in memory, which is where it already was - the caller holds it for the
 * length of the write regardless.
 */
/**
 * The work factor is part of the cache identity, not just the salt.
 *
 * Two envelopes of the same box can legitimately want different counts - a write after the constant moved
 * uses the new one, a read of a box written before it uses the old - and a cache that ignored the count
 * would hand back whichever key was derived first. The failure is quiet and looks like corruption: the
 * wrong key opens nothing, so `secureGet` returns null and the draft is gone.
 */
function keyFor(storage: Storage, password: string, key: string, iterations: number): Promise<CryptoKey> {
  const salt = saltFor(storage, key);
  const cacheKey = `${key}:${password.length}:${salt.join(',')}:${iterations}:${password}`;
  const existing = derived.get(cacheKey);
  if (existing) return existing;
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
      { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations, hash: 'SHA-256' },
      passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  })();
  derived.set(cacheKey, promise);
  return promise;
}

/**
 * Forgets every derived key.
 *
 * Called when the account is signed out, so a later sign-in under a different password cannot be served a
 * key derived from the previous one, and so the tab does not hold a key for an account nobody is signed
 * in to. Without it this map grows one entry per password anyone typed in this tab - a wrong password
 * during an ordinary sign-in is enough.
 */
export function forgetSecureKeys(): void {
  derived.clear();
}

/**
 * Writes a value as `{v, iv, data, iterations}` under the key, and says whether it landed.
 *
 * Still silent about failure - a full disk is not worth throwing over - but it is no longer silent to its
 * caller. It used to return nothing and swallow everything, so a `QuotaExceededError` looked exactly like a
 * successful write, and the callers that clear a "needs saving" flag before writing had nothing left to
 * retry from: the unsent draft was lost and the tab reported it had been stored.
 *
 * `false` covers every reason the write did not happen: no storage, no password, and any throw below.
 * "The box is stale" is not one of them.
 *
 * `iterations` is written here for the reason its counterpart is written in `src/crypto-keys.ts`: it is the
 * only record of what this box was sealed at, and the constant it was sealed at is a value in a module that
 * exists to be changed.
 */
export async function secureSet(key: string, password: string, value: unknown): Promise<boolean> {
  const storage = safeStorage();
  if (!storage || !password) return false;
  try {
    const cryptoKey = await keyFor(storage, password, key, PBKDF2_ITER);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    let data: ArrayBuffer;
    try {
      data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    } finally {
      wipe(encoded);
    }
    storage.setItem(key, JSON.stringify({
      v: 1,
      iv: bufToBase64(iv.buffer),
      data: bufToBase64(data),
      iterations: PBKDF2_ITER,
    }));
    return true;
  } catch {
    /* a storage failure must not break sending */
    return false;
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
    const cryptoKey = await keyFor(storage, password, key, iterationsFromEnvelope(parsed.iterations));
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
