import { MAX_UPLOAD_BYTES } from './upload';

const ALGO_AES = { name: 'AES-GCM', length: 256 };

export interface EncryptedFile {
  blob: Blob;
  ivB64: string;
  rawKey: ArrayBuffer;
}

/**
 * A large attachment used to be encrypted in one piece, which meant the plaintext, the ciphertext and
 * a third copy of the ciphertext behind a PNG wrapper all had to exist at the same time. That is three
 * times the file size in memory at once, and it is why a private chat was capped at a hundred
 * megabytes: a phone cannot be asked to hold three copies of a film.
 *
 * So the ciphertext is written a chunk at a time instead, and handed to the network as a stream. Only
 * one chunk is ever resident, which lifts the limit to the same one gigabyte the global chat allows.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * The chunked body format, and the nonce construction it is built on.
 *
 * `v: 2` is a body of length-prefixed AES-GCM chunks under one content key. Chunks used to take a fresh
 * random 96-bit nonce each, carried in front of them, and nothing tied a chunk to where it sat: the index,
 * the declared total size and the header were all unauthenticated. A media host holding the ciphertext for
 * a stable url could reorder chunks inside one attachment or substitute chunk 0 for chunk 1, and every
 * chunk still authenticated, the `produced === header.size` total still held, and the client wrote a file
 * whose content the host chose at 4 MB granularity inside a legitimately encrypted attachment.
 *
 * So the nonce is no longer random per chunk. One random base nonce per file, in the header, and each
 * chunk's nonce is HKDF(base, info=chunk index) - which makes nonce uniqueness a property of the index
 * rather than of the RNG, so it can no longer be lost to a collision and cannot be replayed onto a different
 * index. HKDF rather than XOR-ing a counter into the base: XOR needs counter bits carved out of the random
 * nonce, so a 32-bit counter over a 12-byte nonce would leave only 64 bits of file entropy and would put a
 * 2^32-chunk ceiling on what can be encrypted, whereas HKDF returns a full 96 bits from the whole 96-bit
 * base with no bits spent and no ceiling to reason about. Both the index and the declared total size go in
 * as associated data on every chunk, so a chunk cannot be moved, dropped, duplicated or re-declared.
 *
 * The version went to 3 because the frame layout changed. A body written by a build with `v: 2` will not
 * open here - the old chunks carry their own random nonces, and a reader that derives them from the header
 * gets a different nonce and a failed tag - and a `v: 3` body will not open in an older build, which would
 * read the first four ciphertext bytes as a chunk length. Both directions are a real cost and it is
 * deliberate: keeping the old reader path alive would leave every existing attachment open to exactly the
 * reordering this fixes.
 */
const MEDIA_FORMAT_V3 = 3;

/**
 * The associated data for one chunk: a fixed label, then its index and the declared total size.
 *
 * Fixed-width binary rather than text, so no two different (index, size) pairs can produce the same bytes -
 * a string encoding would have to get its separators right, and this does not have to get anything right.
 */
function chunkAad(index: number, size: number): Uint8Array<ArrayBuffer> {
  const aad = new Uint8Array(12);
  const view = new DataView(aad.buffer);
  view.setUint32(0, MEDIA_FORMAT_V3, false);
  view.setUint32(4, index, false);
  view.setUint32(8, size, false);
  return aad;
}

/**
 * The nonce for one chunk, derived from the file's base nonce.
 *
 * HKDF is available in WebCrypto on every platform this runs on, so there is no reason to hand-roll it, and
 * the base nonce is imported once per body rather than per chunk.
 */
async function chunkNonce(base: CryptoKey, index: number): Promise<Uint8Array<ArrayBuffer>> {
  const info = new Uint8Array(4);
  new DataView(info.buffer).setUint32(0, index, false);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, base, 96);
  return new Uint8Array(bits);
}

export interface EncryptedFileStream {
  stream: ReadableStream<Uint8Array>;
  /** The whole plaintext length, so a reader can allocate before it starts. */
  size: number;
  rawKey: ArrayBuffer;
  /**
   * Carried in the file key entry alongside the wrapped key, which is where every reader looks for
   * it. The chunked format uses a nonce per chunk instead, but the entry still has the shape readers
   * expect, and it is what a reader falls back to if it ever meets an older body.
   */
  ivB64: string;
}

function u32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, false);
  return b;
}

/**
 * Reads exact byte counts out of a response stream.
 *
 * A queue of whatever the network handed over plus a read cursor into the head of it, rather than one
 * contiguous buffer. The contiguous version re-concatenated on every single read: `fill` allocated a fresh
 * `Uint8Array` of `buf.length + value.length` and copied the whole accumulated buffer into it, so the cost
 * of a drain was the sum of the running totals, not the total. `takeAll` calls `fill(buf.length + 1)`, which
 * is one read per network read and a full copy each time - a host trickling 64 KB reads over a 100 MB
 * attachment made the client copy roughly 77 GB and hang, and the 1 GB ceiling that stops the allocation
 * does nothing about the time. `readThroughWrap` was worse per byte: `tryTake(1)` per byte, so scanning the
 * 4 KB window cost about 4 K buffer copies. The chunked path paid it too, once per network read while a
 * 4 MB chunk was filling up.
 *
 * Nothing about the three public methods changed: same names, same arguments, same returned bytes.
 */
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Queued network reads. `chunks[head]` is the one being read from; everything before it is spent. */
  private chunks: Uint8Array[] = [];
  /** Index of the first unspent chunk. */
  private head = 0;
  /** How far into `chunks[head]` the read cursor already is. */
  private offset = 0;
  /** Bytes readable from the queue, which is what `fill` compares against and what `takeAll` bounds. */
  private buffered = 0;
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(min: number): Promise<boolean> {
    while (this.buffered < min && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) { this.done = true; break; }
      if (!value || !value.length) continue;
      this.chunks.push(value);
      this.buffered += value.length;
    }
    return this.buffered >= min;
  }

  /** Exactly n bytes, or null if the stream ended first. */
  async tryTake(n: number): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!(await this.fill(n))) return null;
    const head = this.chunks[this.head];
    // The common case by a wide margin: a 4-byte length or a 4 MB chunk sits inside one network read, so
    // nothing is copied and the head chunk is simply consumed.
    //
    // Note that this hands back a *view* into the network read, not a private copy. That is deliberate -
    // copying every chunk of a gigabyte would double the peak memory the streaming format exists to avoid -
    // so callers must treat the result as read-only, and must not keep it expecting it to be unaffected by
    // anything they do next. `compact` only drops the reference; it never writes back into consumed bytes,
    // so retaining the view is safe and mutating it is merely a way to surprise yourself.
    if (this.offset + n <= head.length) {
      const out = head.subarray(this.offset, this.offset + n) as Uint8Array<ArrayBuffer>;
      this.offset += n;
      this.buffered -= n;
      this.compact();
      return out;
    }
    // only a request that straddles two network reads pays for a copy, and only for the straddled bytes
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[this.head];
      const take = Math.min(chunk.length - this.offset, n - written);
      out.set(chunk.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      this.buffered -= take;
      if (this.offset >= chunk.length) { this.head++; this.offset = 0; }
    }
    this.compact();
    return out;
  }

  /**
   * Everything the stream has left, refusing to go past a ceiling.
   *
   * The bound is not an optimisation. This reads until the stream ends, so a host that never ends it would
   * grow this without limit, and a caller that only wants the next few bytes would be no protection —
   * `tryTake` hands back what it could read once the peer stops sending, which for a lying length is
   * nothing until the memory is already gone.
   *
   * One copy, at the end, instead of one per read: the legacy whole-body path is the only one that takes
   * an unbounded body into memory, so it is the one where the copy has to be cheap.
   */
  async takeAll(limit: number): Promise<Uint8Array<ArrayBuffer>> {
    while (!this.done) {
      if (this.buffered > limit) throw new Error('Attachment too large');
      await this.fill(this.buffered + 1);
    }
    if (this.buffered > limit) throw new Error('Attachment too large');
    const out = new Uint8Array(this.buffered);
    let written = 0;
    for (let i = this.head; i < this.chunks.length; i++) {
      const from = i === this.head ? this.offset : 0;
      out.set(this.chunks[i].subarray(from), written);
      written += this.chunks[i].length - from;
    }
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.buffered = 0;
    return out;
  }

  /** Drops the spent chunks once they are a meaningful fraction of the queue, so it cannot grow unbounded. */
  private compact(): void {
    if (this.head === 0) return;
    if (this.head === this.chunks.length) { this.chunks = []; this.head = 0; return; }
    // Amortised: slicing once per 64 spent chunks keeps the array from being reallocated on every read while
    // still discarding the old buffers, which is the thing that actually matters - a retained reference to
    // a 64 KB network read is what turns a queue into a leak.
    if (this.head >= 64) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  cancel(): void { try { this.reader.cancel(); } catch { /* the stream is already gone */ } }
}

export async function encryptFileStream(file: Blob): Promise<EncryptedFileStream> {
  const key = await crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt']);
  // One random nonce for the whole file. Every chunk's nonce is derived from this and the chunk's index, so
  // the nonce space is a function of the layout rather than of luck, and the value itself never has to be
  // unique per chunk - only per file, which is one draw instead of hundreds.
  const baseIv = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = await crypto.subtle.exportKey('raw', key);
  const nonceBase = await crypto.subtle.importKey('raw', baseIv, 'HKDF', false, ['deriveBits']);

  let offset = 0;
  let index = 0;
  let headerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        // The header carries the base nonce and the total size, and both are now authenticated by every
        // chunk through `chunkAad`. That is the other half of the fix: an unauthenticated size is what made
        // a re-declared length acceptable in the first place.
        const header = new TextEncoder().encode(JSON.stringify({
          v: MEDIA_FORMAT_V3,
          iv: bufToBase64(baseIv.buffer),
          size: file.size,
          chunk: CHUNK_BYTES,
        }));
        controller.enqueue(new Uint8Array(PNG_PREFIX));
        controller.enqueue(u32(header.length));
        controller.enqueue(header);
      }
      if (offset >= file.size) { controller.close(); return; }
      const end = Math.min(offset + CHUNK_BYTES, file.size);
      const plain = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      offset = end;
      const nonce = await chunkNonce(nonceBase, index);
      // the length goes in front of the chunk because the reader needs it to know how much to take, but it
      // is *not* what authenticates the chunk - the nonce and the associated data are, and the length is a
      // redundant claim the reader checks against the size the chunks themselves authenticated
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: chunkAad(index, file.size) }, key, plain
      ));
      index++;
      controller.enqueue(u32(ct.length));
      controller.enqueue(ct);
    },
  });

  return { stream, size: file.size, rawKey, ivB64: bufToBase64(baseIv.buffer) };
}

export function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function encryptFile(file: Blob): Promise<EncryptedFile> {
  const key = await crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = await file.arrayBuffer();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    blob: new Blob([ciphertext], { type: 'application/octet-stream' }),
    ivB64: bufToBase64(iv.buffer),
    rawKey: await crypto.subtle.exportKey('raw', key),
  };
}

const MEDIA_WRAP_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_PREFIX = new Uint8Array(base64ToBuf(MEDIA_WRAP_PNG_B64));
export function wrapForMedia(ciphertext: ArrayBuffer): Blob {
  const ct = new Uint8Array(ciphertext);
  const out = new Uint8Array(PNG_PREFIX.length + ct.length);
  out.set(PNG_PREFIX, 0);
  out.set(ct, PNG_PREFIX.length);
  return new Blob([out], { type: 'image/png' });
}

/**
 * Pulls bytes off a response stream until the wrapper PNG has been consumed, so the ciphertext that
 * follows can be read as a chunk stream. The wrapper is located the same way the in-memory path
 * locates it, which is why a host that re-encoded the image still works.
 */
/**
 * Steps over the wrapper PNG so the ciphertext that follows can be read as a stream.
 *
 * The wrapper is located by its IEND marker rather than by length, so a host that touched the bytes
 * does not break the read. When there is no wrapper at all — an attachment stored without one — the
 * bytes that were scanned are handed back, because they are the start of the ciphertext and dropping
 * them would corrupt the file in a way that only shows up as a decryption failure much later.
 */
async function readThroughWrap(reader: ByteReader): Promise<{ found: boolean; scanned: Uint8Array<ArrayBuffer> }> {
  const LIMIT = PNG_PREFIX.length + 4096;
  const seen = new Uint8Array(LIMIT);
  let filled = 0;
  for (;;) {
    if (filled >= 4 && seen[filled - 4] === 0x49 && seen[filled - 3] === 0x45 && seen[filled - 2] === 0x4e && seen[filled - 1] === 0x44) {
      // the marker itself is already spent, since the scan consumed it; only the crc after it still
      // has to be stepped over before the ciphertext begins
      //
      // and it has to actually be there. This used to discard the result, so a stream that ended between
      // the marker and the CRC reported `found: true` with four bytes of the *ciphertext* already eaten -
      // which surfaces much later as an unexplained four-byte gap and a tag failure that names the file
      // rather than the host. A truncated wrapper is not a wrapper.
      if (!(await reader.tryTake(4))) return { found: false, scanned: seen.subarray(0, filled) };
      return { found: true, scanned: seen.subarray(0, filled) };
    }
    if (filled >= LIMIT) return { found: false, scanned: seen };
    const byte = await reader.tryTake(1);
    if (!byte) return { found: false, scanned: seen.subarray(0, filled) };
    seen[filled++] = byte[0];
  }
}

interface MediaHeader { v: number; size: number; iv: string }

/** A header is a short json blob, so a length that could not be one means this is not a header. */
const MAX_HEADER_BYTES = 4096;

/**
 * Tries to read a version header without committing to it. A body in the old format begins with
 * ciphertext, whose first four bytes read as an enormous length, so the length check is what tells
 * the two apart before anything is treated as a header. Anything already read is handed back as the
 * start of the ciphertext for the old path.
 */
async function tryReadHeader(
  reader: ByteReader
): Promise<{ header: MediaHeader } | { legacyStart: Uint8Array<ArrayBuffer> }> {
  const lenBytes = await reader.tryTake(4);
  if (!lenBytes) return { legacyStart: new Uint8Array(0) };
  const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0, false);
  if (len === 0 || len > MAX_HEADER_BYTES) return { legacyStart: lenBytes };
  const body = await reader.tryTake(len);
  if (!body) return { legacyStart: lenBytes };
  let parsed: MediaHeader | null = null;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as MediaHeader;
  } catch { /* not json, so it is ciphertext that happens to start with a plausible length */ }
  // The nonce is required, not merely expected: without it there is nothing to derive the per-chunk nonces
  // from, and a reader that fell back to making one up would be back to accepting any nonce the host liked.
  if (parsed && parsed.v === MEDIA_FORMAT_V3 && typeof parsed.size === 'number' && typeof parsed.iv === 'string') {
    return { header: parsed };
  }
  // A `v: 2` header is refused by name rather than falling through to the legacy whole-body path. This is
  // not just tidiness: those chunks cannot be read at all any more, because each one was sealed under its
  // own random nonce and this reader derives every nonce from the header. Left to fall through it would be
  // mistaken for a single AES-GCM message over the whole body and read to its end first - which turns an
  // unsupported attachment into an allocation of up to a gigabyte, taken from a host that has already been
  // told it is not welcome. Saying what happened costs one branch.
  //
  // It has to live *outside* the `try` above. Inside it, the `throw` was caught by the `catch {}` two lines
  // down - whose comment is about ciphertext, and which cannot tell an unsupported header from it - so the
  // branch was unreachable and every `v: 2` attachment quietly became the gigabyte read it was written to
  // prevent.
  if (parsed && parsed.v === 2 && typeof parsed.size === 'number') {
    throw new Error('Attachment format no longer supported');
  }
  const joined = new Uint8Array(lenBytes.length + body.length);
  joined.set(lenBytes, 0);
  joined.set(body, lenBytes.length);
  return { legacyStart: joined };
}

/** GCM's authentication tag, which every chunk carries on top of its plaintext. */
const GCM_TAG_BYTES = 16;
/**
 * The largest a chunk may claim to be.
 *
 * The length is a bare uint32 in front of the ciphertext and is *not* authenticated — GCM authenticates
 * the ciphertext, and by the time a tag can be checked the bytes have already been read into memory. So
 * this is the bound that has to exist here rather than being taken on trust from whoever wrote the number.
 *
 * Without it, whoever controls the media host declares a four-gigabyte chunk and the client sits there
 * accumulating it before the decryption that would have rejected it ever runs. The media host is a third
 * party, so that number is genuinely not ours to trust: the honest answer to a length that large is that
 * the body is not one of ours, which is exactly what refusing says.
 */
const MAX_CHUNK_CIPHERTEXT = CHUNK_BYTES + GCM_TAG_BYTES;

/**
 * The ceiling on a whole attachment, which is the server's - not a second number of our own.
 *
 * It used to be written out here as a flat gigabyte while `upload.ts` and the server both said a thousand
 * megabytes. Nothing breaks at 1000 MB rather than 1024, but two constants for one limit means one of them
 * is wrong by the time somebody edits it, and the reader's ceiling is the one that decides how much this tab
 * will hold in memory before it gives up. `upload.ts` is where the server's figure already lives, and it
 * has no imports of its own, so this is a one-way dependency.
 */
const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;

/**
 * Reads a chunked attachment a chunk at a time.
 *
 * Each chunk is authenticated by GCM before its plaintext is kept — `crypto.subtle.decrypt` throws on a bad
 * tag and nothing is pushed, so a tampered chunk cannot reach the result. What is new since this format was
 * written is *which* chunk has to be where: the nonce is derived from the header's base nonce and the index
 * the reader is at, and the index and the declared size are bound in as associated data. So the host cannot
 * reorder two chunks inside one attachment, cannot put chunk zero where chunk one belongs, cannot replay a
 * chunk at another index, and cannot re-declare the total size — every one of those now produces a chunk
 * that fails its tag rather than a file the host composed. A duplicate is caught the same way: two copies of
 * one chunk decrypt at two different indices, so at most the first can authenticate.
 *
 * The length in front of each chunk is still not authenticated, and that is fine now for a reason that was
 * not true before: the only number the derivation depends on is the reader's own index, which counts chunks
 * in the order it received them. A lying length therefore gets the reader to take the wrong number of bytes
 * for the next chunk, and the resulting chunk fails its tag. It cannot be used to make a chunk decrypt in a
 * different place, because the place is not something the length can influence. The bounds below stay
 * regardless: by the time a tag can be checked the bytes are already in memory, so a length is only safe to
 * believe up to a ceiling.
 *
 * What is *not* true is the older claim in this comment that the file never occupies the heap. On the way
 * out the writer is genuinely streaming: one chunk at a time, and the plaintext is never whole. On the way
 * in it cannot be — a browser has no place to stream a file to — so the plaintext parts are held until
 * they are handed to a Blob. The bounds below are therefore not a nicety: they are what stops a hostile
 * or broken host from turning that into an allocation it chooses.
 */
async function decryptChunkedBody(reader: ByteReader, aesKey: CryptoKey, header: MediaHeader): Promise<Blob> {
  // the declared length is unauthenticated, so it is checked against the ceiling before anything is
  // allocated on the strength of it. It is authenticated in the sense that matters - every chunk binds it -
  // but that check cannot run until the bytes are read, which is exactly what makes this bound necessary.
  if (!Number.isFinite(header.size) || header.size < 0 || header.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachment too large');
  }
  let nonceBase: CryptoKey;
  try {
    nonceBase = await crypto.subtle.importKey('raw', base64ToBuf(header.iv), 'HKDF', false, ['deriveBits']);
  } catch {
    throw new Error('Attachment header unusable');
  }

  const parts: BlobPart[] = [];
  let produced = 0;
  let index = 0;
  for (;;) {
    const b = await reader.tryTake(4);
    if (!b) break; // end of the body
    const len = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
    if (len === 0) break;
    if (len > MAX_CHUNK_CIPHERTEXT) throw new Error('Attachment chunk implausible');
    // checked against the running total before the chunk is read, so a stream of chunks that each claim
    // to be legal cannot add up past the declared size either
    if (produced + len - GCM_TAG_BYTES > header.size) throw new Error('Attachment truncated');
    const ct = await reader.tryTake(len);
    if (!ct) throw new Error('Attachment truncated');
    // throws on a bad tag, so a chunk that does not authenticate never reaches `parts`, and a chunk
    // presented at the wrong index gets a nonce that was never used to encrypt anything
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: await chunkNonce(nonceBase, index), additionalData: chunkAad(index, header.size) },
      aesKey,
      ct
    );
    parts.push(new Uint8Array(plain));
    produced += plain.byteLength;
    index++;
  }
  // A body that stopped early produces a shorter file, which the length catches. It also cannot be reached
  // by substituting chunks: the total is what the host declared *and* what every chunk was sealed against,
  // so a shorter file is refused and a longer one is not expressible.
  if (produced !== header.size) throw new Error('Attachment truncated');
  return new Blob(parts);
}

/**
 * Opens an attachment, whatever format it was written in.
 *
 * Anything sent before the chunked format existed is one AES-GCM message over the whole file, so it
 * has to be read into memory to be opened — which is fine, because it was written under a ceiling
 * that made that necessary. New attachments stream: only one chunk is ever resident, which is what
 * lifted the private-chat limit to the same gigabyte the global chat allows.
 */
export async function openStreamedAttachment(
  res: Response,
  rawKey: ArrayBuffer,
  legacyIvB64: string
): Promise<Blob> {
  if (!res.body) throw new Error('Empty response');
  const aesKey = await crypto.subtle.importKey('raw', rawKey, ALGO_AES, false, ['decrypt']);
  const reader = new ByteReader(res.body as ReadableStream<Uint8Array>);

  // Every way out of this function other than a Blob leaves the response half-read with the reader still
  // locked, and nothing told the host to stop. A body that was refused - too large, implausible chunk,
  // truncated, or failing its tag - therefore kept arriving, and kept being buffered by the network stack
  // for a file the client had already decided to throw away. `ByteReader.cancel` existed for this and no
  // caller used it, so it is done here, once, where the reader lives.
  try {
    return await readAttachment(reader, aesKey, legacyIvB64);
  } catch (e) {
    reader.cancel();
    throw e;
  }
}

async function readAttachment(reader: ByteReader, aesKey: CryptoKey, legacyIvB64: string): Promise<Blob> {
  // an attachment with no wrapper is one that was stored without one, and the scan window is the
  // start of its ciphertext
  const wrap = await readThroughWrap(reader);
  let legacyStart: Uint8Array<ArrayBuffer> = wrap.found ? new Uint8Array(0) : wrap.scanned;

  if (wrap.found) {
    const attempt = await tryReadHeader(reader);
    if ('header' in attempt) return decryptChunkedBody(reader, aesKey, attempt.header);
    legacyStart = attempt.legacyStart;
  }

  // The one-AES-message format, which is read whole because it has to be decrypted whole.
  //
  // This is the only path where an unbounded body is taken into memory, so the bound goes here rather
  // than trusting whatever the host says it is sending: `takeAll` reads until the stream ends, and the
  // media host is a third party that could otherwise hand over as much as it liked. The ceiling is the
  // same one the server enforces on the way in, plus a wrapper's worth of slack.
  const rest = await reader.takeAll(MAX_ATTACHMENT_BYTES + PNG_PREFIX.length + MAX_HEADER_BYTES);
  const whole = new Uint8Array(legacyStart.length + rest.length);
  whole.set(legacyStart, 0);
  whole.set(rest, legacyStart.length);
  // The wrapper is already gone in both branches, so nothing is stripped here.
  //
  // `readThroughWrap` consumes it as it scans - through the IEND marker and the four CRC bytes after it -
  // and hands back `scanned` only when it found *no* wrapper, in which case those bytes are the start of
  // the ciphertext. So `whole` never contains a wrapper, and running `stripMediaWrap` over it was a scan
  // of the ciphertext for `IEND`. That lands at random with probability (N-3)/2^32 - roughly 0.02% on a
  // megabyte and 23% on a gigabyte - and everything past the hit was thrown away, so the tag failed and
  // the user was told "Message did not authenticate" about a file that was perfectly intact. The guarded
  // form `wrap.found ? stripMediaWrap(whole) : whole` fixed the *unwrapped* case and left this one: the
  // wrapper is gone precisely when `wrap.found` is true.
  const payload = whole;
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(legacyIvB64) }, aesKey, payload);
  return new Blob([plaintext]);
}

export async function wrapFileKeyFor(
  rawKey: ArrayBuffer,
  recipientPublicKey: JsonWebKey
): Promise<string> {
  const pub = await crypto.subtle.importKey('jwk', recipientPublicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, rawKey);
  return bufToBase64(wrapped);
}

export async function wrapFileKeyForChannel(
  rawKey: ArrayBuffer,
  channelMediaKeyB64: string,
  ivB64: string
): Promise<string> {
  const iv = base64ToBuf(ivB64);
  const key = await crypto.subtle.importKey('raw', base64ToBuf(channelMediaKeyB64), ALGO_AES, false, ['encrypt', 'decrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, rawKey);
  return bufToBase64(ct);
}

/**
 * The wrapped-key map, for the public channel only.
 *
 * A `#general` attachment is not encrypted and cannot be: there is nobody to encrypt it to. The channel
 * has one symmetric key, the server hands it to signed-in clients, and the wrapped key travels beside
 * the file. That is a deliberate property of a public room rather than a private-message shortcut, which
 * is why this function is no longer called for direct messages at all — a private attachment's key goes
 * inside the sealed body instead.
 */
export async function buildFileKeyMap(
  rawKey: ArrayBuffer,
  recipientIds: string[],
  getPublicKey: (id: string) => JsonWebKey | null,
  ownId: string,
  ownPublicKey: JsonWebKey | null,
  ivB64: string,
  channelMediaKeyB64?: string | null
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const ids = new Set(recipientIds);
  if (ownId) ids.add(ownId);
  for (const id of ids) {
    const jwk = id === ownId ? ownPublicKey : getPublicKey(id);
    if (!jwk) continue;
    try {
      map[id] = `${ivB64}:${await wrapFileKeyFor(rawKey, jwk)}`;
    } catch (e) {
      console.error(`wrapFileKeyFor failed for ${id}:`, e);
    }
  }
  if (channelMediaKeyB64) {
    try {
      map['channel'] = `${ivB64}:${await wrapFileKeyForChannel(rawKey, channelMediaKeyB64, ivB64)}`;
    } catch (e) {
      console.error('wrapFileKeyForChannel failed:', e);
    }
  }
  return map;
}

/**
 * Packs the attachment key into the message text, which is then sealed with everything else.
 *
 * This is the whole reason a private attachment can be opened. The alternative - which is what this app
 * used to do - was to wrap the file key to a long-lived RSA key for each participant and put the wrapped
 * copies in the message payload, outside the ciphertext. That put every attachment's key on the server
 * under a key that never rotated: seizing the server opened every photo and video ever sent in every
 * private chat, no matter how well the message text itself was protected.
 *
 * Putting the key inside the sealed body removes the long-lived key from the path entirely. The
 * attachment now travels exactly as the words do: one sealed copy per device, forward secrecy, and
 * nothing on the server that opens it.
 *
 * The key is carried as `<iv>:<key>` in base64, in a marker the reader strips before showing anything.
 */
const FILE_KEY_MARKER = '[filekey]';
const FILE_KEY_MARKER_END = '[/filekey]';

/** Wraps a file key into the message text that gets sealed. */
export function sealFileKeyInText(text: string, rawKey: ArrayBuffer, ivB64: string): string {
  const packed = `${FILE_KEY_MARKER}${ivB64}:${bufToBase64(rawKey)}${FILE_KEY_MARKER_END}`;
  // appended rather than prepended, so the media marker at the start of the line keeps matching the way
  // every reader and the quote renderer already expect
  return `${text}\n${packed}`;
}

/**
 * Pulls the attachment key back out and returns the text without it.
 *
 * Returns null when there is no key in the text, which is the ordinary case for anything that is not a
 * private attachment and for every attachment sent before this change.
 */
export function openFileKeyFromText(text: string): { text: string; entry: string | null } {
  const start = text.indexOf(FILE_KEY_MARKER);
  if (start < 0) return { text, entry: null };
  const end = text.indexOf(FILE_KEY_MARKER_END, start);
  if (end < 0) return { text, entry: null };
  const entry = text.slice(start + FILE_KEY_MARKER.length, end);
  return { text: text.slice(0, start).replace(/\n$/, ''), entry: entry || null };
}

/** Opens an attachment from a key that came out of the sealed message body. */
export async function openAttachmentWithKey(entry: string, url: string): Promise<Blob> {
  const [ivB64, keyB64] = entry.split(':');
  if (!ivB64 || !keyB64) throw new Error('Malformed file key');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return openStreamedAttachment(res, base64ToBuf(keyB64), ivB64);
}

/**
 * Opens an attachment from the old wrapped-key map, for messages sent before the key moved inside.
 *
 * Kept because those messages are still in people's histories and are not re-sendable: a key that stops
 * being readable takes a photo with it. New messages never come through here.
 */
export async function unwrapAndDecrypt(
  entry: string,
  url: string,
  privateKeyJwk: JsonWebKey
): Promise<Blob> {
  const [ivB64, wrappedB64] = entry.split(':');
  if (!ivB64 || !wrappedB64) throw new Error('Malformed file key');
  const priv = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, base64ToBuf(wrappedB64));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return openStreamedAttachment(res, rawKey, ivB64);
}

export async function unwrapAndDecryptChannelBlob(
  entry: string,
  channelMediaKeyB64: string
): Promise<ArrayBuffer> {
  const [ivB64, wrappedB64] = entry.split(':');
  if (!ivB64 || !wrappedB64) throw new Error('Malformed file key');
  const wrapKey = await crypto.subtle.importKey('raw', base64ToBuf(channelMediaKeyB64), ALGO_AES, false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(ivB64) }, wrapKey, base64ToBuf(wrappedB64));
}

export async function unwrapAndDecryptChannel(
  entry: string,
  url: string,
  channelMediaKeyB64: string
): Promise<Blob> {
  const [ivB64] = entry.split(':');
  if (!ivB64) throw new Error('Malformed file key');
  const rawKey = await unwrapAndDecryptChannelBlob(entry, channelMediaKeyB64);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return openStreamedAttachment(res, rawKey, ivB64);
}

/**
 * A media message carries its url inside a `[image]...[/image]` marker. The marker used to be
 * matched with five separate copies of the regex, two of which disagreed about the capture groups,
 * so the reader asked for group 2 of a regex that only had one: every attachment was fetched as
 * `/api/media?url=undefined` and reported "Could not decrypt attachment". One parser, one shape,
 * no capture indices to get wrong.
 */
const MEDIA_TAG_RE = /^\[(image|video)\]([\s\S]*?)\[\/\1\]/;

export type MediaKind = 'image' | 'video';

export interface MediaTag {
  kind: MediaKind;
  url: string;
}

export function parseMediaTag(text: string | null | undefined): MediaTag | null {
  if (!text) return null;
  const m = MEDIA_TAG_RE.exec(text);
  // an empty url would turn into a request for /api/media?url= and then a decryption error, so a
  // bare marker with nothing in it is not a media message
  if (!m || !m[2]) return null;
  return { kind: m[1] as MediaKind, url: m[2] };
}

export function isMediaMessage(text: string | null | undefined): boolean {
  return parseMediaTag(text) !== null;
}

export function buildMediaTag(kind: MediaKind, url: string): string {
  return `[${kind}]${url}[/${kind}]`;
}
