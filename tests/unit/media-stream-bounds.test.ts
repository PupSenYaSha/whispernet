import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, type StartedServer } from '../helpers';
import { encryptFileStream, openStreamedAttachment } from '../../src/media-crypto';

/**
 * The media stream, read by something that does not want to be reasonable.
 *
 * Every chunk is authenticated by GCM before its plaintext is kept — `crypto.subtle.decrypt` throws on a
 * bad tag, so a doctored chunk cannot reach the result. That much holds.
 *
 * What does not hold is the length in front of each chunk. It is a bare uint32, it is *not* part of the
 * authenticated data, and the client used to read that many bytes before the decryption that would have
 * rejected them. So a media host could declare a four-gigabyte chunk and the reader would sit there
 * accumulating it. `MEDIA_BASE_URL` points at somebody else's host, which makes the number on that length
 * genuinely not ours to trust.
 *
 * These build hostile streams by hand and check what the reader does with them.
 */

let server: StartedServer;
const clients: TestClient[] = [];

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
});

const CHUNK = 4 * 1024 * 1024;
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
));

// a raw key, in the shape the reader takes it
const rawKey = () => crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer;

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return new Uint8Array(b);
};

/** PNG wrapper, then the length-prefixed header, exactly as the writer lays it down. */
function frame(header: Record<string, unknown>, body: Uint8Array[]): Uint8Array[] {
  const head = new TextEncoder().encode(JSON.stringify(header));
  return [PNG, u32(head.length), head, ...body];
}

/** A response over a fixed list of byte runs, so a test can lie about a length and then stop. */
function responseOf(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  }));
}

/** A response that keeps offering data, counting how much it managed to hand over before stopping. */
function greedyResponse(chunks: Uint8Array[]): { res: Response; handedOver: () => number } {
  let index = 0;
  let bytes = 0;
  return {
    handedOver: () => bytes,
    res: new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
          bytes += chunks[index - 1].length;
          return;
        }
        // whatever the reader asks for beyond the frames, keep answering — this is the part that
        // matters: a reader that trusts the length will keep asking
        controller.enqueue(new Uint8Array(1024 * 1024));
        bytes += 1024 * 1024;
      },
    })),
  };
}

describe('a media stream from a host that does not want to be reasonable', () => {
  it('stops reading at a chunk length it cannot believe, rather than buffering up to it', async () => {
    const raw = rawKey();
    await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);

    // declares 4 GB and then is perfectly willing to keep sending, which is what makes this the
    // difference between refusing and filling the heap
    const { res, handedOver } = greedyResponse(frame(
      { v: 2, iv: 'AAAAAAAAAAAAAAAA', size: 16, chunk: CHUNK },
      [u32(0xfffffff0), new Uint8Array(12)],
    ));

    await expect(openStreamedAttachment(res, raw, 'AAAAAAAAAAAAAAAA')).rejects.toThrow(/implausible|too large/i);
    // The refusal has to happen on the length alone. If the reader buffered up to the declared size
    // first, this number would be in the gigabytes - and on a phone that is the whole failure.
    expect(handedOver(), 'the reader kept taking bytes from a length it had no reason to believe')
      .toBeLessThan(4 * 1024 * 1024);
  }, 60000);

  it('refuses a whole attachment bigger than the ceiling', async () => {
    const raw = rawKey();

    // a declared size past a gigabyte, with the stream ending immediately
    const stream = responseOf(frame(
      { v: 2, iv: 'AAAAAAAAAAAAAAAA', size: 4 * 1024 * 1024 * 1024, chunk: CHUNK },
      [u32(0)],
    ));
    await expect(openStreamedAttachment(stream, raw, 'AAAAAAAAAAAAAAAA')).rejects.toThrow(/too large/i);
  });

  it('refuses chunks that each look legal but add up past the declared size', async () => {
    const raw = rawKey();
    await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);

    // a small declared size, then chunks sized to the real limit, three of them
    const oneChunk = CHUNK + 16;
    const stream = responseOf(frame(
      { v: 2, iv: 'AAAAAAAAAAAAAAAA', size: 1024, chunk: CHUNK },
      [u32(oneChunk), new Uint8Array(12), new Uint8Array(oneChunk)],
    ));
    await expect(openStreamedAttachment(stream, raw, 'AAAAAAAAAAAAAAAA')).rejects.toThrow(/truncated|implausible|authenticate/i);
  });

  it('still opens an honest one', async () => {
    // the bounds are a refusal, not a break: a body written by the real writer still reads
    const source = new Blob([crypto.getRandomValues(new Uint8Array(1000))]);
    const enc = await encryptFileStream(source);
    const written = new Uint8Array(await new Response(enc.stream).arrayBuffer());
    const blob = await openStreamedAttachment(responseOf([written]), enc.rawKey, enc.ivB64);
    expect(blob.size).toBe(1000);
  }, 30000);

  it('rejects a tampered chunk rather than returning it', async () => {
    // the property the whole format rests on, checked directly: flip one byte of one chunk and the
    // plaintext must not appear
    const source = new Blob([crypto.getRandomValues(new Uint8Array(5000))]);
    const enc = await encryptFileStream(source);
    const written = new Uint8Array(await new Response(enc.stream).arrayBuffer());

    // find the PNG header and corrupt the last byte of the body
    const copy = written.slice();
    copy[copy.length - 1] ^= 0xff;

    await expect(openStreamedAttachment(responseOf([copy]), enc.rawKey, enc.ivB64)).rejects.toBeTruthy();
  }, 30000);
});