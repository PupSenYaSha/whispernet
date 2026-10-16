import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Changing the account password must not be able to destroy the key material.
 *
 * Both managers used to write the new salt first and then re-encrypt, which turned one failed write into a
 * permanent loss rather than a failed operation: a fresh salt over material still sealed under the old key
 * means the next launch derives a different key, cannot open the store, and there is nothing left anywhere
 * to recover it from. For the prekeys that means no incoming message can ever be opened again.
 *
 * The realistic way to hit it is the quota, and a password change is the moment the store is largest - so
 * this is not a theoretical ordering complaint. These tests fail the write on purpose and check that the
 * store still opens with the *old* password afterwards.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  /** Keys that throw on write, standing in for a full disk or a browser in private mode. */
  failWrites = new Set<string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) {
    if (this.failWrites.has(k)) { const e: any = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.map.set(k, v);
  }
  removeItem(k: string) { this.map.delete(k); }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as any).localStorage = store;
});

const OLD_PASSWORD = 'correct horse';
const NEW_PASSWORD = 'battery staple';

describe('the prekey store when the rewrite fails', () => {
  it('still opens with the old password', async () => {
    const { PreKeyManager } = await import('../../src/signal/prekey');
    const first = new PreKeyManager();
    await first.init(OLD_PASSWORD);
    first.initialize();
    first.flush();
    await new Promise((r) => setTimeout(r, 300));

    // The one-time prekey blob is the largest, so it is the one a full store refuses.
    store.failWrites.add('wn_signal_opk');

    const second = new PreKeyManager();
    await second.init(OLD_PASSWORD);
    second.initialize();
    await expect(second.rekey(NEW_PASSWORD)).rejects.toThrow();
    store.failWrites.clear();

    // A fresh manager on the same store, with the old password: if the salt moved without the blob, this
    // is where it shows up - and there is nothing that could be done about it at this point.
    const third = new PreKeyManager();
    await third.init(OLD_PASSWORD);
    expect(third.getIdentityKeyPair(), 'the identity key did not survive a failed password change').not.toBeNull();
    expect(third.getSignedPreKey(), 'the signed prekey did not survive').not.toBeNull();
  }, 60000);

  it('really did move the salt if the write was allowed', async () => {
    // The control for the test above. Without it, a rekey that silently did nothing would pass it.
    const { PreKeyManager } = await import('../../src/signal/prekey');
    const m = new PreKeyManager();
    await m.init(OLD_PASSWORD);
    m.initialize();
    m.flush();
    await new Promise((r) => setTimeout(r, 300));
    const before = store.getItem('wn_signal_prekey_salt');

    await m.rekey(NEW_PASSWORD);

    expect(store.getItem('wn_signal_prekey_salt'), 'the salt did not change on a successful rekey').not.toBe(before);

    const after = new PreKeyManager();
    await after.init(NEW_PASSWORD);
    expect(after.getIdentityKeyPair(), 'the new password does not open the store').not.toBeNull();
  }, 60000);
});

describe('the session store when the rewrite fails', () => {
  it('still opens with the old password', async () => {
    const { SessionManager } = await import('../../src/signal/session');
    const { generateIdentityKeyPair, generateSignedPreKeyRecord, generateKeyPair } = await import('../../src/signal/keys');

    const m = new SessionManager();
    await m.init(OLD_PASSWORD);
    const aliceId = generateIdentityKeyPair();
    const bobId = generateIdentityKeyPair();
    const bobSigned = generateSignedPreKeyRecord(bobId.ed25519PrivateKey, 1);
    const oneTime = generateKeyPair();
    m.createInitiatorSession('alice', 'bob', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, {
      bundleVersion: 2,
      registrationId: bobId.registrationId,
      identityKey: bobId.publicKey,
      ed25519PublicKey: bobId.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: bobSigned.keyPair.publicKey, signature: bobSigned.signature, createdAt: Date.now() },
      oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
    } as any);
    m.flush();
    await new Promise((r) => setTimeout(r, 300));

    store.failWrites.add('wn_signal_sessions');

    const second = new SessionManager();
    await second.init(OLD_PASSWORD);
    second.createInitiatorSession('alice', 'bob', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, {
      bundleVersion: 2,
      registrationId: bobId.registrationId,
      identityKey: bobId.publicKey,
      ed25519PublicKey: bobId.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: bobSigned.keyPair.publicKey, signature: bobSigned.signature, createdAt: Date.now() },
      oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
    } as any);
    await expect(second.rekey(NEW_PASSWORD)).rejects.toThrow();
    store.failWrites.clear();

    // The conversation must still be there, readable with the password that was in force before.
    const third = new SessionManager();
    await third.init(OLD_PASSWORD);
    third.createInitiatorSession('alice', 'bob', { privateKey: aliceId.privateKey, publicKey: aliceId.publicKey }, {
      bundleVersion: 2,
      registrationId: bobId.registrationId,
      identityKey: bobId.publicKey,
      ed25519PublicKey: bobId.ed25519PublicKey,
      signedPreKey: { keyId: 1, publicKey: bobSigned.keyPair.publicKey, signature: bobSigned.signature, createdAt: Date.now() },
      oneTimePreKey: { keyId: 1, publicKey: oneTime.publicKey },
    } as any);
    expect(third.getSession('alice:bob'), 'the conversation did not survive a failed password change').toBeDefined();
  }, 60000);
});
