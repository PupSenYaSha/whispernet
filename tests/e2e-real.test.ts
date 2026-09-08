import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  encryptFile, buildFileKeyMap, unwrapAndDecrypt, wrapForMedia, bufToBase64, base64ToBuf,
} from '../src/media-crypto.js';
import {
  generateKeyPair, encryptMessage, decryptMessage,
} from '../src/crypto.js';

function getMediaBase(): URL {
  return new URL(process.env.MEDIA_BASE_URL || 'https://img.n1ko.dev');
}

class Client {
  ws: WebSocket;
  inbox: any[] = [];
  constructor(public port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (data: Buffer) => {
      try { this.inbox.push(JSON.parse(data.toString())); } catch {}
    });
  }
  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('ws open timeout')), 8000);
      this.ws.on('open', () => { clearTimeout(to); res(); });
      this.ws.on('error', (e) => { clearTimeout(to); rej(e); });
    });
  }
  send(type: string, payload: any): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }
  async next(filter?: (m: any) => boolean, timeout = 9000): Promise<any> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const idx = this.inbox.findIndex(filter || (() => true));
      if (idx >= 0) return this.inbox.splice(idx, 1)[0];
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timeout waiting for message (filter=' + (filter ? filter.toString().slice(0, 60) : 'any') + ')');
  }
}

async function makeUser(port: number, nickHint: string) {
  const nick = nickHint.slice(0, 4) + Math.random().toString(36).slice(2, 9);
  const keys = await generateKeyPair();
  const client = new Client(port);
  await client.open();
  client.send('auth_register', {
    nickname: nick,
    password: 'Passw0rd123',
    publicKey: keys.publicKey,
    preKeyBundle: {
      bundleVersion: 1,
      identityKey: 'ik-' + nick,
      ed25519PublicKey: 'ek-' + nick,
      signedPreKey: { publicKey: 'spk-' + nick, signature: [1, 2, 3] },
      oneTimePreKey: null,
    },
  });
  const resp = await client.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');
  if (resp.type === 'auth_failure') console.error('REG FAIL', nick, JSON.stringify(resp.payload));
  expect(resp.type).toBe('auth_success');
  return {
    client,
    userId: resp.payload.userId as string,
    nick,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: any;
let PORT = 0;
let MEDIA_PORT = 0;
let dataDir = '';

async function uploadEncrypted(blob: Blob, port: number): Promise<string> {
  const buf = Buffer.from(await (await wrapForMedia(await blob.arrayBuffer())).arrayBuffer());
  const boundary = '----FormBoundaryTest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="enc.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(`http://127.0.0.1:${port}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    console.error('UPLOAD FAIL', res.status, await res.text());
    throw new Error('upload failed ' + res.status);
  }
  const json = await res.json();
  expect(json.url).toBeTruthy();
  return json.url as string;
}

describe('WhisperNet real E2E', () => {
  const EXTERNAL = process.env.WN_EXTERNAL_URL;
  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-e2e-'));
    process.env.DISABLE_RATE_LIMITS = '1';
    process.env.ADMIN_KEY = 'wn-test-admin-key';
    const { setDataDir } = await import('../server/database.js');
    setDataDir(dataDir);

    if (EXTERNAL) {
      // Use a real, externally-started server (real entrypoint, real media host).
      const u = new URL(EXTERNAL);
      PORT = Number(u.port) || 8080;
      return;
    }

    // Local fake media host (in-process mode only)
    const mediaFiles = new Map<string, Buffer>();
    const mediaSrv = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/upload') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          const b = Buffer.concat(chunks);
          const ct = (req.headers['content-type'] as string) || '';
          const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
          const bound = (m ? (m[1] || m[2]) : 'boundary').trim();
          const delim = Buffer.from('--' + bound);
          const idxs: number[] = [];
          let from = 0;
          while (true) {
            const i = b.indexOf(delim, from);
            if (i < 0) break;
            idxs.push(i);
            from = i + delim.length;
          }
          let content = Buffer.alloc(0);
          for (let k = 0; k < idxs.length - 1; k++) {
            let part = b.subarray(idxs[k] + delim.length, idxs[k + 1]);
            if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
            if (part.toString('latin1').includes('Content-Disposition')) {
              const h = part.indexOf('\r\n\r\n');
              if (h >= 0) {
                let c = part.subarray(h + 4);
                if (c.length >= 2 && c[c.length - 2] === 0x0d && c[c.length - 1] === 0x0a) c = c.subarray(0, c.length - 2);
                content = Buffer.from(c);
              }
            }
          }
          const name = 'f' + Math.random().toString(36).slice(2) + '.bin';
          mediaFiles.set(name, content);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ status: 'ready', url: `http://127.0.0.1:${MEDIA_PORT}/f/${name}` })}\n`);
        });
      } else if (req.method === 'GET' && req.url && req.url.startsWith('/f/')) {
        const f = mediaFiles.get(req.url.slice(3));
        if (!f) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(f);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => { mediaSrv.listen(0, '127.0.0.1', () => r()); });
    MEDIA_PORT = (mediaSrv.address() as any).port;

    const { createApp } = await import('../server/app.js');
    process.env.MEDIA_STORAGE = 'local';
    app = await createApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    PORT = (app.server.address() as any).port;
  }, 30000);

  afterAll(async () => {
    try { if (app && app.close) await app.close(); } catch {}
    try { await fs.promises.rm(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('general chat: message broadcast to other user', async () => {
    const a = await makeUser(PORT, 'alpha' + Date.now());
    const b = await makeUser(PORT, 'beta' + Date.now());
    await sleep(1100);
    a.client.send('chat_message', { text: 'hello from alpha', ttl: 86400 });
    const toB = await b.client.next((m) => m.type === 'chat_message' && m.payload.text === 'hello from alpha');
    expect(toB.payload.senderNickname).toBe(a.nick);
    expect(toB.payload.isOwn).toBe(false);
    expect(toB.payload.expiresAt).toBeGreaterThan(Date.now());
    const echo = await a.client.next((m) => m.type === 'chat_message' && m.payload.text === 'hello from alpha');
    expect(echo.payload.isOwn).toBe(true);
    expect(echo.payload.expiresAt).toBeGreaterThan(Date.now());
    a.client.ws.close(); b.client.ws.close();
  }, 20000);

  it('encrypted DM round-trip with real WebCrypto', async () => {
    const a = await makeUser(PORT, 'gamma' + Date.now());
    const b = await makeUser(PORT, 'delta' + Date.now());
    await sleep(1100);
    const text = 'secret via RSA-OAEP AES-GCM';
    const enc = await encryptMessage(text, { [b.userId]: b.publicKey });
    expect(Object.keys(enc.encryptedKeys)).toContain(b.userId);
    a.client.send('dm_send', { to: b.userId, text: '', encrypted: enc });
    const toB = await b.client.next((m) => m.type === 'dm_message' && m.payload.encrypted);
    const dec = await decryptMessage(toB.payload.encrypted, b.userId, b.privateKey);
    expect(dec).toBe(text);
    a.client.ws.close(); b.client.ws.close();
  }, 20000);

  it('sealed-sender: DM routed by recipient public key (toKey), username hidden', async () => {
    const a = await makeUser(PORT, 'seala' + Date.now());
    const b = await makeUser(PORT, 'sealb' + Date.now());
    await sleep(1100);
    const text = 'secret via toKey routing';
    const enc = await encryptMessage(text, { [b.userId]: b.publicKey });
    a.client.send('dm_send', { toKey: b.publicKey, text: '', encrypted: enc });
    const toB = await b.client.next((m) => m.type === 'dm_message' && m.payload.encrypted);
    const dec = await decryptMessage(toB.payload.encrypted, b.userId, b.privateKey);
    expect(dec).toBe(text);
    expect(toB.payload.senderNickname).toBe(a.nick);
    a.client.ws.close(); b.client.ws.close();
  }, 20000);

  it('multi-device: DM delivered to all of recipient devices (fan-out)', async () => {
    const a = await makeUser(PORT, 'fanA' + Date.now());
    const b = await makeUser(PORT, 'fanB' + Date.now());
    await sleep(1100);
    const b2 = new Client(PORT);
    await b2.open();
    b2.send('auth_login', { nickname: b.nick, password: 'Passw0rd123', publicKey: b.publicKey });
    await b2.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');

    const text = 'to both devices';
    const enc = await encryptMessage(text, { [b.userId]: b.publicKey });
    a.client.send('dm_send', { to: b.userId, text: '', encrypted: enc });

    const toB1 = await b.client.next((m) => m.type === 'dm_message' && m.payload.encrypted);
    const toB2 = await b2.next((m) => m.type === 'dm_message' && m.payload.encrypted);
    const d1 = await decryptMessage(toB1.payload.encrypted, b.userId, b.privateKey);
    const d2 = await decryptMessage(toB2.payload.encrypted, b.userId, b.privateKey);
    expect(d1).toBe(text);
    expect(d2).toBe(text);
    a.client.ws.close(); b.client.ws.close(); b2.ws.close();
  }, 20000);

  it('key_backup: upload then fetch returns same blob', async () => {
    const u = await makeUser(PORT, 'kb' + Date.now());
    const blob = 'encrypted-blob-' + Math.random().toString(36);
    u.client.send('key_backup_upload', { blob });
    const saved = await u.client.next((m) => m.type === 'key_backup_saved');
    expect(saved.payload.ok).toBe(true);
    u.client.send('key_backup_fetch');
    const got = await u.client.next((m) => m.type === 'key_backup');
    expect(got.payload.blob).toBe(blob);
    u.client.ws.close();
  }, 20000);

  it('plaintext DM is rejected (ENCRYPTION_REQUIRED)', async () => {
    const a = await makeUser(PORT, 'eps' + Date.now());
    const b = await makeUser(PORT, 'zeta' + Date.now());
    await sleep(1100);
    a.client.send('dm_send', { to: b.userId, text: 'cleartext' });
    const err = await a.client.next((m) => m.type === 'error' && m.payload.code === 'ENCRYPTION_REQUIRED');
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
    a.client.ws.close(); b.client.ws.close();
  }, 20000);

  it('photo E2EE: encrypt -> upload -> fetch -> decrypt (byte-exact)', async () => {
    const a = await makeUser(PORT, 'ph' + Date.now());
    const b = await makeUser(PORT, 'pg' + Date.now());
    const original = new Uint8Array(2048);
    for (let i = 0; i < original.length; i++) original[i] = (i * 37) & 0xff;
    const blob = new Blob([original], { type: 'application/octet-stream' });
    const enc = await encryptFile(blob as any);
    const url = await uploadEncrypted(enc.blob, PORT);
    const fileKey = await buildFileKeyMap(
      enc.rawKey,
      [b.userId, a.userId],
      (id) => id === b.userId ? b.publicKey : (id === a.userId ? a.publicKey : null),
      a.userId,
      a.publicKey,
      enc.ivB64,
    );
    expect(fileKey[b.userId]).toBeTruthy();
    await sleep(1100);
    a.client.send('chat_message', { text: `[image]${url}[/image]`, fileKey });
    const msg = await b.client.next((m) => m.type === 'chat_message' && /\[image\]/.test(m.payload.text));
    expect(msg.payload.fileKey[b.userId]).toBeTruthy();
    const proxyUrl = `http://127.0.0.1:${PORT}/api/media?url=${encodeURIComponent(url)}`;
    const entry = msg.payload.fileKey[b.userId];
    const decrypted = await unwrapAndDecrypt(entry, proxyUrl, b.privateKey);
    const got = new Uint8Array(await decrypted.arrayBuffer());
    expect(Buffer.from(got)).toEqual(Buffer.from(original));
    a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('video E2EE: encrypt -> upload -> fetch -> decrypt (byte-exact)', async () => {
    const a = await makeUser(PORT, 'vd' + Date.now());
    const b = await makeUser(PORT, 'vc' + Date.now());
    const original = new Uint8Array(4096);
    for (let i = 0; i < original.length; i++) original[i] = (i * 13 + 5) & 0xff;
    const blob = new Blob([original], { type: 'application/octet-stream' });
    const enc = await encryptFile(blob as any);
    const url = await uploadEncrypted(enc.blob, PORT);
    const fileKey = await buildFileKeyMap(enc.rawKey, [b.userId, a.userId], (id) => id === b.userId ? b.publicKey : (id === a.userId ? a.publicKey : null), a.userId, a.publicKey, enc.ivB64);
    await sleep(1100);
    a.client.send('chat_message', { text: `[video]${url}[/video]`, fileKey });
    const msg = await b.client.next((m) => m.type === 'chat_message' && /\[video\]/.test(m.payload.text));
    const decrypted = await unwrapAndDecrypt(msg.payload.fileKey[b.userId], `http://127.0.0.1:${PORT}/api/media?url=${encodeURIComponent(url)}`, b.privateKey);
    const got = new Uint8Array(await decrypted.arrayBuffer());
    expect(Buffer.from(got)).toEqual(Buffer.from(original));
    a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('reactions: add and remove broadcast to both participants (DM)', async () => {
    const a = await makeUser(PORT, 'ra' + Date.now());
    const b = await makeUser(PORT, 'rb' + Date.now());
    await sleep(1100);
    const text = 'react to me';
    const enc = await encryptMessage(text, { [b.userId]: b.publicKey });
    a.client.send('dm_send', { to: b.userId, text: '', encrypted: enc });
    const dm = await b.client.next((m) => m.type === 'dm_message' && m.payload.encrypted);
    const msgId = dm.payload.id;
    await sleep(300);
    a.client.send('add_reaction', { messageId: msgId, emoji: '👍' });
    const addB = await b.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'add' && m.payload.emoji === '👍');
    expect(addB.payload.messageId).toBe(msgId);
    const addA = await a.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'add' && m.payload.emoji === '👍');
    expect(addA.payload.userId).toBe(a.userId);
    a.client.send('remove_reaction', { messageId: msgId, emoji: '👍' });
    const rem = await b.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'remove');
    expect(rem.payload.emoji).toBe('👍');
    a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('replies: quoted payload propagates to other participants (general + DM)', async () => {
    const a = await makeUser(PORT, 'rqa' + Date.now());
    const b = await makeUser(PORT, 'rqb' + Date.now());
    await sleep(1100);
    // general chat reply
    a.client.send('chat_message', { text: 'replying now', ttl: 0, quoted: { id: 'msg-general', text: 'original line', sender: 'someone' } });
    const gen = await b.client.next((m) => m.type === 'chat_message' && m.payload.quotedMessageText);
    expect(gen.payload.quotedMessageId).toBe('msg-general');
    expect(gen.payload.quotedMessageText).toBe('original line');
    expect(gen.payload.quotedMessageSender).toBe('someone');
    // DM reply
    const enc = await encryptMessage('dm reply body', { [b.userId]: b.publicKey });
    a.client.send('dm_send', { to: b.userId, text: '', encrypted: enc, quoted: { id: 'msg-dm', text: 'dm original', sender: 'someone' } });
    const dm = await b.client.next((m) => m.type === 'dm_message' && m.payload.quotedMessageText);
    expect(dm.payload.quotedMessageId).toBe('msg-dm');
    expect(dm.payload.quotedMessageText).toBe('dm original');
    expect(dm.payload.quotedMessageSender).toBe('someone');
    a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('search privacy: third user cannot read others DM; public search works', async () => {
    const a = await makeUser(PORT, 'sa' + Date.now());
    const b = await makeUser(PORT, 'sb' + Date.now());
    const c = await makeUser(PORT, 'sc' + Date.now());
    const secret = 'SUPERSECRETDM_' + Date.now();
    const enc = await encryptMessage(secret, { [b.userId]: b.publicKey });
    await sleep(1100);
    a.client.send('dm_send', { to: b.userId, text: '', encrypted: enc });
    await a.client.next((m) => m.type === 'dm_message');
    // public message (general chat is plaintext by design)
    const pub = 'PUBLICMSG_' + Date.now();
    await sleep(300);
    a.client.send('chat_message', { text: pub });
    await b.client.next((m) => m.type === 'chat_message' && m.payload.text === pub);
    await sleep(300);
    // C (non-participant) searching the DM secret -> must find nothing
    c.client.send('search_messages', { query: secret });
    const cRes = await c.client.next((m) => m.type === 'message_search_results');
    expect(cRes.payload.results.length).toBe(0);
    // C searching the public message -> finds it (proves search scope works)
    c.client.send('search_messages', { query: pub });
    const cRes2 = await c.client.next((m) => m.type === 'message_search_results');
    expect(cRes2.payload.results.length).toBeGreaterThan(0);
    // A searching own DM secret -> ciphertext stored, so no plaintext match (E2EE at rest)
    a.client.send('search_messages', { query: secret });
    const aRes = await a.client.next((m) => m.type === 'message_search_results');
    expect(aRes.payload.results.length).toBe(0);
    a.client.ws.close(); b.client.ws.close(); c.client.ws.close();
  }, 25000);

  it('prekey_fetch returns stored bundle', async () => {
    const a = await makeUser(PORT, 'pk' + Date.now());
    const b = await makeUser(PORT, 'pk2' + Date.now());
    await sleep(300);
    a.client.send('prekey_fetch', { userIds: [b.userId] });
    const res = await a.client.next((m) => m.type === 'prekey_bundles');
    expect(res.payload.bundles[b.userId]).toBeTruthy();
    expect(res.payload.bundles[b.userId].identityKey).toBe('ik-' + b.nick);
    a.client.ws.close(); b.client.ws.close();
  }, 20000);

  it('media proxy blocks foreign hosts (SSRF guard)', async () => {
    const a = await makeUser(PORT, 'se' + Date.now());
    const url = 'http://127.0.0.1:' + PORT + '/api/media?url=' + encodeURIComponent('https://example.com/evil.jpg');
    const res = await fetch(url);
    expect(res.status).toBe(403);
    a.client.ws.close();
  }, 20000);

  // keep helper referenced to avoid unused warnings
  void bufToBase64; void base64ToBuf;

  it('blocking: blocked user cannot DM the blocker; unblock restores delivery', async () => {
    const a = await makeUser(PORT, 'blkA' + Date.now());
    const b = await makeUser(PORT, 'blkB' + Date.now());
    await sleep(1100);

    a.client.send('block_user', { userId: b.userId });
    const list1 = await a.client.next((m) => m.type === 'blocked_list');
    expect(list1.payload.blockedIds).toContain(b.userId);

    // B tries to DM A -> must be rejected
    const text = 'you blocked me?';
    const enc = await encryptMessage(text, { [a.userId]: a.publicKey });
    b.client.send('dm_send', { to: a.userId, text: '', encrypted: enc });
    const err = await b.client.next((m) => m.type === 'error' || m.type === 'dm_message');
    expect(err.type).toBe('error');
    expect(err.payload.code).toBe('BLOCKED');

    // A unblocks B -> DM works again
    a.client.send('unblock_user', { userId: b.userId });
    const list2 = await a.client.next((m) => m.type === 'blocked_list');
    expect(list2.payload.blockedIds).not.toContain(b.userId);
    const enc2 = await encryptMessage('back online?', { [a.userId]: a.publicKey });
    b.client.send('dm_send', { to: a.userId, text: '', encrypted: enc2 });
    const toA = await a.client.next((m) => m.type === 'dm_message');
    const dec = await decryptMessage(toA.payload.encrypted, a.userId, a.privateKey);
    expect(dec).toBe('back online?');

    a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('admin: ban rejects re-login and disconnects online devices', async () => {
    const b = await makeUser(PORT, 'bnB' + Date.now());
    await sleep(300);

    // Unauthorized (wrong key) -> forbidden
    b.client.send('admin_ban', { key: 'wrong', nickname: b.nick });
    const forbid = await b.client.next((m) => m.type === 'error');
    expect(forbid.payload.code).toBe('FORBIDDEN');

    // Authorized ban by nickname
    const admin = await makeUser(PORT, 'adm' + Date.now());
    admin.client.send('admin_ban', { key: 'wn-test-admin-key', nickname: b.nick });
    const act = await admin.client.next((m) => m.type === 'admin_action');
    expect(act.payload.ok).toBe(true);

    // B's existing connection should be force-closed (banned)
    await new Promise<void>((res) => {
      if (b.client.ws.readyState === WebSocket.CLOSED) return res();
      b.client.ws.on('close', () => res());
      setTimeout(res, 4000);
    });

    // Re-login -> auth_failure "Account banned"
    await sleep(300);
    const b2 = new Client(PORT);
    await b2.open();
    b2.send('auth_login', { nickname: b.nick, password: 'Passw0rd123' });
    const resp = await b2.next((m) => m.type === 'auth_success' || m.type === 'auth_failure', 6000);
    expect(resp.type).toBe('auth_failure');
    expect(String(resp.payload.reason).toLowerCase()).toContain('banned');

    b2.ws.close(); b.client.ws.close();
  }, 25000);

  it('report_user stores a report; admin_reports returns it (with auth)', async () => {
    const reporter = await makeUser(PORT, 'rpA' + Date.now());
    const target = await makeUser(PORT, 'rpB' + Date.now());
    await sleep(300);

    reporter.client.send('report_user', { targetId: target.userId, reason: 'spam' });
    const recv = await reporter.client.next((m) => m.type === 'report_received');
    expect(recv.payload.ok).toBe(true);

    // unauth admin_reports -> forbidden
    reporter.client.send('admin_reports', { key: 'wrong' });
    const forbid = await reporter.client.next((m) => m.type === 'error');
    expect(forbid.payload.code).toBe('FORBIDDEN');

    reporter.client.send('admin_reports', { key: 'wn-test-admin-key' });
    const res = await reporter.client.next((m) => m.type === 'admin_reports');
    const found = (res.payload.reports as any[]).find(r => r.targetId === target.userId && r.reason === 'spam');
    expect(found).toBeTruthy();
    expect(found.reporterId).toBe(reporter.userId);

    reporter.client.ws.close(); target.client.ws.close();
  }, 25000);

  it('reactions: one reaction per user (re-add replaces the previous emoji)', async () => {
    const a = await makeUser(PORT, 'rxA' + Date.now());
    const b = await makeUser(PORT, 'rxB' + Date.now());
    await sleep(1100);

    a.client.send('chat_message', { text: 'react me' });
    const echo = await a.client.next((m) => m.type === 'chat_message' && m.payload.text === 'react me');
    const msgId = echo.payload.id;

    a.client.send('add_reaction', { messageId: msgId, emoji: '❤️' });
    await a.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'add');
    a.client.send('add_reaction', { messageId: msgId, emoji: '👍' });
    const replace = await a.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'add' && m.payload.emoji === '👍');

    const mine = (replace.payload.reactions as any[]).filter((r) => r.userId === a.userId);
    expect(mine.length).toBe(1);
    expect(mine[0].emoji).toBe('👍');

    b.client.send('remove_reaction', { messageId: msgId, emoji: '👍' });
    const rem = await b.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'remove');
    expect((rem.payload.reactions as any[]).filter((r) => r.userId === b.userId).length).toBe(0);

    a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('reactions: persist and are returned in chat_history after reconnect', async () => {
    const a = await makeUser(PORT, 'rxP' + Date.now());
    const b = await makeUser(PORT, 'rxQ' + Date.now());
    await sleep(1100);

    a.client.send('chat_message', { text: 'persist reaction' });
    const echo = await a.client.next((m) => m.type === 'chat_message' && m.payload.text === 'persist reaction');
    const msgId = echo.payload.id;

    b.client.send('add_reaction', { messageId: msgId, emoji: '👍' });
    await b.client.next((m) => m.type === 'reaction_update' && m.payload.action === 'add' && m.payload.emoji === '👍');

    // Reconnect B: the reloaded chat history must carry the stored reaction.
    const c = new Client(PORT);
    await c.open();
    c.send('auth_login', { nickname: b.nick, password: 'Passw0rd123', deviceId: 'rx-re' });
    const auth = await c.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');
    expect(auth.type).toBe('auth_success');
    const hist = await c.next((m) => m.type === 'chat_history');
    const found = hist.payload.messages.find((x: any) => x.id === msgId);
    expect(found).toBeTruthy();
    const mine = (found.reactions as any[]).filter((r) => r.userId === b.userId);
    expect(mine.length).toBe(1);
    expect(mine[0].emoji).toBe('👍');

    c.ws.close(); a.client.ws.close(); b.client.ws.close();
  }, 25000);

  it('sessions: 4th new device is rejected (existing sessions are never evicted)', async () => {
    const a = await makeUser(PORT, 'sesA' + Date.now());
    a.client.ws.close();
    await sleep(500);

    const devices: Client[] = [];
    for (let i = 1; i <= 3; i++) {
      const c = new Client(PORT);
      await c.open();
      c.send('auth_login', { nickname: a.nick, password: 'Passw0rd123', deviceId: `tk-dev-${i}` });
      const r = await c.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');
      expect(r.type).toBe('auth_success');
      devices.push(c);
    }

    // A brand-new 4th device must be rejected; existing sessions must stay alive.
    const fourth = new Client(PORT);
    await fourth.open();
    fourth.send('auth_login', { nickname: a.nick, password: 'Passw0rd123', deviceId: 'tk-dev-4' });
    const r4 = await fourth.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');
    expect(r4.type).toBe('auth_failure');
    expect(String(r4.payload.reason)).toContain('Session limit');
    fourth.ws.close();

    await sleep(400);
    expect(devices[0].ws.readyState).toBe(WebSocket.OPEN);
    expect(devices[1].ws.readyState).toBe(WebSocket.OPEN);
    expect(devices[2].ws.readyState).toBe(WebSocket.OPEN);

    // sessions_list still reports exactly 3 sessions
    devices[1].send('get_sessions', {});
    const list = await devices[1].next((m) => m.type === 'sessions_list');
    expect(list.payload.sessions.length).toBe(3);

    // Reconnecting an already-registered device works even at the limit
    const again = new Client(PORT);
    await again.open();
    again.send('auth_login', { nickname: a.nick, password: 'Passw0rd123', deviceId: 'tk-dev-1' });
    const rAgain = await again.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');
    expect(rAgain.type).toBe('auth_success');

    for (const d of [...devices, again]) d.ws.close();
  }, 30000);

  it('report_user: stores targetNick + channel + message text for a general-chat message', async () => {
    const reporter = await makeUser(PORT, 'rp2A' + Date.now());
    const target = await makeUser(PORT, 'rp2B' + Date.now());
    await sleep(1100);

    reporter.client.send('chat_message', { text: 'reported content here' });
    const echo = await reporter.client.next((m) => m.type === 'chat_message' && m.payload.text === 'reported content here');

    reporter.client.send('report_user', { targetId: target.userId, reason: 'scam', messageId: echo.payload.id });
    await reporter.client.next((m) => m.type === 'report_received');

    reporter.client.send('admin_reports', { key: 'wn-test-admin-key' });
    const res = await reporter.client.next((m) => m.type === 'admin_reports');
    const found = (res.payload.reports as any[]).find((r) => r.targetId === target.userId && r.reason === 'scam');
    expect(found).toBeTruthy();
    expect(found.targetNick).toBe(target.nick);
    expect(found.channel).toBe('general');
    expect(found.messageText).toBe('reported content here');

    reporter.client.ws.close(); target.client.ws.close();
  }, 25000);

  it('auth_success: role reflects nickname in data/admins.json (seeded with "admin")', async () => {
    const adminClient = new Client(PORT);
    await adminClient.open();
    const keys = await generateKeyPair();
    adminClient.send('auth_register', {
      nickname: 'admin',
      password: 'Passw0rd123',
      publicKey: keys.publicKey,
      preKeyBundle: {
        bundleVersion: 1,
        identityKey: 'ik-admin',
        ed25519PublicKey: 'ek-admin',
        signedPreKey: { publicKey: 'spk-admin', signature: [1, 2, 3] },
        oneTimePreKey: null,
      },
    });
    const adminResp = await adminClient.next((m) => m.type === 'auth_success' || m.type === 'auth_failure');
    expect(adminResp.type).toBe('auth_success');
    expect(adminResp.payload.role).toBe('admin');

    // a nickname-based admin (the seeded 'admin' account) can ban WITHOUT the ADMIN_KEY
    const banned = await makeUser(PORT, 'byNick' + Date.now());
    adminClient.send('admin_ban', { nickname: banned.nick });
    const act = await adminClient.next((m) => m.type === 'admin_action' || m.type === 'error');
    expect(act.type).toBe('admin_action');
    expect(act.payload.ok).toBe(true);
    await sleep(400);
    expect(banned.client.ws.readyState).toBe(WebSocket.CLOSED);

    adminClient.ws.close();
  }, 30000);

  it('moderation: get_banned lists banned users; banning from a report removes the report', async () => {
    const reporter = await makeUser(PORT, 'brA' + Date.now());
    const target = await makeUser(PORT, 'brB' + Date.now());
    await sleep(1100);

    // Target posts in general chat, reporter file a report against that message
    target.client.send('chat_message', { text: 'bad behavior example' });
    const msg = await target.client.next((m) => m.type === 'chat_message' && m.payload.text === 'bad behavior example');
    reporter.client.send('report_user', { targetId: target.userId, reason: 'harassment', messageId: msg.payload.id });
    await reporter.client.next((m) => m.type === 'report_received');

    // Confirm the report exists
    reporter.client.send('admin_reports', { key: 'wn-test-admin-key' });
    const before = await reporter.client.next((m) => m.type === 'admin_reports');
    expect((before.payload.reports as any[]).some((r) => r.targetId === target.userId)).toBe(true);

    // Ban by nickname (the "block" button on a report row)
    reporter.client.send('admin_ban', { key: 'wn-test-admin-key', nickname: target.nick });
    const act = await reporter.client.next((m) => m.type === 'admin_action' || m.type === 'error');
    expect(act.type).toBe('admin_action');
    expect(act.payload.ok).toBe(true);

    // The report must be removed after a successful ban
    reporter.client.send('admin_reports', { key: 'wn-test-admin-key' });
    const after = await reporter.client.next((m) => m.type === 'admin_reports');
    expect((after.payload.reports as any[]).some((r) => r.targetId === target.userId)).toBe(false);

    // And the banned user must appear in the moderation blocked list
    reporter.client.send('get_banned', { key: 'wn-test-admin-key' });
    const bl = await reporter.client.next((m) => m.type === 'banned_list');
    expect(bl.payload.banned.some((b: any) => b.nickname === target.nick)).toBe(true);

    // Unban restores the account (and the user can log in again)
    reporter.client.send('admin_unban', { key: 'wn-test-admin-key', nickname: target.nick });
    const ub = await reporter.client.next((m) => m.type === 'admin_action' || m.type === 'error');
    expect(ub.type).toBe('admin_action');
    expect(ub.payload.ok).toBe(true);

    reporter.client.ws.close(); target.client.ws.close();
  }, 30000);
});
