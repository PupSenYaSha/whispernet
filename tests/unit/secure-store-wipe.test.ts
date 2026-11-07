import { describe, it, expect, beforeEach } from 'vitest';
import { secureSet, secureGet, secureRemove } from '../../src/secureStore';

/**
 * Zeroing a finished buffer.
 *
 * Small, and worth being honest about rather than impressive: it does not touch the keys, which are
 * `CryptoKey` objects marked `extractable: false` and hold no bytes this process could overwrite. What it
 * does is overwrite the plaintext of the box in the one place it lives in a typed array, so a heap read
 * later cannot pull it back out of a buffer that happened to survive.
 *
 * It cannot reach the engine's own copies, and it cannot touch `bufToBase64`, which builds an immutable
 * JavaScript string on the way out. So this is hygiene and not a boundary. The test therefore asserts
 * exactly one thing — that the wipe happens — and the limits are written down beside it rather than left
 * for somebody to discover and over-read.
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

const PASSWORD = 'testpass1234';

/**
 * Wraps TextEncoder so the test can hold a reference to the buffer it handed out.
 *
 * The alternative is exporting the wipe for a test to call, which would prove nothing: it would show that
 * `fill(0)` works, which is not in question. What is in question is whether the encrypt path actually
 * reaches for it, and only an interception can answer that.
 *
 * The reference is kept rather than a copy of it, and that distinction is the whole test. A snapshot taken
 * before the wipe would still contain the plaintext — which is correct and unavoidable, since anything
 * holding a copy already has the data — and would make this pass or fail for reasons that have nothing to
 * do with whether the wipe happens.
 */
let seen: Uint8Array[] = [];
const realEncode = TextEncoder.prototype.encode;

beforeEach(() => {
  store.clear();
  seen = [];
  TextEncoder.prototype.encode = function patched(this: TextEncoder, input?: string) {
    const out = realEncode.call(this, input);
    // holding the reference is also what keeps it alive long enough to be inspected
    seen.push(out);
    return out;
  };
});

describe('the local box', () => {
  it('still round-trips a value', async () => {
    await secureSet('wn_thing', PASSWORD, { note: 'the half-thought' });
    expect(await secureGet('wn_thing', PASSWORD)).toEqual({ note: 'the half-thought' });
  });

  it('overwrites the plaintext it handed to the cipher', async () => {
    await secureSet('wn_thing', PASSWORD, { note: 'the half-thought' });
    expect(seen.length).toBeGreaterThan(0);
    for (const buffer of seen) {
      expect(
        Array.from(buffer).some((b) => b !== 0),
        'a plaintext buffer handed to the cipher was still readable afterwards',
      ).toBe(false);
    }
  });

  it('does not leave the value readable in storage by accident', async () => {
    await secureSet('wn_thing', PASSWORD, { note: 'the half-thought' });
    const onDisk = [...store.values()].join('\n');
    expect(onDisk).not.toContain('half-thought');
  });
});

describe('cleanup', () => {
  it('is quiet about a key that was never there', () => {
    expect(() => secureRemove('never_written')).not.toThrow();
  });
});

// put the encoder back so a later file in this worker is not affected
afterAllRestore();

function afterAllRestore() {
  // vitest gives every file its own context, but the prototype is shared, so it is put back here rather
  // than in an afterEach that would run between the assertions above
  process.on('exit', () => { TextEncoder.prototype.encode = realEncode; });
}