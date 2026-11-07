/**
 * Bucket sizes for padding message plaintexts.
 *
 * The server learns the length of every encrypted body it relays. Padding to fixed buckets hides the
 * exact length behind a coarse size class, so an observer cannot tell a one-word message from a long one
 * just by the ciphertext size. Buckets grow exponentially so the overhead stays modest even for long texts.
 */
const BUCKETS: number[] = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

/**
 * Pads `text` with NUL bytes up to the next bucket size.
 *
 * The padding is deterministic and cheap. Callers must strip it after decryption with `stripPadding`
 * before parsing the sealed-sender envelope.
 */
export function padToBucket(text: string): string {
  const len = new TextEncoder().encode(text).length;
  for (const b of BUCKETS) {
    if (len <= b) {
      return text + '\0'.repeat(b - len);
    }
  }
  // A message larger than the biggest bucket is sent unpadded rather than silently truncated.
  return text;
}

/** Removes trailing NUL padding added by `padToBucket`. */
export function stripPadding(text: string): string {
  return text.replace(/\0+$/, '');
}
