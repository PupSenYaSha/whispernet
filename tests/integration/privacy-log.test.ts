import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * What the operator is allowed to keep about who used the server.
 *
 * A module existed for this - a daily-rotating pseudonym for an address, a coarse label for a device -
 * and was described in the documentation. It was never called: every entry went to disk with the
 * caller's real address in it, and the sessions table held the full user agent. These are integration
 * tests rather than unit tests on purpose. The unit test for that module passes, and passes happily,
 * while the module sits unused - which is exactly the failure this is here to catch.
 */

let server: StartedServer;
const clients: TestClient[] = [];

afterAll(async () => {
  for (const c of clients) c.close();
  await server?.stop();
});

async function client(label: string) {
  const c = new TestClient(server.url, label);
  clients.push(c);
  await c.connect();
  return c;
}

function securityLog(): string {
  const file = path.join(server.dataDir, 'security.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function dbFile(): Buffer {
  return fs.readFileSync(path.join(server.dataDir, 'whispernet.db'));
}

describe('what the operator is left holding', () => {
  it('never writes a raw address into the security log', async () => {
    server = await startTestServer();
    const a = await client('privacy-a');
    const nick = uniqueNick('pv');
    await a.register(nick);
    a.close();
    // sign-in is the event that is written down, so this is the one to look at
    const b = new TestClient(server.url, 'privacy-b');
    clients.push(b);
    await b.connect();
    await b.login(nick);
    await new Promise((r) => setTimeout(r, 300));

    const log = securityLog();
    expect(log.length).toBeGreaterThan(0);
    // every connection in a test arrives from loopback, so this is the address that would be written
    expect(log).not.toContain('127.0.0.1');
    expect(log).not.toContain('::ffff:127.0.0.1');
    // and something was actually recorded, so the assertion is not passing on an empty file
    expect(log).toContain('LOGIN_SUCCESS');
  }, 60000);

  it('never writes a raw user agent into the sessions table', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const b = new TestClient(server.url, 'privacy-ua');
    clients.push(b);
    await b.connect();
    await b.register(uniqueNick('ua'), { deviceInfo: ua });
    await new Promise((r) => setTimeout(r, 300));

    // the raw string is not in the database file, not even as a fragment of the version numbers
    const raw = dbFile().toString('latin1');
    expect(raw).not.toContain('AppleWebKit');
    expect(raw).not.toContain('Chrome/120.0.0.0');
  }, 60000);

  it('keeps the device a session is shown as recognisable after coarsening', async () => {
    const c = await client('privacy-sessions');
    const nick = uniqueNick('coarse');
    await c.register(nick, { deviceInfo: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/121.0.0.0 Safari/537.36' });
    await new Promise((r) => setTimeout(r, 200));
    c.clear();
    c.send('get_sessions', {});
    const list = await c.waitFor('sessions_list');
    const current = (list.payload.sessions || []).find((s: any) => s.current);
    // the account owner still has to be able to tell their own devices apart
    expect(current).toBeTruthy();
    expect(current.name).toMatch(/Chrome/i);
    // the version is what would identify one machine rather than a browser family
    expect(current.name).not.toMatch(/\d+\.\d+/);
  }, 60000);

  it('does not hand one account the public key of every other account', async () => {
    const c = await client('privacy-keys');
    for (let i = 0; i < 3; i++) {
      const other = await client('privacy-keys-other-' + i);
      await other.register(uniqueNick('dir' + i), {
        publicKey: { kty: 'RSA', alg: 'RSA-OAEP-256', n: 'x'.repeat(340), e: 'AQAB' },
      });
    }
    const me = uniqueNick('me');
    const mine = await c.register(me, {
      publicKey: { kty: 'RSA', alg: 'RSA-OAEP-256', n: 'y'.repeat(340), e: 'AQAB' },
    });
    await new Promise((r) => setTimeout(r, 300));

    const keys = c.logs.filter((m) => m.type === 'auth_success').pop()?.payload?.publicKeys || {};
    // only this account's own key travels at sign-in
    expect(Object.keys(keys)).toEqual([mine.payload.userId]);
  }, 90000);
});
