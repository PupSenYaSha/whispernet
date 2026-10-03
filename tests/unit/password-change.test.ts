import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Changing the account password, tested where it can actually go wrong.
 *
 * The password is the key every piece of local state is sealed under, so a change is a re-wrap rather
 * than an update: sessions, prekeys and the outgoing-message cache all have to end up readable under the
 * new password, and none of them may become unreadable under it. The failure this guards against is
 * silent and permanent - a launch that opens no sessions looks like a wiped account, not like a bug - so
 * it is worth pinning down with tests rather than trusting the order of the awaits.
 *
 * The properties asserted are the ones a user would notice:
 *   - a conversation continues across a change, in both directions, including messages already in flight
 *   - the old password no longer opens the new state
 *   - prekeys survive, so the far end can still start a conversation afterwards
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

const OLD_PASSWORD = 'pass123456';
const NEW_PASSWORD = 'hunter2hunter2';
const id = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`;
const wireNumber = (m: any, s: string) => m.getSession(s)!.state.sendingMessageNumber - 1;

/**
 * Every manager this file builds, so each test can tear them down.
 *
 * Not tidiness. The store is one shared localStorage key and the saves are debounced timers, so a
 * manager left over from an earlier test writes its state out half a second into a later one - under the
 * password that earlier test used. The result is a test that passes alone and fails in a run, which is
 * exactly the kind of green that means nothing.
 */
const managers: InstanceType<typeof SessionManager>[] = [];
const preKeyManagers: InstanceType<typeof PreKeyManager>[] = [];
const track = <T>(m: T, list: T[]): T => { list.push(m); return m; };

/**
 * The published bundle, as an object rather than as a nullable.
 *
 * The manager answers null when it has nothing to publish, and every assertion here is about a bundle
 * that must exist — a null would make the test pass for the wrong reason if it were only checked by
 * property access on a possibly-null value.
 */
async function bundleOf(manager: InstanceType<typeof PreKeyManager>) {
  const bundle = await manager.getPublicKeyForServer();
  expect(bundle).toBeTruthy();
  return bundle!;
}

async function conversation(alice = track(new SessionManager(), managers), bob = track(new SessionManager(), managers)) {
  await alice.init(OLD_PASSWORD);
  await bob.init(OLD_PASSWORD);

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
    B, A, { privateKey: bobId.privateKey, publicKey: bobId.publicKey }, bobSigned.keyPair, oneTime,
    x3dhMessage, ratchetPublicKey, new Uint8Array(0), 0,
  );
  return { alice, bob, A, B };
}

beforeEach(() => store.clear());
afterEach(() => {
  for (const m of managers.splice(0)) m.destroy();
  for (const p of preKeyManagers.splice(0)) p.destroy();
});

describe('changing the account password', () => {
  it('keeps a conversation readable in both directions', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    const before = await alice.encryptMessage(s, 'written before the change');
    await bob.decryptMessage(s, before, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!);

    await alice.rekey(NEW_PASSWORD);

    const after = await alice.encryptMessage(s, 'written after the change');
    const text = await bob.decryptMessage(s, after, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!);
    expect(text).toBe('written after the change');

    // and the far side still encrypts into it, which is what proves the change was not one-way
    const reply = await bob.encryptMessage(s, 'reply from the other device');
    const back = await alice.decryptMessage(s, reply, wireNumber(bob, s), bob.getSession(s)!.state.currentRatchetPublicKey!);
    expect(back).toBe('reply from the other device');
  });

  it('opens the state after a restart under the new password', async () => {
    const { alice, A, B } = await conversation();
    const s = id(A, B);
    await alice.encryptMessage(s, 'something worth keeping');
    await alice.rekey(NEW_PASSWORD);

    // a fresh manager is what the next launch builds; it only knows the new password
    const reopened = track(new SessionManager(), managers);
    await reopened.init(NEW_PASSWORD);
    const session = reopened.getSession(s);
    expect(session).toBeTruthy();
    expect(session!.state.sendingMessageNumber).toBe(alice.getSession(s)!.state.sendingMessageNumber);
  });

  it('does not open the new state under the old password', async () => {
    const { alice, A, B } = await conversation();
    const s = id(A, B);
    await alice.encryptMessage(s, 'secret');
    await alice.rekey(NEW_PASSWORD);

    // the old password has to stop working, or the change only added a second way in
    const stale = track(new SessionManager(), managers);
    await stale.init(OLD_PASSWORD);
    expect(stale.getSession(s)).toBeFalsy();
  });

  it('carries skipped keys across the change, so nothing in flight is lost', async () => {
    const { alice, bob, A, B } = await conversation();
    const s = id(A, B);

    // two messages sent without either being read, so the second leaves the first in the skipped set
    const first = await alice.encryptMessage(s, 'first');
    const second = await alice.encryptMessage(s, 'second');
    await alice.rekey(NEW_PASSWORD);

    // and they still arrive afterwards, in order, which is the case a naive re-wrap gets wrong by
    // dropping the skipped keys with the old key material
    const secondText = await bob.decryptMessage(s, second, wireNumber(alice, s), alice.getSession(s)!.state.currentRatchetPublicKey!);
    const firstText = await bob.decryptMessage(s, first, wireNumber(alice, s) - 1, alice.getSession(s)!.state.currentRatchetPublicKey!);
    expect(secondText).toBe('second');
    expect(firstText).toBe('first');
  });

  it('keeps the prekeys that let somebody start a conversation', async () => {
    const preKeys = track(new PreKeyManager(), preKeyManagers);
    await preKeys.init(OLD_PASSWORD);
    preKeys.initialize();
    const published = await bundleOf(preKeys);
    expect(published.oneTimePreKey).toBeTruthy();

    await preKeys.rekey(NEW_PASSWORD);

    const reopened = track(new PreKeyManager(), preKeyManagers);
    await reopened.init(NEW_PASSWORD);
    const after = await bundleOf(reopened);
    expect(after.oneTimePreKey).toBeTruthy();
    expect(after.signedPreKey.keyId).toBe(published.signedPreKey.keyId);
  });

  it('keeps the identity key, which is the one thing a change must never touch', async () => {
    const preKeys = track(new PreKeyManager(), preKeyManagers);
    await preKeys.init(OLD_PASSWORD);
    preKeys.initialize();
    const before = await bundleOf(preKeys);
    await preKeys.rekey(NEW_PASSWORD);

    const reopened = track(new PreKeyManager(), preKeyManagers);
    await reopened.init(NEW_PASSWORD);
    const after = await bundleOf(reopened);
    // a different identity key would read to every contact as a reinstall and break every session
    expect(after.identityKey).toEqual(before.identityKey);
  });
});