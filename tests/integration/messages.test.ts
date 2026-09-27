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
