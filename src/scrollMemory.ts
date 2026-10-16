/**
 * Where the reader was in a conversation, kept outside React.
 *
 * The mobile and desktop layouts are two different trees, and crossing 768px swaps one for the other. That
 * unmounts the message list, and the list's own state went with it - most visibly the scroll position, so
 * dragging a window across the breakpoint while reading back through history threw the reader to the bottom
 * of the conversation.
 *
 * Component state cannot survive this, because the component that holds it is destroyed; so the position is
 * held here instead, keyed by conversation and written from the scroll handler. Anything that survives a
 * remount for a reason other than the breakpoint - a StrictMode double mount in development, a tab restored
 * from the back/forward cache - gets the same treatment, because the failure is identical.
 *
 * It is deliberately not persisted to disk. Scroll position is not something to carry between devices, and
 * restoring one across a relaunch would fight the list's own "go to the newest message" behaviour.
 */

/** How close to the bottom counts as "at the bottom", and so needs no restoration. */
const NEAR_BOTTOM_SLOP = 120;

interface Remembered {
  scrollTop: number;
  scrollHeight: number;
}

const positions = new Map<string, Remembered>();

/**
 * How many conversations are worth remembering.
 *
 * Bounded because nothing else bounds it. `forgetScrollPosition` is the intended way to drop one, and it
 * is only ever called from tests - a conversation that is closed is not the same as one that will not be
 * reopened, so dropping on close would lose the position of somebody who switched tabs and came back. The
 * map therefore only ever grew, keyed by a peer id the server supplies, for as long as the tab was open.
 * Entries are small, but "for the life of the tab" is the thing being fixed here, not the size of each one.
 */
const MAX_REMEMBERED = 50;

/** Records where the list is. Cheap enough to call from the scroll handler. */
export function rememberScrollPosition(channel: string, scrollTop: number, scrollHeight: number): void {
  if (!channel) return;
  // deleted first so the re-insert moves this conversation to the end: `Map` keeps insertion order, which
  // makes the head the least recently seen one. This runs from the scroll handler, so it is on a hot path,
  // and the eviction is at worst one delete.
  positions.delete(channel);
  positions.set(channel, { scrollTop, scrollHeight });
  while (positions.size > MAX_REMEMBERED) {
    const oldest = positions.keys().next();
    if (oldest.done) break;
    positions.delete(oldest.value);
  }
}

/**
 * The position to come back to, or `null` to behave as if there were none.
 *
 * Returns null when the reader was at the bottom, because the list scrolls there on mount by itself and
 * restoring a remembered near-bottom offset would only ever fight it. Also null once the content has grown
 * so much that the old offset no longer means anything.
 */
export function recallScrollPosition(channel: string, scrollHeight: number, clientHeight: number): number | null {
  const saved = positions.get(channel);
  if (!saved) return null;
  const wasNearBottom = saved.scrollHeight - saved.scrollTop - clientHeight < NEAR_BOTTOM_SLOP;
  if (wasNearBottom) return null;
  // Measured against the previous content, so a shorter list than remembered means the offset is meaningless.
  //
  // The bound is `scrollHeight - clientHeight`, not `scrollHeight`. A scroll offset can never exceed the
  // scrollable distance, so comparing it with the full height lets an offset that no longer fits pass the
  // check - and assigning it is silently clamped to the maximum, dropping the reader somewhere in the list
  // they were never in, with nothing to say so. `Math.max` because the list can be shorter than the window
  // itself, which leaves nothing to scroll.
  if (saved.scrollTop > Math.max(0, scrollHeight - clientHeight)) return null;
  return saved.scrollTop;
}

/** Forgets one conversation, for when it is closed or signed out. */
export function forgetScrollPosition(channel: string): void {
  positions.delete(channel);
}

/** Forgets everything. */
export function forgetAllScrollPositions(): void {
  positions.clear();
}
