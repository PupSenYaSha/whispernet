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
    // One message at a time, each waited for. This used to fire all hundred and thirty frames back to
    // back and then ask for history while they were still being written, so the page came back short and
    // the test failed for reasons that had nothing to do with paging. `waitFor` also finds the first
    // matching frame in the log, so without the clear each iteration returned the previous echo at once.
    for (let i = 0; i < total; i++) {
      a.clear();
      a.send('chat_message', { text: 'page ' + i });
      const echoed = await a.waitFor('chat_message', 5000);
      if (!echoed) throw new Error('message ' + i + ' was never echoed');
    }

    a.clear();
    a.send('chat_history', { limit: 50 });
    const newest = await a.waitFor('chat_history_page', 8000);
    expect(newest).toBeTruthy();
    expect(newest.payload.messages).toHaveLength(50);
    expect(newest.payload.hasMore).toBe(true);

    a.clear();
    a.send('chat_history', { before: newest.payload.messages[0].timestamp, limit: 50 });
    const older = await a.waitFor('chat_history_page', 8000);
    expect(older).toBeTruthy();
    expect(older.payload.messages).toHaveLength(50);
    // the older page must not overlap the newer one
    const newerIds = new Set(newest.payload.messages.map((m: any) => m.id));
    expect(older.payload.messages.every((m: any) => !newerIds.has(m.id))).toBe(true);
  }, 120000);

  it('reports no more pages when history runs out', async () => {
    const a = await client('page-end');
    await a.register(uniqueNick('pend'));
    a.clear();
    a.send('chat_history', { before: 1, limit: 50 });
    // Answered, not ignored. Silence used to be how "there is nothing older" was signalled, which left
    // the client waiting on an answer that was never coming and left "load earlier" on screen for good.
    const end = await a.waitFor('chat_history_page');
    expect(end.payload.messages).toHaveLength(0);
    expect(end.payload.hasMore).toBe(false);
  });

  it('pages backwards through a dm', async () => {
    const a = await client('dmpage-a');
    const b = await client('dmpage-b');
    const ra = await a.register(uniqueNick('dpa'));
    const rb = await b.register(uniqueNick('dpb'));
    const bId = rb.payload.userId;
    const aId = ra.payload.userId;

    // waited for rather than paced: a fixed sleep leaves some sends in flight when the history is read,
    // and the page then comes back with fewer rows than were written
    for (let i = 0; i < 60; i++) {
      b.clear();
      a.send('dm_send', { to: bId, encrypted: { ciphertext: 'c' + i, iv: 'iv', encryptedKeys: { [bId]: 'k' + i } } });
      const got = await b.waitFor('dm_message', 5000);
      if (!got) throw new Error('dm ' + i + ' was never delivered');
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
