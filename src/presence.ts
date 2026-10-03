/**
 * Typing indicators and read receipts, kept in one place because they share a shape.
 *
 * Both are things one person tells the other end of a conversation, and both are relayed and then
 * forgotten: the server writes neither down. That is a deliberate trade rather than a missing feature.
 * A stored "who was typing in which chat, when" is a record of social graph and attention that a
 * messenger does not need in order to show a tick, and this server already tries to hold as little
 * about who talks to whom as it can get away with. The cost is that a receipt means "some device of
 * theirs looked", not "both of them looked", which is the truth anyway.
 *
 * What is kept locally is per conversation and per device, so signing in on a second machine does not
 * inherit somebody else's reading position.
 */

const TYPING_KEY = 'wn_typing_seen';
const READ_KEY = 'wn_read_upto';
/** How long a relayed "still typing" is shown after it arrives. */
export const TYPING_VISIBLE_MS = 6000;
/** How often a typing signal goes out while somebody keeps typing. */
export const TYPING_THROTTLE_MS = 3000;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/** Drops entries older than a week so neither map can grow without bound. */
function prune<T extends Record<string, number>>(map: T, maxAgeMs: number): T {
  const cutoff = Date.now() - maxAgeMs;
  for (const key of Object.keys(map)) {
    if (!(map[key] > cutoff)) delete map[key];
  }
  return map;
}

export function loadReadUpTo(): Record<string, number> {
  return prune(readJson<Record<string, number>>(READ_KEY, {}), 90 * 24 * 60 * 60 * 1000);
}

export function saveReadUpTo(map: Record<string, number>): void {
  writeJson(READ_KEY, prune({ ...map }, 90 * 24 * 60 * 60 * 1000));
}

/**
 * Whether a conversation is showing as typed-in right now.
 *
 * Reads the stored timestamps rather than a live flag so that a signal which arrived before a reload
 * still expires on schedule instead of sticking.
 */
export function isTypingRecently(typingUntil: Record<string, number> | undefined, channel: string): boolean {
  if (!typingUntil) return false;
  const until = typingUntil[channel];
  return typeof until === 'number' && until > Date.now();
}

/** Records a relayed typing signal, keeping the later of the two times. */
export function noteTyping(typingUntil: Record<string, number>, channel: string, now: number = Date.now()): Record<string, number> {
  const next = { ...typingUntil, [channel]: now + TYPING_VISIBLE_MS };
  for (const key of Object.keys(next)) {
    if (next[key] <= now) delete next[key];
  }
  return next;
}

/** Whether this device has told the far end it has read as far as the given message. */
export function hasReadUpTo(readUpTo: Record<string, number> | undefined, channel: string, timestamp: number): boolean {
  if (!readUpTo) return false;
  const upTo = readUpTo[channel];
  return typeof upTo === 'number' && upTo >= timestamp;
}

export function noteRead(readUpTo: Record<string, number>, channel: string, upTo: number): Record<string, number> {
  const existing = readUpTo[channel];
  // a receipt never moves backwards: a device that has seen a message cannot unsee it
  if (typeof existing === 'number' && existing >= upTo) return readUpTo;
  return { ...readUpTo, [channel]: upTo };
}

export { TYPING_KEY };
