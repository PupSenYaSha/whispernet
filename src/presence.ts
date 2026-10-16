/**
 * Typing indicators and read receipts, kept in one place because they share a shape.
 *
 * Both are things one person tells the other end of a conversation, and both are relayed and then
 * forgotten: the server writes neither down, and neither does this file. That is a deliberate trade rather
 * than a missing feature. A stored "who was typing in which chat, when", or "how far have they read" is a
 * record of social graph and attention that a messenger does not need in order to show a tick, and this
 * server already tries to hold as little about who talks to whom as it can get away with. The cost is that
 * a receipt means "some device of theirs looked", not "both of them looked", which is the truth anyway.
 *
 * Nothing here touches storage. It used to: read positions went out under `wn_read_upto`, pruned only after
 * ninety days and never removed on sign-out, so a record of how far each contact had read each conversation
 * sat on disk outliving the session that built it. Every map in this file is per tab, which also means a
 * second machine does not inherit anybody's reading position.
 */

/** How long a relayed "still typing" is shown after it arrives. */
export const TYPING_VISIBLE_MS = 6000;
/** How often a typing signal goes out while somebody keeps typing. */
export const TYPING_THROTTLE_MS = 3000;

/**
 * How many conversations a tab tracks read positions for.
 *
 * `noteTyping` prunes itself, because an expired typing signal has a natural expiry. A read position has
 * none: it stays true until the peer reads further, so the map only ever grew, keyed by a peer id the
 * server supplies, and nothing dropped an entry except signing out. Capped by dropping the *least* advanced
 * entries, which are exactly the ones no tick is drawn from - the value is a timestamp, so the furthest
 * behind is the least recently used.
 */
export const MAX_READ_CHANNELS = 200;

/**
 * How far the *other* end has said it has read, for this tab only.
 *
 * This is the peer's position, and the only one that is kept. How far this device has read is a different
 * thing and lives in a ref - `ownReadRef` in App.tsx - because the two used to share this map, so reading
 * our own incoming message wrote the entry the "Seen" tick is drawn from and an outgoing message could show
 * as read on the strength of our having received it, with the other person having said nothing.
 */
export function noteRead(readUpTo: Record<string, number>, channel: string, upTo: number): Record<string, number> {
  const existing = readUpTo[channel];
  // never moves backwards: a late frame from a device that was behind must not un-tick a message
  if (typeof existing === 'number' && existing >= upTo) return readUpTo;
  const next = { ...readUpTo, [channel]: upTo };
  // The sort is only paid once the cap is actually exceeded, which for most people never happens.
  //
  // The incoming conversation is excluded from the eviction. Sorting ascending by timestamp and dropping the
  // tail would otherwise be free to drop the entry that was just added - a receipt for an older message in
  // a newly-tracked conversation has the *lowest* value of any, so it would be written and immediately
  // discarded, and nothing would ever put it back: `SET_READ` is not re-dispatched for that `upTo`, so the
  // "Seen" tick simply never appears.
  const others = Object.keys(next).filter((k) => k !== channel);
  if (others.length > MAX_READ_CHANNELS - 1) {
    others.sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0));
    for (const key of others.slice(0, others.length - (MAX_READ_CHANNELS - 1))) delete next[key];
  }
  return next;
}

/**
 * Whether a conversation is showing as typed-in right now.
 *
 * Compared against a clock rather than held as a flag, so a signal that arrived before a reload still
 * expires on schedule instead of sticking for the life of the tab.
 */
export function isTypingRecently(typingUntil: Record<string, number> | undefined, channel: string): boolean {
  if (!typingUntil) return false;
  const until = typingUntil[channel];
  return typeof until === 'number' && until > Date.now();
}

/** Records a relayed typing signal, keeping the later of the two times and dropping expired ones. */
export function noteTyping(typingUntil: Record<string, number>, channel: string, now: number = Date.now()): Record<string, number> {
  const next = { ...typingUntil, [channel]: now + TYPING_VISIBLE_MS };
  for (const key of Object.keys(next)) {
    if (next[key] <= now) delete next[key];
  }
  return next;
}

/** Whether the other end has said it has read as far as the given message. */
export function hasReadUpTo(readUpTo: Record<string, number> | undefined, channel: string, timestamp: number): boolean {
  if (!readUpTo) return false;
  const upTo = readUpTo[channel];
  return typeof upTo === 'number' && upTo >= timestamp;
}