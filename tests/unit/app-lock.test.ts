import { describe, it, expect, beforeEach } from 'vitest';

/**
 * The passcode that has to be entered before the conversation is shown.
 *
 * This is the one control in the app whose whole threat model is "somebody picked up an unlocked
 * machine", so the interesting cases are the ones where it reports itself as working and is not.
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

const { setAppLockCode, unlockAppLock, clearAppLockCode, isAppLockSet, isWeakCode, appLockLockedOut } =
  await import('../../src/appLock');

const CODE = '739182';
const HASH_KEY = 'wn_app_lock_hash';

beforeEach(async () => {
  store.clear();
  await clearAppLockCode();
});

describe('the app lock code', () => {
  it('opens with the code that was set and refuses any other', async () => {
    expect((await setAppLockCode(CODE)).ok).toBe(true);
    expect(isAppLockSet()).toBe(true);

    expect((await unlockAppLock('000000')).ok).toBe(false);
    expect((await unlockAppLock(CODE)).ok).toBe(true);
  });

  it('lets anybody in when no code was ever set', async () => {
    expect(isAppLockSet()).toBe(false);
    expect((await unlockAppLock('')).ok).toBe(true);
  });

  it('refuses the codes that make a lock theatre', () => {
    expect(isWeakCode('111111')).toBe(true);
    expect(isWeakCode('123456')).toBe(true);
    expect(isWeakCode('654321')).toBe(true);
    expect(isWeakCode(CODE)).toBe(false);
  });

  it('stops answering for a while after ten wrong guesses', async () => {
    await setAppLockCode(CODE);
    for (let i = 0; i < 10; i++) expect((await unlockAppLock('000000')).ok).toBe(false);

    expect(appLockLockedOut()).toBeGreaterThan(0);
    // the right code is refused while the lockout stands, which is the point of it
    expect(await unlockAppLock(CODE)).toMatchObject({ ok: false, reason: 'locked' });
  });

  /**
   * A code that is set but whose stored hash cannot be read.
   *
   * This used to answer "unlocked". `readHash` returned null both when there was nothing stored and when
   * what was stored would not parse, and `unlockAppLock` read that single null as permission to let
   * somebody in — so a truncated write or a half-cleared entry turned the lock off while `isAppLockSet`
   * went on reporting a passcode as configured, and Settings kept offering to turn it off. A lock that
   * reports itself as working while it is not is worse than no lock at all, because it is believed.
   *
   * Failing closed without a way out would just be a different kind of broken, so the answer is distinct
   * and the gate offers to stand down.
   */
  it('refuses to open when the stored hash cannot be read', async () => {
    await setAppLockCode(CODE);
    expect(isAppLockSet()).toBe(true);

    for (const damaged of ['not json at all', '{"v":1}', '{"v":1,"salt":"AA==","hash":"AA=="}', '{"v":2,"salt":"AA==","hash":"AA==","iterations":310000}']) {
      store.set(HASH_KEY, damaged);
      const result = await unlockAppLock(CODE);
      expect(result.ok, `a damaged entry let the right code in: ${damaged}`).toBe(false);
      expect(result).toMatchObject({ reason: 'damaged' });
    }
  });

  /**
   * The work factor is read back out of storage and handed to PBKDF2.
   *
   * The file checked the version, the salt and the hash, and let this one through unchecked — so a blob
   * carrying `"iterations": 1` turned a six-to-twelve digit code into something a browser could exhaust in
   * microseconds, and a very large one hangs the main thread instead. Only something that can already write
   * localStorage can do it, which bounds the severity, but it is the attacker-controlled-KDF-parameter
   * mistake and it was an oversight rather than a decision: three sibling fields were checked.
   */
  it('does not take the cost of the derivation from what is stored', async () => {
    await setAppLockCode(CODE);
    const stored = JSON.parse(store.get(HASH_KEY)!);

    for (const iterations of [1, 0, -310000, 999, 1e12, 'many', null, undefined, 1.5]) {
      store.set(HASH_KEY, JSON.stringify({ ...stored, iterations }));
      const result = await unlockAppLock(CODE);
      expect(result.ok, `an iteration count of ${JSON.stringify(iterations)} was accepted`).toBe(false);
      expect(result).toMatchObject({ reason: 'damaged' });
    }
  });

  it('still accepts the figure this build writes', async () => {
    await setAppLockCode(CODE);
    const stored = JSON.parse(store.get(HASH_KEY)!);
    expect(stored.iterations).toBeGreaterThan(1000);

    store.set(HASH_KEY, JSON.stringify(stored));
    expect((await unlockAppLock(CODE)).ok).toBe(true);
  });

  it('is gone once it is turned off', async () => {
    await setAppLockCode(CODE);
    await clearAppLockCode();

    expect(isAppLockSet()).toBe(false);
    expect(store.get(HASH_KEY)).toBeUndefined();
    expect((await unlockAppLock('')).ok).toBe(true);
  });
});