import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { MAX_MESSAGE_CHARS } from '../../src/limits';

let server: StartedServer;
const clients: TestClient[] = [];

const client = async (label: string, ip?: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  if (ip) await c.connect({ 'x-forwarded-for': ip });
  return c;
};

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('message length', () => {
  it('refuses a message over the limit', async () => {
    const a = await client('len');
    await a.register(uniqueNick('len'));
    a.clear();
    a.send('chat_message', { text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) });
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('MESSAGE_TOO_LONG');
  });

  it('accepts a message at the limit', async () => {
    const a = await client('len2');
    await a.register(uniqueNick('len'));
    a.clear();
    a.send('chat_message', { text: 'x'.repeat(MAX_MESSAGE_CHARS) });
    const msg = await a.waitFor('chat_message');
    expect(msg.payload.text).toHaveLength(MAX_MESSAGE_CHARS);
  });
});

describe('history paging', () => {
  it('pages backwards through the general chat', async () => {
    const a = await client('page');
    await a.register(uniqueNick('page'));

    const total = 130;
    for (let i = 0; i < total; i++) {
      a.send('chat_message', { text: 'page ' + i });
      await a.waitFor('chat_message', 2000);
    }

    a.clear();
    a.send('chat_history', { limit: 50 });
    const newest = await a.waitFor('chat_history_page');
    expect(newest.payload.messages).toHaveLength(50);
    expect(newest.payload.hasMore).toBe(true);

    a.clear();
    a.send('chat_history', { before: newest.payload.messages[0].timestamp, limit: 50 });
    const older = await a.waitFor('chat_history_page');
    expect(older.payload.messages).toHaveLength(50);
    // the older page must not overlap the newer one
    const newerIds = new Set(newest.payload.messages.map((m: any) => m.id));
    expect(older.payload.messages.every((m: any) => !newerIds.has(m.id))).toBe(true);
  }, 60000);

  it('reports no more pages when history runs out', async () => {
    const a = await client('page-end');
    await a.register(uniqueNick('pend'));
    a.clear();
    a.send('chat_history', { before: 1, limit: 50 });
    await new Promise((r) => setTimeout(r, 400));
    expect(a.logs.find((m) => m.type === 'chat_history_page')).toBeUndefined();
  });

  it('pages backwards through a dm', async () => {
    const a = await client('dmpage-a');
    const b = await client('dmpage-b');
    const ra = await a.register(uniqueNick('dpa'));
    const rb = await b.register(uniqueNick('dpb'));
    const bId = rb.payload.userId;
    const aId = ra.payload.userId;

    for (let i = 0; i < 60; i++) {
      a.send('dm_send', { to: bId, encrypted: { ciphertext: 'c' + i, iv: 'iv', encryptedKeys: { [bId]: 'k' + i } } });
      await new Promise((r) => setTimeout(r, 20));
    }

    b.clear();
    b.send('dm_history', { with: aId, limit: 40 });
    const first = await b.waitFor('dm_history');
    expect(first.payload.messages).toHaveLength(40);
    expect(first.payload.hasMore).toBe(true);

    b.clear();
    b.send('dm_history', { with: aId, before: first.payload.messages[0].timestamp, limit: 40 });
    // an older page has to be answered as a page: answering with the plain type made the client
    // replace the whole conversation with this slice, and an empty page blanked the chat
    const second = await b.waitFor('dm_history_page');
    const seen = new Set(first.payload.messages.map((m: any) => m.id));
    expect(second.payload.messages.every((m: any) => !seen.has(m.id))).toBe(true);

    b.clear();
    b.send('dm_history', { with: aId, before: second.payload.messages[0].timestamp, limit: 40 });
    const third = await b.waitFor('dm_history_page');
    // sixty messages over two full pages leaves nothing behind
    expect(third.payload.messages).toHaveLength(0);
    expect(third.payload.hasMore).toBe(false);
  }, 60000);
});
