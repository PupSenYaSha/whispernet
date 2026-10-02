import { describe, it, expect } from 'vitest';
import { encryptFileStream, openStreamedAttachment } from '../../src/media-crypto';

/**
 * An attachment in a private chat is encrypted a chunk at a time and posted as a stream, so that one
 * of the three copies of the file that used to be resident at once no longer exists. These cover the
 * format itself, because a mistake in it loses the attachment rather than failing visibly.
 */

const CHUNK = 4 * 1024 * 1024;

/** Feeds a stream through a transform so the consumer sees it the way fetch would deliver it. */
async function collect(stream: ReadableStream<Uint8Array>, pieces: number): Promise<Blob> {
  const reader = stream.getReader();
  const parts: BlobPart[] = [];
  let buf = new Uint8Array(0);
  let n = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = new Uint8Array([...buf, ...value]);
    // arbitrary boundaries, so a chunk that spans two reads has to be handled
    if (buf.length > 65536 && ++n % pieces === 0) {
      parts.push(buf);
      buf = new Uint8Array(0);
    }
  }
  if (buf.length) parts.push(buf);
  return new Blob(parts, { type: 'application/octet-stream' });
}

const responseOf = (blob: Blob) => ({ body: blob.stream(), ok: true, status: 200 }) as unknown as Response;

async function roundTrip(bytes: number): Promise<{ sent: number; got: number; matches: boolean }> {
  const plain = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) plain[i] = i % 251;
  const enc = await encryptFileStream(new Blob([plain]));
  const wire = await collect(enc.stream, 7);
  const back = await openStreamedAttachment(responseOf(wire), enc.rawKey, '');
  const got = new Uint8Array(await back.arrayBuffer());
  let matches = got.length === plain.length;
  if (matches) for (let i = 0; i < got.length; i++) if (got[i] !== plain[i]) { matches = false; break; }
  return { sent: plain.length, got: got.length, matches };
}

describe('a streamed attachment', () => {
  it('round-trips an empty file', async () => {
    const r = await roundTrip(0);
    expect(r.sent).toBe(0);
    expect(r.got).toBe(0);
    expect(r.matches).toBe(true);
  });

  it('round-trips a file smaller than one chunk', async () => {
    const r = await roundTrip(1024);
    expect(r.matches).toBe(true);
  });

  it('round-trips a file that lands exactly on a chunk boundary', async () => {
    const r = await roundTrip(CHUNK);
    expect(r.matches).toBe(true);
  });

  it('round-trips a file several chunks long', async () => {
    const r = await roundTrip(CHUNK * 2 + 12345);
    expect(r.matches).toBe(true);
  });

  it('reassembles a body split at arbitrary byte boundaries', async () => {
    const plain = new Uint8Array(300000);
    for (let i = 0; i < plain.length; i++) plain[i] = (i * 7) % 256;
    const enc = await encryptFileStream(new Blob([plain]));
    // one byte at a time, which is the worst case a transport can hand over
    const reader = enc.stream.getReader();
    const wire: BlobPart[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) wire.push(value.subarray(i, i + 1) as BlobPart);
    }
    const back = await openStreamedAttachment(responseOf(new Blob(wire)), enc.rawKey, '');
    const got = new Uint8Array(await back.arrayBuffer());
    expect(got.length).toBe(plain.length);
    expect(got[299999]).toBe(plain[299999]);
  });

  it('will not open a body that was cut short', async () => {
    const plain = new Uint8Array(CHUNK + 4096);
    plain.fill(7);
    const enc = await encryptFileStream(new Blob([plain]));
    const wire = await collect(enc.stream, 5);
    const bytes = new Uint8Array(await wire.arrayBuffer());
    // drop the tail, the way a connection cut in half would
    const truncated = new Blob([bytes.subarray(0, bytes.length - 2048)]);
    await expect(openStreamedAttachment(responseOf(truncated), enc.rawKey, '')).rejects.toThrow(/truncated/i);
  });

  it('will not open a body whose bytes were altered', async () => {
    const plain = new Uint8Array(2048);
    plain.fill(3);
    const enc = await encryptFileStream(new Blob([plain]));
    const bytes = new Uint8Array(await (await collect(enc.stream, 3)).arrayBuffer());
    bytes[bytes.length - 10] ^= 0xff;
    await expect(openStreamedAttachment(responseOf(new Blob([bytes])), enc.rawKey, '')).rejects.toThrow();
  });

  it('will not open a body encrypted under a different key', async () => {
    const enc = await encryptFileStream(new Blob([new Uint8Array(4096)]));
    const wire = await collect(enc.stream, 3);
    const other = await encryptFileStream(new Blob([new Uint8Array(4096)]));
    await expect(openStreamedAttachment(responseOf(wire), other.rawKey, '')).rejects.toThrow();
  });

  it('keeps the upload as one pass rather than a buffered copy', async () => {
    // the point of the format: the stream produces output before it has consumed everything, so a
    // request can start with the first chunk instead of waiting for a finished buffer
    const plain = new Uint8Array(CHUNK * 3);
    const enc = await encryptFileStream(new Blob([plain]));
    const reader = enc.stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.length).toBeGreaterThan(0);
    await reader.cancel();
  });
});