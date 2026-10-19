import { iterationsFor } from './pbkdf2';
/**
 * The passcode that has to be entered before the conversation is shown.
 *
 * This is not a second password. The account password proves who you are to the server; this is for the
 * person who picks up an unlocked machine. It gates the app, not the account: nothing is re-encrypted
 * under it and nothing is sent with it, because a lock that could lose somebody their messages if they
 * forget it is worse than the problem it solves.
 *
 * Which is why it is stored the way it is. The code is verified against a salted hash kept on this
 * device, and after a few wrong attempts it stops answering for a while rather than becoming something
 * that can be guessed at leisure. Forgotten means removing it in Settings, which needs the account
 * password - so the code protects against a borrowed device, not against the owner.
 *
 * Whether it is on, and how long the machine may be idle before it comes back, live in the ordinary app
 * settings so there is one place a reader looks and one source of truth. The hash is separate, because it
 * is not a preference.
 */

const PBKDF2_ITER = iterationsFor('appLock');
const SALT_BYTES = 16;
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 60_000;

export interface AppLockSettings {
  enabled: boolean;
  /** Milliseconds of inactivity before the app covers itself. Zero means only on launch. */
  autoLockMs: number;
}

const HASH_KEY = 'wn_app_lock_hash';
const STATE_KEY = 'wn_app_lock_state';

interface StoredHash {
  v: 1;
  salt: string;
  iterations: number;
  hash: string;
}

interface LockState {
  failures: number;
  lockedUntil: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The failure counter's second home.
 *
 * `readState` answered `{failures: 0, lockedUntil: 0}` for a missing key, an unparseable value, and a
 * `localStorage` that was absent entirely - and `writeState` swallowed its own write failure. So in private
 * mode, or under quota pressure, or with a storage policy that blocks writes, `MAX_ATTEMPTS` and
 * `LOCKOUT_MS` never engaged at all: the count went back to zero every time it was read, and the passcode
 * stayed guessable at the PBKDF2 rate indefinitely. A lockout that can be reset by making storage misbehave
 * is not a lockout, and making storage misbehave is not something the person guessing has to be able to do
 * - it happens on its own.
 *
 * `sessionStorage` is the mirror because it fails differently. It is per-tab, so it does not survive a
 * restart, which is a real loss and the honest one to take; but a quota-exhausted or write-blocked
 * `localStorage` is nearly always still writable in `sessionStorage`, and the failure this is guarding
 * against is a *silent* one. What it buys is degradation rather than reset: the counter survives for as long
 * as the tab does, which is exactly long enough to stop a person working through ten guesses.
 */
function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
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

/** Hygiene rather than a boundary: the salt and hash are public anyway, but there is no reason to keep them. */
function wipe(bytes: Uint8Array): void {
  try { bytes.fill(0); } catch { /* a detached buffer is already gone */ }
}

export function isAppLockSet(): boolean {
  const s = storage();
  return !!s && !!s.getItem(HASH_KEY);
}

/**
 * Whether the gate is currently up, published by the host component so that code outside the lock
 * tree can ask.
 *
 * The lock is React state in `AppLockHost`, so a notification raised while the tab is in the
 * background — which is exactly when the gate comes up — cannot see it by looking at a component.
 * Without this the preview that leaks a private message onto the lock screen is the one surface the
 * passcode was supposed to cover.
 */
let locked = false;

export function setAppLocked(value: boolean): void {
  locked = value;
}

export function isAppLocked(): boolean {
  return locked;
}

/**
 * Establishes the code.
 *
 * Rejects the codes that make a lock theatre: four digits is a hundred combinations and nothing else, so
 * six is the floor, and the common runs like 111111 or 123456 are refused outright.
 */
export async function setAppLockCode(code: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!/^\d{6,12}$/.test(code)) return { ok: false, reason: 'Use 6 to 12 digits' };
  if (isWeakCode(code)) return { ok: false, reason: 'That code is too easy to guess' };
  const s = storage();
  if (!s) return { ok: false, reason: 'Storage is unavailable' };
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(code, salt, PBKDF2_ITER);
  const stored: StoredHash = { v: 1, salt: bufToBase64(salt.buffer), iterations: PBKDF2_ITER, hash: bufToBase64(hash) };
  try {
    s.setItem(HASH_KEY, JSON.stringify(stored));
  } catch {
    return { ok: false, reason: 'Storage is unavailable' };
  }
  // through `writeState`, so the mirror is cleared too - a stale failure count left in it would lock the
  // new code out on its first use
  writeState({ failures: 0, lockedUntil: 0 });
  return { ok: true };
}

export async function clearAppLockCode(): Promise<void> {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(HASH_KEY);
    s.removeItem(STATE_KEY);
  } catch { /* nothing to clear */ }
  // the mirror too: it is a second copy of the failure count, and turning the lock off has to remove every
  // trace of it or a later code starts life locked out
  try { sessionStore()?.removeItem(STATE_KEY); } catch { /* nothing to clear */ }
}

/** Whether the code is currently being refused because too many attempts have failed. */
export function appLockLockedOut(): number {
  const state = readState();
  return Math.max(0, state.lockedUntil - Date.now());
}

/**
 * What `readHash` found, including the case that is not a hash at all.
 *
 * The distinction matters because "there is no code set" and "there is a code set and I cannot read it"
 * have to be answered differently. Only the first may let somebody in.
 */
type HashRead = { kind: 'none' } | { kind: 'ok'; stored: StoredHash } | { kind: 'unreadable' };

export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'locked'; retryInMs: number }
  | { ok: false; reason: 'wrong' }
  | { ok: false; reason: 'damaged' };

export async function unlockAppLock(code: string): Promise<UnlockResult> {
  const remaining = appLockLockedOut();
  if (remaining > 0) return { ok: false, reason: 'locked', retryInMs: remaining };

  const read = readHash();
  // No code has been set on this device, so there is nothing to ask for.
  if (read.kind === 'none') return { ok: true };
  if (read.kind === 'unreadable') {
    // A code *is* configured - `isAppLockSet` is what put this gate on screen - and the stored hash cannot
    // be read. It used to answer `{ ok: true }` here, because "no hash" and "unreadable hash" were the same
    // return value. So a truncated write, a half-cleared entry, or anything else that damaged the blob
    // turned the lock off while Settings went on reporting a passcode as configured. A lock that reports
    // itself as off is worse than no lock, because it is believed.
    //
    // Failing closed on its own would be a trap, so this is a distinct answer the gate can act on rather
    // than a wrong-code refusal: `AppLockGate` offers to turn the lock off, which costs nothing an attacker
    // could not already do by deleting the key, and it leaves the account password as the thing that still
    // actually guards the account.
    return { ok: false, reason: 'damaged' };
  }

  const stored = read.stored;
  const salt = new Uint8Array(base64ToBuf(stored.salt));
  const hash = await derive(code, salt, stored.iterations);
  wipe(salt);
  if (!constantTimeEqual(bufToBase64(hash), stored.hash)) {
    const state = readState();
    state.failures += 1;
    if (state.failures >= MAX_ATTEMPTS) {
      state.lockedUntil = Date.now() + LOCKOUT_MS;
      state.failures = 0;
    }
    // Failing closed on an unpersistable counter. The alternative is to answer `wrong` as though the count
    // had been kept, which tells a person guessing that this attempt cost them nothing - and it cost them
    // nothing, because the next one starts from zero again. Refusing is temporary and states its own
    // reason, so it is not the trap `damaged` would be: once storage recovers the counter reads back and the
    // lock ends on its own.
    if (!writeState(state)) return { ok: false, reason: 'locked', retryInMs: LOCKOUT_MS };
    return { ok: false, reason: 'wrong' };
  }
  // A reset that cannot be written is not a reason to refuse a correct code: the stored count can only make
  // the lock stricter, never weaker, so leaving the old one in place is the safe direction. It does mean the
  // next few wrong guesses are refused sooner than they should be, which is the right way round.
  writeState({ failures: 0, lockedUntil: 0 });
  return { ok: true };
}

/**
 * Reads the stored hash, or says why it could not be read.
 *
 * `iterations` is checked like the other three fields, and it is the one that matters most. It is read back
 * out of storage and handed straight to PBKDF2 as the work factor, so a blob carrying `"iterations": 1`
 * turns a six-to-twelve digit code into something that can be exhausted in microseconds, and a large one
 * hangs the main thread. The file validated `v`, `salt` and `hash` and let this one past, which is the
 * attacker-controlled-KDF-parameter mistake rather than a deliberate feature.
 *
 * The bounds are wide enough for the figures this file ships - 310,000 - and for the environment override
 * the cost module allows, while excluding both "none" and "hang the tab".
 */
function readHash(): HashRead {
  const s = storage();
  if (!s) return { kind: 'none' };
  try {
    const raw = s.getItem(HASH_KEY);
    if (!raw) return { kind: 'none' };
    const parsed = JSON.parse(raw) as StoredHash;
    if (parsed?.v !== 1 || typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string') {
      return { kind: 'unreadable' };
    }
    if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1_000 || parsed.iterations > 10_000_000) {
      return { kind: 'unreadable' };
    }
    return { kind: 'ok', stored: parsed };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * The counter, from whichever store can be read.
 *
 * A `localStorage` that is missing, unreadable or holding something that will not parse falls through to
 * the `sessionStorage` mirror rather than to zero. Falling through to zero is what made the lockout
 * optional: the failure modes that cause it are exactly the ones where the write below also fails, so the
 * count was always zero by the time anybody looked. A store that works but holds a fresh entry still wins -
 * it is the one that survives a reload - and the mirror only fills the gap.
 */
function readState(): LockState {
  for (const s of [storage(), sessionStore()]) {
    if (!s) continue;
    let raw: string | null = null;
    try { raw = s.getItem(STATE_KEY); } catch { continue; }
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      return {
        failures: typeof parsed?.failures === 'number' ? parsed.failures : 0,
        lockedUntil: typeof parsed?.lockedUntil === 'number' ? parsed.lockedUntil : 0,
      };
    } catch {
      continue;
    }
  }
  return { failures: 0, lockedUntil: 0 };
}

/**
 * Writes the counter, and reports whether it landed anywhere durable.
 *
 * Returning the outcome is the whole point. The old version swallowed its own failure, so a caller counting
 * a wrong guess could not tell the difference between "counted" and "threw it away", and the honest
 * response to "this counter cannot be persisted" - refuse the attempt - was not available to it. A counter
 * that cannot be written must fail closed: if the count is not being kept, then `MAX_ATTEMPTS` is not
 * enforced, and the honest report of that is "locked" rather than "wrong, please try again". The mirror is
 * written in the same call and is what usually makes the outcome true; a false return means neither store
 * would take it.
 *
 * Both stores are written even when the first succeeds, because the mirror is what will be read if the
 * first one stops working, and a mirror that was only ever written when the primary failed would be empty
 * at the moment it was needed.
 */
function writeState(state: LockState): boolean {
  const encoded = JSON.stringify(state);
  let written = false;
  for (const s of [storage(), sessionStore()]) {
    if (!s) continue;
    try { s.setItem(STATE_KEY, encoded); written = true; } catch { /* private mode, or quota */ }
  }
  return written;
}

async function derive(code: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations, hash: 'SHA-256' },
    key,
    256
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The codes a first guess would reach for. */
export function isWeakCode(code: string): boolean {
  if (/^(\d)\1+$/.test(code)) return true;
  if (isRun(code)) return true;
  const year = new Date().getFullYear().toString();
  if (code === year || code === year.slice(-2)) return true;
  return false;
}

function isRun(code: string): boolean {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < code.length; i++) {
    const delta = code.charCodeAt(i) - code.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
  }
  return code.length > 2 && (ascending || descending);
}
