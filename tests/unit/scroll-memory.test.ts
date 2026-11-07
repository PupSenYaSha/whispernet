import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberScrollPosition,
  recallScrollPosition,
  forgetScrollPosition,
  forgetAllScrollPositions,
} from '../../src/scrollMemory';

/**
 * Keeping the reader's place when the layout is swapped underneath them.
 *
 * The mobile and desktop trees are different components, so crossing 768px unmounts the list. Scroll
 * position is the one piece of reading state a person would actually miss - everything else about a
 * conversation is either in the store or re-derivable - and it used to snap to the newest message.
 */
describe('scroll memory', () => {
  beforeEach(() => forgetAllScrollPositions());

  it('comes back to where it was', () => {
    rememberScrollPosition('general', 4200, 12000);
    expect(recallScrollPosition('general', 12000, 800)).toBe(4200);
  });

  it('leaves the list alone when nothing was remembered', () => {
    expect(recallScrollPosition('general', 12000, 800)).toBeNull();
  });

  it('does not restore anything for a list at the bottom', () => {
    // At the bottom the list scrolls there by itself on mount, and a restored offset would only fight it.
    // Being at the bottom is the common case, so getting this wrong would affect everyone rather than the
    // few reading back through history.
    rememberScrollPosition('general', 11200, 12000);
    expect(recallScrollPosition('general', 12000, 800)).toBeNull();
  });

  it('treats "just above the bottom" as the bottom', () => {
    // Within a row of the bottom counts as following along; the list's own threshold is 120px.
    rememberScrollPosition('general', 12000 - 800 - 100, 12000);
    expect(recallScrollPosition('general', 12000, 800)).toBeNull();
  });

  it('restores a position above that threshold', () => {
    // 400px from the bottom of a 12000px list in an 800px viewport.
    rememberScrollPosition('general', 12000 - 800 - 400, 12000);
    expect(recallScrollPosition('general', 12000, 800)).toBe(10800);
  });

  it('refuses an offset the new content cannot reach', () => {
    // The list came back shorter than it was remembered. Honouring the offset would pin the reader past
    // the end of the conversation, where there is nothing to read.
    rememberScrollPosition('general', 9000, 12000);
    expect(recallScrollPosition('general', 4000, 800)).toBeNull();
  });

  it('keeps conversations apart', () => {
    rememberScrollPosition('general', 100, 5000);
    rememberScrollPosition('peer1', 3000, 5000);
    expect(recallScrollPosition('general', 5000, 800)).toBe(100);
    expect(recallScrollPosition('peer1', 5000, 800)).toBe(3000);
  });

  it('ignores an unnamed conversation', () => {
    // Nothing to key it by, so remembering it would leak one conversation's position into another's.
    rememberScrollPosition('', 1234, 5000);
    expect(recallScrollPosition('', 5000, 800)).toBeNull();
  });

  it('forgets one conversation on request', () => {
    rememberScrollPosition('peer1', 100, 5000);
    forgetScrollPosition('peer1');
    expect(recallScrollPosition('peer1', 5000, 800)).toBeNull();
  });

  it('takes the most recent position, not the first', () => {
    rememberScrollPosition('general', 100, 5000);
    rememberScrollPosition('general', 3000, 5000);
    expect(recallScrollPosition('general', 5000, 800)).toBe(3000);
  });
});
