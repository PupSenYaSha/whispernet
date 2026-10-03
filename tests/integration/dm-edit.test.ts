import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

/**
 * A private message has to be correctable by whoever wrote it.
 *
 * The server holds ciphertext for these, so it cannot rewrite the words; what it can do is record the
 * author and swap one encrypted body for another. That is the reason sealed sender had to go: a row
 * filed under an addressee-only channel hid its own author, so the person who wrote it could not edit
 * or delete it, on any device, ever.
 */

let server: StartedServer;
const clients: TestClient[] = [];
const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

describe('correcting a private message', () => {
  let alice: TestClient, bob: TestClient;
  let aliceNick: string, bobNick: string;
  let aliceId: string, bobId: string;
  let sentId: string;

  const dm = (from: TestClient, to: string, body: any) => {
    from.clear();
    from.send('dm_send', { to, encrypted: body });
  };

  beforeAll(async () => {
    alice = await client('ed-a');
    bob = await client('ed-b');
    aliceNick = uniqueNick('eda');
    bobNick = uniqueNick('edb');
    const ra = await alice.register(aliceNick);
    const rb = await bob.register(bobNick);
    aliceId = ra.payload.userId;
    bobId = rb.payload.userId;
  });

  it('delivers the replacement to the recipient', async () => {
    dm(alice, bobId, { ciphertext: 'first-body', iv: 'iv', encryptedKeys: { [bobId]: 'k1' } });
    const first = await bob.waitFor('dm_message');
    sentId = first.payload.id;

    bob.clear();
    alice.clear();
    alice.send('edit_message', { messageId: sentId, encrypted: { ciphertext: 'second-body', iv: 'iv2', encryptedKeys: { [bobId]: 'k2' } } });
    const edited = await bob.waitFor('message_edited');
    expect(edited.payload.messageId).toBe(sentId);
    expect(edited.payload.encrypted.ciphertext).toBe('second-body');
  });

  it('does not put the words on the wire', async () => {
    // The client sends only the ciphertext, so an operator watching the socket sees two opaque bodies
    // and never either version of the text.
    const bobsView = bob.logs.filter((m: any) => m.type === 'message_edited').pop();
    expect(bobsView.payload.text).toBeUndefined();
  });

  it('shows the correction again in history, not the original', async () => {
    bob.clear();
    bob.send('dm_history', { with: aliceId });
    const hist = await bob.waitFor('dm_history');
    const row = hist.payload.messages.find((m: any) => m.id === sentId);
    expect(row).toBeTruthy();
    expect(row.encrypted.ciphertext).toBe('second-body');
  });

  it('reaches a second device of the recipient', async () => {
    // Broadcasting to the whole conversation rather than only to the socket that asked is what makes a
    // correction show up on a phone that was not the one it was made on.
    const second = await client('ed-b2');
    clients.push(second);
    const res = await second.login(bobNick, { deviceId: 'ed-b-2' });
    expect(res.type).toBe('auth_success');

    bob.clear();
    second.clear();
    alice.send('edit_message', { messageId: sentId, encrypted: { ciphertext: 'third-body', iv: 'iv4', encryptedKeys: { [bobId]: 'k4' } } });

    const onSecond = await second.waitFor('message_edited', 5000);
    expect(onSecond, 'the correction did not reach the other device').toBeTruthy();
    expect(onSecond.payload.encrypted.ciphertext).toBe('third-body');
  });

  it('takes a per-device correction, and hands each device only its own body', async () => {
    // A correction is sealed like any other message: one body per device of both accounts. Broadcasting
    // the whole fan-out instead would tell a phone what was sent to a laptop, in bytes it can only fail
    // to open.
    const phone = await client('ed-fan-phone');
    clients.push(phone);
    const phoneReg = await phone.login(bobNick, { deviceId: 'ed-fan-phone' });
    expect(phoneReg.type).toBe('auth_success');

    const fanOut = {
      kind: 'devices',
      bodies: [
        { deviceId: 'ed-fan-phone', body: { ciphertext: 'for-the-phone', ratchetPublicKey: 'rk', messageNumber: 0 } },
        { deviceId: 'ed-b-2', body: { ciphertext: 'for-the-laptop', ratchetPublicKey: 'rk', messageNumber: 0 } },
      ],
    };

    dm(alice, bobId, fanOut);
    const delivered = await phone.waitFor('dm_message', 5000);
    const editedId = delivered.payload.id;

    phone.clear();
    alice.clear();
    alice.send('edit_message', { messageId: editedId, encrypted: fanOut });

    const onPhone = await phone.waitFor('message_edited', 5000);
    expect(onPhone.payload.encrypted.ciphertext).toBe('for-the-phone');
    // and not the other one, which is the whole point
    expect(JSON.stringify(onPhone.payload)).not.toContain('for-the-laptop');

    // history is filtered the same way, or a reload would hand it every device's copy
    phone.clear();
    phone.send('dm_history', { with: aliceId });
    const hist = await phone.waitFor('dm_history', 5000);
    const row = hist.payload.messages.find((m: any) => m.id === editedId);
    expect(row.encrypted.ciphertext).toBe('for-the-phone');
    expect(JSON.stringify(hist.payload)).not.toContain('for-the-laptop');
  });

  it('refuses a correction that is not a body it could have been sent', async () => {
    alice.clear();
    alice.send('edit_message', {
      messageId: sentId,
      encrypted: { kind: 'devices', bodies: [] },
    });
    const err = await alice.waitFor('error', 4000);
    expect(err.payload.code).toBe('INVALID_PAYLOAD');
  });

  it('refuses somebody who did not write it', async () => {
    bob.clear();
    bob.send('edit_message', { messageId: sentId, encrypted: { ciphertext: 'hijacked', iv: 'iv3', encryptedKeys: { [aliceId]: 'k3' } } });
    const err = await bob.waitFor('error');
    expect(err.payload.code).toBe('NOT_FOUND');
  });

  it('refuses plaintext words for a private message', async () => {
    // The words are never sent for these, and accepting them here would be a way in if some client did.
    alice.clear();
    alice.send('edit_message', { messageId: sentId, text: 'plain correction' });
    const err = await alice.waitFor('error');
    expect(err.payload.code).toBe('INVALID_PAYLOAD');
  });

  it('lets the author delete it, which sealed sender made impossible', async () => {
    alice.clear();
    bob.clear();
    alice.send('delete_message', { messageId: sentId });
    const gone = await bob.waitFor('message_deleted');
    expect(gone.payload.messageId).toBe(sentId);

    alice.clear();
    alice.send('dm_history', { with: bobId });
    const hist = await alice.waitFor('dm_history');
    expect(hist.payload.messages.some((m: any) => m.id === sentId)).toBe(false);
  });
});

describe('a public message keeps its own rules', () => {
  let a: TestClient, b: TestClient;

  beforeAll(async () => {
    a = await client('gp-a');
    b = await client('gp-b');
    await a.register(uniqueNick('gpa'));
    await b.register(uniqueNick('gpb'));
  });

  it('still refuses to edit somebody else\'s', async () => {
    a.clear(); b.clear();
    a.send('chat_message', { text: 'mine ' + Date.now() });
    const got = await b.waitFor('chat_message');
    b.clear();
    b.send('edit_message', { messageId: got.payload.id, text: 'not mine' });
    await new Promise((r) => setTimeout(r, 300));
    b.clear();
    b.send('edit_message', { messageId: got.payload.id, text: 'still not mine' });
    const err = await b.waitFor('error');
    expect(err.payload.code).toBe('NOT_FOUND');
  });
});