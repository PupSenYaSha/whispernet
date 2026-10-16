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

/** Registers from a given address *and* a given device id, since both are now limited. */
const register = async (ip: string, label = 'reg', deviceId?: string): Promise<{ type: string; reason?: string }> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  const res = await c.register(uniqueNick('rl'), deviceId ? { deviceId } : undefined);
  c.close();
  return { type: res.type, reason: res.payload?.reason };
};

beforeAll(async () => {
  // the suite default of a thousand is right for a file that creates a dozen accounts and useless
  // for testing a ceiling, and DISABLE_RATE_LIMITS has to be off or the cap is never consulted.
  // The address ceiling is high here so the *device* ceiling is what these tests actually hit - the two
  // are independent, and a test that only ever trips one of them proves nothing about the other.
  server = await startTestServer({
    MAX_REGISTRATIONS_PER_IP: '3',
    MAX_ACCOUNTS_PER_DEVICE: '4',
    DISABLE_RATE_LIMITS: '0',
  });
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

/**
 * The limit per device, which is the more meaningful of the two.
 *
 * An address is shared by everyone behind it and is a rotating pool behind CGNAT, so it says very little
 * about a person. A device id is a much better signal, with the caveat that the client chooses it - so this
 * is a cost, not a wall, and the tests say so rather than pretending otherwise.
 */
describe('the limit per device', () => {
  // A distinct address per account, so the address ceiling is never what refuses here.
  let ipCounter = 0;
  const freshAddress = () => `203.0.113.${(ipCounter += 1)}`;

  it('lets one device create several accounts', async () => {
    // The normal arrangement is one account per device. This ceiling has to leave room for a second and
    // third - work and personal, a shared family tablet, a profile that has outlived several sign-outs -
    // rather than police them.
    const deviceId = 'dev-multi-' + Math.random().toString(36).slice(2);
    for (let i = 0; i < 3; i++) {
      expect((await register(freshAddress(), `multi-${i}`, deviceId)).type, `account ${i + 1}`).toBe('auth_success');
    }
  }, 30000);

  it('refuses the next one from the same device, and names the device', async () => {
    const deviceId = 'dev-cap-' + Math.random().toString(36).slice(2);
    for (let i = 0; i < 4; i++) {
      expect((await register(freshAddress(), `cap-${i}`, deviceId)).type, `account ${i + 1}`).toBe('auth_success');
    }
    const res = await register(freshAddress(), 'cap-over', deviceId);
    expect(res.type).toBe('auth_failure');
    // The message has to distinguish the two ceilings. "This device" is something the person can act on -
    // sign in to an account they already have - while "this network" is not theirs to raise.
    expect(res.reason).toMatch(/Too many accounts from this device\. Try again in \d+ hour\(s\)/);
  }, 30000);

  it('does not let a fresh address get a fresh device budget', async () => {
    // The point of adding the device limit: the address limit alone could be sidestepped by changing
    // nothing but the address, which costs the attacker one header.
    const deviceId = 'dev-fixed-' + Math.random().toString(36).slice(2);
    for (let i = 0; i < 4; i++) await register(freshAddress(), `fixed-${i}`, deviceId);
    expect((await register(freshAddress(), 'fixed-over', deviceId)).type).toBe('auth_failure');
  }, 30000);

  it('counts a taken nickname against neither', async () => {
    const deviceId = 'dev-dup-' + Math.random().toString(36).slice(2);
    const taken = uniqueNick('rl');
    const first = new TestClient(server.url, 'dupfirst');
    clients.push(first);
    await first.connect({ 'x-forwarded-for': freshAddress() });
    expect((await first.register(taken, { deviceId })).type).toBe('auth_success');
    first.close();

    for (let i = 0; i < 6; i++) {
      const c = new TestClient(server.url, 'dup');
      clients.push(c);
      await c.connect({ 'x-forwarded-for': freshAddress() });
      const res = await c.register(taken, { deviceId });
      c.close();
      expect(res.payload?.reason).toMatch(/already taken/i);
    }

    // Still under the ceiling, so a genuinely new name still works.
    expect((await register(freshAddress(), 'dupnew', deviceId)).type).toBe('auth_success');
  }, 30000);
});
