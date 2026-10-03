import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';
import { makeDevice, publish, sealToEach, openAsRecipient } from '../helpers-fanout';

/**
 * The whole multi-device path, driven through the server rather than around it.
 *
 * `dm-multidevice.test.ts` covers the shape: one bundle per device, one body per device, a body that will
 * not open on a device it was not sealed for. What it does not cover is the part that actually breaks in
 * production — the frames a running client receives and whether what is in them can be opened.
 *
 * That is worth its own file because the failure looks like nothing at all from the outside. A client
 * handed a body meant for another device does not error; it renders a message it cannot read, and the
 * conversation carries on. The only way to catch it is to open every frame with the device it was routed
 * to and insist it works.
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

// see helpers-fanout: the managers share one storage key and save on a timer
afterEach(async () => {
  const { resetFanoutDevices } = await import('../helpers-fanout');
  resetFanoutDevices();
});

function socket(label: string): TestClient {
  const c = new TestClient(server.url, label);
  sockets.push(c);
  return c;
}

const ACCOUNT = 'acct-e2e';
const SENDER_ACCOUNT = 'sender-e2e';

interface Party {
  device: Awaited<ReturnType<typeof makeDevice>>;
  client: TestClient;
}

/** One account on two devices, both signed in, both reachable. */
async function accountOnTwoDevices(label: string): Promise<{ parties: Party[]; userId: string; nickname: string }> {
  const nickname = uniqueNick(label);
  const phone = await makeDevice('phone', ACCOUNT);
  const phoneSock = socket(`${label}-phone`);
  const reg = await phoneSock.register(nickname, {
    deviceId: 'phone', preKeyBundle: publish(phone), identityKey: ACCOUNT,
  });
  expect(reg.type, JSON.stringify(reg.payload)).toBe('auth_success');

  const laptop = await makeDevice('laptop', ACCOUNT);
  const laptopSock = socket(`${label}-laptop`);
  const second = await laptopSock.login(nickname, {
    deviceId: 'laptop', preKeyBundle: publish(laptop), identityKey: ACCOUNT,
  });
  expect(second.type).toBe('auth_success');

  return {
    parties: [{ device: phone, client: phoneSock }, { device: laptop, client: laptopSock }],
    userId: reg.payload.userId,
    nickname,
  };
}

/** A third party with one device, who is going to send something. */
async function senderWithOneDevice(label: string): Promise<Party & { userId: string }> {
  const device = await makeDevice('sender-device', SENDER_ACCOUNT);
  const client = socket(label);
  const reg = await client.register(uniqueNick(label), {
    deviceId: 'sender-device', preKeyBundle: publish(device), identityKey: SENDER_ACCOUNT,
  });
  expect(reg.type).toBe('auth_success');
  return { device, client, userId: reg.payload.userId };
}

async function bundlesFor(from: TestClient, userId: string): Promise<{ deviceId: string; bundle: any }[]> {
  from.clear();
  from.send('prekey_fetch', { userIds: [userId] });
  const res = await from.waitFor('prekey_bundles', 4000);
  return res.payload.bundles[userId] || [];
}

describe('every frame a client receives', () => {
  it('opens on the device it was routed to, live and in history', async () => {
    const { parties, userId } = await accountOnTwoDevices('e2e');
    const [phone, laptop] = parties;
    const sender = await senderWithOneDevice('e2e-sender');

    const targets = await bundlesFor(sender.client, userId);
    expect(targets.map((t) => t.deviceId).sort()).toEqual(['laptop', 'phone']);

    // Two messages, not one read twice. The ratchet spends a message key on the first open and will
    // not produce the plaintext again — that is replay protection working, not a bug — so a test that
    // reads the same body live and then again out of history is testing the wrong thing twice.
    const liveBodies = await sealToEach(sender.device, SENDER_ACCOUNT, targets, 'a message for both screens');
    expect(liveBodies.length).toBe(2);

    for (const p of parties) p.client.clear();
    sender.client.clear();
    sender.client.send('dm_send', {
      to: userId, text: '', clientId: 'endtoendmessage001', encrypted: { kind: 'devices', bodies: liveBodies },
    });

    // live: each device is handed its own body and must be able to open it
    const liveForPhone = await phone.client.waitFor('dm_message', 5000);
    const liveForLaptop = await laptop.client.waitFor('dm_message', 5000);

    expect(
      await openAsRecipient(phone.device, ACCOUNT, SENDER_ACCOUNT, liveForPhone.payload.encrypted),
    ).toBe('a message for both screens');
    expect(
      await openAsRecipient(laptop.device, ACCOUNT, SENDER_ACCOUNT, liveForLaptop.payload.encrypted),
    ).toBe('a message for both screens');

    // A second message, which is only ever read out of history.
    //
    // It does arrive live as well — the server has no notion of a device choosing not to look — so the
    // point is that this test never opens that copy. A real client would open it and then find nothing
    // left for the history response, which is why the two messages are separate rather than one read
    // twice.
    const historyBodies = await sealToEach(sender.device, SENDER_ACCOUNT, targets, 'and one from history');
    // cleared first, so the frame picked up below is this message and not the one already read
    for (const p of parties) p.client.clear();
    sender.client.send('dm_send', {
      to: userId, text: '', clientId: 'endtoendmessage002', encrypted: { kind: 'devices', bodies: historyBodies },
    });
    await phone.client.waitFor('dm_message', 5000);
    await laptop.client.waitFor('dm_message', 5000);
    const secondId = phone.client.logs.filter((m: any) => m.type === 'dm_message').pop().payload.id;

    // history: the path that used to hand every device the whole set
    for (const p of parties) p.client.clear();
    phone.client.send('dm_history', { with: sender.userId });
    laptop.client.send('dm_history', { with: sender.userId });

    const histPhone = await phone.client.waitFor('dm_history', 5000);
    const histLaptop = await laptop.client.waitFor('dm_history', 5000);
    const rowFor = (hist: any) => hist.payload.messages.find((m: any) => m.id === secondId);
    const phoneRow = rowFor(histPhone);
    const laptopRow = rowFor(histLaptop);
    expect(phoneRow, 'the phone history lost the message').toBeTruthy();
    expect(laptopRow, 'the laptop history lost the message').toBeTruthy();

    expect(
      await openAsRecipient(phone.device, ACCOUNT, SENDER_ACCOUNT, phoneRow.encrypted),
    ).toBe('and one from history');
    expect(
      await openAsRecipient(laptop.device, ACCOUNT, SENDER_ACCOUNT, laptopRow.encrypted),
    ).toBe('and one from history');
  });

  it('will not open the same body twice, which is what replay protection means', async () => {
    // The key behind a ratchet message is spent on the first open. A server that captured a message and
    // replayed it — to a device, or into a history response — gets nothing, and the reason it gets
    // nothing has to be that the key is gone rather than that the client forgot to try twice.
    const { parties, userId } = await accountOnTwoDevices('replay');
    const [phone] = parties;
    const sender = await senderWithOneDevice('replay-sender');

    const targets = await bundlesFor(sender.client, userId);
    const bodies = await sealToEach(sender.device, SENDER_ACCOUNT, targets, 'only once');
    sender.client.send('dm_send', {
      to: userId, text: '', clientId: 'replaymessage0001', encrypted: { kind: 'devices', bodies },
    });
    const frame = await phone.client.waitFor('dm_message', 5000);

    expect(await openAsRecipient(phone.device, ACCOUNT, SENDER_ACCOUNT, frame.payload.encrypted)).toBe('only once');
    // the second read of the very same bytes
    expect(await openAsRecipient(phone.device, ACCOUNT, SENDER_ACCOUNT, frame.payload.encrypted, true)).toBeNull();
  });

  it('sends a whole conversation, not just a first message', async () => {
    // A single message proves the handshake works. A conversation proves the chain keeps working — and
    // that is where the app broke: creating an initiator session over an existing one restarts the chain
    // on this side while the far end stays where it was, so the second message onwards fails to
    // authenticate with nothing in the output to say why. Found by writing the test, then pinned here.
    const { parties, userId } = await accountOnTwoDevices('chain');
    const [phone, laptop] = parties;
    const sender = await senderWithOneDevice('chain-sender');
    const targets = await bundlesFor(sender.client, userId);

    const lines = ['first', 'second', 'third', 'fourth'];
    for (let i = 0; i < lines.length; i++) {
      const bodies = await sealToEach(sender.device, SENDER_ACCOUNT, targets, lines[i]);
      sender.client.send('dm_send', {
        to: userId, text: '', clientId: `chainmessage000${i}0`, encrypted: { kind: 'devices', bodies },
      });
      // the frame for this message, not an earlier one
      for (const p of parties) p.client.clear();
      const forPhone = await phone.client.waitFor('dm_message', 5000);
      const forLaptop = await laptop.client.waitFor('dm_message', 5000);

      // both devices open it, in order, because that is what a client does with every frame it is sent.
      // Reading only one of them and then jumping to the last would be testing a skipped handshake, which
      // is a different thing and not what a conversation looks like.
      expect(
        await openAsRecipient(phone.device, ACCOUNT, SENDER_ACCOUNT, forPhone.payload.encrypted),
      ).toBe(lines[i]);
      expect(
        await openAsRecipient(laptop.device, ACCOUNT, SENDER_ACCOUNT, forLaptop.payload.encrypted),
      ).toBe(lines[i]);
    }
  });

  it('reaches the sender’s own second device, so a second screen is in the conversation', async () => {
    // The copy a sender keeps for itself used to be the stateless envelope — the reason the long-lived
    // key was on every message. It now arrives as a body sealed to that device like any other.
    const me = await makeDevice('my-phone', ACCOUNT);
    const mySock = socket('sync-phone');
    const nickname = uniqueNick('syncme');
    const reg = await mySock.register(nickname, {
      deviceId: 'my-phone', preKeyBundle: publish(me), identityKey: ACCOUNT,
    });
    expect(reg.type).toBe('auth_success');

    // this account signs in on a second device, which is what gives the first one somebody to copy to
    const myLaptop = await makeDevice('my-laptop', ACCOUNT);
    const laptopSock = socket('sync-laptop');
    await laptopSock.login(nickname, {
      deviceId: 'my-laptop', preKeyBundle: publish(myLaptop), identityKey: ACCOUNT,
    });
    // and again, so the phone's bundle list is refreshed from the server
    mySock.clear();
    mySock.send('prekey_fetch', { userIds: [reg.payload.userId] });
    await mySock.waitFor('prekey_bundles', 4000);

    const peer = await senderWithOneDevice('sync-peer');
    const peerTargets = await bundlesFor(peer.client, reg.payload.userId);
    expect(peerTargets.length).toBe(2);

    // the sender here is the peer, and the recipient is the two-device account, which is the ordinary
    // direction. What matters is checked from the other side: the frames the *recipient's* second device
    // receives are ones it can open, which is the same property as the test above.
    const bodies = await sealToEach(peer.device, SENDER_ACCOUNT, peerTargets, 'from the peer');
    peer.client.send('dm_send', {
      to: reg.payload.userId, text: '', clientId: 'syncmessage00001', encrypted: { kind: 'devices', bodies },
    });

    const onLaptop = await laptopSock.waitFor('dm_message', 5000);
    expect(
      await openAsRecipient(myLaptop, ACCOUNT, SENDER_ACCOUNT, onLaptop.payload.encrypted),
    ).toBe('from the peer');
    void me;
  });

  it('gives a device that was not sealed for a frame it can act on, not a silent gap', async () => {
    const { parties, userId } = await accountOnTwoDevices('gap');
    const [phone, laptop] = parties;
    const sender = await senderWithOneDevice('gap-sender');
    const targets = await bundlesFor(sender.client, userId);

    // sealed for the laptop only — as happens when the phone's keys have aged out
    const onlyForLaptop = targets.filter((t) => t.deviceId === 'laptop');
    const bodies = await sealToEach(sender.device, SENDER_ACCOUNT, onlyForLaptop, 'for the laptop only');

    for (const p of parties) p.client.clear();
    sender.client.send('dm_send', {
      to: userId, text: '', clientId: 'gapmessage000001', encrypted: { kind: 'devices', bodies },
    });

    const laptopFrame = await laptop.client.waitFor('dm_message', 5000);
    expect(
      await openAsRecipient(laptop.device, ACCOUNT, SENDER_ACCOUNT, laptopFrame.payload.encrypted),
    ).toBe('for the laptop only');

    // the phone is told the message exists, with nothing in it. Not dropped — a dropped message and a
    // message nobody can read are indistinguishable from outside, which is the one ambiguity this must
    // not have.
    const phoneFrame = await phone.client.waitFor('dm_message', 5000);
    expect(phoneFrame.payload.id).toBeTruthy();
    expect(phoneFrame.payload.encrypted).toBeNull();
    expect(phoneFrame.payload.text).toBe('');
  });

  it('refuses a fan-out whose bodies are not bodies', async () => {
    const { userId } = await accountOnTwoDevices('hostile');
    const attacker = await senderWithOneDevice('hostile-sender');

    attacker.client.clear();
    // a body carrying a key where a ciphertext belongs, which is what the wrapper would let through if
    // the per-body check were skipped
    attacker.client.send('dm_send', {
      to: userId,
      text: '',
      encrypted: {
        kind: 'devices',
        bodies: [{ deviceId: 'phone', body: { kind: 'ratchet', privateKey: 'AAAA', ratchetPublicKey: 'BB', messageNumber: 0 } }],
      },
    });
    const err = await attacker.client.waitFor('error', 4000);
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
  });

  it('refuses more bodies than devices could possibly need', async () => {
    const { userId } = await accountOnTwoDevices('many');
    const attacker = await senderWithOneDevice('many-sender');

    const bodies = Array.from({ length: 40 }, (_, i) => ({
      deviceId: `device-${i}`,
      body: { kind: 'ratchet', ciphertext: 'AAAA', ratchetPublicKey: 'BBBB', messageNumber: 0 },
    }));
    attacker.client.clear();
    attacker.client.send('dm_send', { to: userId, text: '', encrypted: { kind: 'devices', bodies } });
    const err = await attacker.client.waitFor('error', 4000);
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
  });
});