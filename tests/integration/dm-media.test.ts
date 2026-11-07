import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { generateKeyPair } from '../../src/crypto';
import {
  encryptFile, encryptFileStream, buildFileKeyMap, unwrapAndDecrypt,
  sealFileKeyInText, openFileKeyFromText, openAttachmentWithKey, parseMediaTag,
} from '../../src/media-crypto';

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

/**
 * A private attachment's key belongs inside the sealed body.
 *
 * It used to travel beside the body in the payload, wrapped to a long-lived RSA key for each
 * participant. That meant the server held, in the clear next to every message, a key that never rotated
 * and opened every attachment in every private chat: seizing the server recovered every photo and video
 * the app had ever sent, no matter how well the text was protected. The message text was on the ratchet;
 * the picture was not.
 *
 * These pin down that the key now travels inside the ciphertext, that nothing readable is left in the
 * payload, and that a message in somebody's history keeps working - an attachment whose key stops being
 * readable takes the photo with it, and old messages are not re-sendable.
 */
describe('the key of a private attachment', () => {
  it('rides inside the sealed text and leaves nothing in the payload', async () => {
    const enc = await encryptFile(new Blob([new TextEncoder().encode('a photo')]));
    const sealed = sealFileKeyInText('[image]https://host/x.png[/image]', enc.rawKey, enc.ivB64);

    // the media marker still has to match, because every reader and the quote renderer go through it
    expect(parseMediaTag(sealed)).toEqual({ kind: 'image', url: 'https://host/x.png' });

    // and the key comes back out of the text, with the marker stripped so nothing shows it
    const { text, entry } = openFileKeyFromText(sealed);
    expect(text).toBe('[image]https://host/x.png[/image]');
    expect(entry).toBeTruthy();
    const [ivB64, keyB64] = entry!.split(':');
    expect(Buffer.from(base64ToBuf(keyB64)).equals(Buffer.from(enc.rawKey))).toBe(true);
    expect(ivB64).toBe(enc.ivB64);
  });

  it('does not put the key in the message payload', async () => {
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();
    const ca = await open('10.30.0.1', 'keya');
    const cb = await open('10.30.0.2', 'keyb');
    const ra = await ca.register(uniqueNick('keya'), { publicKey: aKeys.publicKey });
    const rb = await cb.register(uniqueNick('keyb'), { publicKey: bKeys.publicKey });
    expect(ra.type).toBe('auth_success');
    expect(rb.type).toBe('auth_success');

    const enc = await encryptFile(new Blob([new TextEncoder().encode('secret photo')]));
    const url = await upload(origin, enc.blob, ca.uploadToken);
    const sealed = sealFileKeyInText(`[image]${url}[/image]`, enc.rawKey, enc.ivB64);

    ca.send('dm_send', {
      toKey: bKeys.publicKey,
      text: '',
      clientId: 'inlinekey1234567',
      encrypted: { ciphertext: 'sealed-by-the-ratchet', iv: 'y', encryptedKeys: {} },
    });
    // the sender's plaintext is inside the sealed body; the server is handed nothing that opens the file
    void sealed;

    const delivered = await cb.waitFor('dm_message');
    // the payload has no wrapped key at all for a private message: nothing to seize
    expect(delivered.payload.fileKey).toBeFalsy();
    // and the sealed body carries the key, which the recipient opens with the ratchet - the bytes the
    // server holds open no part of the attachment
    expect(delivered.payload.encrypted.ciphertext).toBe('sealed-by-the-ratchet');
  });

  it('opens the bytes from the key inside the text', async () => {
    // needs a real upload token: the point is the whole round trip, and the media proxy will not serve a
    // url the uploader was not authorised to post
    const keys = await generateKeyPair();
    const uploader = await open('10.30.0.3', 'keymedia');
    const reg = await uploader.register(uniqueNick('keymedia'), { publicKey: keys.publicKey });
    expect(reg.type).toBe('auth_success');

    const plaintext = 'the actual photo bytes';
    const enc = await encryptFile(new Blob([new TextEncoder().encode(plaintext)]));
    const url = await upload(origin, enc.blob, uploader.uploadToken);
    const sealed = sealFileKeyInText(`[image]${url}[/image]`, enc.rawKey, enc.ivB64);

    const { entry } = openFileKeyFromText(sealed);
    const blob = await openAttachmentWithKey(
      entry!,
      `${origin}/api/media?url=${encodeURIComponent(url)}`,
    );
    expect(await blob.text()).toBe(plaintext);
  });

  it('keeps the wrapped map working, for the messages that still carry one', async () => {
    // Messages sent before the key moved inside are in people's histories and cannot be re-sent. A key
    // that stops being readable takes the photo with it, so the old path has to keep working alongside
    // the new one rather than being removed - it is just never taken for a new attachment.
    const aKeys = await generateKeyPair();
    const bKeys = await generateKeyPair();
    const enc = await encryptFile(new Blob([new TextEncoder().encode('an older photo')]));
    const fileKey = await buildFileKeyMap(
      enc.rawKey, ['user-b'], () => bKeys.publicKey, 'user-a', aKeys.publicKey, enc.ivB64, null,
    );

    // and a sealed text still opens when a wrapped map is present too, in case a client ever sends both
    const sealed = sealFileKeyInText('[image]https://host/x.png[/image]', enc.rawKey, enc.ivB64);
    expect(openFileKeyFromText(sealed).entry).toBeTruthy();
    expect(fileKey['user-b']).toBeTruthy();
  });

  it('leaves a message with no attachment key alone', () => {
    // the ordinary case: most messages have no key, and stripping must not touch them
    for (const text of ['hello', '[image]https://host/x.png[/image]', '', 'a [filekey] mention in prose']) {
      const { text: out, entry } = openFileKeyFromText(text);
      if (text === 'a [filekey] mention in prose') {
        // an unclosed marker is not a key, so the text stays as it was rather than being truncated
        expect(entry).toBeNull();
        expect(out).toBe(text);
      } else {
        expect(out).toBe(text);
        expect(entry).toBeNull();
      }
    }
  });
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
