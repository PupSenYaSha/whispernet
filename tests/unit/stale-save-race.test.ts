import { describe, it, expect, beforeEach } from 'vitest';

/**
 * A save that finishes after the manager it belonged to is gone.
 *
 * `destroy()` cancels timers. It cannot cancel a promise that has already passed its first `await`, and every
 * save here has one: the encryption or decryption is genuinely in flight while `destroy()` runs, and the
 * continuation then carries on against whatever the object has become.
 *
 * The damage is not theoretical, and in one direction it is *this codebase's* code doing it. A `doSave` that
 * resumes after `destroy()` has cleared the encryption key takes the fail-closed path and deletes the store -
 * but by then the store belongs to whoever came next. In a test suite sharing one mocked `localStorage` that
 * is the following test's data, removed by the previous test's pending write, which is the shape of a bug that
 * gets blamed on the wrong test for months.
 *
 * So the managers carry a generation counter, and every asynchronous read and write refuses to touch storage
 * if it has moved on. These tests reproduce the race by destroying the manager without awaiting, then letting
 * the microtask queue drain.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get keys() { return [...this.map.keys()]; }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as any).localStorage = store;
});

/** Lets every queued microtask and promise continuation run. */
const settle = () => new Promise((r) => setTimeout(r, 50));

/**
* Flushes and then waits for it.
 *
 * `flush()` returns void by design - it hands the write to a promise chain - so awaiting it waits for
 * nothing at all. Writing and then immediately reading the store is how a test convinces itself the write
 * landed when it had not started.
 */
const write = async (m: { flush: () => void }) => { m.flush(); await settle(); };
describe('a save that outlives its manager', () => {
  it('does not delete a store that now belongs to somebody else', async () => {
    const { SessionManager } = await import('../../src/signal/session');
    const { generateIdentityKeyPair, generateSignedPreKeyRecord, generateKeyPair } = await import('../../src/signal/keys');

    const bundleFor = (bobId: any, bobSigned: any, oneTime: any) => ({
      bundleVersion: 2,
      registrationId: bobId.registrationId,
      identityKey: bobId.publicKey,
      ed25519PublicKey: bobId.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: bobSigned.keyPair.publicKey, signature: bobSigned.signature, createdAt: Date.now() },
      oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
    });

    const first = new SessionManager();
    await first.init('pass123456');
    const aliceId = generateIdentityKeyPair();
    const bobId = generateIdentityKeyPair();
    const bobSigned = generateSignedPreKeyRecord(bobId.ed25519PrivateKey, 1);
    const oneTime = generateKeyPair();
    first.createInitiatorSession('alice', 'bob', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, bundleFor(bobId, bobSigned, oneTime) as any);
    await write(first);
    expect(store.getItem('wn_signal_sessions')).not.toBeNull();

    // The race: a save is started, the manager is destroyed before it can finish, and the store is then
    // replaced by "the next thing" - here, a different manager that has written its own state.
    first.createInitiatorSession('alice', 'carol', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, bundleFor(bobId, bobSigned, oneTime) as any);
    void first.flush();          // in flight, awaiting the encryption
    first.destroy();             // cancels the timer, cannot cancel the promise

    const second = new SessionManager();
    await second.init('pass123456');
    second.createInitiatorSession('dave', 'erin', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, bundleFor(bobId, bobSigned, oneTime) as any);
    await write(second);
    const written = store.getItem('wn_signal_sessions');
    expect(written, 'the second manager wrote nothing').not.toBeNull();

    await settle();

    // The stale write must not have removed the second manager's store, nor replaced it with the first's.
    expect(store.getItem('wn_signal_sessions'), "the finished save from the destroyed manager deleted the store").not.toBeNull();
    expect(store.getItem('wn_signal_sessions')).toBe(written);
  }, 60000);

  it('does not populate a torn-down manager from a load that was in flight', async () => {
    const { SessionManager } = await import('../../src/signal/session');
    const { generateIdentityKeyPair, generateSignedPreKeyRecord, generateKeyPair } = await import('../../src/signal/keys');
    const bobId = generateIdentityKeyPair();
    const bobSigned = generateSignedPreKeyRecord(bobId.ed25519PrivateKey, 1);
    const oneTime = generateKeyPair();
    const bundle = {
      bundleVersion: 2,
      registrationId: bobId.registrationId,
      identityKey: bobId.publicKey,
      ed25519PublicKey: bobId.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: bobSigned.keyPair.publicKey, signature: bobSigned.signature, createdAt: Date.now() },
      oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
    };

    const writer = new SessionManager();
    await writer.init('pass123456');
    const aliceId = generateIdentityKeyPair();
    writer.createInitiatorSession('alice', 'bob', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, bundle as any);
    await write(writer);

    const reader = new SessionManager();
    const loading = reader.init('pass123456');   // in flight, awaiting the decryption
    reader.destroy();                            // ...and torn down immediately

    await loading;
    await settle();

    // A destroyed manager has no sessions, and a stale read must not put them back into it.
    expect(reader.getSession('alice:bob'), 'a stale load populated a destroyed manager').toBeUndefined();
  }, 60000);

  it('does not leave a half-written prekey store behind', async () => {
    const { PreKeyManager } = await import('../../src/signal/prekey');

    const first = new PreKeyManager();
    await first.init('pass123456');
    first.initialize();
    await write(first);
    const keys = ['wn_signal_ik', 'wn_signal_spk', 'wn_signal_opk'];
    expect(keys.every((k) => store.getItem(k) !== null), 'the first manager wrote nothing').toBe(true);

    void first.flush();
    first.destroy();

    const second = new PreKeyManager();
    await second.init('pass123456');
    second.initialize();
    await write(second);
    const snapshot = keys.map((k) => store.getItem(k));

    await settle();

    // Four awaits means four chances to be torn down mid-write. A partial set is worse than none: it will not
    // open under any password.
    expect(keys.map((k) => store.getItem(k)), 'a stale save left the prekey store inconsistent').toEqual(snapshot);
  }, 60000);
});
