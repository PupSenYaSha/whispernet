import { describe, it, expect } from 'vitest';
import { PRODUCTION_ITERATIONS, isPbkdf2Overridden, iterationsFor } from '../../src/pbkdf2';

/**
 * The cost numbers are allowed to drop under test, which is the only reason the suite stops being flaky.
 *
 * That is only safe while nobody changes what actually ships, so this file exists for one reason: to make
 * the production figures impossible to lower by accident and to make a lowered one visible rather than
 * silent. A test asserting "the constant is 600000" is dull, and it is also the only thing standing between
 * a deliberate performance decision and an accidental four-hundred-fold weakening that would still pass
 * every behavioural test in the repository, because nothing about the envelope changes.
 */
describe('PBKDF2 cost', () => {
  it('ships the figures the design calls for', () => {
    expect(PRODUCTION_ITERATIONS.localStore).toBe(600_000);
    expect(PRODUCTION_ITERATIONS.deviceCredentials).toBe(100_000);
    expect(PRODUCTION_ITERATIONS.appLock).toBe(310_000);
  });

  it('is not weakened in this run', () => {
    // this suite runs at the real cost on purpose. `npm test` is what decides whether the code is correct,
    // and a run that quietly derived keys a thousand times is not evidence of anything. The speedup is a
    // separate opt-in.
    expect(isPbkdf2Overridden, 'this run has PBKDF2 overridden, so it is not testing what ships').toBe(false);
  });

  it('gives every kind its own figure rather than one shared number', () => {
    const kinds = ['localStore', 'deviceCredentials', 'appLock'] as const;
    for (const kind of kinds) expect(iterationsFor(kind)).toBe(PRODUCTION_ITERATIONS[kind]);
  });
});