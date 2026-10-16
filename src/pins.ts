import type { Message } from './context';

/**
 * Reading and writing pinned messages on this device.
 *
 * Pins are a per-device reading convenience, kept in `localStorage` rather than on the server, and they are
 * stored as a bare `{ id }` reference. That is the whole design: a pin has to survive a reload, but a pin
 * of a private conversation must not become a second, readable copy of that conversation. The old version
 * stored the whole message, so the text of a pinned private message sat in `localStorage` in the clear - in
 * the one store the app had just gone to the trouble of encrypting for precisely this reason - and it
 * outlived signing out.
 *
 * Which makes loading a migration rather than a read. A store left by an older version still contains that
 * plaintext, so `loadPinned` rewrites it to ids on the way in. Returning a cleaned array while leaving the
 * old bytes in place would look correct and change nothing that matters.
 */

const KEY = 'wn_pinned';

/**
 * Kept at most this many per conversation.
 *
 * Exported because the reducer now does the deciding - it has to, or two pins toggled before the next
 * commit both read the same snapshot - and a cap that lives in two files is a cap that will drift.
 */
export const MAX_PINS = 20;

function readStore(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeStore(value: Record<string, unknown>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    // Private mode, or the quota is gone. The pin simply does not survive a reload, which is a far better
    // outcome than an exception thrown out of a click handler.
    return false;
  }
}

/** The reference for a pinned message: an id, and nothing that came with it. */
function pinRef(message: Message): Message {
  return { id: message.id, text: '' } as Message;
}

/**
 * Loads pins, reducing anything older than the id-only format.
 *
 * Also drops the read positions a previous version persisted for peers, which were never meant to outlive
 * the session.
 */
export function loadPinned(): Record<string, Message[]> {
  const parsed = readStore();
  const out: Record<string, Message[]> = {};
  let scrubbed = false;
  for (const [channel, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    out[channel] = list
      .filter((m: unknown): m is Message => !!m && typeof (m as Message).id === 'string')
      .map((m) => {
        // Text, sender or timestamp alongside the id means this row is a copy of a message.
        if (m.text || m.senderNickname || m.senderId) scrubbed = true;
        return pinRef(m);
      });
  }
  try { localStorage.removeItem('wn_read_upto'); } catch { /* storage unavailable */ }
  if (scrubbed) writeStore(out);
  return out;
}

/**
 * Replaces the pin list for one conversation.
 *
 * Two things happen here that used to be left to the callers, who did not agree with each other: the list
 * is capped, and every entry is reduced to a bare reference. `togglePin` already built an id-only object,
 * but only on that one path - so the guard belongs where the write does, or the next caller to pass a
 * whole message puts its text back on disk.
 *
 * Returns whether it reached disk. A store that refuses the write means the pins do not survive a reload,
 * which is better than an exception thrown out of a click handler.
 */
export function savePinned(pinned: Record<string, Message[]>): boolean {
  const capped: Record<string, Message[]> = {};
  for (const [channel, list] of Object.entries(pinned)) {
    capped[channel] = list.slice(0, MAX_PINS).map(pinRef);
  }
  return writeStore(capped);
}

/** Forgets every pin on this device, used when signing out. */
export function clearPinned(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing stored to remove */ }
}
