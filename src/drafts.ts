/**
 * Where the half-typed message for a conversation is kept.
 *
 * Per conversation, on this device, and encrypted — which is the part that changed.
 *
 * A draft used to go into `localStorage` in the clear. That is defensible for a message already sent and
 * indefensible for one that was never sent: the app has a passcode lock whose entire promise is that
 * nobody who picks up an unlocked machine can read what is on the screen, and a draft sitting in plain
 * text next to it quietly removes that promise for exactly the conversation somebody was in the middle of
 * thinking about. It is also the only place the app kept words the server had never seen and would never
 * see, which made it the most valuable thing in the profile to steal.
 *
 * So it goes in the same box the rest of the local material does, under the account password. In memory
 * for the tab, written out on a debounce — the same shape as the own-message cache, for the same reason:
 * the key behind the box is derived at six hundred thousand PBKDF2 iterations, and doing that on every
 * keystroke would be felt as lag on every character.
 */

import { secureGet, secureRemove, secureSet } from './secureStore';

const STORAGE_KEY = 'wn_drafts';

type ChannelMap = Record<string, string>;

/** Held for the tab, so the common case never touches storage or a key derivation. */
const memory = new Map<string, string>();

let password = '';
let dirty = false;
/**
 * Bumped whenever the account changes.
 *
 * The write is a chain of timers, and a sign-out in the middle of one must not be undone by a write that
 * lands afterwards — that would put the words back on disk after the box was cleared. So a write checks
 * this before it stores anything, the same guard the own-message cache uses.
 */
let generation = 0;

/** Writes and the initial load, chained so two of them cannot interleave on one box. */
let pending: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;

export function setDraftsPassword(next: string): void {
  if (next === password) return;
  generation++;
  password = next || '';
  if (!password) {
    // signing out: the tab copy goes, and so does anything left on disk
    memory.clear();
    secureRemove(STORAGE_KEY);
    dirty = false;
    return;
  }
  // queued onto the same chain as the writes, so two of them cannot interleave on one box
  pending = pending.then(() => hydrate(password), () => hydrate(password));
  // Anything already in the tab has to be re-wrapped under the new password even though nothing was
  // typed after the change. Without this the box on disk stays sealed under the old one and the previous
  // password carries on opening it, which is the opposite of what changing a password is for.
  if (memory.size > 0) dirty = true;
}

async function hydrate(withPassword: string): Promise<void> {
  const stored = await secureGet<ChannelMap>(STORAGE_KEY, withPassword);
  if (!stored) return;
  for (const [channel, text] of Object.entries(stored)) {
    if (typeof text === 'string') memory.set(channel, text);
  }
}

/**
 * Waits for the load in flight.
 *
 * It matters beyond a test: a draft restored from disk has to be in the box before the composer looks for
 * it, and the composer looks synchronously. Signing in and typing into a chat in the same tick would
 * otherwise write a new draft over a box whose contents had not arrived yet.
 */
export function whenDraftsHydrated(): Promise<void> {
  return pending;
}

/** Every draft for this account, keyed by channel. Synchronous: the tab already has them. */
export function draftSnapshot(): ChannelMap {
  const out: ChannelMap = {};
  for (const [channel, text] of memory) out[channel] = text;
  return out;
}

export function getDraft(channel: string): string {
  return memory.get(channel) || '';
}

export function setDraft(channel: string, text: string): void {
  if (!channel) return;
  if (text) memory.set(channel, text);
  else memory.delete(channel);
  if (!password) return;
  dirty = true;
  schedulePersist();
}

function schedulePersist(): void {
  if (timer) clearTimeout(timer);
  // a person types in bursts; one write a second behind the last keystroke is indistinguishable from one
  // that keeps up, and costs nothing while they are thinking
  timer = setTimeout(() => {
    timer = null;
    pending = pending.then(persist, persist);
  }, 1000);
}

/** Waits for the write in flight, which is what a sign-out or a test needs before it moves on. */
export function flushDrafts(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  pending = pending.then(persist, persist);
  return pending;
}

async function persist(): Promise<void> {
  if (!password || !dirty) return;
  dirty = false;
  const withPassword = password;
  const mine = generation;
  await secureSet(STORAGE_KEY, withPassword, draftSnapshot());
  // the account changed while the key was being derived: the box has been cleared, and putting it back
  // would undo a sign-out that already happened
  if (mine !== generation) await secureRemove(STORAGE_KEY);
}

export function forgetDrafts(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  memory.clear();
  dirty = false;
  secureRemove(STORAGE_KEY);
}

/** The channels that currently hold a draft, for a test or a settings entry that lists them. */
export function channelsWithDrafts(): string[] {
  return [...memory.keys()];
}