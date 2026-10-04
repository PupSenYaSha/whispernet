import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediaCache, BYTE_BUDGET, ENTRY_LIMIT } from '../../src/mediaCache';

/**
 * The media cache bounded how many decrypted attachments it held, and not how much.
 *
 * An attachment is allowed to be a gigabyte, so the ceiling was a hundred entries — a hundred gigabytes
 * of plaintext, on a phone that has never had a hundred gigabytes of anything. Counting entries quietly
 * assumed the files were avatar-sized, which is the one thing about them that was never true.
 *
 * A broken download is a different story, and the better one. `decryptChunkedBody` only reaches the `Blob`
 * constructor if its loop finished, so a stream that dies at chunk forty-five of a hundred unwinds and
 * drops what it had, and no half-file is ever built. That case is covered in media-stream-bounds.
 */

const revoked: string[] = [];
let created = 0;

beforeEach(() => {
  revoked.length = 0;
  created = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:fake/${created++}`,
    revokeObjectURL: (u: string) => { revoked.push(u); },
  });
});

const MB = 1024 * 1024;

describe('the decrypted media cache', () => {
  it('gives up an oversized attachment rather than keeping bytes it cannot afford', () => {
    const cache = new MediaCache();

    cache.put('a', 'blob:a', 200 * MB);
    cache.retain('a');
    expect(cache.has('a')).toBe(true); // inside the budget, and it has to survive or nothing works

    // 'a' scrolls out of the list, and a fresh gigabyte-class file is decrypted
    cache.release('a');
    cache.put('b', 'blob:b', 300 * MB);
    // 'b' is bigger than the whole budget by itself, so once nobody is looking at it there is no way to
    // be under the line while holding it
    cache.release('b');

    expect(cache.has('a'), 'a stale oversized attachment was kept').toBe(false);
    expect(cache.has('b'), 'an attachment that cannot fit the budget was kept after release').toBe(false);
    expect(cache.bytes()).toBeLessThanOrEqual(BYTE_BUDGET);
  });

  it('comes back under the budget the moment the last bubble lets go', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 100 * MB);
    cache.retain('a');
    cache.put('b', 'blob:b', 100 * MB);
    cache.retain('b');
    cache.put('c', 'blob:c', 100 * MB);
    cache.retain('c');
    expect(cache.bytes()).toBe(300 * MB); // over, and nothing to take

    cache.release('a');
    // releasing is the only event that could have freed anything, so the budget is met right here rather
    // than whenever the next attachment happens to be decrypted
    expect(cache.bytes()).toBe(200 * MB);
    expect(cache.has('a')).toBe(false);
  });

  it('takes the unpinned one first, and never the one on screen', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 200 * MB);
    cache.retain('a');
    cache.put('b', 'blob:b', 300 * MB);
    cache.retain('b');

    // both claimed, so nothing may go: the budget is exceeded rather than met by breaking what is on screen
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.bytes()).toBe(500 * MB);
    expect(revoked).toEqual([]);
  });

  it('never revokes a url in the gap before its bubble has taken over the claim', () => {
    // a chat full of media: every entry is put in a burst and every bubble adopts afterwards
    const cache = new MediaCache();
    for (let i = 0; i < 40; i++) cache.put(`m${i}`, `blob:${i}`, 20 * MB);
    // nothing adopted yet, and the total is eight hundred megabytes over a two hundred and fifty six
    // megabyte budget — so eviction ran forty times and had nothing it was allowed to take
    expect(cache.bytes()).toBe(800 * MB);
    expect(revoked).toEqual([]);

    // and now the bubbles mount
    for (let i = 0; i < 40; i++) cache.retain(`m${i}`);
    expect([...Array(40).keys()].every((i) => cache.has(`m${i}`))).toBe(true);
  });

  it('frees an entry once the last bubble lets it go', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 200 * MB);
    cache.retain('a');
    // one bubble per message, so one release is what it takes — the claim `put` made is adopted, not stacked
    cache.release('a');
    expect(cache.tracked()).toBe(0);

    cache.put('b', 'blob:b', 100 * MB);
    cache.retain('b');
    expect(cache.has('a')).toBe(false);
    expect(cache.bytes()).toBe(100 * MB);
  });

  it('counts two bubbles showing one message, and frees it when both go', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 100 * MB);
    cache.retain('a');
    cache.retain('a');
    cache.release('a');
    // the second bubble is still showing it
    expect(cache.has('a')).toBe(true);
    cache.release('a');
    expect(cache.tracked()).toBe(0);
  });

  it('stops counting bytes once nothing is holding an entry', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 200 * MB);
    cache.retain('a');
    expect(cache.bytes()).toBe(200 * MB);

    cache.release('a');
    cache.put('b', 'blob:b', 100 * MB);
    // 'a' is evictable again, so it is the one that goes, and the total drops with it
    expect(cache.has('a')).toBe(false);
    expect(cache.bytes()).toBe(100 * MB);
  });

  it('forgets ids nothing is holding, instead of one per media message for the life of the tab', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 1024);
    cache.retain('a');
    cache.release('a');
    expect(cache.tracked()).toBe(0);
  });

  it('still bounds itself by count when the files are small', () => {
    const cache = new MediaCache();
    for (let i = 0; i < ENTRY_LIMIT + 10; i++) {
      cache.put(`m${i}`, `blob:${i}`, 1024);
      cache.retain(`m${i}`);
      cache.release(`m${i}`); // scrolled past: kept in the cache, wanted by nobody
    }
    // far below the byte budget, so only the count can be what stopped this
    expect(cache.bytes()).toBeLessThan(BYTE_BUDGET);
    expect([...Array(ENTRY_LIMIT + 10).keys()].filter((i) => cache.has(`m${i}`)).length).toBe(ENTRY_LIMIT);
  });

  it('revokes everything on sign-out, bytes included', () => {
    const cache = new MediaCache();
    cache.put('a', 'blob:a', 100 * MB);
    cache.retain('a');
    cache.clear();
    expect(cache.bytes()).toBe(0);
    expect(cache.tracked()).toBe(0);
    expect(revoked).toContain('blob:a');
  });
});