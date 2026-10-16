import { describe, it, expect, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * Three things that used to be checked nowhere, each of which had a plausible story for why it was fine.
 *
 * The forwarding header was believed because the peer was on loopback, which is true of a tunnel and also of
 * anything else that binds the port - so one header chose the client's own address and walked past every
 * per-address limit. And the registration ceiling was counted from rows keyed on a pseudonym whose salt
 * rotates at midnight, so "forty accounts in the last day" was forty per UTC day; a burst read the count
 * before any of them wrote one; and two accounts created in the same millisecond collapsed into one row.
 *
 * One configuration for the whole file, because `server/constants` reads the environment when the module is
 * first imported and only the first `startTestServer` here can set it. Both ceilings are 2 so that each case
 * can be attributed to the scope it is actually about: the proxy cases give every account its own device id
 * and share an address, and the burst case shares a device id across four addresses.
 *
 * `TRUST_PROXY` is read per call rather than at import, so the one case that needs it off can say so.
 */

const IP_CAP = '2';
const DEVICE_CAP = '2';

const ENV = {
  MAX_REGISTRATIONS_PER_IP: IP_CAP,
  MAX_ACCOUNTS_PER_DEVICE: DEVICE_CAP,
  DISABLE_RATE_LIMITS: '0',
  // Charges every `auth_login` frame whatever the outcome. The ceiling on failures cannot do this job: a
  // `bcryptjs` comparison at cost 12 is computed synchronously and takes about 310 ms of the only Node
  // thread, and it happens *before* the failure counter is consulted.
  MAX_AUTH_ATTEMPTS_PER_ADDRESS: '3',
  MAX_AUTH_ATTEMPTS: '1000',
};

const clients: TestClient[] = [];
let server: StartedServer | null = null;

afterAll(async () => {
  clients.forEach((c) => c.close());
  if (server) await server.stop();
});

const register = async (srv: StartedServer, headers: Record<string, string>, deviceId?: string): Promise<string> => {
  const c = new TestClient(srv.url, 'reg');
  clients.push(c);
  await c.connect(headers);
  const res = await c.register(uniqueNick('lim'), deviceId ? { deviceId } : undefined);
  c.close();
  return res.type;
};

const loginFrom = async (srv: StartedServer, ip: string, nickname: string): Promise<string> => {
  const c = new TestClient(srv.url, 'pw-' + nickname);
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  const res = await c.login(nickname);
  c.close();
  return String(res?.payload?.reason || '');
};

describe('a forwarding header is only believed when the operator says so', () => {
  it('ignores X-Forwarded-For with no TRUST_PROXY, so a limit cannot be stepped around', async () => {
    server = await startTestServer({ ...ENV, TRUST_PROXY: '' });
    expect(process.env.TRUST_PROXY, 'the harness declares a proxy by default; this case needs it off').toBe('');

    // Three accounts, three declared addresses, three of their own devices. The address ceiling is the only
    // thing that can refuse the third, so the claimed addresses having no effect at all is the point.
    const results: string[] = [];
    for (let i = 1; i <= 3; i++) {
      results.push(await register(server, { 'x-forwarded-for': `198.51.100.${i}` }));
    }

    expect(results.slice(0, 2), 'the first two accounts should have gone through').toEqual(['auth_success', 'auth_success']);
    expect(results[2], 'the address ceiling did not fire, so three buckets were in use').toBe('auth_failure');
  }, 180000);

  it('reads the chain from the right, not the leftmost element the client sent', async () => {
    server = await startTestServer({ ...ENV, TRUST_PROXY: '1', TRUSTED_PROXY_HOPS: '1' });

    // What a client behind one real hop produces: its own claim first, the address the proxy actually saw
    // last, because a standard proxy appends to what arrived. Taking the leftmost entry would give three
    // different buckets and refuse nothing; taking the rightmost gives one.
    const results: string[] = [];
    for (const claimed of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      results.push(await register(server, { 'x-forwarded-for': `${claimed}, 10.0.0.9` }));
    }

    expect(results.slice(0, 2)).toEqual(['auth_success', 'auth_success']);
    expect(results[2], 'the leftmost element - the client\'s own claim - decided the buckets').toBe('auth_failure');
  }, 180000);

  it('honours x-real-ip, which a proxy sets to the address it actually saw', async () => {
    server = await startTestServer({ ...ENV, TRUST_PROXY: '1', TRUSTED_PROXY_HOPS: '1' });

    // The claimed chain says three different addresses; x-real-ip says they were all one person.
    const results: string[] = [];
    for (const claimed of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      results.push(await register(server, { 'x-forwarded-for': `${claimed}, 10.0.0.9`, 'x-real-ip': '198.51.100.9' }));
    }

    expect(results.slice(0, 2)).toEqual(['auth_success', 'auth_success']);
    expect(results[2], 'x-real-ip was ignored, so the claimed chain decided the buckets').toBe('auth_failure');
  }, 180000);
});

describe('the per-address budget on the cost of a sign-in', () => {
  it('counts successes too, and is spent by nothing else', async () => {
    server = await startTestServer({ ...ENV, TRUST_PROXY: '1' });
    const srv = server;

    const nick = uniqueNick('wb');
    const reg = new TestClient(srv.url, 'wb-reg');
    clients.push(reg);
    await reg.connect({ 'x-forwarded-for': '203.0.113.20' });
    await reg.register(nick);
    reg.close();

    // Three *correct* sign-ins. The failure counter never moves, and none of them is refused.
    for (let i = 0; i < 3; i++) {
      expect(await loginFrom(srv, '203.0.113.20', nick), `sign-in ${i + 1} was refused`).toBe('');
    }

    // The fourth is not, even though every password it sent was right and the failure count is still zero.
    // The wording is the same as the failure limit's on purpose: a caller that could tell the two counters
    // apart would learn which one it was up against.
    const refused = await loginFrom(srv, '203.0.113.20', nick);
    expect(refused, 'a budget on work that ignores successes is a budget on nothing').toMatch(/^Too many attempts\./);
  }, 180000);
});

describe('a socket holds one account', () => {
  it('refuses a second auth_login rather than registering the same socket twice', async () => {
    // `auth_login` was dispatched with no check on whether this socket already held an account, so a signed
    // in socket could sign in as a second one. `registerDevice` then added a second `clients` entry pointing
    // at the *same* ws - every later broadcast delivered to it twice - and one of the account's three session
    // slots was spent without the owner ever seeing a device appear in Settings.
    server = await startTestServer({ ...ENV, TRUST_PROXY: '1' });
    const srv = server;

    const c = new TestClient(srv.url, 'reauth');
    clients.push(c);
    await c.connect();
    const firstNick = uniqueNick('ra1');
    const secondNick = uniqueNick('ra2');
    expect((await c.register(firstNick)).type).toBe('auth_success');

    // Cleared, because the helper reuses the challenge already in the log rather than waiting for a new one.
    c.clear();
    await c.register(secondNick);
    c.clear();
    const again = await c.login(secondNick);
    expect(again.type, 'the socket signed in a second time instead of being refused').toBe('auth_failure');
    expect(String(again.payload?.reason || '')).toMatch(/already signed in/i);
  }, 180000);
});

describe('the registration ceiling holds under a burst', () => {
  it('counts every account created, not every millisecond one was created in', async () => {
    server = await startTestServer({ ...ENV, TRUST_PROXY: '1' });
    const srv = server;

    // One device, four addresses, four registrations at once. The old counter key was
    // `PRIMARY KEY (scope, subject, created_at)` written with INSERT OR IGNORE, so accounts created in the
    // same millisecond collapsed into a single counted row - and even without that, every one of these read
    // the count before any of them wrote one, because each step in between was an await.
    const deviceId = 'burst-device';
    const attempts = ['203.0.113.31', '203.0.113.32', '203.0.113.33', '203.0.113.34'].map(async (ip) =>
      register(srv, { 'x-forwarded-for': ip }, deviceId));

    const results = await Promise.all(attempts);
    const created = results.filter((t) => t === 'auth_success').length;
    expect(created, 'the check-then-act let a burst past a ceiling it had already read').toBeLessThanOrEqual(2);
    expect(created, 'nothing at all got through, which is a different failure').toBeGreaterThan(0);
  }, 180000);
});