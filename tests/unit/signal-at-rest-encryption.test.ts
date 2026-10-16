import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Nothing readable may reach localStorage, ever.
 *
 * Both managers used to fall back to writing their state as raw JSON whenever their encryption key was
 * missing. In the code as it stands neither path was reachable - the key is always set before the state
 * exists, and the one call that drops the key empties the state in the same tick - so this is a test of the
 * invariant rather than of a bug that was being exploited, and it is here because "unreachable today" is a
 * property of the call order in two other files, not something either class enforces.
 *
 * What it does check is that the invariant holds from the outside: whatever these two classes do, and in
 * whatever order, no readable key material appears in the store. The mutation that matters is a one-line
 * change in either class, and this is what notices.
 *
 * The prekey case is the one worth the name. The state it holds is the account's private identity key -
 * the thing that would let somebody else read as this account at all - and `PreKeyManager` exposes
 * `initialize()` publicly, so "the key is set before the state exists" is an ordering fact about
 * `dmCrypto.ts` rather than a guarantee of the class.
 */

/** A real store, so a write and a read behave as they do in a browser. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  get keys() { return [...this.map.keys()]; }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as any).localStorage = store;
});

const SESSION_KEYS = ['wn_signal_sessions'];
const PREKEY_KEYS = ['wn_signal_ik', 'wn_signal_spk', 'wn_signal_spk_history', 'wn_signal_opk'];

/** Everything written under the signal keys, concatenated, so a secret anywhere shows up. */
function everythingWritten(): string {
  return store.keys.map((k) => `${k}=${store.getItem(k)}`).join('\n');
}

/** The obvious tell: a raw private key byte array sitting in a value. */
function looksLikeRawKeys(): boolean {
  const all = everythingWritten();
  // A plaintext JSON blob has an array of 32-ish numbers in it; an AES-GCM envelope is base64 text.
  return /\[\s*\d{1,3}\s*,(\s*\d{1,3}\s*,){10,}/.test(all);
}

const { SessionManager } = await import('../../src/signal/session');
const { generateIdentityKeyPair, generateSignedPreKeyRecord, generateKeyPair } = await import('../../src/signal/keys');

/** A real conversation, so the store being inspected actually contains keys worth leaking. */
async function withAConversation(fn: (m: InstanceType<typeof SessionManager>) => Promise<void> | void): Promise<void> {
  const m = new SessionManager();
  await m.init('pass123456');
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
  await fn(m);
}

describe('the session store', () => {
  it('never holds a plaintext ratchet state', async () => {
    await withAConversation(async (m) => {
      // Saved while there is a key, so there is a real encrypted blob to begin with.
      m.flush();
      await new Promise((r) => setTimeout(r, 300));
      expect(store.getItem('wn_signal_sessions'), 'nothing was written at all').not.toBeNull();
      expect(looksLikeRawKeys(), 'the ordinary save already wrote raw JSON').toBe(false);

      // Then destroyed, which is what signing out and resetting an identity both do.
      m.destroy();

      // Anything left on disk must still be an envelope, never the raw state.
      for (const key of SESSION_KEYS) {
        const value = store.getItem(key);
        if (value === null) continue;
        const parsed = JSON.parse(value);
        expect(typeof parsed?.iv, `${key} is not an encrypted envelope`).toBe('string');
        expect(typeof parsed?.data, `${key} is not an encrypted envelope`).toBe('string');
      }
      expect(looksLikeRawKeys(), 'a ratchet state was written as raw JSON').toBe(false);
    });
  }, 30000);

  it('deletes an unencrypted store left by an older build', async () => {
    // Anyone who ran the version with the fallback may have one sitting in their profile right now. It
    // cannot be opened as a ciphertext, so there is nothing to migrate - only something to delete.
    store.setItem('wn_signal_sessions', JSON.stringify({
      'me:peer': { rootKey: [1, 2, 3], chainKey: [4, 5, 6], sendCount: 7 },
    }));

    const { SessionManager: SM } = await import('../../src/signal/session');
    const m = new SM();
    await m.init('pass123456');

    const left = store.getItem('wn_signal_sessions');
    if (left !== null) {
      expect(left, 'an unencrypted ratchet state survived').not.toMatch(/\[\s*\d+\s*,/);
      const parsed = JSON.parse(left);
      expect(typeof parsed?.iv, 'the leftover is not an encrypted envelope either').toBe('string');
    }
    expect(looksLikeRawKeys(), 'a ratchet state is still readable on disk').toBe(false);
  }, 30000);
});

describe('the prekey store', () => {
it('never holds a plaintext identity key', async () => {
    const { PreKeyManager } = await import('../../src/signal/prekey');
    const preKeyManager = new PreKeyManager();
    await preKeyManager.init('pass123456');
    preKeyManager.initialize();
    preKeyManager.flush();
    await new Promise((r) => setTimeout(r, 400));

    // Written while there is a key, so the store has real material in it - otherwise a plaintext fallback
    // would have nothing to leak and the check would pass for the wrong reason.
    expect(store.getItem('wn_signal_ik'), 'nothing was written at all').not.toBeNull();
    expect(looksLikeRawKeys(), 'the ordinary save already wrote raw JSON').toBe(false);

    // And the ordering that protects the class is not the class's doing, so it is asserted here directly.
    preKeyManager.destroy();
    preKeyManager.flush();
    await new Promise((r) => setTimeout(r, 300));
    expect(looksLikeRawKeys(), 'prekey material was written as raw JSON').toBe(false);
  }, 30000);

  it('deletes unencrypted identity material left by an older build', async () => {
    const { PreKeyManager } = await import('../../src/signal/prekey');
    const preKeyManager = new PreKeyManager();
    store.setItem('wn_signal_ik', JSON.stringify({
      privateKey: Array.from({ length: 32 }, (_, i) => i + 1),
      publicKey: Array.from({ length: 32 }, (_, i) => 200 - i),
      registrationId: 1,
    }));

    await preKeyManager.init('pass123456');

    const left = store.getItem('wn_signal_ik');
    // Either deleted, or rewritten as an envelope. What must never happen is it surviving as raw JSON.
    if (left !== null) {
      expect(left, 'an unencrypted identity key survived').not.toMatch(/\[\s*\d{1,3}\s*,(\s*\d{1,3}\s*,){10,}/);
    }
    expect(PREKEY_KEYS.some((k) => looksLikeRawKeys() && store.getItem(k) !== null), 'a private key stayed in the clear').toBe(false);
  }, 30000);
});
