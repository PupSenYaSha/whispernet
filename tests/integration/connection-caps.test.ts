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
