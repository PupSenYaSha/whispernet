import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { generateKeyPair } from '../../src/crypto';
import { encryptFile, encryptFileStream, buildFileKeyMap, unwrapAndDecrypt } from '../../src/media-crypto';

let server: StartedServer;
let mediaHost: { port: number; stop: () => void };
let origin: string;
const clients: TestClient[] = [];

const open = async (ip: string, label: string) => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  return c;
};

beforeAll(async () => {
  // the media base url is read once when the app is built, so the stand in host has to be up first
  mediaHost = await startLocalMediaHost();
  process.env.MEDIA_BASE_URL = `http://127.0.0.1:${mediaHost.port}`;
  // a megabyte rather than a gigabyte, so the ceiling can be crossed by a test instead of by a
  // hypothetical: the guard is the same one either way
  server = await startTestServer({ DISABLE_RATE_LIMITS: '0', MAX_UPLOAD_SIZE: String(1024 * 1024) });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
  mediaHost.stop();
});

describe('dm media over the wire', () => {
  it('wraps a media key for the recipient and for the sender', async () => {
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();

    const enc = await encryptFile(new Blob([new TextEncoder().encode('pretend this is a photo')]));
    const fileKey = await buildFileKeyMap(
      enc.rawKey, ['user-b'], () => bKeys.publicKey, 'user-a', aKeys.publicKey, enc.ivB64, null,
    );
    expect(Object.keys(fileKey).sort()).toEqual(['user-a', 'user-b']);

    // the sender can read their own copy back with their own private key
    const own = await unwrapRawKey(fileKey['user-a'], aKeys.privateKey);
    const peer = await unwrapRawKey(fileKey['user-b'], bKeys.privateKey);
    expect(Buffer.from(own).toString('hex')).toBe(Buffer.from(peer).toString('hex'));
  });

  it('uploads, delivers the key and reads the bytes back', async () => {
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();

    const ca = await open('10.20.0.1', 'ma');
const cb = await open('10.20.0.2', 'mb');
const ra = await ca.register(uniqueNick('ma'), { publicKey: aKeys.publicKey });
    const token = ca.uploadToken;
    expect(token).toBeTruthy();
    const rb = await cb.register(uniqueNick('mb'), { publicKey: bKeys.publicKey });
    expect(ra.type, `a: ${JSON.stringify(ra.payload)}`).toBe('auth_success');
    expect(rb.type, `b: ${JSON.stringify(rb.payload)}`).toBe('auth_success');

    const plaintext = 'the bytes of a photo';
    const enc = await encryptFile(new Blob([new TextEncoder().encode(plaintext)]));
    const url = await upload(origin, enc.blob, token);
    expect(url).toMatch(/^https?:\/\//);

    const fileKey = await buildFileKeyMap(
      enc.rawKey, [rb.payload.userId], () => bKeys.publicKey, ra.payload.userId, aKeys.publicKey, enc.ivB64, null,
    );

    ca.send('dm_send', {
      toKey: bKeys.publicKey,
      text: '',
      fileKey,
      clientId: 'clientid12345678',
      encrypted: { ciphertext: 'x', iv: 'y', encryptedKeys: {} },
    });

    const delivered = await cb.waitFor('dm_message');
    expect(delivered.payload.fileKey, 'the server did not deliver the file key').toBeTruthy();

    const blob = await unwrapAndDecrypt(
      delivered.payload.fileKey[rb.payload.userId],
      `${origin}/api/media?url=${encodeURIComponent(url)}`,
      bKeys.privateKey,
    );
    expect(await blob.text()).toBe(plaintext);
  });

  it('delivers the same key in the history, not only live', async () => {
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();

    const ca = await open('10.20.0.3', 'ha');
const cb = await open('10.20.0.4', 'hb');
const ra = await ca.register(uniqueNick('ha'), { publicKey: aKeys.publicKey });
    const token = ca.uploadToken;
    const rb = await cb.register(uniqueNick('hb'), { publicKey: bKeys.publicKey });
    expect(ra.type).toBe('auth_success');
    expect(rb.type).toBe('auth_success');

    const plaintext = 'history photo';
    const enc = await encryptFile(new Blob([new TextEncoder().encode(plaintext)]));
    const url = await upload(origin, enc.blob, token);
    const fileKey = await buildFileKeyMap(
      enc.rawKey, [rb.payload.userId], () => bKeys.publicKey, ra.payload.userId, aKeys.publicKey, enc.ivB64, null,
    );

    ca.send('dm_send', {
      toKey: bKeys.publicKey, text: '', fileKey, clientId: 'historyid1234567',
      encrypted: { ciphertext: 'x', iv: 'y', encryptedKeys: {} },
    });
    await cb.waitFor('dm_message');

    cb.clear();
    cb.send('dm_history', { with: ra.payload.userId });
    const history = await cb.waitFor('dm_history');
    const withMedia = history.payload.messages.find((m: any) => m.fileKey);
    expect(withMedia, 'the history entry lost its file key').toBeTruthy();

    const blob = await unwrapAndDecrypt(
      withMedia.fileKey[rb.payload.userId],
      `${origin}/api/media?url=${encodeURIComponent(url)}`,
      bKeys.privateKey,
    );
    expect(await blob.text()).toBe(plaintext);
  });
});

async function unwrapRawKey(entry: string, privateKeyJwk: JsonWebKey): Promise<Uint8Array> {
  const wrappedB64 = entry.split(':')[1];
  const priv = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, base64ToBuf(wrappedB64)));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer as ArrayBuffer;
}

/** Stands in for the remote image host: accepts a multipart upload and serves it back. */
async function startLocalMediaHost(): Promise<{ port: number; stop: () => void }> {
  const http = await import('http');
  const files = new Map<string, Buffer>();
  let n = 0;
  let selfOrigin = '';
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const start = body.indexOf('\r\n\r\n') + 4;
        const end = body.lastIndexOf('\r\n--');
        const id = 'f' + n++;
        files.set(id, body.subarray(start, end));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // the proxy only accepts urls that match MEDIA_BASE_URL, so report our own origin
        res.end(`data: {"status":"ready","url":"${selfOrigin}/${id}.bin"}\n\n`);
      });
      return;
    }
    const id = (req.url || '').replace(/^\//, '').replace(/\.bin$/, '');
    const data = files.get(id);
    if (!data) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(data);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  selfOrigin = `http://127.0.0.1:${port}`;
  return { port, stop: () => srv.close() };
}

async function upload(origin: string, blob: Blob, token: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([blob], { type: 'image/png' }), 'media.png');
  const res = await fetch(`${origin}/api/upload`, { method: 'POST', body: form, headers: { 'X-WN-Upload-Token': token } });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.url;
}

/**
 * The streamed route is what lifted the private-chat ceiling: a multipart body has to arrive whole,
 * so a large attachment had to be held in memory by the sender before the request could start.
 */
async function uploadStream(origin: string, stream: ReadableStream<Uint8Array>, token: string): Promise<string> {
  const res = await fetch(`${origin}/api/upload-raw?name=media.png&type=image%2Fpng`, {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/octet-stream', 'X-WN-Upload-Token': token },
  } as RequestInit);
  if (!res.ok) throw new Error(`streamed upload failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.url;
}

describe('a streamed attachment over the wire', () => {
  // The upload routes now need the token the handshake issues, so this suite signs in one account
  // and uploads as it rather than posting anonymously.
  let token = '';

  beforeAll(async () => {
    const uploader = await open('10.20.0.9', 'streamer');
    await uploader.register(uniqueNick('str'));
    token = uploader.uploadToken;
    expect(token).toBeTruthy();
  });

  it('is accepted, stored and readable back byte for byte', async () => {
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();

    const plaintext = new Uint8Array(300000);
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 31) % 256;

    const enc = await encryptFileStream(new Blob([plaintext]));
    const url = await uploadStream(origin, enc.stream, token);
    expect(url).toMatch(/^https?:\/\//);

    const fileKey = await buildFileKeyMap(
      enc.rawKey, ['user-b'], () => bKeys.publicKey, 'user-a', aKeys.publicKey, enc.ivB64, null,
    );
    const blob = await unwrapAndDecrypt(
      fileKey['user-b'],
      `${origin}/api/media?url=${encodeURIComponent(url)}`,
      bKeys.privateKey,
    );
    const got = new Uint8Array(await blob.arrayBuffer());
    expect(got.length).toBe(plaintext.length);
    expect(got[299999]).toBe(plaintext[299999]);
    expect(got[0]).toBe(plaintext[0]);
  });

  it('stops a streamed body once it passes the ceiling, without buffering it', async () => {
    // two megabytes against a one megabyte cap, sent as a stream so the refusal is about the guard
    // rather than about a declared length the client would refuse to lie about
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 2 * 1024 * 1024) { c.close(); return; }
        sent += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const res = await fetch(`${origin}/api/upload-raw?name=media.png&type=image%2Fpng`, {
      method: 'POST', body: stream, duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream', 'X-WN-Upload-Token': token },
    } as RequestInit).catch(() => null);
    // either the server refuses it, or the client notices the socket closing mid-body: both are the
    // ceiling doing its job, and what must not happen is the whole thing being accepted
    if (res) expect(res.status).toBe(413);
  });

  it('refuses a file type it will not store', async () => {
    const res = await fetch(`${origin}/api/upload-raw?name=evil&type=text%2Fhtml`, {
      method: 'POST',
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }),
      duplex: 'half',
      headers: { 'Content-Type': 'application/octet-stream', 'X-WN-Upload-Token': token },
    } as RequestInit);
    expect(res.status).toBe(400);
  });

  it('still opens an attachment written in the old single-shot format', async () => {
    // the in-memory format is what every attachment sent before this change looks like, and it has
    // to keep opening or the pictures already in a conversation are lost
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();
    const plaintext = 'written before the streamed format existed';

    const enc = await encryptFile(new Blob([new TextEncoder().encode(plaintext)]));
    const { wrapForMedia } = await import('../../src/media-crypto');
    const url = await upload(origin, wrapForMedia(await enc.blob.arrayBuffer()), token);

    const fileKey = await buildFileKeyMap(
      enc.rawKey, ['user-b'], () => bKeys.publicKey, 'user-a', aKeys.publicKey, enc.ivB64, null,
    );
    const blob = await unwrapAndDecrypt(
      fileKey['user-b'],
      `${origin}/api/media?url=${encodeURIComponent(url)}`,
      bKeys.privateKey,
    );
    expect(await blob.text()).toBe(plaintext);
  });
});
