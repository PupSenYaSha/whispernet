import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

let server: StartedServer;
const clients: TestClient[] = [];
const PASSWORD = 'pass123456';

const open = async (label: string, ip?: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  if (ip) await c.connect({ 'x-forwarded-for': ip });
  return c;
};

/** Registers a throwaway user, used as the target of a wrong password. */
const newUser = async (): Promise<string> => {
  const n = uniqueNick('ra');
  const c = await open('reg');
  await c.register(n);
  c.close();
  return n;
};

const loginWith = async (ip: string, nickname: string, password = PASSWORD): Promise<string> => {
  const c = await open('x', ip);
  const res = await c.login(nickname, { password });
  const reason = String(res?.payload?.reason || '');
  c.close();
  return reason;
};

beforeAll(async () => {
  server = await startTestServer({ DISABLE_RATE_LIMITS: '0' });
});

afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('auth rate limiting', () => {
  it('rejects a wrong password', async () => {
    const n = await newUser();
    expect(await loginWith('10.9.0.1', n, 'wrongpassword')).toBe('Invalid nickname or password');
  });

  it('never locks out a user who only ever logs in', async () => {
    const n = await newUser();
    const ip = '10.9.0.4';
    for (let i = 0; i < 25; i++) {
      expect(await loginWith(ip, n)).toBe('');
    }
  });

  it('does not spend the budget on a successful login', async () => {
    const n = await newUser();
    const ip = '10.9.0.3';
    for (let i = 0; i < 4; i++) await loginWith(ip, n, 'wrongpassword');

    expect(await loginWith(ip, n)).toBe('');

    // the counter was cleared, so a fresh mistake starts over instead of stacking
    for (let i = 0; i < 4; i++) await loginWith(ip, n, 'wrongpassword');
    expect(await loginWith(ip, n)).toBe('');
  });

  it('blocks an ip that sprays many accounts and reports the real wait', async () => {
    const ip = '10.9.0.2';
    const victim = await newUser();
    const blocked = await sprayUntilBlocked(ip);

    expect(blocked).toMatch(/^Too many attempts\. Try again in \d+ second\(s\)\.$/);

    // even the correct password is refused while the limit is active
    expect(await loginWith(ip, victim)).toMatch(/Too many attempts/);
  });

  it('keeps separate buckets per forwarded ip', async () => {
    const mine = '203.0.113.7';
    const other = '198.51.100.9';
    const n = await newUser();

    await sprayUntilBlocked(mine);

    // a different client behind the same tunnel must not be affected
    expect(await loginWith(other, n)).toBe('');
  });
});

/**
 * Repeatedly tries a wrong password against names that do not exist, from one ip, until the
 * limiter answers. Each attempt costs a dummy bcrypt compare, so this stays well inside the
 * one minute window while still exercising the counter.
 */
async function sprayUntilBlocked(ip: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    // the generated name has to stay within the 3-16 char nickname rule, otherwise the attempt is
    // rejected as invalid and never reaches the rate limiter
    const reason = await loginWith(ip, uniqueNick('x'), 'wrongpassword');
    if (reason.startsWith('Too many attempts')) return reason;
  }
  return '';
}
