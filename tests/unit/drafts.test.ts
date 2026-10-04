import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setDraftsPassword, getDraft, setDraft, forgetDrafts, flushDrafts, channelsWithDrafts } from '../../src/drafts';
import { secureGet } from '../../src/secureStore';

/**
 * A draft is the one thing in the app the server never sees and the person never sent.
 *
 * Which is what made it the most valuable thing in a profile to steal, and it sat in `localStorage` in the
 * clear — right next to an app whose passcode lock promises that an unlocked machine reveals nothing. The
 * lock was not lying about the conversation on screen, but it was doing nothing about the sentence
 * somebody had typed and not yet sent.
 *
 * So drafts go into the same box as the rest of the local material. These check the property rather than
 * the mechanism: nothing readable on disk, nothing left after a sign-out, and nothing lost across a
 * reload.
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

const OLD = 'pass123456';
const NEW = 'hunter2hunter2';

beforeEach(async () => {
  store.clear();
  forgetDrafts();
  setDraftsPassword('');
});

describe('a draft', () => {
  it('is never written to storage in the clear', async () => {
    setDraftsPassword(OLD);
    setDraft('somebody', 'the thing I did not send yet');
    await flushDrafts();

    // nothing anywhere in the profile carries the words
    for (const [key, value] of store) {
      expect(value, `${key} holds the draft in the clear`).not.toContain('did not send');
    }
    // and there is no per-channel plaintext key left over from the version that used to
    for (const key of store.keys()) expect(key.startsWith('wn_draft_')).toBe(false);
  });

  it('opens under the account password afterwards', async () => {
    setDraftsPassword(OLD);
    setDraft('somebody', 'a private half-thought');
    await flushDrafts();

    const mine = await secureGet<Record<string, string>>('wn_drafts', OLD);
    expect(mine?.somebody).toBe('a private half-thought');
    // the wrong password gets nothing, which is the whole point of the box
    expect(await secureGet('wn_drafts', NEW)).toBeNull();
  });

  it('survives a reload, because that is the feature', async () => {
    setDraftsPassword(OLD);
    setDraft('somebody', 'still here after a restart');
    await flushDrafts();
    expect(getDraft('somebody')).toBe('still here after a restart');

    // A reload is a fresh module over the same storage, not a sign-out — signing out is *supposed* to
    // destroy the box, and using it here would have tested that instead of this.
    vi.resetModules();
    const reloaded = await import('../../src/drafts');
    reloaded.setDraftsPassword(OLD);
    await reloaded.whenDraftsHydrated();

    expect(reloaded.getDraft('somebody'), 'a draft did not survive a restart').toBe('still here after a restart');
  });

  it('keeps conversations apart', async () => {
    setDraftsPassword(OLD);
    setDraft('alice', 'for alice');
    setDraft('bob', 'for bob');
    expect(getDraft('alice')).toBe('for alice');
    expect(getDraft('bob')).toBe('for bob');
    expect(channelsWithDrafts().sort()).toEqual(['alice', 'bob']);
  });

  it('takes a draft with it when it is sent, rather than leaving it behind', async () => {
    setDraftsPassword(OLD);
    setDraft('alice', 'sent');
    await flushDrafts();
    setDraft('alice', '');
    await flushDrafts();

    expect(getDraft('alice')).toBe('');
    expect(channelsWithDrafts()).not.toContain('alice');
    const stored = await secureGet<Record<string, string>>('wn_drafts', OLD);
    expect(stored?.alice ?? '').toBe('');
  });

  it('goes when the account does', async () => {
    setDraftsPassword(OLD);
    setDraft('alice', 'never to be seen again');
    await flushDrafts();

    forgetDrafts();
    setDraftsPassword('');
    await flushDrafts();

    expect(getDraft('alice')).toBe('');
    expect(await secureGet('wn_drafts', OLD)).toBeNull();
    for (const value of store.values()) expect(value).not.toContain('never to be seen');
  });

  it('follows a password change, so the old one opens nothing', async () => {
    setDraftsPassword(OLD);
    setDraft('alice', 'written under the old password');
    await flushDrafts();

    setDraftsPassword(NEW);
    await flushDrafts();

    expect(getDraft('alice')).toBe('written under the old password');
    expect(await secureGet('wn_drafts', OLD)).toBeNull();
    expect(await secureGet<Record<string, string>>('wn_drafts', NEW)).toBeTruthy();
  });

  it('writes nothing at all before the account is known', async () => {
    // the ordering that matters: the app sets the password after sign-in, and anything typed before that
    // would otherwise be written under no key at all
    setDraft('alice', 'typed before sign-in finished');
    await flushDrafts();
    expect(store.size).toBe(0);
    // still in the tab, which is the honest outcome: it is not persisted and not lost
    expect(getDraft('alice')).toBe('typed before sign-in finished');
  });
});