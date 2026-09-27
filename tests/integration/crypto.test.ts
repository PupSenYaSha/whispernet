import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TestClient, uniqueNick, type StartedServer } from '../helpers';

let server: StartedServer;
const clients: TestClient[] = [];
const client = async (label: string): Promise<TestClient> => {
  const c = new TestClient(server.url, label);
  clients.push(c);
  return c;
};

beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => { clients.forEach((c) => c.close()); await server.stop(); });

const b64 = (seed: number): string => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed * 13 + 11) % 256)).toString('base64');

/** Bundle shape produced by src/signal/prekey.ts getPublicKeyForServer() (field "version"). */
function clientBundle(seed: number) {
  return {
    version: 2,
    identityKey: b64(seed),
    ed25519PublicKey: b64(seed + 1),
    signedPreKey: { keyId: 1, publicKey: b64(seed + 2), signature: Array.from({ length: 64 }, (_, i) => (i * 3 + seed) % 256), createdAt: Date.now() },
    oneTimePreKey: { keyId: 2, publicKey: b64(seed + 3) },
  };
}

function expectedSafetyNumber(selfB64: string, peerB64: string | null): string {
  const self = Buffer.from(selfB64, 'base64');
  const peer = peerB64 ? Buffer.from(peerB64, 'base64') : null;
  const data = peer ? (Buffer.compare(self, peer) <= 0 ? Buffer.concat([self, peer]) : Buffer.concat([peer, self])) : self;
  const h = require('crypto').createHash('sha256').update(data).digest();
  const groups: string[] = [];
  for (let i = 0; i < 24; i += 4) groups.push(h.subarray(i, i + 4).toString('hex').toUpperCase());
  return groups.join(' ');
}

describe('prekey bundles & safety numbers', () => {
  let a: TestClient, b: TestClient, c: TestClient;
  let aId: string, bId: string, cId: string;

  beforeAll(async () => {
    a = await client('pk-a');
    b = await client('pk-b');
    c = await client('pk-c');
    const ra = await a.register(uniqueNick('pka'));
    const rb = await b.register(uniqueNick('pkb'));
    const rc = await c.register(uniqueNick('pkc'));
    aId = ra.payload.userId; bId = rb.payload.userId; cId = rc.payload.userId;
  });

  it('stores a bundle sent during registration (field "version")', async () => {
    const n = uniqueNick('pkr');
    const d = new TestClient(server.url, 'pk-reg');
    clients.push(d);
    await d.connect();
    const p = new Promise<any>((r) => d.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'auth_success' || m.type === 'auth_failure') r(m); }));
    d.send('auth_register', { nickname: n, password: 'pass123456', preKeyBundle: clientBundle(11), deviceId: 'x' + n, deviceInfo: 'vitest' });
    const res = await p;
    expect(res.type).toBe('auth_success');
  });

  it('stores a bundle sent with prekey_upload and serves it via prekey_fetch', async () => {
    a.send('prekey_upload', { bundle: clientBundle(1) });
    expect(await a.waitFor('prekey_uploaded')).toBeTruthy();
    b.send('prekey_upload', { bundle: clientBundle(2) });
    expect(await b.waitFor('prekey_uploaded')).toBeTruthy();
    a.clear();
    a.send('prekey_fetch', { userIds: [bId] });
    const bundles = await a.waitFor('prekey_bundles');
    expect(bundles.payload.bundles[bId].identityKey).toBe(b64(2));
  });

  it('derives the same safety number on both sides', async () => {
    a.clear();
    a.send('profile_get', { userId: bId });
    const ab = await a.waitFor('profile');
    const expected = expectedSafetyNumber(b64(1), b64(2));
    expect(ab.payload.profile.safetyNumber).toBe(expected);
    b.clear();
    b.send('profile_get', { userId: aId });
    const ba = await b.waitFor('profile');
    expect(ba.payload.profile.safetyNumber).toBe(expected);
  });

  it('derives a self-only number for your own profile', async () => {
    a.clear();
    a.send('profile_get', { userId: aId });
    const self = await a.waitFor('profile');
    expect(self.payload.profile.safetyNumber).toBe(expectedSafetyNumber(b64(1), null));
  });

  it('returns no number when the peer has no published keys', async () => {
    a.clear();
    a.send('profile_get', { userId: cId });
    const res = await a.waitFor('profile');
    expect(res.payload.profile.safetyNumber).toBeNull();
  });

  it('accepts the legacy "bundleVersion" field as well', async () => {
    const d = new TestClient(server.url, 'pk-legacy');
    clients.push(d);
    await d.connect();
    const p = new Promise<any>((r) => d.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'auth_success' || m.type === 'auth_failure') r(m); }));
    const nick = uniqueNick('pkl');
    const bundle = { ...clientBundle(21), bundleVersion: 2, version: undefined };
    d.send('auth_register', { nickname: nick, password: 'pass123456', preKeyBundle: bundle, deviceId: 'y' + nick, deviceInfo: 'vitest' });
    const res = await p;
    expect(res.type).toBe('auth_success');
  });

  it('rejects malformed bundles instead of storing them', async () => {
    a.clear();
    a.send('prekey_upload', { bundle: { version: 2, identityKey: 42 } });
    await a.waitFor('error', 1500);
    a.clear();
    a.send('prekey_upload', {});
    await a.waitFor('error', 1500);
    // the stored bundle must be unchanged
    a.clear();
    a.send('prekey_fetch', { userIds: [aId] });
    const bundles = await a.waitFor('prekey_bundles');
    expect(bundles.payload.bundles[aId].identityKey).toBe(b64(1));
  });
});

describe('direct messages keep their ciphertext', () => {
  let a: TestClient, b: TestClient, aId: string, bId: string;

  beforeAll(async () => {
    a = await client('dm-a');
    b = await client('dm-b');
    const ra = await a.register(uniqueNick('dma'));
    const rb = await b.register(uniqueNick('dmb'));
    aId = ra.payload.userId;
    bId = rb.payload.userId;
  });

  it('forwards and persists signalEncrypted, x3dhMessage and ratchetPublicKey', async () => {
    b.clear();
    a.send('dm_send', {
      to: bId,
      signalEncrypted: { ciphertext: 'AAAA', ratchetPublicKey: 'BBBB', messageNumber: 3 },
      x3dhMessage: { header: { ik: 'x' }, ephemeral: 'y' },
      ratchetPublicKey: [1, 2, 3, 4],
    });
    const dm = await b.waitFor('dm_message');
    expect(dm.payload.signalEncrypted.ciphertext).toBe('AAAA');
    expect(dm.payload.x3dhMessage).toBeTruthy();
    expect(dm.payload.ratchetPublicKey).toEqual([1, 2, 3, 4]);

    b.clear();
    b.send('dm_history', { with: aId });
    const hist = await b.waitFor('dm_history');
    const m0 = hist.payload.messages[0];
    expect(m0.signalEncrypted.ciphertext).toBe('AAAA');
    expect(m0.x3dhMessage).toBeTruthy();
    expect(m0.ratchetPublicKey).toEqual([1, 2, 3, 4]);
  });

  it('refuses plaintext direct messages', async () => {
    a.clear();
    a.send('dm_send', { to: bId, text: 'plain' });
    const err = await a.waitFor('error');
    expect(err.payload.code).toBe('ENCRYPTION_REQUIRED');
  });

  it('carries the client message id back to the sender and into the history', async () => {
    const clientId = 'a1b2c3d4e5f6a7b8';
    a.clear();
    a.send('dm_send', {
      to: bId,
      clientId,
      signalEncrypted: { ciphertext: 'CCCC', ratchetPublicKey: 'DDDD', messageNumber: 4 },
      ratchetPublicKey: [1, 2, 3, 4],
    });

    const echo = await a.waitFor('dm_message');
    expect(echo.payload.isOwn).toBe(true);
    expect(echo.payload.clientId).toBe(clientId);

    b.clear();
    b.send('dm_history', { with: aId });
    const hist = await b.waitFor('dm_history');
    const mine = hist.payload.messages.find((m: any) => m.clientId === clientId);
    expect(mine).toBeTruthy();
    expect(mine.signalEncrypted.ciphertext).toBe('CCCC');
  });

  it('drops a client message id that does not look like one', async () => {
    a.clear();
    a.send('dm_send', {
      to: bId,
      clientId: 'no spaces allowed here',
      signalEncrypted: { ciphertext: 'EEEE', ratchetPublicKey: 'FFFF', messageNumber: 5 },
      ratchetPublicKey: [1, 2, 3, 4],
    });
    const echo = await a.waitFor('dm_message');
    expect(echo.payload.clientId ?? null).toBeNull();
  });
});
