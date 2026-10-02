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
  // The per-address backstop is 300 a minute in production, which a test could not afford to walk
  // through. It is lowered here so the spray still trips it, while the per-nickname lockout below
  // keeps the production number of five.
  server = await startTestServer({
    DISABLE_RATE_LIMITS: '0',
    MAX_AUTH_ATTEMPTS: '30',
  });
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

  it('locks a real account out on repeated wrong passwords', async () => {
    const n = await newUser();
    const ip = '198.51.100.44';
    for (let i = 0; i < 5; i++) expect(await loginWith(ip, n, 'wrongpassword')).toBe('Invalid nickname or password');
    // further wrong passwords from the same address are told to wait
    expect(await loginWith(ip, n, 'wrongpassword')).toMatch(/Account locked/);
  });

  // This is the vulnerability. The lockout used to be keyed by the nickname alone and was checked
  // before the password, so anybody who knew a name could lock the account out for five minutes at a
  // time and keep it there for as long as they cared to. A lockout that can refuse the right password
  // is a denial of service; one that cannot is only a slower guess.
  it('never refuses the right password, however many failures the nickname has collected', async () => {
    const n = await newUser();
    const attacker = '198.51.100.60';

    for (let i = 0; i < 6; i++) await loginWith(attacker, n, 'wrongpassword');
    expect(await loginWith(attacker, n, 'wrongpassword')).toMatch(/Account locked/);

    // the owner, from their own address, is not affected at all
    expect(await loginWith('198.51.100.61', n)).toBe('');
    // and neither is the attacker themselves guessing correctly
    expect(await loginWith(attacker, n)).toBe('');
  });

  it('lets a correct password in from the very address that is being throttled', async () => {
    const n = await newUser();
    const ip = '198.51.100.62';
    for (let i = 0; i < 6; i++) await loginWith(ip, n, 'wrongpassword');
    expect(await loginWith(ip, n)).toBe('');
  });

  it('counts failures for one name across every address, at a much higher ceiling', async () => {
    // the per-address lock is 5; the cross-address one is 20, so a spray has to be twenty times
    // noisier before the whole name is slowed down
    const n = await newUser();
    for (let i = 0; i < 19; i++) {
      await loginWith(`198.51.100.${70 + i}`, n, 'wrongpassword');
    }
    // nineteen failures from nineteen addresses, and the owner can still log in
    expect(await loginWith('198.51.100.200', n)).toBe('');
  });

  it('throttles one name from one address when there is no account to lock', async () => {
    // A name that does not exist still gets a lockout, because the counter is keyed by nickname and
    // not by whether the account is real. That is what bounds a spray aimed at a single name.
    const ip = '198.51.100.45';
    const ghost = uniqueNick('x');
    let last = '';
    for (let i = 0; i < 12; i++) last = await loginWith(ip, ghost, 'wrongpassword');
    expect(last).toMatch(/Account locked/);
  });

  // The reason the limit is keyed per address and nickname: a family, an office or a school shares
  // one router, so every login through it arrives from the same address. Counting the address alone
  // meant one person's wrong password locked out everybody else in the building.
  it('does not let one person fumbling lock out their neighbours on the same address', async () => {
    const ip = '198.51.100.77';
    const noisy = await newUser();
    const neighbour = await newUser();

    for (let i = 0; i < 6; i++) await loginWith(ip, noisy, 'wrongpassword');

    // the neighbour shares the address but not the nickname, so they are untouched
    expect(await loginWith(ip, neighbour)).toBe('');
  });

  it('still lets the right password through for somebody else on a sprayed address', async () => {
    const ip = '203.0.113.200';
    const victim = await newUser();
    await sprayUntilBlocked(ip);

    // the address is throttled, which is the backstop doing its job against a spray
    expect(await loginWith(ip, victim)).toMatch(/Too many attempts/);
    // and a different address is entirely unaffected
    expect(await loginWith('203.0.113.201', victim)).toBe('');
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
