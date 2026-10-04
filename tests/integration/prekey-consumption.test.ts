import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * A one-time prekey that gets handed out twice is not a one-time prekey.
 *
 * X3DH mixes the responder's one-time prekey into the shared secret. Serve the same one to a second sender
 * and the responder's private half goes into both secrets — so a device compromised later opens every one
 * of those sessions, not only the ones after the compromise. That is the whole reason the key is called
 * one-time, and it is why the server has to remember what it has already given away rather than trusting
 * the device to republish in time.
 *
 * The server did not remember. It served the stored bundle unchanged to every sender until the device
 * happened to upload a new one, and the table that recorded issuance had been dropped.
 */

let server: StartedServer;
const clients: TestClient[] = [];

const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

/** A bundle shaped like the real thing, with one one-time prekey in it. */
const bundle = (opkId: number) => ({
  version: 2,
  identityKey: Buffer.from('identity-key-material-00000000000').toString('base64'),
  ed25519PublicKey: Buffer.from('ed25519-key-material-000000000').toString('base64'),
  signedPreKey: {
    keyId: 1,
    publicKey: Buffer.from('signed-prekey-material-000000000').toString('base64'),
    signature: [1, 2, 3],
    createdAt: 1700000000000,
  },
  oneTimePreKey: { keyId: opkId, publicKey: Buffer.from('one-time-prekey-material-00000').toString('base64') },
});

async function fetchOpk(as: TestClient, targetId: string, deviceId: string): Promise<any | null> {
  as.clear();
  as.send('prekey_fetch', { userIds: [targetId] });
  const res = await as.waitFor('prekey_bundles', 4000);
  const entry = (res.payload.bundles[targetId] || []).find((b: any) => b.deviceId === deviceId);
  return entry?.bundle?.oneTimePreKey ?? null;
}

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('a one-time prekey', () => {
  it('is not handed to a second sender', async () => {
    const owner = await client('opk-owner');
    const nick = uniqueNick('opkowner');
    const reg = await owner.register(nick, { deviceId: 'opk-dev', preKeyBundle: bundle(1) });
    expect(reg.type).toBe('auth_success');

    const first = await client('opk-first');
    await first.register(uniqueNick('opkfirst'), { deviceId: 'f1', preKeyBundle: bundle(1) });
    const second = await client('opk-second');
    await second.register(uniqueNick('opksecond'), { deviceId: 'f2', preKeyBundle: bundle(1) });

    const gotFirst = await fetchOpk(first, reg.payload.userId, 'opk-dev');
    expect(gotFirst, 'the first sender got nothing to work with').toBeTruthy();
    expect(gotFirst.keyId).toBe(1);

    const gotSecond = await fetchOpk(second, reg.payload.userId, 'opk-dev');
    // this is the failure: the same key, offered to the next sender
    expect(gotSecond, 'the same one-time prekey was served to a second sender').toBeNull();
  });

  it('still starts a session once they run out, because X3DH does not require the one-time key', async () => {
    // refusing to answer would be worse than answering with less protection: the conversation would simply
    // not happen. The identity and signed prekeys are enough on their own.
    const owner = await client('opk-exhaust-owner');
    const nick = uniqueNick('opkexhaust');
    const reg = await owner.register(nick, { deviceId: 'ex-dev', preKeyBundle: bundle(1) });
    expect(reg.type).toBe('auth_success');

    const first = await client('opk-ex-1');
    await first.register(uniqueNick('opkex1'), { deviceId: 'e1', preKeyBundle: bundle(1) });
    const second = await client('opk-ex-2');
    await second.register(uniqueNick('opkex2'), { deviceId: 'e2', preKeyBundle: bundle(1) });

    expect(await fetchOpk(first, reg.payload.userId, 'ex-dev')).toBeTruthy();

    second.clear();
    second.send('prekey_fetch', { userIds: [reg.payload.userId] });
    const res = await second.waitFor('prekey_bundles', 4000);
    const entry = (res.payload.bundles[reg.payload.userId] || []).find((b: any) => b.deviceId === 'ex-dev');

    // the rest of the bundle is intact and usable
    expect(entry).toBeTruthy();
    expect(entry.bundle.identityKey).toBeTruthy();
    expect(entry.bundle.signedPreKey.keyId).toBe(1);
    expect(entry.bundle.oneTimePreKey).toBeUndefined();
  });

  it('is offered again once the device publishes a fresh bundle', async () => {
    // keys get replenished on a schedule, so a spent id must not poison the ids that replace it
    const owner = await client('opk-refill-owner');
    const nick = uniqueNick('opkrefill');
    const reg = await owner.register(nick, { deviceId: 'ref-dev', preKeyBundle: bundle(1) });
    expect(reg.type).toBe('auth_success');

    const first = await client('opk-refill-1');
    await first.register(uniqueNick('opkrefill1'), { deviceId: 'r1', preKeyBundle: bundle(1) });
    expect(await fetchOpk(first, reg.payload.userId, 'ref-dev')).toBeTruthy();

    const second = await client('opk-refill-2');
    await second.register(uniqueNick('opkrefill2'), { deviceId: 'r2', preKeyBundle: bundle(1) });
    expect(await fetchOpk(second, reg.payload.userId, 'ref-dev')).toBeNull();

    // the device replenishes and republishes, with a new id
    owner.clear();
    owner.send('prekey_upload', { deviceId: 'ref-dev', bundle: bundle(2) });
    await owner.waitFor('prekey_uploaded', 4000);

    const third = await client('opk-refill-3');
    await third.register(uniqueNick('opkrefill3'), { deviceId: 'r3', preKeyBundle: bundle(1) });
    const refilled = await fetchOpk(third, reg.payload.userId, 'ref-dev');
    expect(refilled, 'a fresh bundle was not offered after the device replenished').toBeTruthy();
    expect(refilled.keyId).toBe(2);
  });

  it('keys what it has spent per device, not per account', async () => {
    // One fetch legitimately takes one key from each of the account's devices, because a sender about to
    // write to a phone and a laptop needs one for each. What must not happen is the phone's key being
    // spent marking the laptop's as spent too - they are different devices holding different keys that
    // happen to share an id.
    const owner = await client('opk-multi-owner');
    const nick = uniqueNick('opkmulti');
    const reg = await owner.register(nick, { deviceId: 'phone', preKeyBundle: bundle(1) });

    const laptop = await client('opk-multi-laptop');
    const lap = await laptop.login(nick, { deviceId: 'laptop', preKeyBundle: bundle(1) });
    expect(lap.type, `the laptop could not sign in: ${JSON.stringify(lap.payload)}`).toBe('auth_success');

    // a sender who wants only the phone takes only the phone's key
    const phoneOnly = await client('opk-multi-s1');
    await phoneOnly.register(uniqueNick('opkmultis1'), { deviceId: 'm1', preKeyBundle: bundle(1) });
    phoneOnly.clear();
    phoneOnly.send('prekey_fetch', { userIds: [reg.payload.userId] });
    const both = await phoneOnly.waitFor('prekey_bundles', 4000);
    const phoneEntry = (both.payload.bundles[reg.payload.userId] || []).find((b: any) => b.deviceId === 'phone');
    const laptopEntry = (both.payload.bundles[reg.payload.userId] || []).find((b: any) => b.deviceId === 'laptop');
    expect(phoneEntry.bundle.oneTimePreKey).toBeTruthy();
    expect(laptopEntry.bundle.oneTimePreKey, 'the laptop key went unspent on the same fetch')
      .toBeTruthy();

    // and now both are spent, independently — neither device's key is handed out again
    const later = await client('opk-multi-s2');
    await later.register(uniqueNick('opkmultis2'), { deviceId: 'm2', preKeyBundle: bundle(1) });
    expect(await fetchOpk(later, reg.payload.userId, 'phone')).toBeNull();
    expect(await fetchOpk(later, reg.payload.userId, 'laptop')).toBeNull();
  });

  it('spends nothing when a device asks for its own bundles', async () => {
    // Sign-in hands a client the list of its own devices so it can seal a copy to its other screens. A
    // client that then asks over the wire is not opening a session with itself, and treating that as one
    // would burn a one-time prekey per device — draining the supply of an account that never had many.
    const owner = await client('opk-self-owner');
    const nick = uniqueNick('opkself');
    const reg = await owner.register(nick, { deviceId: 'self-dev', preKeyBundle: bundle(1) });
    expect(reg.type).toBe('auth_success');

    const other = await client('opk-self-other');
    await other.register(uniqueNick('opkselfother'), { deviceId: 'so', preKeyBundle: bundle(1) });

    // twice, because that is what a client refreshing its own list would do
    expect(await fetchOpk(owner, reg.payload.userId, 'self-dev'), 'a self-fetch spent the key').toBeTruthy();
    expect(await fetchOpk(owner, reg.payload.userId, 'self-dev'), 'a second self-fetch spent the key').toBeTruthy();

    // and a genuine sender still finds one waiting
    expect(await fetchOpk(other, reg.payload.userId, 'self-dev'), 'the self-fetch drained the supply').toBeTruthy();
  });
});