import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFailedLogin,
  clearFailedLogins,
  loginLockedOut,
  pruneCounters,
  collectExpiredLocks,
  authCounterSizes,
  resetAuthCounters,
} from '../../server/authCounters';

/**
 * The failed-sign-in counters, without a server and without bcrypt.
 *
 * These are the tables a spray lands in, and they are checked on the path of every sign-in - so a defect
 * here is not one bad sign-in, it is a server nobody can log in to.
 */

beforeEach(() => {
  resetAuthCounters();
});

describe('the failed-sign-in counters', () => {
  it('locks an address and a name out after five wrong passwords', () => {
    for (let i = 0; i < 5; i++) {
      expect(loginLockedOut('10.0.0.1|alice', 'alice')).toBe(0);
      recordFailedLogin('10.0.0.1|alice', 'alice');
    }
    expect(loginLockedOut('10.0.0.1|alice', 'alice')).toBeGreaterThan(0);
  });

  it('keeps one person fumbling from locking out their neighbour', () => {
    for (let i = 0; i < 6; i++) recordFailedLogin('10.0.0.1|alice', 'alice');

    expect(loginLockedOut('10.0.0.1|alice', 'alice')).toBeGreaterThan(0);
    // same address, different name
    expect(loginLockedOut('10.0.0.1|bob', 'bob')).toBe(0);
  });

  /**
   * A counter that forgets its own lockout is not a slower guess, it is no lockout at all.
   *
   * `recordFailedLogin` used to restart a locked entry from a count of one, which cleared the lockout as
   * a side effect of counting another failure against it. The socket handler checks the lock before it
   * calls this, so a sign-in could not reach it - but the rule the counter exists to enforce should not
   * depend on every caller remembering to check first.
   */
  it('does not let a failure during a lockout end the lockout', () => {
    for (let i = 0; i < 5; i++) recordFailedLogin('10.0.0.1|alice', 'alice');
    const lockedFor = loginLockedOut('10.0.0.1|alice', 'alice');
    expect(lockedFor).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) recordFailedLogin('10.0.0.1|alice', 'alice');

    // still locked, and not handed back a fresh count of five guesses
    expect(loginLockedOut('10.0.0.1|alice', 'alice')).toBeGreaterThanOrEqual(lockedFor);
  });

  it('counts the name across every address, at a higher ceiling', () => {
    for (let i = 0; i < 19; i++) recordFailedLogin(`10.0.0.${i}|alice`, 'alice');

    // nineteen addresses, so the per-pair lock never fires, but the name is nearly spent
    expect(loginLockedOut('10.0.0.99|alice', 'alice')).toBe(0);
    recordFailedLogin('10.0.0.99|alice', 'alice');
    expect(loginLockedOut('10.0.0.99|alice', 'alice')).toBeGreaterThan(0);
  });

  it('forgets everything about a name once it is let in', () => {
    for (let i = 0; i < 4; i++) recordFailedLogin('10.0.0.1|alice', 'alice');
    clearFailedLogins('alice');

    expect(authCounterSizes()).toEqual({ pairs: 0, names: 0 });
    expect(loginLockedOut('10.0.0.1|alice', 'alice')).toBe(0);
  });

  it('drops entries the retention window has passed', () => {
    recordFailedLogin('10.0.0.1|alice', 'alice');
    expect(authCounterSizes().pairs).toBe(1);

    // an hour later, plus enough to clear the lockout as well
    pruneCounters(Date.now() + 24 * 60 * 60 * 1000);

    expect(authCounterSizes()).toEqual({ pairs: 0, names: 0 });
  });

  it('keeps an entry that is still inside the window', () => {
    recordFailedLogin('10.0.0.1|alice', 'alice');
    pruneCounters(Date.now());

    expect(authCounterSizes().pairs).toBe(1);
  });

  /**
   * The one that was a live denial of service.
   *
   * The prune used to re-run itself while either table was still over a ceiling of five thousand. That
   * cannot terminate: a second pass with the same clock inspects the same entries and deletes exactly
   * what the first already deleted, so a table the first pass could not shrink sent it round for good.
   *
   * Filling that table took one address sending failed sign-ins at five thousand different names - each
   * name fails once, so no per-name lockout ever fires and the per-address backstop is the only thing in
   * the way. The result was a stack overflow thrown from `recordFailedLogin`, which is on the path of
   * every sign-in: for as long as those entries stayed inside the retention window, nobody could log in
   * to the server at all. An hour of quiet was the only cure.
   */
  it('terminates with far more live entries than the old ceiling allowed', () => {
    const now = Date.now();
    for (let i = 0; i < 5001; i++) recordFailedLogin(`10.0.0.1|name${i}`, `name${i}`);
    expect(authCounterSizes().pairs).toBe(5001);

    // The whole point: this used to throw. It is called on every failed sign-in, so "does not throw" is
    // the property that keeps the server reachable.
    expect(() => pruneCounters(now)).not.toThrow();
    // and the entries are genuinely still there, not silently dropped on the way through
    expect(authCounterSizes().pairs).toBe(5001);
  });

  it('keeps answering sign-ins after that flood, and reports the size once', () => {
    const now = Date.now();
    for (let i = 0; i < 5001; i++) recordFailedLogin(`10.0.0.1|name${i}`, `name${i}`);

    collectExpiredLocks(now);
    pruneCounters(now);
    const counters = authCounterSizes();

    expect(counters.pairs).toBe(5001);
    // a fresh name is still counted and still answerable rather than throwing its way out of the handler
    expect(() => recordFailedLogin('10.0.0.1|after', 'after')).not.toThrow();
    expect(loginLockedOut('10.0.0.1|after', 'after')).toBe(0);
  });
});