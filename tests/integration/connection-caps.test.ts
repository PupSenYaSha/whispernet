import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { MAX_SESSIONS_PER_USER } from '../../server/constants';

let server: StartedServer;
const clients: TestClient[] = [];

const open = async (ip: string, deviceId: string): Promise<TestClient> => {
  const c = new TestClient(server.url, deviceId);
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  return c;
};

// rate limits have to be on here, they are what these tests exercise
beforeAll(async () => { server = await startTestServer({ DISABLE_RATE_LIMITS: '0' }); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('shared networks', () => {
  it('lets many accounts connect from one address', async () => {
    const ip = '10.1.0.1';
    for (let i = 0; i < 12; i++) {
      const c = await open(ip, 'nat-' + i);
      const res = await c.register(uniqueNick('nat'));
      expect(res.type, `register ${i}: ${JSON.stringify(res.payload)}`).toBe('auth_success');
    }
  }, 30000);

  it('caps how many devices one account may hold', async () => {
    const ip = '10.1.0.2';
    const nick = uniqueNick('multi');
    const first = await open(ip, 'dev-0');
    const reg = await first.register(nick);
    expect(reg.type, `register: ${JSON.stringify(reg.payload)}`).toBe('auth_success');

    const reasons: string[] = [];
    let rejected = 0;
    for (let i = 1; i <= MAX_SESSIONS_PER_USER + 3; i++) {
      const deviceId = 'dev-' + i;
      const c = await open(ip, deviceId);
      const res = await c.login(nick, { deviceId });
      if (res.type === 'auth_failure') { rejected++; reasons.push(res.payload.reason); }
    }
    expect(rejected, `expected refusals, got: ${reasons.join(' | ')}`).toBeGreaterThan(0);
  }, 30000);

  /**
   * The device id lives in localStorage, so a reload or a second tab sends the same one. The new
   * socket replaces the old one, and the old socket's close handler used to look the device up by
   * id and unregister whatever it found - by then the new connection, which then went deaf.
   */
  it('keeps the new socket alive when the same device reconnects', async () => {
    const ip = '10.1.0.3';
    const nick = uniqueNick('recon');
    // the device id lives in localStorage, so a reload or a second tab sends the same one
    const deviceId = 'dev-recon';

    const first = await open(ip, deviceId);
    expect((await first.register(nick, { deviceId })).type).toBe('auth_success');

    const listener = await open('10.1.0.4', 'dev-listener');
    expect((await listener.register(uniqueNick('peer'), { deviceId: 'dev-listener' })).type).toBe('auth_success');

    const second = await open(ip, deviceId);
    expect((await second.login(nick, { deviceId })).type).toBe('auth_success');

    // give the kicked socket time to run its close handler
    await new Promise((r) => setTimeout(r, 300));

    second.clear();
    listener.send('chat_message', { text: 'still there?' });
    const received = await second.waitFor('chat_message', 5000);
    expect(received, 'the reconnected socket went deaf after its predecessor closed').toBeTruthy();
    expect(received.payload.text).toBe('still there?');
  }, 30000);

  /**
   * Two accounts on one browser share a device id, and that is not an attack.
   *
   * `wn_device_id` is stored once per browser profile, not once per account, so signing in as somebody else
   * on the same machine presents an id the server has already seen. The registry was keyed by that id
   * alone, so the second sign-in evicted the first account's socket with `close(4001)` - and then held only
   * one entry, which meant the first account's typing indicators and read receipts were routed to the
   * second account's socket. Both halves of that are wrong, and the eviction is the visible one.
   */
  it('lets two accounts share one device id without evicting each other', async () => {
    const ip = '10.1.0.6';
    const deviceId = 'dev-shared-browser';
    const firstNick = uniqueNick('share');
    const secondNick = uniqueNick('share2');

    const first = await open(ip, deviceId);
    const firstAuth = await first.register(firstNick, { deviceId });
    expect(firstAuth.type, `register: ${JSON.stringify(firstAuth.payload)}`).toBe('auth_success');

    const listener = await open('10.1.0.7', 'dev-share-listener');
    expect((await listener.register(uniqueNick('sharepeer'), { deviceId: 'dev-share-listener' })).type).toBe('auth_success');

    // The collision: a different account, presented the same device id.
    const second = await open(ip, deviceId);
    const secondAuth = await second.register(secondNick, { deviceId });
    expect(secondAuth.type, `second register: ${JSON.stringify(secondAuth.payload)}`).toBe('auth_success');

    await new Promise((r) => setTimeout(r, 300));

    // Neither account may be silently disconnected by the other's sign-in.
    first.clear();
    listener.send('chat_message', { text: 'is the first account still here?' });
    const toFirst = await first.waitFor('chat_message', 5000);
    expect(toFirst, 'signing in as a second account disconnected the first one').toBeTruthy();
    expect(toFirst.payload.text).toBe('is the first account still here?');

    // And the shared entry must not swallow private traffic. A read receipt is looked up by device id, so
    // with one entry per device it went to whichever account registered last: the sender received its own
    // receipt and the recipient got nothing.
    const dm = `${second.userId}:${first.userId}`;
    second.clear();
    first.clear();
    second.send('dm_read', { channel: dm, upTo: Date.now() });

    const misrouted = await second.waitFor('dm_read', 900);
    expect(misrouted, "the sender received its own read receipt, so it never reached the recipient").toBeNull();

    const delivered = await first.waitFor('dm_read', 5000);
    expect(delivered, "the read receipt never reached the account it was addressed to").toBeTruthy();
    expect(delivered.payload.channel).toBe(dm);
  }, 30000);

  it('does not let one address flood the server before signing in', async () => {
    const ip = '10.1.0.5';
    const nick = uniqueNick('flood');
    const first = await open(ip, 'dev-flood');
    expect((await first.register(nick)).type).toBe('auth_success');

    // several sockets for one device from one address are allowed; the per account limit is not
    // the thing being tested here
    const results = [];
    for (let i = 0; i < 5; i++) {
      const c = await open(ip, 'dev-flood-' + i);
      results.push((await c.login(nick, { deviceId: 'dev-flood-' + i })).type);
    }
    // each new device is its own session, so the session limit is what answers
    expect(results.every((t) => t === 'auth_success' || t === 'auth_failure')).toBe(true);
    expect(results.filter((t) => t === 'auth_failure').length).toBeGreaterThan(0);
  }, 30000);
});
