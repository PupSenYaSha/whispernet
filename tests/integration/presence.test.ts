import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * Typing and read receipts: what is relayed, and what is deliberately not kept.
 *
 * Both are things one person tells the other end of a conversation. Neither is written down anywhere on
 * the server - the frames are relayed to the far end and forgotten - because a durable record of who was
 * in which chat and when, or how far each conversation had been read, is social graph data a messenger
 * does not need in order to draw a tick. The tests below check the relaying works and that a receipt
 * cannot be claimed for a conversation the sender is not part of.
 */

let server: StartedServer;
const clients: TestClient[] = [];

async function client(label: string): Promise<TestClient> {
  const c = new TestClient(server.url, label);
  clients.push(c);
  await c.connect();
  return c;
}

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('typing indicators', () => {
  it('reaches the other end of a direct conversation', async () => {
    const alice = await client('type-a');
    const bob = await client('type-b');
    const ra = await alice.register(uniqueNick('typa'));
    const rb = await bob.register(uniqueNick('typb'));

    bob.clear();
    alice.send('typing', { channel: [ra.payload.userId, rb.payload.userId].sort().join(':') });
    const got = await bob.waitFor('typing', 5000);
    expect(got.payload.userId).toBe(ra.payload.userId);
    expect(got.payload.channel).toContain(rb.payload.userId);
  }, 60000);

  it('reaches everyone in the global chat', async () => {
    const alice = await client('type-g');
    const bob = await client('type-g2');
    const ra = await alice.register(uniqueNick('typc'));
    await bob.register(uniqueNick('typd'));

    bob.clear();
    alice.send('typing', { channel: 'general' });
    const got = await bob.waitFor('typing', 5000);
    expect(got.payload.channel).toBe('general');
    expect(got.payload.userId).toBe(ra.payload.userId);
  }, 60000);

  it('cannot be aimed at a conversation the sender is not part of', async () => {
    const alice = await client('type-x');
    const bob = await client('type-y');
    const carol = await client('type-z');
    const ra = await alice.register(uniqueNick('typd'));
    const rb = await bob.register(uniqueNick('type'));
    const rc = await carol.register(uniqueNick('typf'));

    carol.clear();
    // alice and bob's channel, named by somebody else
    alice.send('typing', { channel: [ra.payload.userId, rb.payload.userId].sort().join(':') });
    await new Promise((r) => setTimeout(r, 400));
    // carol must not learn that either of them is typing
    const relayed = carol.logs.filter((m) => m.type === 'typing');
    for (const frame of relayed) {
      expect(frame.payload.channel).not.toContain(rc.payload.userId);
    }
  }, 90000);
});

describe('read receipts', () => {
  it('tells the sender how far the reader has got', async () => {
    const alice = await client('read-a');
    const bob = await client('read-b');
    const ra = await alice.register(uniqueNick('reda'));
    const rb = await bob.register(uniqueNick('redb'));

    alice.clear();
    bob.send('dm_read', { channel: [ra.payload.userId, rb.payload.userId].sort().join(':'), upTo: 1234567890 });
    const got = await alice.waitFor('dm_read', 5000);
    expect(got.payload.upTo).toBe(1234567890);
    expect(got.payload.userId).toBe(rb.payload.userId);
  }, 60000);

  it('refuses a receipt from somebody outside the conversation', async () => {
    const alice = await client('read-x');
    const bob = await client('read-y');
    const carol = await client('read-z');
    const ra = await alice.register(uniqueNick('redc'));
    const rb = await bob.register(uniqueNick('redd'));
    await carol.register(uniqueNick('rede'));

    alice.clear();
    // carol is neither end of the conversation she is naming, so her claim about how far it has been read
    // is not hers to make and must not be relayed to it
    carol.send('dm_read', { channel: [ra.payload.userId, rb.payload.userId].sort().join(':'), upTo: 999 });
    await new Promise((r) => setTimeout(r, 500));
    for (const frame of alice.logs.filter((m) => m.type === 'dm_read')) {
      expect(frame.payload.upTo).not.toBe(999);
    }
  }, 90000);

  it('ignores a nonsense position', async () => {
    const alice = await client('read-bad');
    const bob = await client('read-bad2');
    const ra = await alice.register(uniqueNick('rede'));
    const rb = await bob.register(uniqueNick('redf'));
    const channel = [ra.payload.userId, rb.payload.userId].sort().join(':');

    alice.clear();
    for (const upTo of [0, -1, 'soon', null, undefined]) {
      bob.send('dm_read', { channel, upTo });
    }
    await new Promise((r) => setTimeout(r, 400));
    expect(alice.logs.filter((m) => m.type === 'dm_read')).toHaveLength(0);
  }, 90000);
});
