/**
 * How many times PBKDF2 is asked to hash.
 *
 * These numbers are the reason an unlock takes a moment, and they are the single cheapest thing an
 * attacker has to grind against, so they are not decoration: six hundred thousand for the box that holds
 * the message keys, three hundred and ten thousand for the app lock, a hundred thousand for the device
 * credentials. They live in four files, which is how they ended up being four separate magic numbers that
 * nothing could reason about together.
 *
 * They are also why the test suite is slow, and why `password-change.test.ts` failed intermittently in a
 * full run while passing alone. That is not a wall-clock assertion: the work is CPU-bound, the full run
 * keeps every core busy, and a derive that takes ninety milliseconds when it has the machine to itself
 * takes seconds when thirty-five other files are competing for the same cores. Re-wrapping a dozen
 * sessions and prekey stores in one test multiplies that.
 *
 * So under test the count drops. Nothing about the behaviour depends on it — the same envelope, the same
 * key length, the same code path — and a test that asserted on the count itself would be asserting that a
 * constant stayed put, which `tests/unit/pbkdf2-iterations.test.ts` does directly instead. Production
 * keeps the real numbers, and the override is read from the environment rather than detected, so the only
 * way to get a weak number is to say so out loud.
 */

const OVERRIDE_ENV = 'WN_PBKDF2_ITERATIONS';

function readOverride(): number | null {
  const raw = (globalThis as any).process?.env?.[OVERRIDE_ENV];
  if (!raw) return null;
  const parsed = Number(raw);
  // A typo here would silently run six hundred thousand iterations anyway, or a handful, so it is
  // rejected rather than guessed at.
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

const override = readOverride();

export const isPbkdf2Overridden = override !== null;

/**
 * The production figure, whatever the override says.
 *
 * Exported so the test can assert that six hundred thousand is still what ships. An override that quietly
 * became the only number anyone ever ran would otherwise be indistinguishable from a deliberate choice.
 */
export const PRODUCTION_ITERATIONS = {
  localStore: 600_000,
  deviceCredentials: 100_000,
  appLock: 310_000,
} as const;

/** The count to actually use, given what the module needed it for. */
export function iterationsFor(kind: keyof typeof PRODUCTION_ITERATIONS): number {
  return override ?? PRODUCTION_ITERATIONS[kind];
}