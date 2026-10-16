/**
 * Clearing a buffer that held key material.
 *
 * ## What this is for, and what it is not
 *
 * JavaScript gives no way to say "this array of bytes is secret, please destroy it". What can be done is
 * overwrite the bytes, which removes them from the live object and stops them showing up in a heap dump
 * taken after the fact.
 *
 * It is hygiene, not a boundary, and the reason is worth being blunt about:
 *
 * - V8 may have copied the bytes elsewhere. A `Uint8Array` over a small buffer can live inside the young
 *   generation's page, and a compaction can leave stale copies of a moved region behind.
 * - The engine is free to have spread the values into registers or a stack slot, and neither comes back.
 * - Anything that already *holds* the value - a JavaScript string, a plain array produced by `Array.from`,
 *   a `CryptoKey` with `extractable: true` - is out of reach entirely. The JSON this layer persists is built
 *   with `Array.from` and then serialised to a string, so a wiped buffer here is not the last copy.
 * - It is not constant-time and is not meant to be.
 *
 * So nothing in the crypto should *depend* on this for correctness, and it must never be the reason a key is
 * considered destroyed. What it does buy is narrower and still real: the large, long-lived buffers that sit
 * around waiting for the next message stop holding chain keys after they have been used once, instead of
 * sitting in the heap for the life of the tab.
 *
 * A detached buffer throws on access, which is the outcome being asked for anyway, so failures are swallowed.
 */

/** Overwrites the bytes of a buffer or a typed array in place. */
export function wipe(buf: ArrayBuffer | Uint8Array | null | undefined): void {
  if (!buf) return;
  try {
    if (ArrayBuffer.isView(buf)) new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).fill(0);
    else new Uint8Array(buf).fill(0);
  } catch {
    /* detached, or read-only: already unreachable, which is the point */
  }
}

/**
 * Overwrites every buffer given, then empties the array holding them.
 *
 * The array is cleared because it is itself a list of live references to the buffers just wiped: leaving it
 * for the collector leaves the one thing a heap snapshot could have used to find where those buffers used to
 * be. `splice(0)` rather than a fresh array, so that a caller holding the array sees it emptied - which is
 * what this docstring used to claim and did not do.
 *
 * Safe only because every call site passes a literal it does not read again; that is an invariant of the
 * callers, not something this function can enforce.
 */
export function wipeAll(buffers: (ArrayBuffer | Uint8Array | null | undefined)[]): void {
  for (const b of buffers) wipe(b);
  buffers.splice(0);
}
