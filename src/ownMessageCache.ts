/**
 * The plaintext of this account's own outgoing private messages, so the sender can read them back.
 *
 * A direct message is sealed to the recipient, so its author cannot open what it just wrote from the
 * ciphertext alone. The copy that lets it do so is encrypted to the account's own key, which is enough
 * for the sender and every one of its other devices - so this cache is a convenience and not the only
 * route, and it is deliberately not kept anywhere in the clear.
 *
 * It used to be a plain `localStorage` map of the last three hundred messages. That was the one place
 * the app's central claim did not hold: the words of a private message were on disk in the browser
 * profile, readable by anything with access to it, and signing out left them there. It is now held in
 * memory for the tab and, when it is written at all, written as an AES-GCM box under the account
 * password.
 */

import { secureGet, secureRemove, secureSet } from './secureStore';

const STORAGE_KEY = 'wn_own_dm_text';
const MAX_ENTRIES = 300;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Held for the tab, so the common case never touches storage at all. */
const memory = new Map<string, string>();

/** The account password, once a session has supplied it. Without it nothing is written to disk. */
let password = '';
/** Whether the on-disk copy still holds what was written under the previous password. */
let dirty = false;
/**
 * Bumped whenever the account changes.
 *
 * A write takes about a second, because the key it needs is derived at the same cost the identity keys
 * are. Signing out in the middle of one must not let it land afterwards and put the words back on disk
 * after the box has been cleared, so a write checks this before it stores anything.
 */
let generation = 0;

export function setOwnMessageCachePassword(next: string): void {
  if (next === password) return;
  generation++;
  password = next || '';
  if (password) {
    // a different password means whatever is on disk was written under the old one
    void hydrate(password);
  } else {
    // signing out: the tab copy goes with it, and so does anything left on disk
    memory.clear();
    secureRemove(STORAGE_KEY);
    dirty = false;
  }
}

async function hydrate(withPassword: string): Promise<void> {
  const stored = await secureGet<Record<string, string>>(STORAGE_KEY, withPassword);
  if (!stored) return;
  for (const [id, text] of Object.entries(stored)) {
    if (isValidClientMessageId(id) && typeof text === 'string') memory.set(id, text);
  }
}

let pending: Promise<void> = Promise.resolve();

async function persist(): Promise<void> {
  if (!password || !dirty) return;
  dirty = false;
  const withPassword = password;
  const mine = generation;
  const all: Record<string, string> = {};
  // insertion order is the oldest-first order the map keeps, so the tail is the most recent
  const entries = [...memory.entries()];
  for (const [id, text] of entries.slice(Math.max(0, entries.length - MAX_ENTRIES))) all[id] = text;
  await secureSet(STORAGE_KEY, withPassword, all);
  // the account changed while the key was being derived: the box has already been cleared, and putting
  // it back would undo the sign-out that just happened
  if (mine !== generation) await secureRemove(STORAGE_KEY);
}

/** Waits for the write in flight, which is what a sign-out or a test needs before it moves on. */
export function flushOwnMessageCache(): Promise<void> {
  return pending;
}

export function newClientMessageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function isValidClientMessageId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

function getStorage(explicit?: StorageLike): StorageLike | null {
  if (explicit) return explicit;
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * The plain-storage variant, kept for the tests and for nothing else.
 *
 * Production goes through the encrypted box above; this exists so the id validation and the eviction
 * order can still be exercised without a password.
 */
export function rememberOwnMessageTextPlain(id: string, text: string, storage?: StorageLike): void {
  if (!isValidClientMessageId(id) || !text) return;
  const s = getStorage(storage);
  if (!s) return;
  let all: Record<string, string> = {};
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        all = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (isValidClientMessageId(k) && typeof v === 'string') all[k] = v;
        }
      }
    }
  } catch { /* start from empty rather than fail the send */ }
  all[id] = text;
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
  }
  try { s.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* a full disk is not worth an error */ }
}

export function recallOwnMessageTextPlain(id: unknown, storage?: StorageLike): string | null {
  if (!isValidClientMessageId(id)) return null;
  const s = getStorage(storage);
  if (!s) return null;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = (parsed as Record<string, unknown>)[id as string];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

export function rememberOwnMessageText(id: string, text: string): void {
  if (!isValidClientMessageId(id) || !text) return;
  memory.set(id, text);
  if (memory.size > MAX_ENTRIES) {
    const keys = [...memory.keys()];
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) memory.delete(k);
  }
  dirty = true;
  // writes are chained rather than fired in parallel: two concurrent writes would race on the box, and
  // the slower of the two could land first and lose the newer messages
  pending = pending.then(persist, persist);
}

export function recallOwnMessageText(id: unknown): string | null {
  if (!isValidClientMessageId(id)) return null;
  return memory.get(id as string) || null;
}

export function forgetOwnMessages(): void {
  memory.clear();
  dirty = false;
  secureRemove(STORAGE_KEY);
}

/**
 * Rewrites the box under a new password.
 *
 * The contents are already in memory, so this is the same re-wrap as the ratchet stores: mark dirty and
 * let the normal write path do it, with the password swapped first. Ordered after that swap deliberately
 * - the write derives from whatever the current password is, so doing it the other way round would
 * cheerfully re-encrypt the words under the old one.
 */
export function rekeyOwnMessageCache(newPassword: string): Promise<void> {
  generation++;
  password = newPassword;
  if (!newPassword) {
    memory.clear();
    secureRemove(STORAGE_KEY);
    dirty = false;
    return pending;
  }
  // whatever was on disk was written under the old password and cannot be read now; the tab copy is the
  // only remaining source, so it becomes the contents
  dirty = true;
  pending = pending.then(persist, persist);
  return pending;
}