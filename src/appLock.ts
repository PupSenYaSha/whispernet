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

export const DEFAULT_APP_LOCK: AppLockSettings = { enabled: false, autoLockMs: 5 * 60_000 };

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
export function isAppLockSet(): boolean {
  const s = storage();
  return !!s && !!s.getItem(HASH_KEY);
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
    s.setItem(STATE_KEY, JSON.stringify({ failures: 0, lockedUntil: 0 }));
  } catch {
    return { ok: false, reason: 'Storage is unavailable' };
  }
  return { ok: true };
}

export async function clearAppLockCode(): Promise<void> {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(HASH_KEY);
    s.removeItem(STATE_KEY);
  } catch { /* nothing to clear */ }
}

/** Whether the code is currently being refused because too many attempts have failed. */
export function appLockLockedOut(): number {
  const state = readState();
  return Math.max(0, state.lockedUntil - Date.now());
}

export type UnlockResult = { ok: true } | { ok: false; reason: 'locked'; retryInMs: number } | { ok: false; reason: 'wrong' };

export async function unlockAppLock(code: string): Promise<UnlockResult> {
  const remaining = appLockLockedOut();
  if (remaining > 0) return { ok: false, reason: 'locked', retryInMs: remaining };

  const stored = readHash();
  if (!stored) return { ok: true };
  const hash = await derive(code, new Uint8Array(base64ToBuf(stored.salt)), stored.iterations);
  if (!constantTimeEqual(bufToBase64(hash), stored.hash)) {
    const state = readState();
    state.failures += 1;
    if (state.failures >= MAX_ATTEMPTS) {
      state.lockedUntil = Date.now() + LOCKOUT_MS;
      state.failures = 0;
    }
    writeState(state);
    return { ok: false, reason: 'wrong' };
  }
  writeState({ failures: 0, lockedUntil: 0 });
  return { ok: true };
}

function readHash(): StoredHash | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(HASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredHash;
    if (parsed?.v !== 1 || typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function readState(): LockState {
  const s = storage();
  if (!s) return { failures: 0, lockedUntil: 0 };
  try {
    const raw = s.getItem(STATE_KEY);
    if (!raw) return { failures: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw);
    return {
      failures: typeof parsed?.failures === 'number' ? parsed.failures : 0,
      lockedUntil: typeof parsed?.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { failures: 0, lockedUntil: 0 };
  }
}

function writeState(state: LockState): void {
  try { storage()?.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
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
