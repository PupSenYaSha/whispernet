import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { makeDevice, publish, sealToEach, openAsRecipient, resetFanoutDevices, type TestDevice } from '../helpers-fanout';

/**
 * One message, every device it should reach.
 *
 * The shape this app used to send was one ratchet body for the recipient plus a copy of the same words
 * under a stateless envelope wrapped to a long-lived account key, so that the sender's other devices
 * could read it. That second copy was the weakness: it travelled on every message, so an operator
 * seizing the server opened the whole history regardless of what the ratchet had achieved, and forward
 * secrecy held only for whichever copy the recipient happened to read.
 *
 * Signal has no such copy. Every device publishes its own bundle, a sender builds a session with each
 * and seals a separate body for each, and a second screen of your own account is simply another device
 * to seal for. Nothing is shared between a phone and a laptop, so compromising one does not open the
 * other - and there is no long-lived key anywhere in the path for a seized server to use.
 *
 * These run against the real server, because the failure worth catching is not in the cipher. It is the
 * server handing a body to the wrong device, which looks from the inside exactly like a key that stopped
 * working and is very hard to tell apart.
 */

let server: StartedServer;
const sockets: TestClient[] = [];

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  for (const s of sockets) { try { s.ws.close(); } catch { /* already gone */ } }
  await server.stop();
});

// The managers share one storage key and save on a timer, so one test's sessions would land in the
// next one's. Without this the file fails in a full run and passes on its own, which is the worst
// possible combination.
afterEach(() => resetFanoutDevices());

function socket(label: string): TestClient {
  const c = new TestClient(server.url, label);
  sockets.push(c);
  return c;
}

/**
 * A second device of an account that already exists.
 *
 * Takes the device rather than making one, because the device has to be the same object the test later
 * reads with: answering a handshake needs the private half of the one-time prekey *this* device
 * published, and a device built here and thrown away would leave the test unable to open anything.
 */
async function signInMore(client: TestClient, nickname: string, device: TestDevice): Promise<string> {
  const again = await client.login(nickname, {
    deviceId: device.deviceId,
    preKeyBundle: publish(device),
    identityKey: device.accountKey,
  });
  expect(again.type).toBe('auth_success');
  return again.payload.userId;
}

/** What the server will hand a sender for one account: one entry per device. */
async function publishedBundles(from: TestClient, userId: string): Promise<{ deviceId: string; bundle: any }[]> {
  from.clear();
  from.send('prekey_fetch', { userIds: [userId] });
  const res = await from.waitFor('prekey_bundles', 4000);
  return res.payload.bundles[userId] || [];
}

describe('a message that reaches several devices', () => {
  it('keeps one bundle per device, so signing in does not unpublish the other device', async () => {
    const first = socket('duo-phone');
    const nickname = uniqueNick('duo');
    const accountKey = 'acct-duo-alpha';
    const phone = await makeDevice('phone', accountKey);
    const reg = await first.register(nickname, { deviceId: 'phone', preKeyBundle: publish(phone), identityKey: accountKey });
    const userId = reg.payload.userId;

    const laptop = await makeDevice('laptop', accountKey);
    await signInMore(socket('duo-laptop'), nickname, laptop);
    void laptop;

    const bundles = await publishedBundles(first, userId);
    expect(bundles.map((b) => b.deviceId).sort()).toEqual(['laptop', 'phone']);
    // and they are genuinely different material: two devices, two ratchet identities
    expect(bundles[0].bundle.identityKey).not.toBe(bundles[1].bundle.identityKey);
  });

  it('delivers a body to each device and only the one that device can open', async () => {
    const accountKey = 'acct-duo-beta';
    const nickname = uniqueNick('duo2');
    const phoneSock = socket('beta-phone');
    const phone = await makeDevice('phone', accountKey);
    const reg = await phoneSock.register(nickname, { deviceId: 'phone', preKeyBundle: publish(phone), identityKey: accountKey });
    const laptopSock = socket('beta-laptop');
    const laptop = await makeDevice('laptop', accountKey);
    await signInMore(laptopSock, nickname, laptop);

    const senderAccount = 'sender-beta';
    const senderDevice = await makeDevice('sender-device', senderAccount);
    const senderSock = socket('beta-sender');
    await senderSock.register(uniqueNick('senderbeta'), {
      deviceId: 'sender-device',
      preKeyBundle: publish(senderDevice),
      identityKey: senderAccount,
    });

    const targets = await publishedBundles(senderSock, reg.payload.userId);
    expect(targets.length).toBe(2);

    const bodies = await sealToEach(senderDevice, senderAccount, targets, 'one message, two screens');
    expect(bodies.length).toBe(2);

    for (const s of [senderSock, phoneSock, laptopSock]) s.clear();
    senderSock.send('dm_send', {
      to: reg.payload.userId,
      text: '',
      clientId: 'fanoutmessage0001',
      encrypted: { kind: 'devices', bodies },
    });

    const forPhone = await phoneSock.waitFor('dm_message', 4000);
    const forLaptop = await laptopSock.waitFor('dm_message', 4000);

    // routed, not broadcast: each device is handed the one body sealed for it rather than the whole
    // fan-out, so neither ever has to try - and fail - to open something meant for the other
    expect(forPhone.payload.encrypted.kind).toBe('ratchet');
    expect(forLaptop.payload.encrypted.kind).toBe('ratchet');
    expect(forPhone.payload.isOwn).toBe(false);
    expect(forPhone.payload.encrypted.ciphertext).not.toBe(forLaptop.payload.encrypted.ciphertext);

    // and each one really does open on the device it was sealed for
        expect(await openAsRecipient(phone, accountKey, senderAccount, forPhone.payload.encrypted))
      .toBe('one message, two screens');
    expect(await openAsRecipient(laptop, accountKey, senderAccount, forLaptop.payload.encrypted))
      .toBe('one message, two screens');
  });

  it('opens on the device it was sealed for and on no other', async () => {
    const accountKey = 'acct-duo-gamma';
    const nickname = uniqueNick('duog');
    const phoneSock = socket('gamma-phone');
    const phone = await makeDevice('phone', accountKey);
    const reg = await phoneSock.register(nickname, { deviceId: 'phone', preKeyBundle: publish(phone), identityKey: accountKey });
    const laptopSock = socket('gamma-laptop');
    const laptop = await makeDevice('laptop', accountKey);
    await signInMore(laptopSock, nickname, laptop);

    const senderAccount = 'sender-gamma';
    const senderDevice = await makeDevice('sender-device', senderAccount);
    const senderSock = socket('gamma-sender');
    await senderSock.register(uniqueNick('sendergamma'), {
      deviceId: 'sender-device',
      preKeyBundle: publish(senderDevice),
      identityKey: senderAccount,
    });

    const targets = await publishedBundles(senderSock, reg.payload.userId);
    const bodies = await sealToEach(senderDevice, senderAccount, targets, 'private words');

    for (const s of [senderSock, phoneSock, laptopSock]) s.clear();
    senderSock.send('dm_send', {
      to: reg.payload.userId,
      text: '',
      clientId: 'fanoutmessage0002',
      encrypted: { kind: 'devices', bodies },
    });

    const phoneFrame = await phoneSock.waitFor('dm_message', 4000);
    const laptopFrame = await laptopSock.waitFor('dm_message', 4000);

    // a separate ciphertext per device: the same words, sealed to keys that do not open each other
    expect(phoneFrame.payload.encrypted.ciphertext).not.toBe(laptopFrame.payload.encrypted.ciphertext);

        const phoneText = await openAsRecipient(phone, accountKey, senderAccount, phoneFrame.payload.encrypted);
    expect(phoneText).toBe('private words');

    const laptopText = await openAsRecipient(laptop, accountKey, senderAccount, laptopFrame.payload.encrypted);
    expect(laptopText).toBe('private words');

    // and the body meant for the laptop does not open on the phone, which is the property a session shared
    // between two devices would have destroyed: taking the phone would have opened the laptop too
    const crossed = await openAsRecipient(
      phone, accountKey, senderAccount, laptopFrame.payload.encrypted, true,
    );
    expect(crossed).toBeNull();
  });

  it('carries no body to a device the sender did not seal for', async () => {
    const a = socket('unrelated-a');
    const reg = await a.register(uniqueNick('unrelated'), { deviceId: 'unrelated', preKeyBundle: { version: 2 } });
    const b = socket('unrelated-b');
    await b.register(uniqueNick('unrelatedb'), { deviceId: 'unrelatedb', preKeyBundle: { version: 2 } });

    b.clear();
    a.clear();
    b.send('dm_send', {
      to: reg.payload.userId,
      text: '',
      clientId: 'unrelatedbody001',
      encrypted: {
        kind: 'devices',
        bodies: [{ deviceId: 'somebody-elses-phone', body: { kind: 'ratchet', ciphertext: 'AAAA', ratchetPublicKey: 'BBBB', messageNumber: 0 } }],
      },
    });

    // the frame still arrives, so the conversation is not silently missing a message - but it carries
    // nothing this device can open, which is a different and much more honest thing than a blob that
    // sits there reading "encrypted" forever
    const got = await a.waitFor('dm_message', 4000);
    expect(got.payload.id).toBeTruthy();
    expect(got.payload.encrypted).toBeNull();
  });

  it('refuses a fan-out with nothing in it', async () => {
    const a = socket('empty-a');
    const reg = await a.register(uniqueNick('empty'), { deviceId: 'empty', preKeyBundle: { version: 2 } });
    const b = socket('empty-b');
    await b.register(uniqueNick('emptyb'), { deviceId: 'emptyb', preKeyBundle: { version: 2 } });

    b.clear();
    a.clear();
    b.send('dm_send', { to: reg.payload.userId, text: '', encrypted: { kind: 'devices', bodies: [] } });
    const err = await b.waitFor('error', 4000);
    // an empty fan-out is a message addressed to nobody, and it is refused rather than stored: what the
    // recipient would see is a delivered message with nothing in it, which is the one shape of silence
    // this cannot have
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
    expect(await a.waitFor('dm_message', 600)).toBeNull();
  });

  it('refuses two bodies for one device', async () => {
    const a = socket('dupe-a');
    const reg = await a.register(uniqueNick('dupe'), { deviceId: 'dupe', preKeyBundle: { version: 2 } });
    const b = socket('dupe-b');
    await b.register(uniqueNick('dupeb'), { deviceId: 'dupeb', preKeyBundle: { version: 2 } });

    b.clear();
    b.send('dm_send', {
      to: reg.payload.userId,
      text: '',
      encrypted: {
        kind: 'devices',
        bodies: [
          { deviceId: 'same', body: { kind: 'ratchet', ciphertext: 'AA', ratchetPublicKey: 'BB', messageNumber: 0 } },
          { deviceId: 'same', body: { kind: 'ratchet', ciphertext: 'CC', ratchetPublicKey: 'DD', messageNumber: 0 } },
        ],
      },
    });
    const err = await b.waitFor('error', 4000);
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
  });

  it('refuses a body that is not one it could have been sent', async () => {
    const a = socket('smuggle-a');
    const reg = await a.register(uniqueNick('smuggle'), { deviceId: 'smuggle', preKeyBundle: { version: 2 } });
    const b = socket('smuggle-b');
    await b.register(uniqueNick('smuggleb'), { deviceId: 'smuggleb', preKeyBundle: { version: 2 } });

    b.clear();
    b.send('dm_send', {
      to: reg.payload.userId,
      text: '',
      encrypted: {
        kind: 'devices',
        // a key where a ciphertext belongs, smuggled past the per-body check by the wrapper
        bodies: [{ deviceId: 'phone', body: { kind: 'ratchet', privateKey: 'AAAA', ratchetPublicKey: 'BB', messageNumber: 0 } }],
      },
    });
    const err = await b.waitFor('error', 4000);
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
  });

  it('does not let a second device move the account identity key', async () => {
    const first = socket('acct-1');
    const nickname = uniqueNick('acct');
    const accountKey = 'the-account-identity-key';
    const reg = await first.register(nickname, { deviceId: 'acct-1', preKeyBundle: { version: 2 }, identityKey: accountKey });
    expect(reg.payload.identityKeys[reg.payload.userId]).toBe(accountKey);

    // a second screen of the same account, arriving with a different key and expecting to be believed
    const second = socket('acct-2');
    const secondDevice = await makeDevice('acct-2', 'a-different-key');
    const again = await second.login(nickname, {
      deviceId: 'acct-2',
      preKeyBundle: publish(secondDevice),
      identityKey: 'a-different-key',
    });
    expect(again.type).toBe('auth_success');
    expect(await publishedIdentityKey(second, again.payload.userId)).toBe(accountKey);
  });
});

/** The account-level identity key the server reports, which is what a safety number is built from. */
async function publishedIdentityKey(client: TestClient, userId: string): Promise<string | null> {
  client.clear();
  client.send('prekey_fetch', { userIds: [userId] });
  const res = await client.waitFor('prekey_bundles', 4000);
  return res.payload.identityKeys?.[userId] ?? null;
}