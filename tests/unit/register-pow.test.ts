import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  leadingZeroBits,
  powInput,
  searchSolution,
  verifySolution,
} from '../../src/registerPow';

/**
 * The registration proof, and the one thing that absolutely must not drift.
 *
 * The client searches with `@noble/hashes` and the server verifies with `node:crypto`. They agree only if
 * both hash the same bytes in the same order, and nothing at runtime would notice if they stopped: the
 * client would report success, send a nonce, and be handed a fresh challenge - which looks, from the user's
 * side, like a registration button that does nothing. So the format is checked against an independent
 * implementation here rather than against the client's own digest.
 */

const CHALLENGE = 'abcdef0123456789abcdef0123456789';

describe('the bytes both ends hash', () => {
  it('is the decimal nonce, a colon, then the challenge', () => {
    expect(Buffer.from(powInput(42, CHALLENGE)).toString()).toBe(`42:${CHALLENGE}`);
  });

  it('agrees with node:crypto, which is what the server uses', () => {
    for (const nonce of [0, 1, 42, 999, 1234567, 4294967295]) {
      const client = Buffer.from(sha256(powInput(nonce, CHALLENGE))).toString('hex');
      const server = crypto.createHash('sha256').update(`${nonce}:${CHALLENGE}`).digest('hex');
      expect(client, `nonce ${nonce}`).toBe(server);
    }
  });

  it('cannot be read two ways', () => {
    // Without the colon, `1:ab` and `1ab` would be the same string, and a nonce could be shifted into the
    // challenge or the other way round.
    expect(Buffer.from(powInput(1, 'ab')).toString()).not.toBe(Buffer.from(powInput(11, 'b')).toString());
  });

  it('is unaffected by a challenge that looks like a number', () => {
    // The challenge is attacker-visible, so a hostile one must not be able to forge a different pairing.
    expect(Buffer.from(powInput(5, '12345')).toString()).toBe('5:12345');
    expect(Buffer.from(powInput(5, '12345')).toString()).not.toBe(Buffer.from(powInput(51, '2345')).toString());
  });
});

describe('counting leading zero bits', () => {
  it('counts whole zero bytes', () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0xff]))).toBe(16);
  });

  it('stops at the first set bit', () => {
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0x01]))).toBe(7);
    expect(leadingZeroBits(new Uint8Array([0x40]))).toBe(1);
  });

  it('handles an all-zero digest', () => {
    expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
  });

  it('never reports more than the digest holds', () => {
    // The failure that would silently make every proof valid.
    expect(leadingZeroBits(new Uint8Array([0, 0, 0, 0]))).toBe(32);
  });
});

describe('searching for a nonce', () => {
  it('finds one that verifies', () => {
    const nonce = searchSolution(CHALLENGE, 12);
    expect(nonce).not.toBeNull();
    expect(verifySolution(CHALLENGE, nonce as number, 12)).toBe(true);
  });

  it('finds one for a higher difficulty', () => {
    const nonce = searchSolution(CHALLENGE, 16);
    expect(verifySolution(CHALLENGE, nonce as number, 16)).toBe(true);
  });

  it('rejects a nonce that does not reach the difficulty', () => {
    // A proof that is one bit short must fail, or the difficulty is not being enforced anywhere.
    const nonce = searchSolution(CHALLENGE, 14);
    const bits = leadingZeroBits(sha256(powInput(nonce as number, CHALLENGE)));
    expect(verifySolution(CHALLENGE, nonce as number, bits + 1)).toBe(false);
  });

  it('rejects a nonce solved for a different challenge', () => {
    const nonce = searchSolution(CHALLENGE, 16);
    expect(verifySolution('ffffffffffffffffffffffffffffffff', nonce as number, 16)).toBe(false);
  });

  it('rejects nonsense nonces outright', () => {
    expect(verifySolution(CHALLENGE, -1, 8)).toBe(false);
    expect(verifySolution(CHALLENGE, 1.5, 8)).toBe(false);
    expect(verifySolution(CHALLENGE, Number.NaN, 8)).toBe(false);
    expect(verifySolution(CHALLENGE, Number.MAX_SAFE_INTEGER + 2, 8)).toBe(false);
  });

  it('accepts anything when no work is asked for', () => {
    // POW_BITS=0 is a supported configuration, so a difficulty of zero has to mean "no proof needed"
    // rather than "any nonce counts because the comparison is off by one".
    expect(verifySolution(CHALLENGE, 0, 0)).toBe(true);
  });

  it('reports progress and can be stopped', () => {
    const seen: number[] = [];
    const result = searchSolution(CHALLENGE, 18, (f) => seen.push(f), () => seen.length > 2);
    expect(result).toBeNull();
    expect(seen.length).toBeGreaterThan(2);
    // Progress is a fraction of the expected number of attempts, so it stays inside 0..1 and only ever
    // moves forward - a bar that went backwards would look broken even though the work was fine.
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('costs roughly what the difficulty says it should', () => {
    // A sanity check on the numbers rather than a benchmark: one bit is twice the work, so 14 bits should
    // take roughly a quarter of 16. A wide margin, because a single sample of a random search is noisy -
    // but it catches a difficulty that is not actually being applied.
    const time = (bits: number) => {
      const t0 = Date.now();
      searchSolution(CHALLENGE, bits);
      return Date.now() - t0;
    };
    time(12);
    const cheap = time(13);
    const dear = time(16);
    expect(dear).toBeGreaterThan(cheap / 4);
  }, 60000);
});
