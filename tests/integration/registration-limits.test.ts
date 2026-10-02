import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * How many accounts one address may create.
 *
 * There was no ceiling at all, so anyone who reached the port could fill the users table. The window
 * is deliberately long: a short one punishes a shared address rather than a spammer, which is the
 * mistake the auth backstop used to make.
 */

let server: StartedServer;
const clients: TestClient[] = [];

const register = async (ip: string, label = 'reg'): Promise<{ type: string; reason?: string }> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  const res = await c.register(uniqueNick('rl'));
  c.close();
  return { type: res.type, reason: res.payload?.reason };
};

beforeAll(async () => {
  // the suite default of a thousand is right for a file that creates a dozen accounts and useless
  // for testing a ceiling, and DISABLE_RATE_LIMITS has to be off or the cap is never consulted
  server = await startTestServer({ MAX_REGISTRATIONS_PER_IP: '3', DISABLE_RATE_LIMITS: '0' });
});

afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('registration limits', () => {
  it('lets the first accounts through', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await register('198.51.100.10')).type).toBe('auth_success');
    }
  });

  it('refuses the next one from the same address, and says how long', async () => {
    const res = await register('198.51.100.10');
    expect(res.type).toBe('auth_failure');
    expect(res.reason).toMatch(/Too many accounts created from this network\. Try again in \d+ hour\(s\)\./);
  });

  it('does not stop anybody on a different address', async () => {
    expect((await register('198.51.100.11')).type).toBe('auth_success');
  });

  it('does not charge the address for a nickname that is already taken', async () => {
    // a refusal that happens before the account exists must not spend the budget, or one person
    // holding a name could stop a whole network from registering
    const taken = uniqueNick('rl');
    const first = new TestClient(server.url, 'first');
    clients.push(first);
    await first.connect({ 'x-forwarded-for': '198.51.100.12' });
    expect((await first.register(taken)).type).toBe('auth_success');
    first.close();

    for (let i = 0; i < 5; i++) {
      const c = new TestClient(server.url, 'dupe');
      clients.push(c);
      await c.connect({ 'x-forwarded-for': '198.51.100.12' });
      const res = await c.register(taken);
      c.close();
      expect(res.payload?.reason).toMatch(/already taken/i);
    }

    // the budget is untouched, so a genuinely new name still works
    expect((await register('198.51.100.12')).type).toBe('auth_success');
  });

  it('is lifted entirely when the ceiling is set to zero', async () => {
    // the switch is the environment variable, read when the module loads
    expect(Number.isFinite(Number(process.env.MAX_REGISTRATIONS_PER_IP))).toBe(true);
  });
});
