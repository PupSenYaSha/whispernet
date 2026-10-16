import {
  FAILED_LOGIN_RETENTION_MS,
  MAX_FAILED_LOGINS,
  ACCOUNT_LOCKOUT_DURATION,
  MAX_FAILED_LOGINS_GLOBAL,
  ACCOUNT_LOCKOUT_DURATION_GLOBAL,
  MAX_AUTH_ATTEMPTS_PER_ADDRESS,
  RATE_LIMIT_WINDOW,
} from './constants.js';

/**
 * The failed-sign-in counters, kept apart from the socket handlers so the rules can be read - and
 * tested - on their own.
 *
 * Two counters per attempt, deliberately. One is keyed by address *and* nickname together, which is
 * what refuses an attempt: a family, an office or a school behind one router no longer locks each other
 * out. The other is keyed by the name alone, at a much higher ceiling, and is what a spray from many
 * machines runs into.
 *
 * The original single counter was keyed by nickname alone, which is a denial of service rather than a
 * security measure: anybody who knew a name could lock the account for five minutes at a time and hold
 * it there for as long as they cared to.
 */

interface FailureEntry {
  count: number;
  lockedUntil: number;
  lastActive: number;
}

const failedLogins = new Map<string, FailureEntry>();
const nicknameFailures = new Map<string, FailureEntry>();

/**
 * How many sign-in attempts one address has made in the window, charged whatever the outcome.
 *
 * The two tables above count *mistakes*, which is the right thing to limit for an account - it is what
 * makes guessing expensive - and the wrong thing to limit for a process. The work behind one attempt is a
 * bcrypt comparison that `bcryptjs` computes synchronously, so an address that is refused for a wrong
 * password is refused *after* the server has already spent about 310 ms of its only thread doing it. A
 * ceiling on failures therefore puts no ceiling on the cost of the guessing, and this table is what does:
 * it is charged on every attempt, successful or not, and consulted before the comparison rather than after
 * it.
 */
const authAttempts = new Map<string, { count: number; resetAt: number }>();

/** The budget falls back to the ordinary sliding window, so the "try again in N seconds" answer is honest. */
const AUTH_ATTEMPT_WINDOW_MS = RATE_LIMIT_WINDOW;

/**
 * Forgets entries that have outlived both the retention window and any lockout.
 *
 * Runs once, over the tables, on every failed sign-in. It used to re-run itself while either table was
 * still over a ceiling, and that could not terminate: a second pass with the same clock looks at the same
 * entries and deletes exactly what the first pass already deleted, so any state the first pass could not
 * shrink sent it round again for good. Reaching that state took one address sending five thousand failed
 * sign-ins at five thousand different names - each name fails once, so no per-name lockout ever fires -
 * and the resulting stack overflow was thrown from `recordFailedLogin`, which is on the path of every
 * sign-in. So for as long as those entries stayed inside the retention window, nobody could log in to
 * the server at all.
 *
 * The sweep in `startHeartbeatCheck` calls this too, so the tables also shrink on a server nobody is
 * attacking - there, the only thing that would otherwise run a pass is a failed sign-in.
 */
export function pruneCounters(now: number): void {
  const cutoff = now - FAILED_LOGIN_RETENTION_MS;
  for (const [key, entry] of failedLogins) {
    if (entry.lastActive < cutoff && (!entry.lockedUntil || entry.lockedUntil < now)) failedLogins.delete(key);
  }
  for (const [key, entry] of nicknameFailures) {
    if (entry.lastActive < cutoff && (!entry.lockedUntil || entry.lockedUntil < now)) nicknameFailures.delete(key);
  }
  // The attempt budget rides on the same sweep. It is keyed by an address, so it is one of the tables that
  // grows with whatever a stranger sends and cannot be left to a sign-in happening to check it.
  for (const [ip, entry] of authAttempts) {
    if (now > entry.resetAt) authAttempts.delete(ip);
  }
}

/**
 * Charges one sign-in attempt against this address, whatever it turns out to be.
 *
 * Consulted by the socket handler before the password is touched, so the answer is "no" *before* the
 * blocking comparison rather than after it - which is the whole point: the previous counters only ever
 * answered afterwards, so being refused cost exactly as much as being served.
 */
export function recordAuthAttempt(ip: string, now: number = Date.now()): boolean {
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_ATTEMPT_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_AUTH_ATTEMPTS_PER_ADDRESS) return false;
  entry.count++;
  return true;
}

/** Milliseconds left before this address's attempt budget comes back, 0 when there is no active budget. */
export function authAttemptRemainingMs(ip: string, now: number = Date.now()): number {
  const entry = authAttempts.get(ip);
  if (!entry) return 0;
  return Math.max(0, entry.resetAt - now);
}

/**
 * Hands the budget back early. Not used by the sign-in path, on purpose.
 *
 * A correct password does *not* clear it: an attacker who has the password would otherwise sign in, reset
 * the counter and sign in again as fast as the loop allows, buying an unbounded number of blocking bcrypt
 * comparisons. Only the window gives it back, which is what the ceiling on failures already does to a sprayed
 * address - see MAX_AUTH_ATTEMPTS_PER_ADDRESS.
 */
export function clearAuthAttempts(ip: string): void {
  authAttempts.delete(ip);
}

/** How many entries each table holds. Reported by the sweep, and asserted on by the tests. */
export function authCounterSizes(): { pairs: number; names: number } {
  return { pairs: failedLogins.size, names: nicknameFailures.size };
}

/**
 * Counts one wrong password against both the pair and the name, and reports the pair's state.
 *
 * The pair is what refuses an attempt; the cross-address total is the slower, higher ceiling that only
 * matters to somebody spraying one name from many machines.
 *
 * An entry that is already locked out is left locked. It used to be restarted from a count of one, which
 * quietly undid the lockout: whoever called this during a lockout cleared it and handed the next five
 * guesses straight back, which is the only thing the lockout was there to prevent. The socket handler
 * happens to check the lock before it gets here, so that path was not reachable through a sign-in - but
 * a counter whose safety depends on every caller remembering that is one caller away from being wrong,
 * and this one now carries its own rule.
 */
export function recordFailedLogin(pairKey: string, nicknameKey: string): { count: number; lockedUntil: number } {
  const now = Date.now();
  pruneCounters(now);

  const pair = failedLogins.get(pairKey);
  const pairLocked = !!pair && pair.lockedUntil > now;
  const pairCount = pairLocked ? pair.count : (pair?.count ?? 0) + 1;
  const pairLockedUntil = pairLocked ? pair.lockedUntil : pairCount >= MAX_FAILED_LOGINS ? now + ACCOUNT_LOCKOUT_DURATION : 0;
  failedLogins.set(pairKey, { count: pairCount, lockedUntil: pairLockedUntil, lastActive: now });

  const global = nicknameFailures.get(nicknameKey);
  const globalLocked = !!global && global.lockedUntil > now;
  const globalCount = globalLocked ? global.count : (global?.count ?? 0) + 1;
  const globalLockedUntil = globalLocked ? global.lockedUntil : globalCount >= MAX_FAILED_LOGINS_GLOBAL ? now + ACCOUNT_LOCKOUT_DURATION_GLOBAL : 0;
  nicknameFailures.set(nicknameKey, { count: globalCount, lockedUntil: globalLockedUntil, lastActive: now });

  return { count: pairCount, lockedUntil: pairLockedUntil };
}

/** Forgets a nickname's failures once the right password came through. */
export function clearFailedLogins(nicknameKey: string): void {
  nicknameFailures.delete(nicknameKey);
  for (const key of [...failedLogins.keys()]) {
    if (key.endsWith('|' + nicknameKey)) failedLogins.delete(key);
  }
}

/**
 * Whether the attempt is the one that stops answering, and if so for how many minutes.
 *
 * Only a *wrong* password is ever refused here. A lockout that can turn away the correct password is a
 * way to lock somebody out of their own account, so the check runs after the comparison succeeds and the
 * right password always gets in, however many failures the name has collected.
 */
export function loginLockedOut(pairKey: string, nicknameKey: string): number {
  const now = Date.now();
  const pair = failedLogins.get(pairKey);
  if (pair && pair.lockedUntil > now) return Math.ceil((pair.lockedUntil - now) / 60000);
  const global = nicknameFailures.get(nicknameKey);
  if (global && global.lockedUntil > now) return Math.ceil((global.lockedUntil - now) / 60000);
  return 0;
}

/**
 * Collects the entries a lockout has finished with.
 *
 * Separate from `pruneCounters` because the sweep runs first and can then report the tables without
 * re-walking them: `pruneCounters` already visits every entry, so this only drops the ones whose
 * lockout has run out. Running it first rather than afterwards also means the counts logged are the
 * ones from before anything was dropped.
 */
export function collectExpiredLocks(now: number): { pairs: number; names: number } {
  const sizes = { pairs: failedLogins.size, names: nicknameFailures.size };
  for (const [key, entry] of failedLogins) {
    if (entry.lockedUntil > 0 && now > entry.lockedUntil) failedLogins.delete(key);
  }
  for (const [key, entry] of nicknameFailures) {
    if (entry.lockedUntil > 0 && now > entry.lockedUntil) nicknameFailures.delete(key);
  }
  return sizes;
}

/** Empties both tables. For tests, which share one process across every file. */
export function resetAuthCounters(): void {
  failedLogins.clear();
  nicknameFailures.clear();
  authAttempts.clear();
}