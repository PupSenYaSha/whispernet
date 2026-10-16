import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadPinned, savePinned, clearPinned } from '../../src/pins';
import type { Message } from '../../src/context';

/**
 * What is on disk, not what is on screen.
 *
 * A pin used to be stored as the whole message, so pinning a private conversation wrote its decrypted text
 * into `localStorage` in the clear and kept it there across sign-out. The fix is not that the UI stopped
 * rendering the text - it is that the text is no longer kept at all, which makes these assertions about
 * bytes in the store rather than about components.
 */

/** A real store, minus the quota and privacy-mode behaviour. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as any).localStorage = store;
});
afterEach(() => {
  delete (globalThis as any).localStorage;
});

/** A pinned message as an older version would have left it. */
function legacyPin(id: string, text: string): Message {
  return { id, text, senderId: 'peer', senderNickname: 'bo', timestamp: 1, isOwn: false } as Message;
}

describe('a store written by an older version', () => {
  it('loses the text of pinned messages', () => {
    store.setItem('wn_pinned', JSON.stringify({
      general: [legacyPin('a', 'public thing')],
      peer1: [legacyPin('b', 'the thing we discussed last night')],
    }));

    const pins = loadPinned();

    expect(JSON.stringify(pins)).not.toContain('discussed');
    expect(Object.keys(pins)).toEqual(['general', 'peer1']);
  });

  it('rewrites the store, so the plaintext is gone from disk and not only from memory', () => {
    // The distinction that matters. Returning a clean array while leaving the old value in place passes
    // every other assertion in this file and leaves the private text in the file exactly as it was.
    store.setItem('wn_pinned', JSON.stringify({ peer1: [legacyPin('b', 'secret')] }));

    loadPinned();

    expect(store.getItem('wn_pinned')).not.toContain('secret');
  });

  it('keeps the id, since a pin still has to point at something', () => {
    store.setItem('wn_pinned', JSON.stringify({ peer1: [legacyPin('b', 'secret')] }));
    expect(loadPinned().peer1.map((p) => p.id)).toEqual(['b']);
  });

  it('drops the peer read positions a previous version persisted', () => {
    store.setItem('wn_read_upto', JSON.stringify({ peer1: 12 }));
    loadPinned();
    expect(store.getItem('wn_read_upto')).toBeNull();
  });

  it('leaves an already-migrated store byte for byte alone', () => {
    // Rewriting unconditionally would be a write on every single start, forever, for nothing.
    const before = JSON.stringify({ peer1: [{ id: 'b', text: '' }] });
    store.setItem('wn_pinned', before);

    loadPinned();

    expect(store.getItem('wn_pinned')).toBe(before);
  });

  it('survives a corrupt store instead of throwing during startup', () => {
    store.setItem('wn_pinned', '{"peer1": not json');
    expect(loadPinned()).toEqual({});
  });

  it('survives a store that is not an object', () => {
    store.setItem('wn_pinned', '["a","b"]');
    expect(loadPinned()).toEqual({});
  });

  it('discards entries that are not messages', () => {
    store.setItem('wn_pinned', JSON.stringify({ peer1: [{ nope: 1 }, null, { id: 'b' }] }));
    expect(loadPinned().peer1.map((p) => p.id)).toEqual(['b']);
  });

  it('reports an absent store as no pins', () => {
    expect(loadPinned()).toEqual({});
  });
});

describe('saving pins', () => {
  it('never writes message text, however it is called', () => {
    // The cap is the second line of defence; not storing the text is the first. A caller that hands over a
    // full message object must not be able to put its content back on disk.
    savePinned({ peer1: [legacyPin('b', 'secret')] });
    expect(store.getItem('wn_pinned')).not.toContain('secret');
  });

  it('holds the list to a sane number per conversation', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: '' }) as Message);
    savePinned({ peer1: many });
    expect(JSON.parse(store.getItem('wn_pinned')!).peer1).toHaveLength(20);
  });

  it('keeps the head of the list when it has to choose', () => {
    // Newest first: `togglePin` prepends, so the head is the most recent pin. Whatever it drops has to be
    // the tail, not the pin the user just added.
    const newestFirst = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, text: '' }) as Message);
    savePinned({ peer1: newestFirst });
    const ids = (JSON.parse(store.getItem('wn_pinned')!).peer1 as Message[]).map((m) => m.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('m0');
  });

  it('round-trips through load', () => {
    savePinned({ peer1: [{ id: 'b', text: '' } as Message] });
    expect(loadPinned().peer1.map((p) => p.id)).toEqual(['b']);
  });

  it('reports failure rather than throwing when the store refuses the write', () => {
    // Private mode. A pin that cannot be saved should not take a click handler down with it.
    (globalThis as any).localStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(savePinned({ peer1: [] })).toBe(false);
    expect(clearPinned()).toBeUndefined();
  });
});
