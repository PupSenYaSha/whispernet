import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * A send must not be able to take the handler down.
 *
 * node:sqlite binds only null, numbers, bigints, strings and bytes. Handing it undefined, a boolean
 * or an object throws ERR_INVALID_ARG_TYPE naming the parameter position, and because a message row
 * has eighteen parameters, that number identifies nothing on its own — the log said "parameter 9"
 * six times and the message was simply gone. This file pins both halves of the fix: the server
 * refuses a sealed blob that arrives on the wrong frame instead of binding it, and nothing optional
 * is passed to the driver unchecked.
 */

let server: StartedServer;
const clients: TestClient[] = [];
const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

let a: TestClient, b: TestClient, bId: string;

beforeAll(async () => {
  server = await startTestServer();
  a = await client('bind-a');
  b = await client('bind-b');
  const ra = await a.register(uniqueNick('binda'));
  const rb = await b.register(uniqueNick('bindb'));
  bId = rb.payload.userId;
  expect(ra.payload.userId).toBeTruthy();
});
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('an unbindable field cannot take a send down', () => {
  it('refuses a sealed flag sent as a boolean, instead of crashing', async () => {
    // The older protocol sent `sealed: true` as a flag on dm_send. That boolean was bound straight
    // into the sealed column and every one of those sends died in the driver.
    a.clear();
    a.send('dm_send', { to: bId, text: '', sealed: true });
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');

    // the socket is still usable, which is the part that proved the handler had thrown
    a.clear();
    b.clear();
    a.send('dm_send', { to: bId, encrypted: { ciphertext: 'AFTERFLAG', iv: 'iv', encryptedKeys: { [bId]: 'k' } } });
    const dm = await b.waitFor('dm_message');
    expect(dm.payload.encrypted.ciphertext).toBe('AFTERFLAG');
  });

  it('ignores a sealed object on a normal encrypted send', async () => {
    b.clear();
    a.send('dm_send', {
      to: bId,
      sealed: { blob: 'not a real sealed blob' },
      encrypted: { ciphertext: 'IGNORED', iv: 'iv', encryptedKeys: { [bId]: 'k' } },
    });
    const dm = await b.waitFor('dm_message');
    expect(dm.payload.encrypted.ciphertext).toBe('IGNORED');
    expect(dm.payload.sealed ?? null).toBeNull();
  });

  it('persists a message whose optional columns are all the wrong type', async () => {
    const { saveMessage, getMessageById, getDb } = await import('../../server/database');
    const id = 'bind-' + Date.now();
    await saveMessage(
      id, 'somebody', 'nick',
      '', Date.now(),
      undefined, 'general',
      undefined,
      true as unknown as string,   // sealed, the column that used to throw
      false as unknown as string,  // quoted_message_id
      { nope: 1 } as unknown as number,
      42 as unknown as number,
      false as unknown as string,  // client_id
    );
    const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
    expect(row).toBeTruthy();
    // the bad values become NULL; the row still lands and is still readable
    expect(row.sealed).toBeNull();
    expect(row.quoted_message_id).toBeNull();
    expect(row.client_id).toBeNull();
    expect((await getMessageById(id))?.id).toBe(id);
  });
});
