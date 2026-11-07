import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The plaintext of outgoing private messages is not left on disk.
 *
 * The app promises that the words of a private message are readable only by its two ends, and holds
 * identity keys and ratchet sessions encrypted at rest to keep that true. The cache of the sender's own
 * outgoing text used to sit in localStorage in the clear, up to three hundred messages, and signing out
 * did not touch it - so the browser profile was the one place on the machine where a private message
 * could simply be read.
 *
 * These run against the encrypted path. Where there is no WebCrypto they skip rather than pass
 * vacuously: a test that quietly measures nothing is how the original stayed in place.
 */

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const hasWebCrypto = typeof crypto !== 'undefined' && !!crypto.subtle;
const suite = hasWebCrypto ? describe : describe.skip;

const PASSWORD = 'a-long-enough-password';

beforeEach(() => store.clear());

suite('the own-message cache at rest', () => {
  it('never writes the words where a reader can find them', async () => {
    const cache = await import('../../src/ownMessageCache');
    const secure = await import('../../src/secureStore');
    cache.setOwnMessageCachePassword(PASSWORD);
    cache.forgetOwnMessages();

    const id = cache.newClientMessageId();
    cache.rememberOwnMessageText(id, 'the words of a private message');
    await cache.flushOwnMessageCache();

    const everything = [...store.values()].join('\n');
    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain('the words of a private message');

    // and the text is still there for the account that owns it
    expect(cache.recallOwnMessageText(id)).toBe('the words of a private message');
    const box = await secure.secureGet<Record<string, string>>('wn_own_dm_text', PASSWORD);
    expect(box?.[id]).toBe('the words of a private message');
  }, 60000);
  it('is unreadable with the wrong password', async () => {
    const secure = await import('../../src/secureStore');
    await secure.secureSet('wn_own_dm_text', PASSWORD, { a: 'secret text' });
    expect(store.get('wn_own_dm_text')!).not.toContain('secret text');
    expect(await secure.secureGet('wn_own_dm_text', 'a different password')).toBeNull();
    expect(await secure.secureGet('wn_own_dm_text', PASSWORD)).toEqual({ a: 'secret text' });
  }, 60000);

  it('is gone from disk the moment the account signs out', async () => {
    const cache = await import('../../src/ownMessageCache');
    cache.setOwnMessageCachePassword(PASSWORD);
    cache.forgetOwnMessages();
    const id = cache.newClientMessageId();
    cache.rememberOwnMessageText(id, 'still here after a reload');
    await cache.flushOwnMessageCache();
    expect(store.has('wn_own_dm_text')).toBe(true);

    cache.setOwnMessageCachePassword('');
    await cache.flushOwnMessageCache();
    expect(store.has('wn_own_dm_text')).toBe(false);
    expect(cache.recallOwnMessageText(id)).toBeNull();
  }, 60000);

  it('cannot be put back by a write that was already in flight at sign-out', async () => {
    // The write takes about a second, because the key it needs is derived at the same cost the identity
    // keys are. Signing out during one must not let it land afterwards and restore what was just cleared.
    const cache = await import('../../src/ownMessageCache');
    cache.setOwnMessageCachePassword(PASSWORD);
    cache.forgetOwnMessages();
    cache.rememberOwnMessageText(cache.newClientMessageId(), 'in flight');
    cache.setOwnMessageCachePassword('');
    await cache.flushOwnMessageCache();
    expect(store.has('wn_own_dm_text')).toBe(false);
  }, 60000);

  it('writes nothing at all before an account has unlocked it', async () => {
    const cache = await import('../../src/ownMessageCache');
    cache.forgetOwnMessages();
    cache.setOwnMessageCachePassword('');
    cache.rememberOwnMessageText(cache.newClientMessageId(), 'nothing to write');
    await cache.flushOwnMessageCache();
    expect(store.has('wn_own_dm_text')).toBe(false);
  }, 30000);

  it('keeps the newest messages and drops the oldest past the cap', async () => {
    const cache = await import('../../src/ownMessageCache');
    const secure = await import('../../src/secureStore');
    cache.setOwnMessageCachePassword(PASSWORD);
    cache.forgetOwnMessages();
    const first = cache.newClientMessageId();
    cache.rememberOwnMessageText(first, 'the very first one');
    for (let i = 0; i < 400; i++) cache.rememberOwnMessageText(cache.newClientMessageId(), 'm' + i);
    await cache.flushOwnMessageCache();

    expect(cache.recallOwnMessageText(first)).toBeNull();
    expect(cache.recallOwnMessageText(cache.newClientMessageId())).toBeNull();
    const stored = await secure.secureGet<Record<string, string>>('wn_own_dm_text', PASSWORD);
    expect(Object.keys(stored || {}).length).toBeLessThanOrEqual(300);
    // the tail is what survives, so the most recent send is still there
    expect(Object.values(stored || {})).toContain('m399');
  }, 60000);

  it('comes back after a reload, because the box is keyed by the account password', async () => {
    const first = await import('../../src/ownMessageCache');
    first.setOwnMessageCachePassword(PASSWORD);
    first.forgetOwnMessages();
    const id = first.newClientMessageId();
    first.rememberOwnMessageText(id, 'survives the reload');
    await first.flushOwnMessageCache();

    // A fresh module instance is what a reload looks like from here: the in-memory map is gone, the box
    // on disk is not. Signing in hydrates from it.
    vi.resetModules();
    const fresh = await import('../../src/ownMessageCache');
    fresh.setOwnMessageCachePassword(PASSWORD);
    // the hydration is asynchronous, and it is what a sign-in waits for
    await new Promise((r) => setTimeout(r, 2500));
    expect(fresh.recallOwnMessageText(id)).toBe('survives the reload');
  }, 60000);
});
