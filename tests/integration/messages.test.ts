import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

let server: StartedServer;
const clients: TestClient[] = [];
const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('messages: edit, delete and full-text search', () => {
  let a: TestClient, b: TestClient;

  beforeAll(async () => {
    a = await client('s-a');
    b = await client('s-b');
    await a.register(uniqueNick('sa'));
    await b.register(uniqueNick('sb'));
  });

  it('keeps the search index working after editing a message', async () => {
    const marker = 'zzqmarker' + Date.now();
    a.send('chat_message', { text: 'first text ' + marker });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();

    a.clear();
    a.send('edit_message', { messageId: got.payload.id, text: 'edited text ' + marker });
    const edited = await b.waitFor('message_edited');
    expect(edited).toBeTruthy();

    a.clear();
    a.send('search_messages', { query: marker });
    const found = await a.waitFor('message_search_results');
    expect(found.payload.results.some((m: any) => m.text.includes('edited text'))).toBe(true);
  });

  it('removes the entry from the index after the message is deleted', async () => {
    const marker = 'zzqdelete' + Date.now();
    a.clear(); b.clear();
    a.send('chat_message', { text: 'to delete ' + marker });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();

    a.clear();
    a.send('delete_message', { messageId: got.payload.id });
    await new Promise((r) => setTimeout(r, 400));

    a.clear();
    a.send('search_messages', { query: marker });
    const found = await a.waitFor('message_search_results');
    expect(found.payload.results.some((m: any) => (m.text || '').includes('to delete'))).toBe(false);
  });

  it('adds and removes reactions and broadcasts them with an action', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'react to me ' + Date.now() });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();
    b.clear(); a.clear();
    b.send('add_reaction', { messageId: got.payload.id, emoji: '👍' });
    const add = await a.waitFor('reaction_update');
    expect(add?.payload?.action).toBe('add');
    expect(add?.payload?.emoji).toBe('👍');
    a.clear(); b.clear();
    b.send('remove_reaction', { messageId: got.payload.id, emoji: '👍' });
    const rem = await a.waitFor('reaction_update');
    expect(rem?.payload?.action).toBe('remove');
  });

  it('does not allow editing someone else’s message', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'mine only ' + Date.now() });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();
    b.clear();
    b.send('edit_message', { messageId: got.payload.id, text: 'hijacked' });
    await new Promise((r) => setTimeout(r, 400));
    b.clear();
    b.send('search_messages', { query: 'hijacked' });
    const found = await b.waitFor('message_search_results');
    expect(found.payload.results.length).toBe(0);
  });
});

describe('message length ceilings', () => {
  // Editing used to accept 4096 characters while sending accepted 2000, so a correction was a way to
  // put a longer message on the wire than the composer would ever have allowed. Both are 2000 now,
  // and a quote is a copy of a message, so it gets the same ceiling rather than twice it.
  const LIMIT = 2000;
  let a: TestClient, b: TestClient;

  beforeAll(async () => {
    a = await client('len-a');
    b = await client('len-b');
    await a.register(uniqueNick('la'));
    await b.register(uniqueNick('lb'));
  });

  it('accepts a message right at the ceiling', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'x'.repeat(LIMIT) });
    const got = await b.waitFor('chat_message');
    expect(got.payload.text).toHaveLength(LIMIT);
  });

  it('refuses a message past it', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'x'.repeat(LIMIT + 1) });
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('MESSAGE_TOO_LONG');
  });

  it('refuses an edit past the same ceiling', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'edit ceiling ' + Date.now() });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();

    a.clear(); b.clear();
    a.send('edit_message', { messageId: got.payload.id, text: 'x'.repeat(LIMIT + 1) });
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('MESSAGE_TOO_LONG');
    expect(err.payload.message).toMatch(new RegExp(`max ${LIMIT} chars`));
  });

  it('accepts an edit right at the ceiling', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'edit ok ' + Date.now() });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();

    a.clear(); b.clear();
    a.send('edit_message', { messageId: got.payload.id, text: 'y'.repeat(LIMIT) });
    const edited = await b.waitFor('message_edited');
    expect(edited.payload.text).toHaveLength(LIMIT);
  });

  it('truncates an over-long quote instead of storing all of it', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'quote host ' + Date.now(), quoted: { id: 'q1', text: 'z'.repeat(5000), sender: 'someone' } });
    const got = await b.waitFor('chat_message');
    expect(got).toBeTruthy();
    expect(got.payload.quotedMessageText).toHaveLength(LIMIT);
  });
});

describe('password length', () => {
  it('accepts a long passphrase and refuses one past the ceiling', async () => {
    const c = await client('pw');
    // 64 characters is the ceiling, and a passphrase is exactly what it is there for
    const ok = await c.register(uniqueNick('pw'), { password: 'Aa1' + 'b'.repeat(61) });
    expect(ok.type).toBe('auth_success');

    const d = await client('pw2');
    const tooLong = await d.register(uniqueNick('pw'), { password: 'Aa1' + 'b'.repeat(62) });
    expect(tooLong.type).toBe('auth_failure');
    expect(tooLong.payload.reason).toMatch(/8-64/);
  });
});
