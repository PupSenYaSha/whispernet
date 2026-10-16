import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * The device budget has to outlive the process.
 *
 * Account creation limits used to be a Map in memory, so every restart handed everybody a fresh allowance.
 * That is not an exotic attack to arrange: a deploy does it, an OOM kill does it, a crash does it. The limit
 * was quietly ineffective between restarts and nobody had to do anything deliberate for it to stop working,
 * which is why it went unnoticed.
 *
 * So this file does the one thing the old implementation could not survive - stop the server, start a new
 * one against the same files, and check the account that was refused is still refused.
 *
 * Separate from its address-budget twin on purpose. The ceilings are read from the environment when the
 * module first loads, so one file can only ever test whichever scope it set up first; putting both in one
 * file would silently leave the second one untested against a cap of a thousand.
 */

const CAP = 2;
let server: StartedServer | null = null;
const clients: TestClient[] = [];

const ENV = {
  MAX_REGISTRATIONS_PER_IP: '1000',
  MAX_ACCOUNTS_PER_DEVICE: String(CAP),
  DISABLE_RATE_LIMITS: '0',
};

async function registerOn(srv: StartedServer, ip: string, deviceId: string): Promise<{ type: string; reason?: string }> {
  const c = new TestClient(srv.url, 'persist');
  clients.push(c);
  await c.connect({ 'x-forwarded-for': ip });
  const res = await c.register(uniqueNick('persist'), { deviceId });
  c.close();
  return { type: res.type, reason: res.payload?.reason };
}

afterEach(async () => {
  clients.forEach((c) => c.close());
  clients.length = 0;
  if (server) { await server.stop({ keepData: true }); server = null; }
});

describe('the device budget across a restart', () => {
  it('still refuses an account the previous process refused', async () => {
    const deviceId = 'dev-persist';
    server = await startTestServer(ENV);
    const dataDir = server.dataDir;

    for (let i = 0; i < CAP; i++) {
      expect((await registerOn(server, '198.51.100.1', deviceId)).type, `account ${i + 1}`).toBe('auth_success');
    }
    expect((await registerOn(server, '198.51.100.1', deviceId)).type).toBe('auth_failure');

    // Restart against the same directory. Everything the old process knew from memory is gone.
    await server.stop({ keepData: true });
    server = null;
    expect(fs.existsSync(dataDir), 'the data directory should have survived').toBe(true);
    server = await startTestServer(ENV, { dataDir });

    const afterRestart = await registerOn(server, '198.51.100.1', deviceId);
    expect(
      afterRestart.type,
      'the restart handed the device a fresh allowance, so the limit did not survive the process',
    ).toBe('auth_failure');
    expect(afterRestart.reason).toMatch(/Too many accounts from this device/);
  }, 60000);

  it('leaves a device that was under its budget unaffected by a restart', async () => {
    // The other direction, and the one that would catch a fix which simply refuses everybody: a restart
    // must not cost an account that was still inside the allowance.
    const dataDir = server ? server.dataDir : fs.mkdtempSync(path.join(os.tmpdir(), 'wn-persist-'));
    server = await startTestServer(ENV, { dataDir });
    const deviceId = 'dev-fresh';
    await registerOn(server, '198.51.100.5', deviceId);

    await server.stop({ keepData: true });
    server = null;
    server = await startTestServer(ENV, { dataDir });

    expect((await registerOn(server, '198.51.100.5', deviceId)).type).toBe('auth_success');
  }, 60000);
});
