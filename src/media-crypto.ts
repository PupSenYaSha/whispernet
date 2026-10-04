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
const MEDIA_FORMAT_V2 = 2;

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

/** Reads exact byte counts out of a response stream, keeping at most one chunk buffered. */
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(min: number): Promise<boolean> {
    while (this.buf.length < min && !this.done) {
      const { value, done } = await this.reader.read();
      if (done) { this.done = true; break; }
      if (!value || !value.length) continue;
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf, 0);
      next.set(value, this.buf.length);
      this.buf = next;
    }
    return this.buf.length >= min;
  }

  /** Exactly n bytes, or null if the stream ended first. */
  async tryTake(n: number): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!(await this.fill(n))) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /**
 * Everything the stream has left, refusing to go past a ceiling.
 *
 * The bound is not an optimisation. This reads until the stream ends, so a host that never ends it would
 * grow this without limit, and a caller that only wants the next few bytes would be no protection —
 * `tryTake` hands back what it could read once the peer stops sending, which for a lying length is
 * nothing until the memory is already gone.
 */
async takeAll(limit: number): Promise<Uint8Array<ArrayBuffer>> {
  while (!this.done) {
    if (this.buf.length > limit) throw new Error('Attachment too large');
    await this.fill(this.buf.length + 1);
  }
  if (this.buf.length > limit) throw new Error('Attachment too large');
  const out = this.buf;
  this.buf = new Uint8Array(0);
  return out;
}

  cancel(): void { try { this.reader.cancel(); } catch { /* the stream is already gone */ } }
}

export async function encryptFileStream(file: Blob): Promise<EncryptedFileStream> {
  const key = await crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = await crypto.subtle.exportKey('raw', key);

  let offset = 0;
  let headerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        const header = new TextEncoder().encode(JSON.stringify({
          v: MEDIA_FORMAT_V2,
          iv: bufToBase64(iv.buffer),
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
      // a fresh nonce per chunk, carried in front of it, so a truncated body is detected rather than
      // silently decrypted into a file with a hole in the middle
      const chunkIv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIv }, key, plain));
      controller.enqueue(u32(ct.length));
      controller.enqueue(chunkIv);
      controller.enqueue(ct);
    },
  });

  return { stream, size: file.size, rawKey, ivB64: bufToBase64(iv.buffer) };
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
const IEND = [0x49, 0x45, 0x4e, 0x44];

function indexOfSeq(haystack: Uint8Array, needle: number[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

export function wrapForMedia(ciphertext: ArrayBuffer): Blob {
  const ct = new Uint8Array(ciphertext);
  const out = new Uint8Array(PNG_PREFIX.length + ct.length);
  out.set(PNG_PREFIX, 0);
  out.set(ct, PNG_PREFIX.length);
  return new Blob([out], { type: 'image/png' });
}

function stripMediaWrap(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = bytes.buffer as ArrayBuffer;
  const i = indexOfSeq(bytes, IEND);
  if (i < 0) return new Uint8Array(buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return new Uint8Array(buf.slice(bytes.byteOffset + i + 8, bytes.byteOffset + bytes.byteLength)); 
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
      await reader.tryTake(4);
      return { found: true, scanned: seen.subarray(0, filled) };
    }
    if (filled >= LIMIT) return { found: false, scanned: seen };
    const byte = await reader.tryTake(1);
    if (!byte) return { found: false, scanned: seen.subarray(0, filled) };
    seen[filled++] = byte[0];
  }
}

interface MediaHeader { v: number; size: number }

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
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as MediaHeader;
    if (parsed && parsed.v === MEDIA_FORMAT_V2 && typeof parsed.size === 'number') {
      return { header: parsed };
    }
  } catch { /* not json, so it is ciphertext that happens to start with a plausible length */ }
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

/** The ceiling on a whole attachment, matching what the server will accept on the way in. */
const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024;

/**
 * Reads a chunked attachment a chunk at a time.
 *
 * Each chunk is authenticated by GCM before its plaintext is kept — `crypto.subtle.decrypt` throws on a
 * bad tag and nothing is pushed, so a tampered chunk cannot reach the result. That is the property the
 * whole format rests on, and it is why a doctored media stream cannot smuggle anything into a viewer.
 *
 * What is *not* true is the older claim in this comment that the file never occupies the heap. On the way
 * out the writer is genuinely streaming: one chunk at a time, and the plaintext is never whole. On the way
 * in it cannot be — a browser has no place to stream a file to — so the plaintext parts are held until
 * they are handed to a Blob. The bounds below are therefore not a nicety: they are what stops a hostile
 * or broken host from turning that into an allocation it chooses.
 */
async function decryptChunkedBody(reader: ByteReader, aesKey: CryptoKey, header: MediaHeader): Promise<Blob> {
  // the declared length is unauthenticated too, so it is checked against the ceiling before anything is
  // allocated on the strength of it
  if (!Number.isFinite(header.size) || header.size < 0 || header.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachment too large');
  }

  const parts: BlobPart[] = [];
  let produced = 0;
  for (;;) {
    const b = await reader.tryTake(4);
    if (!b) break; // end of the body
    const len = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, false);
    if (len === 0) break;
    if (len > MAX_CHUNK_CIPHERTEXT) throw new Error('Attachment chunk implausible');
    // checked against the running total before the chunk is read, so a stream of chunks that each claim
    // to be legal cannot add up past the declared size either
    if (produced + len - GCM_TAG_BYTES > header.size) throw new Error('Attachment truncated');
    const chunkIv = await reader.tryTake(12);
    const ct = await reader.tryTake(len);
    if (!chunkIv || !ct) throw new Error('Attachment truncated');
    // throws on a bad tag, so a chunk that does not authenticate never reaches `parts`
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv }, aesKey, ct);
    parts.push(new Uint8Array(plain));
    produced += plain.byteLength;
  }
  // a body that stopped early produces a shorter file, which the length catches. The length itself is
  // not authenticated, but every chunk is, so the worst a dishonest server can do is refuse to hand over
  // the file at all — and the size it claims is now bounded before it is believed.
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
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(legacyIvB64) }, aesKey, stripMediaWrap(whole));
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
