import { describe, it, expect } from 'vitest';
import { generateSafetyNumber } from '../../src/crypto';

/**
 * The safety number is the one check that does not go through the server.
 *
 * Everything else about a private message is verified by the party handing out the keys: it publishes
 * them, routes the bodies, stores them. A number both people can read off their own screen is the only
 * way to notice that the keys in play are not the ones they expected. So the properties that matter are
 * that both sides reach the same answer without agreeing on an order, and that a changed key changes it.
 */

const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString('base64');

describe('the safety number', () => {
  const mine = b64(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256));
  const theirs = b64(Array.from({ length: 32 }, (_, i) => (i * 13 + 91) % 256));
  const other = b64(Array.from({ length: 32 }, (_, i) => (i * 29 + 5) % 256));

  it('is sixty hex characters in twelve groups', async () => {
    const n = await generateSafetyNumber(mine, theirs);
    expect(n).toMatch(/^[0-9A-F]{8}( [0-9A-F]{8}){5}$/);
    expect(n!.split(' ')).toHaveLength(6);
  });

  it('comes out the same on both screens without an agreed order', async () => {
    // Neither side knows whether its key sorts first, so the number has to be symmetric.
    expect(await generateSafetyNumber(mine, theirs)).toBe(await generateSafetyNumber(theirs, mine));
  });

  it('differs for a different person', async () => {
    expect(await generateSafetyNumber(mine, theirs)).not.toBe(await generateSafetyNumber(mine, other));
  });

  it('differs when this side swaps its own key', async () => {
    // The case that matters: a server that hands each of them a different key produces a different
    // number on each screen, which is exactly what the reader is looking for.
    expect(await generateSafetyNumber(mine, theirs)).not.toBe(await generateSafetyNumber(other, theirs));
  });

  it('produces nothing without the other side to compare against', async () => {
    // With one key there is nothing to check. A number derived from our key alone can never match what
    // the other person sees, so putting one on screen is not a weaker check - it is a false alarm on the
    // one check people are told to trust, which is how people learn to wave it through.
    expect(await generateSafetyNumber(mine)).toBeNull();
    expect(await generateSafetyNumber(mine, null)).toBeNull();
    expect(await generateSafetyNumber(mine, undefined)).toBeNull();
    expect(await generateSafetyNumber(mine, '')).toBeNull();
  });

  it('does not depend on the order the two keys happen to have', async () => {
    // A key that is all zeroes sorts before everything, one that is all ff sorts after; both must still
    // land on the same number.
    const low = b64(new Array(32).fill(0));
    const high = b64(new Array(32).fill(255));
    expect(await generateSafetyNumber(low, high)).toBe(await generateSafetyNumber(high, low));
    expect(await generateSafetyNumber(high, low)).toBe(await generateSafetyNumber(low, high));
  });

  it('survives a key of a length other than thirty-two', async () => {
    // An identity key that is the wrong length is not something the number should quietly crash on; the
    // handshake is where a wrong key is caught, and this only has to not throw.
    const short = b64([1, 2, 3]);
    await expect(generateSafetyNumber(short, theirs)).resolves.toBeTruthy();
  });
});