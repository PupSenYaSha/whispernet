import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { generateKeyPair, encryptMessage, decryptMessage } from '../../src/crypto';

/**
 * Who a private message is wrapped to.
 *
 * The envelope wraps one content key once per recipient, and the list it was built from used to be the
 * whole public key directory the server hands out at sign-in - so every account that had ever signed in
 * held a wrapped copy of the content key of every private message anybody had sent, and could unwrap any
 * of them. Nothing about that was visible from the outside: the message looked sealed, the recipient read
 * it, and the only symptom was that the operator's own database was a complete transcript.
 *
 * Two keys is the whole requirement. The recipient is the person being written to. Ours is there because
 * a ratchet session belongs to one device, so the copy is how this account's other devices read what it
 * sends. This file pins that number down.
 */

let server: StartedServer;
const clients: TestClient[] = [];
const accounts: Account[] = [];

interface Account {
  client: TestClient;
  userId: string;
  keys: { publicKey: JsonWebKey; privateKey: JsonWebKey };
}

async function account(prefix: string): Promise<Account> {
  const c = new TestClient(server.url, prefix);
  clients.push(c);
  await c.connect();
  const keys = await generateKeyPair();
  const reg = await c.register(uniqueNick(prefix), { publicKey: keys.publicKey });
  c.send('auth_update_key', { publicKey: keys.publicKey });
  await new Promise((r) => setTimeout(r, 120));
  const a: Account = { client: c, userId: reg.payload.userId, keys };
  accounts.push(a);
  return a;
}

async function peerKey(me: Account, peer: Account): Promise<JsonWebKey> {
  me.client.clear();
  me.client.send('dm_history', { with: peer.userId });
  const hist = await me.client.waitFor('dm_history', 5000);
  const key = hist.payload.publicKeys[peer.userId];
  if (!key) throw new Error('no key for ' + peer.userId);
  return key;
}

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('who a private message is wrapped to', () => {
  it('reaches the recipient and the sender, and nobody else', async () => {
    const alice = await account('wrapa');
    const bob = await account('wrapb');
    const carol = await account('wrapc');
    const dave = await account('wrapd');

    // exactly what the app builds: the recipient plus this account's own key
    const body = await encryptMessage('for your eyes only', {
      [bob.userId]: await peerKey(alice, bob),
      [alice.userId]: alice.keys.publicKey,
    });

    // a directory of strangers, which is what the server used to hand out at sign-in
    const wrappedFor = Object.keys(body.encryptedKeys);
    expect(wrappedFor.sort()).toEqual([alice.userId, bob.userId].sort());

    expect(await decryptMessage(body, bob.userId, bob.keys.privateKey)).toBe('for your eyes only');
    expect(await decryptMessage(body, alice.userId, alice.keys.privateKey)).toBe('for your eyes only');
    await expect(decryptMessage(body, carol.userId, carol.keys.privateKey)).rejects.toThrow();
    await expect(decryptMessage(body, dave.userId, dave.keys.privateKey)).rejects.toThrow();
  }, 60000);

  it('leaves a stored message no bystander account can open', async () => {
    const alice = await account('storea');
    const bob = await account('storeb');
    const carol = await account('storec');

    const body = await encryptMessage('private business', {
      [bob.userId]: await peerKey(alice, bob),
      [alice.userId]: alice.keys.publicKey,
    });

    alice.client.clear();
    alice.client.send('dm_send', { to: bob.userId, toKey: await peerKey(alice, bob), encrypted: body });
    const pushed = await bob.client.waitFor('dm_message', 8000);
    expect(pushed.payload.encrypted.encryptedKeys).not.toHaveProperty(carol.userId);
    expect(await decryptMessage(pushed.payload.encrypted, bob.userId, bob.keys.privateKey)).toBe('private business');
    await expect(decryptMessage(pushed.payload.encrypted, carol.userId, carol.keys.privateKey)).rejects.toThrow();
  }, 60000);

  it('does not let a bystander read the conversation through search', async () => {
    const alice = await account('srcha');
    const bob = await account('srcb');
    const carol = await account('srcc');

    const body = await encryptMessage('needle in the haystack', {
      [bob.userId]: await peerKey(alice, bob),
      [alice.userId]: alice.keys.publicKey,
    });
    alice.client.send('dm_send', { to: bob.userId, toKey: await peerKey(alice, bob), encrypted: body });
    await bob.client.waitFor('dm_message', 8000);

    // carol asks the server directly for the channel alice and bob are using
    carol.client.clear();
    carol.client.send('dm_history', { with: alice.userId });
    await new Promise((r) => setTimeout(r, 400));
    const leak = carol.client.logs.filter((m) => m.type === 'dm_history' || m.type === 'dm_history_page');
    for (const frame of leak) {
      for (const m of frame.payload.messages || []) {
        expect(m.encrypted).toBeFalsy();
      }
    }

    // and asking for bob's side of it gets nothing either
    carol.client.clear();
    carol.client.send('search_messages', { query: 'needle', channel: [alice.userId, bob.userId].sort().join(':') });
    await new Promise((r) => setTimeout(r, 400));
    for (const frame of carol.client.logs.filter((m) => m.type === 'message_search_results')) {
      expect(frame.payload.results || []).toHaveLength(0);
    }
  }, 90000);
});
