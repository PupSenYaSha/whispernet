import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The cost of creating an account, and the shape both ends have to agree on exactly.
 *
 * ## Why this exists
 *
 * Creating an account was free, so the only thing standing between an interested person and a hundred
 * identities was picking a different nickname. Rate limits per address and per device were meant to help,
 * but an address is shared by an office or a mobile carrier, and a device id is a value the client sends:
 * changing one header gets a whole new budget of either. Both raise the price slightly; neither changes it.
 *
 * The only signal that cannot be spoofed is work. Requiring a hash to start with N zero bits means a
 * hundred accounts cost a hundred searches, and no header, header set or nickname choice makes any of them
 * cheaper. It also needs no identity: no email, no phone, no invitation, and no database of whose machine
 * is whose - which matters here, because this project's whole claim is that the operator does not hold a
 * map of its users.
 *
 * ## Why it is not `crypto.subtle.digest`
 *
 * The obvious implementation is a loop around SubtleCrypto, and it is unusably slow: measured here at about
 * 30,000 hashes a second, because every digest is a promise and the await costs far more than the hash. A
 * difficulty that would mean anything - millions of hashes - would take minutes. `@noble/hashes` is already a
 * dependency, is pure JavaScript, and measures roughly ten times faster, so the loop is not the bottleneck.
 *
 * ## The input, precisely
 *
 * `SHA-256(ascii(nonce) + ':' + ascii(challenge))`, nonce written in decimal with no padding or separators.
 * The colon is there so `1:ab` cannot also be read as `1ab`, which matters because the challenge is
 * attacker-visible and the nonce is not. The server recomputes this from the same two strings with
 * `node:crypto`, so both sides must stay in step; `verifySolution` is the one definition and it is what the
 * server-side test checks against an independent implementation.
 */

/** The longest input built by the search loop: nonce + ':' + a 32-character challenge, with room to spare. */
const MAX_INPUT = 64;

/**
 * Counts the zero bits at the front of a digest.
 *
 * Bits rather than hex characters, because hex only moves in steps of four and the interesting range is
 * narrower than that: at the measured rate, four extra bits is the difference between a second and sixteen.
 * Comparing whole bytes first keeps the common case to a couple of array reads.
 */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i];
    if (b === 0) { bits += 8; continue; }
    // The first set bit ends the run. 0b1000_0000 is 128, and the position of the highest bit gives the
    // count of zeros below it.
    bits += Math.clz32(b) - 24;
    return bits;
  }
  return bits;
}

/**
 * Writes `text` into `buf` as ASCII and returns how many bytes it took.
 *
 * The search loop runs millions of times, so it cannot allocate a string per attempt. Everything is
 * assembled in one reused buffer, which is why `nonce` is formatted by hand.
 */
/**
 * Writes `text` into `buf` as ASCII and returns how many bytes it took.
 *
 * The search loop runs millions of times, so it cannot allocate a string per attempt. Everything is
 * assembled in one reused buffer, which is why `nonce` is formatted by hand.
 *
 * The bounds check is the reason this is not three lines. Writing past the end of a typed array is
 * silently dropped - the assignment is a no-op, not a throw - and the length is still returned as if it had
 * worked. So `powInput` handed back a 64-byte `subarray` of a longer input and hashed the first 64 bytes,
 * while claiming it had hashed all of them. A challenge past about thirty characters would therefore be
 * searched truncated, and every nonce it found would be verified by this client against truncated bytes
 * while the server verified the full ones - a silent divergence in the one definition the two ends must
 * agree on, reported as "wrong nonce" forever. Not live today, because the server issues sixteen random
 * bytes as thirty-two hex characters, which fits with room to spare. It becomes live the moment the server
 * changes what it sends, and it fails as an unexplainable registration bug rather than as an error.
 *
 * Throwing is the right answer rather than truncating: a challenge that does not fit is something the
 * caller has to know about, because the alternative is hashing something other than what was issued.
 */
function writeAscii(buf: Uint8Array, text: string, offset: number): number {
  let i = offset;
  for (let j = 0; j < text.length; j++) {
    if (i >= buf.length) throw new Error('proof-of-work input exceeds the buffer');
    buf[i++] = text.charCodeAt(j) & 0xff;
  }
  return i - offset;
}

/**
 * The bytes that get hashed, for a given nonce and challenge. Exported so the tests can check the format.
 *
 * The colon is bounds-checked too, not just the challenge: it is written the same way and a nonce long
 * enough to fill the buffer would otherwise drop it silently while still counting it, giving `1` and `1abc`
 * the same input - which is exactly the ambiguity the colon exists to prevent.
 */
export function powInput(nonce: number, challenge: string, out = new Uint8Array(MAX_INPUT)): Uint8Array {
  const used = writeAscii(out, String(nonce), 0);
  if (used >= out.length) throw new Error('proof-of-work input exceeds the buffer');
  out[used] = 0x3a; // ':'
  const total = used + 1 + writeAscii(out, challenge, used + 1);
  return out.subarray(0, total);
}

/**
 * Whether a solution satisfies the difficulty.
 *
 * The only definition of "good enough", shared with the server. It does not check that the challenge is the
 * one it issued, nor that the nonce is the first one to work - the caller owns those, because only the
 * caller knows what it issued.
 */
export function verifySolution(challenge: string, nonce: number, bits: number): boolean {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  // A difficulty of zero means "no proof needed" - POW_BITS=0 is a supported configuration.
  // A negative difficulty is refused as nonsense.
  if (!Number.isInteger(bits) || bits < 0) return false;
  if (bits === 0) return true;
  return leadingZeroBits(sha256(powInput(nonce, challenge))) >= bits;
}

/**
 * Searches for a nonce, reporting how far along it is.
 *
 * Synchronous and meant to be called inside a worker: at the difficulty the server asks for this runs for
 * seconds, and on the main thread that is several seconds of frozen tab, which reads as a hang rather than
 * as work. `onProgress` is called roughly every 1% so the caller can show something honest.
 */
export function searchSolution(
  challenge: string,
  bits: number,
  onProgress?: (fraction: number) => void,
  shouldStop?: () => boolean,
): number | null {
  // Expected number of attempts for `bits` leading zero bits is 2^bits, so this is the scale to measure
  // progress against. Guarded: a large difficulty would otherwise mean Infinity and a NaN percentage.
  const expected = bits >= 52 ? Number.MAX_SAFE_INTEGER : 2 ** bits;
  const buf = new Uint8Array(MAX_INPUT);
  // Cancellation is checked on every 1024 attempts - often enough to feel immediate, rarely enough not to
  // cost a call per hash. Progress is counted in the *same* ticks rather than on its own schedule: two
  // independent counters that both have to line up before a progress report fires, which is how this ended
  // up reporting nothing at all.
  const CHECK_MASK = 0x3ff;
  const reportEvery = Math.max(1, Math.floor(expected / 1024 / 100));
  let ticks = 0;

  for (let nonce = 0; ; nonce++) {
    if ((nonce & CHECK_MASK) === 0) {
      if (shouldStop?.()) return null;
      if (onProgress) {
        if (ticks % reportEvery === 0) onProgress(Math.min(1, nonce / expected));
        ticks++;
      }
    }
    // the bounds check inside `writeAscii` is what stops a long challenge being searched truncated; a throw
    // out of here propagates to the worker's `failed` branch and then to the caller, rather than producing
    // nonces that verify locally and are rejected by the server
    const used = writeAscii(buf, String(nonce), 0);
    if (used >= buf.length) throw new Error('proof-of-work input exceeds the buffer');
    buf[used] = 0x3a;
    const total = used + 1 + writeAscii(buf, challenge, used + 1);
    if (leadingZeroBits(sha256(buf.subarray(0, total))) >= bits) return nonce;
  }
}

/* ------------------------------------------------------------------ *
 * Running the search off the main thread.
 * ------------------------------------------------------------------ */

/**
 * Solves a challenge in a worker, reporting progress and honouring cancellation.
 *
 * Falls back to searching inline if the worker cannot start - which is what happens in some test and
 * embedded environments. A synchronous fallback freezes the tab, which is the thing the worker exists to
 * avoid, but a registration that cannot complete is worse than an unresponsive one.
 */
export function solveChallenge(
  challenge: string,
  bits: number,
  onProgress?: (fraction: number) => void,
): { promise: Promise<number | null>; cancel: () => void } {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./registerPow.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (!worker) {
    let cancelled = false;
    return {
      promise: new Promise((resolve) => {
        // Deferred so the caller can attach handlers before a fast search resolves.
        setTimeout(() => resolve(searchSolution(challenge, bits, onProgress, () => cancelled)), 0);
      }),
      cancel: () => { cancelled = true; },
    };
  }

  const w = worker;
  // `settled` and `finish` live out here rather than inside the promise executor, because `cancel` has to be
  // able to settle the promise and it is defined after it.
  //
  // This was the bug: `cancel` posted `{type:'cancel'}` and then immediately called `w.terminate()`, and a
  // terminated worker dispatches no events at all - the message is never delivered, so the worker's
  // `cancelled` reply never came, `finish` never ran, and the returned promise stayed pending for the life
  // of the tab. The inline fallback path above does not have this problem, which is why it looked fine:
  // `shouldStop` is a flag the search loop can actually see. The consequence was on the caller, not here -
  // `App.tsx` does `const nonce = await search.promise`, that await never resumed, and the registration
  // form stayed disabled. It needs only a second challenge arriving while a search is running, which the
  // server sends on any re-registration attempt.
  //
  // The cancel message is still posted first, so a worker that is already idle can wind down cleanly and a
  // `done` racing the cancel is simply discarded rather than resolving the promise twice.
  let settled = false;
  const finish = (value: number | null) => {
    if (settled) return;
    settled = true;
    try { w.terminate(); } catch { /* already gone */ }
    resolve(value);
  };

  let resolve!: (value: number | null) => void;
  const promise = new Promise<number | null>((r) => { resolve = r; });

  w.onmessage = (e: MessageEvent<{ type: string; fraction?: number; nonce?: number }>) => {
    const m = e.data;
    if (settled) return;
    if (m.type === 'progress') { onProgress?.(m.fraction ?? 0); return; }
    if (m.type === 'done') finish(m.nonce ?? null);
    else if (m.type === 'cancelled' || m.type === 'failed') finish(null);
  };
  // A worker that fails to load is the same situation as one that could not be created.
  w.onerror = () => finish(null);
  try {
    w.postMessage({ challenge, bits });
  } catch {
    finish(null);
  }

  return {
    promise,
    cancel: () => {
      // Terminating first and posting afterwards could never work - that is the whole bug. Post, then
      // terminate, then settle regardless of whether the worker ever answered.
      try { w.postMessage({ type: 'cancel' }); } catch { /* already gone */ }
      finish(null);
    },
  };
}
