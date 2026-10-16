import { describe, it, expect, afterEach } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * The address budget has to outlive the process, same as the device one.
 *
 * Kept in its own file purely for a harness reason, and the reason is worth recording: the ceilings are
 * read from the environment when the module first loads, so a file can only ever exercise whichever scope
 * it set up first. Folded into the device test this would have looked covered while running against a
 * cap of a thousand, which is the sort of test that passes forever without checking anything.
 *
 * The address limit is the weaker of the two - one address is shared by an office, a school or a mobile
 * carrier, and behind CGNAT it is a rotating pool - but it is still the backstop against a single host
 * filling the users table, and it still has to survive a deploy.
 */

const IP_CAP = 2;
let server: StartedServer | null = null;
const clients: TestClient[] = [];

const ENV = {
  MAX_REGISTRATIONS_PER_IP: String(IP_CAP),
  // Generous, so nothing here can be refused for the device instead - which would make the assertion pass
  // for the wrong reason.
  MAX_ACCOUNTS_PER_DEVICE: '1000',
  DISABLE_RATE_LIMITS: '0',
};

async function registerOn(srv: StartedServer, ip: string, deviceId: string): Promise<{ type: string; reason?: string }> {
  const c = new TestClient(srv.url, 'persist-ip');
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  const res = await c.register(uniqueNick('persistip'), { deviceId });
  c.close();
  return { type: res.type, reason: res.payload?.reason };
}

afterEach(async () => {
  clients.forEach((c) => c.close());
  clients.length = 0;
  if (server) { await server.stop({ keepData: true }); server = null; }
});

describe('the address budget across a restart', () => {
  it('still refuses an account the previous process refused', async () => {
    server = await startTestServer(ENV);
    const dataDir = server.dataDir;

    for (let i = 0; i < IP_CAP; i++) {
      expect((await registerOn(server, '198.51.100.2', `dev-a-${i}`)).type, `account ${i + 1}`).toBe('auth_success');
    }
    const before = await registerOn(server, '198.51.100.2', 'dev-a-2');
    expect(before.type).toBe('auth_failure');
    expect(before.reason).toMatch(/Too many accounts created from this network/);

    await server.stop({ keepData: true });
    server = null;
    server = await startTestServer(ENV, { dataDir });

    // A different device, so only the address can be what refuses it now.
    const afterRestart = await registerOn(server, '198.51.100.2', 'dev-a-3');
    expect(afterRestart.type, 'the address budget reset on restart').toBe('auth_failure');
    expect(afterRestart.reason).toMatch(/Too many accounts created from this network/);
  }, 60000);
});
