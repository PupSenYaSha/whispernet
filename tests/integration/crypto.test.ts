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
