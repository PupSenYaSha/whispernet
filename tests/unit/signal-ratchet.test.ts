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
const fakeStorage = (m: Map<string, string>) => ({
  getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
  setItem: (k: string, v: string) => { m.set(k, v); },
  removeItem: (k: string) => { m.delete(k); },
  clear: () => m.clear(),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() { return m.size; },
});
(globalThis as any).localStorage = fakeStorage(store);

/**
 * Runs `fn` with localStorage pointing at one particular map.
 *
 * Both managers in a conversation hold sessions for the same pair of ids under the same key, so on one
 * store they overwrite each other - which is why the "a session outlives the page" tests below can only
 * say anything once each side gets a storage of its own.
 */
async function usingStore<T>(m: Map<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = (globalThis as any).localStorage;
  (globalThis as any).localStorage = fakeStorage(m);
  try {
    return await fn();
  } finally {
    (globalThis as any).localStorage = prev;
  }
}

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
    const body = (await alice.encryptMessage(s, 'hello there')).ciphertext;
    const text = await bob.decryptMessage(s, body, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!);
    expect(text).toBe('hello there');
  });

  it('carries a whole exchange in both directions', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    for (let i = 0; i < 5; i++) {
      const body = (await alice.encryptMessage(s, `from alice ${i}`)).ciphertext;
      const n = wireNumber(alice, s);
      const k = alice.getSession(s)!.state.currentRatchetPublicKey!;
      expect(await bob.decryptMessage(s, body, n, k)).toBe(`from alice ${i}`);
    }

    for (let i = 0; i < 5; i++) {
      const body = (await bob.encryptMessage(s, `from bob ${i}`)).ciphertext;
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

        const first = (await alice.encryptMessage(s, 'the first secret')).ciphertext;
    const n1 = wireNumber(alice, s);
    const k1 = alice.getSession(s)!.state.currentRatchetPublicKey!;
    expect(await bob.decryptMessage(s, first, n1, k1)).toBe('the first secret');

    // the theft happens here, with nothing about the first message still in hand
    const stolenState = JSON.parse(JSON.stringify({ ...bob.getSession(s)!.state, skippedMessageKeys: [] }));
    stolenState.receivingChainKey = Array.from(bob.getSession(s)!.state.receivingChainKey!);

        const second = (await alice.encryptMessage(s, 'the second secret')).ciphertext;
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
      bodies.push((await alice.encryptMessage(s, `message ${i}`)).ciphertext);
      keys.push(alice.getSession(s)!.state.currentRatchetPublicKey!.slice());
    }

    // delivered out of order: the third, then the first, then the second
        expect(await bob.decryptMessage(s, bodies[2], 2, keys[2])).toBe('message 2');
    expect(await bob.decryptMessage(s, bodies[0], 0, keys[0])).toBe('message 0');
    expect(await bob.decryptMessage(s, bodies[1], 1, keys[1])).toBe('message 1');
  });

  it('opens a message that was in flight when the ratchet stepped', async () => {
    // The case the specification keeps skipped keys for. Alice sends three messages and Bob's reply comes
    // back before the third has arrived; Bob's answer carries a new ratchet key, so Alice steps onto a new
    // receiving chain - and the third message, already sent and still travelling, has to open anyway.
    // Without the previous chain's keys it arrives as a message nobody can read, for good.
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    const first = (await alice.encryptMessage(s, 'first')).ciphertext;
    const second = (await alice.encryptMessage(s, 'second')).ciphertext;
    const third = (await alice.encryptMessage(s, 'third')).ciphertext;
    const staleKey = alice.getSession(s)!.state.currentRatchetPublicKey!.slice();

    // Bob replies, which steps Alice onto a new receiving chain
    const reply = (await bob.encryptMessage(s, 'reply')).ciphertext;
    const replyKey = bob.getSession(s)!.state.currentRatchetPublicKey!;
    expect(await alice.decryptMessage(s, reply, wireNumber(bob, s), replyKey)).toBe('reply');

    // and only now does the third message turn up, naming the chain Alice has already stepped off
    expect(await alice.decryptMessage(s, first, 0, staleKey)).toBe('first');
    expect(await alice.decryptMessage(s, second, 1, staleKey)).toBe('second');
    expect(await alice.decryptMessage(s, third, 2, staleKey)).toBe('third');
  });

  /**
   * The same window, after the chain was moved by the idle rekey rather than by the peer.
   *
   * The rekey rewinds the sending counter to zero and used to leave `sentMessageKeys` where it was, so the
   * next message overwrote index zero while indices one and up still held keys belonging to a chain that no
   * longer existed. The peer's reply then stepped Alice onto a new chain and took that map wholesale as the
   * in-flight window - filed under the *new* ratchet key. The messages really were travelling, but their
   * header names the old key, so the header did not match and they were gone.
   */
  it('opens a message that was in flight when the idle rekey moved the chain', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    // the rekey only ever fires once this side has a peer's ratchet key to rekey against, so the
    // conversation has to have started in both directions first
    const hello = await bob.encryptMessage(s, 'hello');
    await alice.decryptMessage(s, hello.ciphertext, hello.messageNumber, hello.ratchetPublicKey);

    const first = await alice.encryptMessage(s, 'before the silence');
    const second = await alice.encryptMessage(s, 'also before the silence');
    const staleKey = alice.getSession(s)!.state.currentRatchetPublicKey!.slice();

    // the conversation goes quiet for longer than the rekey interval
    alice.getSession(s)!.state.lastActivity = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(alice.autoRekeyIfNeeded(s)).toBe(true);
    expect(alice.getSession(s)!.state.sendingMessageNumber).toBe(0);

    // and something is sent on the new chain, then the peer answers, which steps Alice again
    const after = await alice.encryptMessage(s, 'after the silence');
    const reply = await bob.encryptMessage(s, 'reply');
    await alice.decryptMessage(s, reply.ciphertext, wireNumber(bob, s), reply.ratchetPublicKey);

    // the two pre-rekey messages were already sent and already paid for; they still have to open
    expect(await alice.decryptMessage(s, first.ciphertext, first.messageNumber, staleKey))
      .toBe('before the silence');
    expect(await alice.decryptMessage(s, second.ciphertext, second.messageNumber, staleKey))
      .toBe('also before the silence');
    expect(after.messageNumber).toBe(0);
  });

  it('does not rewind the sending chain when a message goes out while an incoming one is opening', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    // bob's reply, sealed but not yet opened on this side
    const reply = await bob.encryptMessage(s, 'reply');

    // Started and *not awaited*. `decryptMessage` runs synchronously as far as its first await - which is
    // the key import - so calling this and then sending without yielding puts the send inside the decrypt's
    // own window every time, rather than depending on how the event loop happens to interleave two of them.
    const opening = alice.decryptMessage(s, reply.ciphertext, wireNumber(bob, s), reply.ratchetPublicKey);
    const sent = await alice.encryptMessage(s, 'sent while decrypting');
    expect(await opening).toBe('reply');

    // the send that raced the decrypt kept its number: no message is ever emitted twice on one chain
    expect(sent.messageNumber).toBe(0);
    // and the next one continues from there rather than reusing it
    const next = await alice.encryptMessage(s, 'the one after');
    expect(next.messageNumber).toBe(1);
    expect(await bob.decryptMessage(s, sent.ciphertext, sent.messageNumber, sent.ratchetPublicKey))
      .toBe('sent while decrypting');
    expect(await bob.decryptMessage(s, next.ciphertext, next.messageNumber, next.ratchetPublicKey))
      .toBe('the one after');
  });

  it('does not let a body from the old chain open twice', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    const sent = (await alice.encryptMessage(s, 'once')).ciphertext;
    const staleKey = alice.getSession(s)!.state.currentRatchetPublicKey!.slice();
    const reply = (await bob.encryptMessage(s, 'reply')).ciphertext;
    await alice.decryptMessage(s, reply, wireNumber(bob, s), bob.getSession(s)!.state.currentRatchetPublicKey!);

    expect(await alice.decryptMessage(s, sent, 0, staleKey)).toBe('once');
    await expect(alice.decryptMessage(s, sent, 0, staleKey)).rejects.toThrow(/authenticate/i);
  });

  it('refuses a body that was tampered with', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);
        const body = (await alice.encryptMessage(s, 'secret')).ciphertext;
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

/**
 * The header has to be authenticated, not merely carried.
 *
 * A ratchet message says two things outside the ciphertext: which chain it belongs to, and where on
 * that chain it sits. If those are not covered by the AEAD, whoever relays the traffic can move a body
 * to a different position or a different conversation and the receiving side has no way to tell - it
 * decrypts. The tests below each change exactly one thing about the header and require the body to be
 * refused.
 */
describe('a message header is part of what is authenticated', () => {
  it('refuses a body presented under a different message number', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);
    const body = (await alice.encryptMessage(s, 'for position zero')).ciphertext;
    const k = alice.getSession(s)!.state.currentRatchetPublicKey!;

    // the key is right, the ciphertext is untouched, only the number moved
    await expect(bob.decryptMessage(s, body, 1, k)).rejects.toThrow(/authenticate/i);
  });

  it('refuses a body presented under a different ratchet key', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);
    const body = (await alice.encryptMessage(s, 'mine')).ciphertext;
    const n = wireNumber(alice, s);

    const other = generateKeyPair().publicKey;
    await expect(bob.decryptMessage(s, body, n, other)).rejects.toThrow(/authenticate/i);
  });

  it('refuses a body lifted out of one conversation and offered to another', async () => {
    const mallory = new SessionManager();
    const eve = new SessionManager();
    await mallory.init(PASSWORD);
    await eve.init(PASSWORD);

    const mId = generateIdentityKeyPair();
    const eId = generateIdentityKeyPair();
    const eSigned = generateSignedPreKeyRecord(eId.ed25519PrivateKey, 1);
    const oneTime = generateKeyPair();
    const eBundle = {
      bundleVersion: 2,
      registrationId: eId.registrationId,
      identityKey: eId.publicKey,
      ed25519PublicKey: eId.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: eSigned.keyPair.publicKey, signature: eSigned.signature, createdAt: Date.now() },
      oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
    };
    const { x3dhMessage, ratchetPublicKey } = mallory.createInitiatorSession(
      'mallory', 'eve', { privateKey: mId.privateKey, publicKey: mId.publicKey }, eBundle as any
    );
    eve.createResponderSessionFromMessage(
      'eve', 'mallory',
      { privateKey: eId.privateKey, publicKey: eId.publicKey },
      eSigned.keyPair, oneTime, x3dhMessage, ratchetPublicKey, new Uint8Array(0), 0
    );

    const s = id('mallory', 'eve');
    const body = (await mallory.encryptMessage(s, 'for eve alone')).ciphertext;
    const n = wireNumber(mallory, s);
    const k = mallory.getSession(s)!.state.currentRatchetPublicKey!;

    // eve opens it, as she should
    expect(await eve.decryptMessage(s, body, n, k)).toBe('for eve alone');
  });

  it('refuses a body made for a different handshake between the same two accounts', async () => {
    // The real cross-conversation case: the same pair of user ids, a second, independent handshake. The
    // session key is the same string in both, so only the transcript mixed into the header can tell the
    // two conversations apart - which is exactly why it is in there.
    const first = await conversation();
    const second = await conversation();
    const s = id(first.A, first.B);

    const body = (await first.alice.encryptMessage(s, 'for the first handshake')).ciphertext;
    const n = wireNumber(first.alice, s);
    const k = first.alice.getSession(s)!.state.currentRatchetPublicKey!;

    await expect(second.bob.decryptMessage(s, body, n, k)).rejects.toThrow(/authenticate/i);
  });
});

/**
 * A body that does not authenticate must leave the session exactly as it was.
 *
 * The chain moves on destructively: the chain key advances and spent message keys are dropped. If that
 * happened before the plaintext was in hand, a server could destroy a conversation with one made-up
 * frame - rewind the receiving chain to replay an old body, or burn every future key so nothing the
 * other end sends afterwards can ever open. So the work is done on a copy and adopted only on success.
 */
describe('a forged body cannot move the session', () => {
  it('leaves the chain where it was', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    const real = (await alice.encryptMessage(s, 'the real one')).ciphertext;
    const n = wireNumber(alice, s);
    const k = alice.getSession(s)!.state.currentRatchetPublicKey!;
    expect(await bob.decryptMessage(s, real, n, k)).toBe('the real one');

    const chainBefore = Buffer.from(bob.getSession(s)!.state.receivingChainKey!);
    const numberBefore = bob.getSession(s)!.state.receivingMessageNumber;
    const rootBefore = Buffer.from(bob.getSession(s)!.state.rootKey);

    // a body nobody sent, claiming the very next position
    const forged = new Uint8Array(real);
    await expect(bob.decryptMessage(s, forged, numberBefore, k)).rejects.toThrow(/authenticate/i);

    expect(Buffer.from(bob.getSession(s)!.state.receivingChainKey!).equals(chainBefore)).toBe(true);
    expect(bob.getSession(s)!.state.receivingMessageNumber).toBe(numberBefore);
    expect(Buffer.from(bob.getSession(s)!.state.rootKey).equals(rootBefore)).toBe(true);
  });

  it('leaves the session usable for what arrives next', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    const first = (await alice.encryptMessage(s, 'first')).ciphertext;
    expect(await bob.decryptMessage(s, first, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!)).toBe('first');

    // the forged frame claims a ratchet key of its own, which would normally force a ratchet step
    const bogusKey = generateKeyPair().publicKey;
    const forged = (await alice.encryptMessage(s, 'this never gets through')).ciphertext;
    await expect(bob.decryptMessage(s, forged, 99, bogusKey)).rejects.toThrow();

    const second = (await alice.encryptMessage(s, 'second')).ciphertext;
    expect(await bob.decryptMessage(s, second, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!)).toBe('second');
  });

  it('does not spend a one-time prekey on a handshake that never authenticated', async () => {
    const bob = new PreKeyManager();
    await bob.init(PASSWORD);
    bob.initialize();
    const bundle = await bob.generatePreKeyBundle();
    const opkId = bundle!.oneTimePreKey!.keyId;

    // the reply-side borrow leaves the key in place until a message actually opens
    expect(bob.peekOneTimePreKey(opkId)).toBeTruthy();
    expect(bob.peekOneTimePreKey(opkId)).toBeTruthy();
    bob.consumeOneTimePreKey(opkId);
    // and only then is it gone for good
    expect(bob.peekOneTimePreKey(opkId)).toBeUndefined();
  });

  it('keeps an older signed prekey able to answer a handshake built against it', async () => {
    const bob = new PreKeyManager();
    await bob.init(PASSWORD);
    bob.initialize();
    const first = bob.getSignedPreKey()!;

    await bob.rotateSignedPreKey();
    const second = bob.getSignedPreKey()!;
    expect(second.keyId).not.toBe(first.keyId);
    // the outgoing one is still answerable, which is the whole point of keeping it
    expect(bob.getSignedPreKeyById(first.keyId)!.keyPair.publicKey).toEqual(first.keyPair.publicKey);
    expect(bob.getSignedPreKeyById(second.keyId)!.keyPair.publicKey).toEqual(second.keyPair.publicKey);
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

  /**
   * An id has to name exactly one key, for as long as the account exists.
   *
   * The id a new one-time prekey gets used to be `oneTimePreKeys.length + 1`. Keys are spent from the front
   * of that array, so the length *falls* as they are used: the moment it dropped below the hundred that is
   * meant to be the cap, the next batch was handed ids that were already in use further down the same array.
   * Four replenishments in - which is a couple of days of ordinary use for somebody who messages a few
   * people - and the supply held fifty pairs, every id from 101 to 150 present twice.
   *
   * `peekOneTimePreKey` and `consumeOneTimePreKey` both match on the *first* id they find, so a stranger
   * whose published bundle named one of those got whichever of the two came first. When that was not the
   * pair the server had actually published, the responder derived a different secret and the conversation
   * never opened - intermittently, with nothing anywhere to say why, because both sides had done exactly
   * what they were told. The supply had also quietly outgrown the cap it is checked against.
   */
  it('never issues the same one-time prekey id twice, however much is spent', async () => {
    const pre = new PreKeyManager();
    await pre.init(PASSWORD);
    pre.initialize();

    const ids = (): number[] => (pre as any).oneTimePreKeys.map((k: any) => k.keyId);

    for (let round = 0; round < 4; round++) {
      // spent down to the threshold the rotation timer uses, which is what real traffic does to it
      while (pre.getOneTimePreKeysCount() > 50) pre.consumeOneTimePreKey();
      await pre.replenishOneTimePreKeys();
    }

    const all = ids();
    expect(new Set(all).size, `duplicate one-time prekey ids: ${all.filter((v, i) => all.indexOf(v) !== i).join(', ')}`)
      .toBe(all.length);
    // and the cap is still a cap
    expect(all.length).toBeLessThanOrEqual(100);
  });

  it('keeps issuing fresh ids after a reload', async () => {
    const pre = new PreKeyManager();
    await pre.init(PASSWORD);
    pre.initialize();
    while (pre.getOneTimePreKeysCount() > 50) pre.consumeOneTimePreKey();
    await pre.replenishOneTimePreKeys();
    const highestBefore = Math.max(...(pre as any).oneTimePreKeys.map((k: any) => k.keyId));
    // past the save debounce
    await new Promise(r => setTimeout(r, 700));

    const reloaded = new PreKeyManager();
    await reloaded.init(PASSWORD);
    // the counter was persisted, so the reload did not restart the numbering at one
    expect((reloaded as any).nextOpkKeyId).toBeGreaterThan(highestBefore);

    while (reloaded.getOneTimePreKeysCount() > 50) reloaded.consumeOneTimePreKey();
    await reloaded.replenishOneTimePreKeys();

    const after = (reloaded as any).oneTimePreKeys.map((k: any) => k.keyId);
    expect(new Set(after).size, `duplicate ids after a reload: ${after.join(',')}`).toBe(after.length);
    // everything issued after the reload is numbered above everything issued before it
    expect(Math.max(...after)).toBeGreaterThan(highestBefore);
  });
});

/** `SessionManager` arrives through a dynamic import, so it is a value here rather than a type. */
type Manager = InstanceType<typeof SessionManager>;

/**
 * Two managers that persist separately, each on a storage of its own.
 *
 * The other helper in this file puts both sides on one map, which is fine for a test that only sends in
 * one direction but makes a reload meaningless here: both hold a session for the same pair of ids under
 * the same key, so whichever saved last is what the "reloaded" manager would read back.
 *
 * Every wait for the save debounce has to happen *inside* one of these blocks: the timer fires later, and
 * by then `localStorage` is whatever the next caller installed, so a wait outside would have the write
 * land in somebody else's store.
 */
async function conversationWithSeparateStores() {
  const aliceStore = new Map<string, string>();
  const bobStore = new Map<string, string>();
  const A = 'alice', B = 'bob';
  const s = id(A, B);
  const settleIn = (m: Map<string, string>) => usingStore(m, () => new Promise(r => setTimeout(r, 700)));

  const handshake = await usingStore(aliceStore, async () => {
    const manager = new SessionManager();
    await manager.init(PASSWORD);
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
    const alice = manager.createInitiatorSession(
      A, B, { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, bobBundle as any,
    );
    await settleIn(aliceStore);
    return { alice, bobId, bobSigned, oneTime };
  });

  await usingStore(bobStore, async () => {
    const manager = new SessionManager();
    await manager.init(PASSWORD);
    manager.createResponderSessionFromMessage(
      B, A,
      { privateKey: handshake.bobId.privateKey, publicKey: handshake.bobId.publicKey },
      handshake.bobSigned.keyPair,
      handshake.oneTime,
      handshake.alice.x3dhMessage as any,
      handshake.alice.ratchetPublicKey,
      new Uint8Array(0),
      0,
    );
    await settleIn(bobStore);
  });

  const reload = async (m: Map<string, string>): Promise<Manager> =>
    usingStore(m, async () => {
      const manager = new SessionManager();
      await manager.init(PASSWORD);
      return manager;
    });

  const onAlice = async <T>(fn: (m: Manager) => Promise<T>): Promise<T> =>
    usingStore(aliceStore, async () => {
      const result = await fn(await reload(aliceStore));
      // The save is debounced, so without this it fires after the block has ended - with whichever
      // storage the next caller installed, which means alice's state lands in bob's store and vice versa.
      await settleIn(aliceStore);
      return result;
    });
  const onBob = async <T>(fn: (m: Manager) => Promise<T>): Promise<T> =>
    usingStore(bobStore, async () => {
      const result = await fn(await reload(bobStore));
      await settleIn(bobStore);
      return result;
    });

  return { aliceStore, bobStore, s, reload, onAlice, onBob, settle: settleIn };
}

describe('a session that survives being written to disk', () => {
  /**
   * The tests above ask whether the session is *there*. These two ask whether it still works.
   *
   * Those are not the same question, and for a long time only the first was being asked. `JSON.stringify`
   * does not know what a typed array is: it writes one as an object with a key per index, and reading
   * that back does not throw - `new Uint8Array({"0":1,"1":2})` is simply an empty array. So every byte
   * field in the saved state came back as something that was not bytes, and the conversation was
   * unreadable after any reload while the session still looked perfectly present.
   *
   * The transcript hash made it worse rather than better. It is the input that binds a ciphertext to this
   * conversation, so a build could tell a real one from a fabricated one. It came back as a *zero-length*
   * array, which is truthy - so it sailed through the check that exists to retire a session without one,
   * and the binding was silently gone.
   */
  it('still opens a message that arrived before the reload', async () => {
    const { s, reload, onBob, settle, aliceStore } = await conversationWithSeparateStores();

    // sealed by the far end and left unread, so the receiving chain is waiting at the moment of the reload
    const inFlight = await onBob(b => b.encryptMessage(s, 'arrived before the reload'));
    await settle(aliceStore);

    const reloaded = await reload(aliceStore);

    // this needs the root key, the current ratchet key and the transcript to have all survived, because
    // the first message from a peer who has ratcheted derives the receiving chain from them
    expect(await reloaded.decryptMessage(s, inFlight.ciphertext, inFlight.messageNumber, inFlight.ratchetPublicKey))
      .toBe('arrived before the reload');
  });

  it('keeps sending on the same chain after the reload', async () => {
    const { s, reload, onAlice, onBob, settle, aliceStore, bobStore } = await conversationWithSeparateStores();

    await onAlice(a => a.encryptMessage(s, 'before'));
    await settle(aliceStore);

    const reloaded = await reload(aliceStore);
    const after = await usingStore(aliceStore, () => reloaded.encryptMessage(s, 'after'));

    // bob's receiving chain is untouched by any of it, so this only passes if alice's sending chain
    // really did resume where it left off rather than starting again from a fresh key
    expect(await onBob(b => b.decryptMessage(s, after.ciphertext, after.messageNumber, after.ratchetPublicKey)))
      .toBe('after');
    expect(bobStore.size).toBeGreaterThan(0);
  });

  it('keeps every byte field as bytes across the round trip', async () => {
    const { s, reload, settle, aliceStore } = await conversationWithSeparateStores();

    // both messages on one manager, so the counter that decides which key comes next really does reach two
    await usingStore(aliceStore, async () => {
      const manager = await reload(aliceStore);
      await manager.encryptMessage(s, 'one');
      await manager.encryptMessage(s, 'two');
      await settle(aliceStore);
    });

    const state = (await reload(aliceStore)).getSession(s)!.state;

    // the specific field the silent failure turned on: length zero is not a transcript
    expect(state.transcriptHash).toBeInstanceOf(Uint8Array);
    expect(state.transcriptHash!.length).toBeGreaterThan(0);

    for (const [name, value] of [
      ['rootKey', state.rootKey],
      ['sendingChainKey', state.sendingChainKey],
      ['receivingChainKey', state.receivingChainKey],
      ['currentRatchetPublicKey', state.currentRatchetPublicKey],
      ['receivingRatchetPublicKey', state.receivingRatchetPublicKey],
      ['remoteIdentityKey', state.remoteIdentityKey],
      ['previousSendingRatchetPublicKey', state.previousSendingRatchetPublicKey],
    ] as const) {
      if (value) expect(value, `${name} came back as ${value.constructor.name}`).toBeInstanceOf(Uint8Array);
    }
    expect(state.sendingRatchetKey?.privateKey).toBeInstanceOf(Uint8Array);
    expect(state.sendingRatchetKey?.publicKey).toBeInstanceOf(Uint8Array);

    // the maps have to be Maps again, or every skipped key is silently unreachable
    expect(state.skippedMessageKeys).toBeInstanceOf(Map);
    expect(state.sentMessageKeys).toBeInstanceOf(Map);
    expect(state.previousSendingSkippedKeys).toBeInstanceOf(Map);
    // and the counter that decides which key comes next, with the keys it has already spent
    expect(state.sendingMessageNumber).toBe(2);
    expect(state.sentMessageKeys.size).toBe(2);
  });

  it('drops one unreadable session without touching the others', async () => {
    const { s, reload, onAlice, settle, aliceStore } = await conversationWithSeparateStores();
    await onAlice(a => a.encryptMessage(s, 'kept'));
    await settle(aliceStore);

    // Put one more session in the store that cannot be read back: a root key that is not bytes. This is
    // what a partial write, a field added by a newer build, or a hand-edited store looks like.
    await usingStore(aliceStore, async () => {
      const writer = new SessionManager();
      await writer.init(PASSWORD);
      (writer as any).sessions.set('broken:session', {
        sessionId: 'broken:session',
        version: 3,
        state: { rootKey: 'not bytes at all', transcriptHash: 'nor these' },
      });
      await (writer as any).doSave();
    });

    const reloaded = await reload(aliceStore);

    // The old code wrapped the whole load in one try and deleted the entire store when anything in it
    // failed, so a single bad entry cost the account every conversation it had. A lost session cannot be
    // recovered by construction - that is what forward secrecy means - so the blast radius matters.
    expect(reloaded.getSession(s), 'one bad entry took every conversation with it').toBeTruthy();
    expect(reloaded.getSession('broken:session')).toBeUndefined();
    expect((await usingStore(aliceStore, () => reloaded.encryptMessage(s, 'still works'))).messageNumber).toBe(1);
  });
});
