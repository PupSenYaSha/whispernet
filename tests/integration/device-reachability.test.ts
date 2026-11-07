import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * A device that stays connected must not quietly stop being reachable.
 *
 * The server drops a published bundle thirty days after it was uploaded. The client published once, at
 * sign-in, and never again — so a desktop that was simply never closed, which is the ordinary case, had
 * its bundle deleted out from under it while it was still connected and still sending heartbeats. Senders
 * found no bundle, built no ratchet session, and every message to that device degraded to the
 * long-lived envelope. The device was online the whole time.
 *
 * The other half: a device that reinstalls gets a new *device* identity key, and the conversation resets
 * its session because the pinned key no longer matches. It must not also cost the contact their verified
 * mark — that mark is held against the account key, which survives, and clearing it would be the app
 * telling people to distrust a contact who did nothing.
 */

let server: StartedServer;
const clients: TestClient[] = [];

const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

const bundle = (opkId: number, identity = 'stable-identity-key') => ({
  version: 2,
  identityKey: Buffer.from(identity.padEnd(32, '0').slice(0, 32)).toString('base64'),
  ed25519PublicKey: Buffer.from('ed25519-material-00000000000000').toString('base64'),
  signedPreKey: {
    keyId: 1,
    publicKey: Buffer.from('signed-prekey-material-000000000').toString('base64'),
    signature: [1, 2, 3],
    createdAt: 1700000000000,
  },
  oneTimePreKey: { keyId: opkId, publicKey: Buffer.from('one-time-prekey-material-00000').toString('base64') },
});

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('a device that is still connected', () => {
  it('keeps a fresh bundle on the server after republishing', async () => {
    // the re-upload path itself, since the interval that calls it is what makes this true over time
    const device = await client('keepalive-dev');
    const nick = uniqueNick('keepalive');
    const reg = await device.register(nick, { deviceId: 'ka-dev', preKeyBundle: bundle(1), identityKey: 'acct-ka' });
    expect(reg.type).toBe('auth_success');

    const peer = await client('keepalive-peer');
    await peer.register(uniqueNick('keepalivepeer'), { deviceId: 'kp', preKeyBundle: bundle(1), identityKey: 'acct-kp' });

    // the device refreshes: same identity key, fresh one-time prekey
    device.clear();
    device.send('prekey_upload', { deviceId: 'ka-dev', bundle: bundle(7) });
    await device.waitFor('prekey_uploaded', 4000);

    peer.clear();
    peer.send('prekey_fetch', { userIds: [reg.payload.userId] });
    const res = await peer.waitFor('prekey_bundles', 4000);
    const entry = (res.payload.bundles[reg.payload.userId] || []).find((b: any) => b.deviceId === 'ka-dev');

    // still reachable, and the new key is the one on offer
    expect(entry, 'a republished bundle left the device unreachable').toBeTruthy();
    expect(entry.bundle.oneTimePreKey?.keyId).toBe(7);
  });

  it('keeps the account identity key across a reinstall', async () => {
    const device = await client('reinstall-dev');
    const nick = uniqueNick('reinstall');
    const reg = await device.register(nick, { deviceId: 'ri-dev', preKeyBundle: bundle(1), identityKey: 'acct-ri' });
    expect(reg.type).toBe('auth_success');
    expect(reg.payload.identityKeys[reg.payload.userId], 'the account key was not published').toBe('acct-ri');

    // wiped and reinstalled: new device identity, new device id, same account
    const again = await client('reinstall-dev-2');
    const back = await again.login(nick, {
      deviceId: 'ri-dev-fresh',
      // a different *device* key, which is what a reinstall produces
      preKeyBundle: bundle(1, 'a-different-device-key'),
      identityKey: 'a-different-key',
    });
    expect(back.type).toBe('auth_success');

    // the account key is what a safety number is derived from, and it did not move — otherwise every
    // contact would read the reinstall as a different person and the verified mark would have to go
    expect(
      back.payload.identityKeys[back.payload.userId],
      'a reinstall moved the account identity key, so the safety number would have changed',
    ).toBe('acct-ri');
  });
});