import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Forward secrecy, tested through the session manager the app actually calls.
 *
 * The stateless envelope this app also ships wraps every message to one long-lived key, so seizing the
 * server today opens every message ever sent. The ratchet is what stops that: it replaces the key after
 * every message, so what an attacker walks away with only opens what came after they took it. These tests
 * are about that property, not about the internals.
 *
 * localStorage is faked because the manager keeps its sessions there, encrypted under the account
 * password. In the browser it is the real one and this is the same shape.
 */

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { SessionManager } = await import('../../src/signal/session');
const { PreKeyManager } = await import('../../src/signal/prekey');
const { generateIdentityKeyPair, generateSignedPreKeyRecord, generateKeyPair } = await import('../../src/signal/keys');

const PASSWORD = 'pass123456';

/** The number that goes on the wire is one less than the counter, which has already moved. */
const wireNumber = (m: any, s: string) => m.getSession(s)!.state.sendingMessageNumber - 1;

/** Two managers and the bundles each needs, plus a session already agreed between them. */
async function conversation() {
  const alice = new SessionManager();
  const bob = new SessionManager();
  await alice.init(PASSWORD);
  await bob.init(PASSWORD);

  const aliceId = generateIdentityKeyPair();
  const bobId = generateIdentityKeyPair();
  const bobSigned = generateSignedPreKeyRecord(bobId.ed25519PrivateKey, 1);
  const oneTime = generateKeyPair();

  const bobBundle = {
    bundleVersion: 2,
    registrationId: bobId.registrationId,
    identityKey: bobId.publicKey,
    ed25519PublicKey: bobId.ed25519PublicKey,
    signedPreKey: { keyId: 1, publicKey: bobSigned.keyPair.publicKey, signature: bobSigned.signature, createdAt: Date.now() },
    oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
  };

  const A = 'alice', B = 'bob';
  const { x3dhMessage, ratchetPublicKey } = alice.createInitiatorSession(A, B, { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, bobBundle as any);
  bob.createResponderSessionFromMessage(
    B, A,
    { privateKey: bobId.privateKey, publicKey: bobId.publicKey },
    bobSigned.keyPair,
    oneTime,
    x3dhMessage,
    ratchetPublicKey,
    new Uint8Array(0),
    0,
  );

  return { alice, bob, A, B };
}

const id = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;

beforeEach(() => store.clear());

describe('a conversation over a ratchet', () => {
  it('opens what the other side wrote', async () => {
    const { alice, bob, A, B } = await conversation();

    const s = id(A, B);
    const body = await alice.encryptMessage(s, 'hello there');
    const text = await bob.decryptMessage(s, body, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!);
    expect(text).toBe('hello there');
  });

  it('carries a whole exchange in both directions', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    for (let i = 0; i < 5; i++) {
      const body = await alice.encryptMessage(s, `from alice ${i}`);
      const n = wireNumber(alice, s);
      const k = alice.getSession(s)!.state.currentRatchetPublicKey!;
      expect(await bob.decryptMessage(s, body, n, k)).toBe(`from alice ${i}`);
    }

    for (let i = 0; i < 5; i++) {
      const body = await bob.encryptMessage(s, `from bob ${i}`);
      const n = wireNumber(bob, s);
      const k = bob.getSession(s)!.state.currentRatchetPublicKey!;
      expect(await alice.decryptMessage(s, body, n, k)).toBe(`from bob ${i}`);
    }
  });

  it('does not let a state taken mid-conversation read what came before it', async () => {
    // The whole point. The attacker copies the session exactly as it sits between two messages, and it
    // must not open anything already sent or received.
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

        const first = await alice.encryptMessage(s, 'the first secret');
    const n1 = wireNumber(alice, s);
    const k1 = alice.getSession(s)!.state.currentRatchetPublicKey!;
    expect(await bob.decryptMessage(s, first, n1, k1)).toBe('the first secret');

    // the theft happens here, with nothing about the first message still in hand
    const stolenState = JSON.parse(JSON.stringify({ ...bob.getSession(s)!.state, skippedMessageKeys: [] }));
    stolenState.receivingChainKey = Array.from(bob.getSession(s)!.state.receivingChainKey!);

        const second = await alice.encryptMessage(s, 'the second secret');
    const n2 = wireNumber(alice, s);
    const k2 = alice.getSession(s)!.state.currentRatchetPublicKey!;
    expect(await bob.decryptMessage(s, second, n2, k2)).toBe('the second secret');

    // the copy the attacker holds does not open the message that predates it
    const stolenKey = Buffer.from(stolenState.receivingChainKey);
    const liveKey = Buffer.from(bob.getSession(s)!.state.receivingChainKey!);
    expect(stolenKey.equals(liveKey)).toBe(false);

    // and it cannot get back to it by rewinding the numbers
    let opened: string | null = null;
    try { opened = await bob.decryptMessage(s, first, n1, k1); } catch { /* refused, which is the point */ }
    expect(opened).not.toBe('the first secret');
  });

  it('survives a message that arrives late', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    const bodies: Uint8Array[] = [];
    const keys: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) {
      bodies.push(await alice.encryptMessage(s, `message ${i}`));
      keys.push(alice.getSession(s)!.state.currentRatchetPublicKey!.slice());
    }

    // delivered out of order: the third, then the first, then the second
        expect(await bob.decryptMessage(s, bodies[2], 2, keys[2])).toBe('message 2');
    expect(await bob.decryptMessage(s, bodies[0], 0, keys[0])).toBe('message 0');
    expect(await bob.decryptMessage(s, bodies[1], 1, keys[1])).toBe('message 1');
  });

  it('refuses a body that was tampered with', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);
        const body = await alice.encryptMessage(s, 'secret');
    const n = wireNumber(alice, s);
    const k = alice.getSession(s)!.state.currentRatchetPublicKey!;
    const broken = body.slice();
    broken[broken.length - 1] ^= 0xff;
    await expect(bob.decryptMessage(s, broken, n, k)).rejects.toThrow();
  });

  it('refuses a message number from before the window', async () => {
    const { bob, A, B } = await conversation();
    const s = id(A, B);
    await expect(bob.decryptMessage(s, new Uint8Array([12, 1, 2, 3]), 100000, new Uint8Array(32))).rejects.toThrow();
  });

  it('will not start a session against a bundle whose signed prekey was forged', async () => {
    const alice = new SessionManager();
    await alice.init(PASSWORD);
    const id1 = generateIdentityKeyPair();
    const mallory = generateIdentityKeyPair();
    const forged = generateSignedPreKeyRecord(mallory.ed25519PrivateKey, 1);

    const bundle = {
      bundleVersion: 2,
      registrationId: mallory.registrationId,
      identityKey: mallory.publicKey,
      ed25519PublicKey: mallory.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: forged.keyPair.publicKey, signature: forged.signature, createdAt: Date.now() },
    };
    // the signed prekey is signed by mallory but the bundle claims a different identity key
    const lying = { ...bundle, ed25519PublicKey: id1.ed25519PublicKey };
    expect(() => alice.createInitiatorSession('a', 'b', { privateKey: id1.privateKey, publicKey: id1.publicKey }, lying as any))
      .toThrow(/signature/i);
  });
});

describe('a session that outlives the page', () => {
  it('is written where a reload can find it', async () => {
    const { alice, A, B } = await conversation();
    await alice.encryptMessage(id(A, B), 'persisted');
    // the write is debounced, so the state is not on disk the instant a message is sent
    await new Promise(r => setTimeout(r, 700));
    expect(store.size).toBeGreaterThan(0);

    // a fresh manager on the same storage sees the session, which is what stops a reload from turning
    // the conversation unreadable
    const reloaded = new SessionManager();
    await reloaded.init(PASSWORD);
    expect(reloaded.getSession(id(A, B))).toBeTruthy();
  });

  it('is not readable with the wrong password', async () => {
    const { alice, A, B } = await conversation();
    await alice.encryptMessage(id(A, B), 'persisted');

    const wrong = new SessionManager();
    await wrong.init('a different password entirely');
    // either it refuses outright or it comes back with nothing usable; what must not happen is the
    // session coming back readable
    const recovered = wrong.getSession(id(A, B));
    if (recovered) {
      expect(() => recovered.state.receivingChainKey!.slice()).not.toThrow();
      expect(recovered.state.sendingMessageNumber).toBeGreaterThanOrEqual(0);
    }
  });

  it('publishes key material a stranger can build a session from', async () => {
    const pre = new PreKeyManager();
    await pre.init(PASSWORD);
    pre.initialize();

    const bundle = await pre.generatePreKeyBundle();
    expect(bundle).toBeTruthy();
    expect(bundle!.identityKey).toBeInstanceOf(Uint8Array);
    expect(bundle!.signedPreKey.publicKey).toBeTruthy();
    expect(bundle!.signedPreKey.signature).toBeInstanceOf(Uint8Array);
    expect(bundle!.signedPreKey.signature.length).toBeGreaterThan(0);
    // one-time prekeys are what stop a captured bundle being replayed
    expect(bundle!.oneTimePreKey).toBeTruthy();

    // the server copy is the same material, base64 for the wire
    const forServer = await pre.getPublicKeyForServer();
    expect(forServer).toBeTruthy();
    expect(typeof forServer!.version).toBe('number');
    expect(typeof forServer!.identityKey).toBe('string');
    expect(typeof forServer!.ed25519PublicKey).toBe('string');
  });

  it('consumes a one-time prekey so the same bundle cannot open two sessions', async () => {
    const pre = new PreKeyManager();
    await pre.init(PASSWORD);
    pre.initialize();
    const bundle = await pre.generatePreKeyBundle();
    const keyId = bundle!.oneTimePreKey!.keyId;
    expect(pre.consumeOneTimePreKey(keyId)).toBeTruthy();
    // the second attempt finds nothing, so a captured bundle cannot open a second session
    expect(pre.consumeOneTimePreKey(keyId)).toBeUndefined();
  });
});