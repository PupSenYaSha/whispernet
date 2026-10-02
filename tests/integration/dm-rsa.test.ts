import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { generateKeyPair, encryptMessage, decryptMessage } from '../../src/crypto';

/**
 * A direct message has to be readable by the person it was written to.
 *
 * The ratchet that used to carry these is gone. What replaced it is RSA-OAEP with an AES-GCM body,
 * which is stateless: there is no session to negotiate, nothing to keep alive, and therefore no
 * failure mode that can leave a conversation permanently showing [encrypted]. These tests drive the
 * real client crypto over the real server, because the bug this replaces was never in the cipher — it
 * was in how the three delivery paths disagreed about which body a row carried.
 */

let server: StartedServer;
const clients: TestClient[] = [];

const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

interface Account {
  client: TestClient;
  userId: string;
  nickname: string;
  keys: { publicKey: JsonWebKey; privateKey: JsonWebKey };
}

const accounts: Account[] = [];

async function account(prefix: string): Promise<Account> {
  const c = await client(prefix);
  const nickname = uniqueNick(prefix);
  const keys = await generateKeyPair();
  // register with the keys the client would hold, so the server can route to them
  const reg = await c.register(nickname, { publicKey: keys.publicKey });
  c.send('auth_update_key', { publicKey: keys.publicKey });
  await new Promise((r) => setTimeout(r, 150));
  const a: Account = { client: c, userId: reg.payload.userId, nickname, keys };
  accounts.push(a);
  return a;
}

/** Reads the peer's published RSA key the way the app does: out of the contacts frame. */
async function peerKey(me: Account, peer: Account): Promise<JsonWebKey> {
  me.client.clear();
  me.client.send('dm_contacts', {});
  await me.client.waitFor('dm_contacts', 4000).catch(() => null);
  me.client.send('dm_history', { with: peer.userId });
  const hist = await me.client.waitFor('dm_history', 4000);
  return hist.payload.publicKeys[peer.userId];
}

/** Encrypts for one recipient, exactly as sendDmPackage does. */
const sealFor = async (from: Account, to: Account, text: string) =>
  encryptMessage(text, { [to.userId]: await peerKey(from, to) });

const openText = (to: Account, encrypted: any) => decryptMessage(encrypted, to.userId, to.keys.privateKey);

beforeAll(async () => { server = await startTestServer(); });
beforeEach(() => { for (const a of accounts) a.client.clear(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('a direct message is readable by its recipient', () => {
  it('reads on the live push, and on history afterwards', async () => {
    const alice = await account('rsaa');
    const bob = await account('rsab');

    alice.client.send('dm_send', { to: bob.userId, encrypted: await sealFor(alice, bob, 'hello') });
    const pushed = await bob.client.waitFor('dm_message');
    expect(await openText(bob, pushed.payload.encrypted)).toBe('hello');

    bob.client.clear();
    bob.client.send('dm_history', { with: alice.userId });
    const hist = await bob.client.waitFor('dm_history');
    expect(await openText(bob, hist.payload.messages[0].encrypted)).toBe('hello');
  });

  it('the sender cannot read its own message back, and says so honestly', async () => {
    // There is no key here that opens it, and pretending otherwise is what produced the [encrypted]
    // the sender could never explain. The client keeps a local copy of what it just wrote instead.
    const alice = await account('rsaa');
    const bob = await account('rsab');

    alice.client.send('dm_send', { to: bob.userId, encrypted: await sealFor(alice, bob, 'mine') });
    const echo = await alice.client.waitFor('dm_message');
    expect(echo.payload.isOwn).toBe(true);
    await expect(openText(alice, echo.payload.encrypted)).rejects.toThrow();
  });

  it('two different people can message the same person', async () => {
    // The exact scenario the old pre-key handling broke: the second sender was refused a session that
    // could never be built, and every message after it arrived as [encrypted] for good.
    const bob = await account('rsab');
    const carol = await account('rsac');
    const dave = await account('rsad');

    bob.client.clear();
    carol.client.send('dm_send', { to: bob.userId, encrypted: await sealFor(carol, bob, 'from carol') });
    const first = await bob.client.waitFor('dm_message');
    expect(await openText(bob, first.payload.encrypted)).toBe('from carol');

    bob.client.clear();
    dave.client.send('dm_send', { to: bob.userId, encrypted: await sealFor(dave, bob, 'from dave') });
    const second = await bob.client.waitFor('dm_message');
    expect(await openText(bob, second.payload.encrypted)).toBe('from dave');

    bob.client.clear();
    bob.client.send('dm_history', { with: carol.userId });
    const fromCarol = await bob.client.waitFor('dm_history');
    expect(await openText(bob, fromCarol.payload.messages[0].encrypted)).toBe('from carol');
  });

  it('replies, quotes and expiry survive the round trip', async () => {
    const alice = await account('rsaa');
    const bob = await account('rsab');
    const ttl = 86400;

    alice.client.send('dm_send', {
      to: bob.userId,
      ttl,
      quoted: { id: 'prev', text: 'earlier', sender: alice.nickname },
      encrypted: await sealFor(alice, bob, 'replying'),
    });
    const got = await bob.client.waitFor('dm_message');
    expect(await openText(bob, got.payload.encrypted)).toBe('replying');
    expect(got.payload.quotedMessageText).toBe('earlier');
    expect(got.payload.expiresAt).toBeGreaterThan(Date.now());
  });
});
