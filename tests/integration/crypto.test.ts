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

/** A 32-byte X25519 public key, base64. This is what a peer seals to. */
const b64 = (seed: number): string => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed * 13 + 11) % 256)).toString('base64');

describe('sealed sender keys', () => {
  let a: TestClient, b: TestClient, c: TestClient;
  let aId: string, cId: string;

  beforeAll(async () => {
    a = await client('sk-a');
    b = await client('sk-b');
    c = await client('sk-c');
    const ra = await a.register(uniqueNick('ska'));
    const rb = await b.register(uniqueNick('skb'));
    const rc = await c.register(uniqueNick('skc'));
    aId = ra.payload.userId; cId = rc.payload.userId;
    expect(rb.payload.userId).toBeTruthy();
  });

  it('accepts a published key and hands it back with the conversation', async () => {
    a.send('sealed_key_update', { sealedKey: b64(2) });
    await new Promise((r) => setTimeout(r, 150));
    b.clear();
    // dm_history is where the app gets a peer's keys: dm_contacts only covers accounts this one has
    // already exchanged messages with, and a brand new conversation has to work too
    b.send('dm_history', { with: aId });
    const hist = await b.waitFor('dm_history');
    expect(hist.payload.sealedKeys[aId]).toBe(b64(2));
  });

  it('tells the other side when a key changes, so sealed messages keep opening', async () => {
    b.clear();
    a.send('sealed_key_update', { sealedKey: b64(9) });
    const updated = await b.waitFor('sealed_key_updated');
    expect(updated.payload.userId).toBe(aId);
    expect(updated.payload.sealedKey).toBe(b64(9));
  });

  it('refuses anything that is not a 32-byte key', async () => {
    b.clear();
    a.send('sealed_key_update', { sealedKey: 'too-short' });
    a.send('sealed_key_update', { sealedKey: 42 });
    await new Promise((r) => setTimeout(r, 250));
    expect(b.logs.filter((m: any) => m.type === 'sealed_key_updated')).toHaveLength(0);
    // and the stored key is unchanged: still the one published above
    b.clear();
    b.send('dm_history', { with: aId });
    const hist = await b.waitFor('dm_history');
    expect(hist.payload.sealedKeys[aId]).toBe(b64(9));
  });

  it('omits accounts that never published one, rather than sending null', async () => {
    b.clear();
    b.send('dm_history', { with: cId });
    const hist = await b.waitFor('dm_history');
    expect(Object.prototype.hasOwnProperty.call(hist.payload.sealedKeys, cId)).toBe(false);
  });
});

describe('direct messages keep their ciphertext', () => {
  let a: TestClient, b: TestClient, aId: string, bId: string;

  beforeAll(async () => {
    a = await client('dm-a');
    b = await client('dm-b');
    const ra = await a.register(uniqueNick('dma'));
    const rb = await b.register(uniqueNick('dmb'));
    aId = ra.payload.userId;
    bId = rb.payload.userId;
  });

  it('forwards and persists the encrypted payload', async () => {
    b.clear();
    a.send('dm_send', {
      to: bId,
      encrypted: { ciphertext: 'AAAA', iv: 'BBBB', encryptedKeys: { [bId]: 'CCCC' } },
    });
    const dm = await b.waitFor('dm_message');
    expect(dm.payload.encrypted.ciphertext).toBe('AAAA');
    expect(dm.payload.encrypted.encryptedKeys[bId]).toBe('CCCC');

    b.clear();
    b.send('dm_history', { with: aId });
    const hist = await b.waitFor('dm_history');
    const m0 = hist.payload.messages[0];
    expect(m0.encrypted.ciphertext).toBe('AAAA');
    expect(m0.encrypted.encryptedKeys[bId]).toBe('CCCC');
  });

  it('refuses plaintext direct messages', async () => {
    a.clear();
    a.send('dm_send', { to: bId, text: 'plain' });
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
  });

  it('carries the client message id back to the sender and into the history', async () => {
    const clientId = 'a1b2c3d4e5f6a7b8';
    a.clear();
    a.send('dm_send', {
      to: bId,
      clientId,
      encrypted: { ciphertext: 'CCCC', iv: 'DDDD', encryptedKeys: { [bId]: 'EEEE' } },
    });

    const echo = await a.waitFor('dm_message');
    expect(echo.payload.isOwn).toBe(true);
    expect(echo.payload.clientId).toBe(clientId);

    b.clear();
    b.send('dm_history', { with: aId });
    const hist = await b.waitFor('dm_history');
    const mine = hist.payload.messages.find((m: any) => m.clientId === clientId);
    expect(mine).toBeTruthy();
    expect(mine.encrypted.ciphertext).toBe('CCCC');
  });

  it('drops a client message id that does not look like one', async () => {
    a.clear();
    a.send('dm_send', {
      to: bId,
      clientId: 'no spaces allowed here',
      encrypted: { ciphertext: 'EEEE', iv: 'FFFF', encryptedKeys: { [bId]: 'GGGG' } },
    });
    const echo = await a.waitFor('dm_message');
    expect(echo.payload.clientId ?? null).toBeNull();
  });
});
