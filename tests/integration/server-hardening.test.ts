import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, TestClient, uniqueNick, httpGet, type StartedServer } from '../helpers';

/**
 * Three things the server used to do that a hostile or careless client could turn against it.
 *
 * A deletion was announced to the entire server, so any account could learn the id and the existence of a
 * private message it had no part in. An encrypted body and a file key map were stored exactly as they
 * arrived, and the websocket frame ceiling is four megabytes, so one send could file a four-megabyte row.
 * And a stored attachment was read whole into memory to be handed out, unauthenticated, when the ceiling
 * on one is a gigabyte - one request was enough to ask the process for a gigabyte of heap.
 */

let server: StartedServer;
const clients: TestClient[] = [];
const accounts: Array<{ client: TestClient; userId: string }> = [];

async function account(prefix: string): Promise<{ client: TestClient; userId: string }> {
  const c = new TestClient(server.url, prefix);
  clients.push(c);
  await c.connect();
  const reg = await c.register(uniqueNick(prefix));
  const a = { client: c, userId: reg.payload.userId };
  accounts.push(a);
  return a;
}

const envelope = (text: string) => ({
  ciphertext: Buffer.from(text).toString('base64'),
  iv: Buffer.from('iv-iv-iv-iv-').toString('base64'),
  encryptedKeys: {},
});

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('a deletion is only announced where it belongs', () => {
  it('does not tell the rest of the server that a private message existed', async () => {
    const alice = await account('dela');
    const bob = await account('delb');
    const bystander = await account('delc');

    alice.client.send('dm_send', { to: bob.userId, encrypted: envelope('private') });
    const delivered = await bob.client.waitFor('dm_message', 8000);
    const messageId = delivered.payload.id;

    // a third party watching the wire
    bystander.client.clear();
    alice.client.send('delete_message', { messageId });
    await new Promise((r) => setTimeout(r, 600));

    const leaked = bystander.client.logs.filter((m) => m.type === 'message_deleted');
    expect(leaked).toHaveLength(0);
    // and the two of them are still told
    expect(alice.client.logs.filter((m) => m.type === 'message_deleted').length).toBeGreaterThan(0);
    expect(bob.client.logs.filter((m) => m.type === 'message_deleted').length).toBeGreaterThan(0);
  }, 90000);

  it('refuses to delete somebody else’s message', async () => {
    const alice = await account('dele');
    const bob = await account('delf');
    alice.client.send('dm_send', { to: bob.userId, encrypted: envelope('not yours') });
    const delivered = await bob.client.waitFor('dm_message', 8000);

    bob.client.clear();
    bob.client.send('delete_message', { messageId: delivered.payload.id });
    const err = await bob.client.waitFor('error', 5000);
    expect(err.payload.code).toBe('NOT_FOUND');

    // still there
    alice.client.clear();
    alice.client.send('dm_history', { with: bob.userId });
    const hist = await alice.client.waitFor('dm_history', 5000);
    expect(hist.payload.messages).toHaveLength(1);
  }, 90000);
});

describe('a stored body is bounded', () => {
  it('refuses a private message whose body is far larger than any real one', async () => {
    const alice = await account('biga');
    const bob = await account('bigb');

    alice.client.clear();
    alice.client.send('dm_send', {
      to: bob.userId,
      encrypted: {
        ciphertext: 'x'.repeat(200_000),
        iv: 'aaaa',
        encryptedKeys: {},
      },
    });
    const err = await alice.client.waitFor('error', 8000);
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
    expect(bob.client.logs.filter((m) => m.type === 'dm_message')).toHaveLength(0);
  }, 90000);

  it('refuses a file key map with an implausible number of entries', async () => {
    const alice = await account('mapa');
    const bob = await account('mapb');

    const fileKey: Record<string, string> = {};
    for (let i = 0; i < 600; i++) fileKey['user-' + i] = 'aXY=:key' + i;

    alice.client.send('dm_send', { to: bob.userId, encrypted: envelope('with a huge key map'), fileKey });
    await new Promise((r) => setTimeout(r, 600));
    const got = await bob.client.waitFor('dm_message', 4000);
    if (got) expect(Object.keys(got.payload.fileKey || {}).length).toBeLessThanOrEqual(512);
  }, 90000);

  it('still stores an ordinary body', async () => {
    const alice = await account('oka');
    const bob = await account('okb');
    alice.client.send('dm_send', { to: bob.userId, encrypted: envelope('perfectly normal') });
    const got = await bob.client.waitFor('dm_message', 8000);
    expect(got.payload.encrypted.ciphertext).toBe(Buffer.from('perfectly normal').toString('base64'));
  }, 90000);
});

describe('a stored attachment is streamed, not read into memory', () => {
  it('answers a range request with the bytes asked for', async () => {
    // a file put straight where the media route looks for it, so nothing has to be uploaded
    const mediaDir = path.join(server.dataDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const id = 'ab'.repeat(16);
    const body = Buffer.alloc(4096);
    for (let i = 0; i < body.length; i++) body[i] = i % 256;
    fs.writeFileSync(path.join(mediaDir, id), body);

    const full = await httpGet(server.port, `/api/media?url=%2Fmedia%2F${id}`);
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.body.length).toBe(body.length);
    expect(Buffer.compare(full.body, body)).toBe(0);

    const partial = await new Promise<{ status: number; headers: any; body: Buffer }>((resolve) => {
      const http = require('node:http');
      http.get({ host: '127.0.0.1', port: server.port, path: `/api/media?url=%2Fmedia%2F${id}`, headers: { Range: 'bytes=100-199' } }, (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', () => resolve({ status: -1, headers: {}, body: Buffer.alloc(0) }));
    });
    expect(partial.status).toBe(206);
    expect(partial.body.length).toBe(100);
    expect(Buffer.compare(partial.body, body.subarray(100, 200))).toBe(0);
    expect(partial.headers['content-range']).toBe(`bytes 100-199/${body.length}`);
  }, 60000);

  it('refuses a range that is not there', async () => {
    const mediaDir = path.join(server.dataDir, 'media');
    const id = 'cd'.repeat(16);
    fs.writeFileSync(path.join(mediaDir, id), Buffer.alloc(10));

    const res = await new Promise<number>((resolve) => {
      const http = require('node:http');
      http.get({ host: '127.0.0.1', port: server.port, path: `/api/media?url=%2Fmedia%2F${id}`, headers: { Range: 'bytes=500-900' } }, (r: any) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode));
      }).on('error', () => resolve(-1));
    });
    expect(res).toBe(416);
  }, 60000);

  it('still refuses a path that tries to climb out', async () => {
    for (const attempt of ['/media/../../whispernet.db', '/media/..%2f..%2fwhispernet.db', '/media/' + 'z'.repeat(32)]) {
      const res = await httpGet(server.port, `/api/media?url=${encodeURIComponent(attempt)}`);
      expect([400, 404]).toContain(res.status);
    }
  }, 60000);
});
