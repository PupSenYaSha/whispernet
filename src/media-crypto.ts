const ALGO_AES = { name: 'AES-GCM', length: 256 };

export interface EncryptedFile {
  blob: Blob;
  ivB64: string;
  rawKey: ArrayBuffer;
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

// Some media hosts (e.g. img.n1ko.dev) only accept genuine image/video/audio
// files and validate file contents. To store end-to-end-encrypted blobs there
// we disguise the ciphertext as a valid 1x1 PNG. The host stores bytes verbatim
// (including the trailing ciphertext), so we strip the prefix on download.
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

export function stripMediaWrap(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = bytes.buffer as ArrayBuffer;
  const i = indexOfSeq(bytes, IEND);
  if (i < 0) return new Uint8Array(buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return new Uint8Array(buf.slice(bytes.byteOffset + i + 8, bytes.byteOffset + bytes.byteLength)); // past length(4)+'IEND'(4)+crc(4)
}

export async function wrapFileKeyFor(
  rawKey: ArrayBuffer,
  recipientPublicKey: JsonWebKey
): Promise<string> {
  const pub = await crypto.subtle.importKey('jwk', recipientPublicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, rawKey);
  return bufToBase64(wrapped);
}

// General-chat channel media: the raw key is wrapped with the shared channel
// key (AES-GCM) so that ANY registered member - including members who join
// after the media was posted - can decrypt it. Reuses the media IV as the wrap
// IV; AES-GCM is safe with distinct keys under a single IV.
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
    } catch {}
  }
  if (channelMediaKeyB64) {
    try {
      map['channel'] = `${ivB64}:${await wrapFileKeyForChannel(rawKey, channelMediaKeyB64, ivB64)}`;
    } catch {}
  }
  return map;
}

export async function unwrapAndDecrypt(
  entry: string,
  url: string,
  privateKeyJwk: JsonWebKey
): Promise<Blob> {
  const [ivB64, wrappedB64] = entry.split(':');
  if (!ivB64 || !wrappedB64) throw new Error('Malformed file key');
  const priv = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, base64ToBuf(wrappedB64));
  const aesKey = await crypto.subtle.importKey('raw', rawKey, ALGO_AES, false, ['decrypt']);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  const ciphertext = stripMediaWrap(raw);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(ivB64) }, aesKey, ciphertext);
  return new Blob([plaintext]);
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
  const aesKey = await crypto.subtle.importKey('raw', rawKey, ALGO_AES, false, ['decrypt']);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  const ciphertext = stripMediaWrap(raw);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(ivB64) }, aesKey, ciphertext);
  return new Blob([plaintext]);
}
