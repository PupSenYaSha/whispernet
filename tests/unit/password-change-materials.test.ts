import { describe, it, expect } from 'vitest';
import { rekeyOwnMessageCache, rememberOwnMessageText, recallOwnMessageText, isValidClientMessageId } from '../../src/ownMessageCache';
import { encryptPrivateKey, decryptPrivateKey } from '../../src/crypto-keys';
import { validateNewPassword, changeAccountPassword } from '../../src/changePassword';
import { storePassword, clearStoredAuth, verifyStoredAuth } from '../../src/device-crypto';

/**
 * The parts of a password change that are not the ratchet.
 *
 * The ratchet stores are covered in `password-change.test.ts`, which builds real sessions and watches
 * them survive. What is left is the material around them: the cached plaintext of the account's own
 * outgoing messages, and the encrypted copy of the private key that the legacy envelope needs.
 *
 * The own-message cache is the one worth being careful about. It is a second store sealed under the same
 * password, and it is written on a timer. Getting the order wrong here does not fail loudly: it either
 * writes the words under the old password - leaving them readable with a password that was supposed to be
 * gone - or wipes them, taking the sender's own copy of the conversation with it.
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

/**
 * Enough of IndexedDB for the device key to live in it.
 *
 * The sign-in blob is sealed under a key held in IndexedDB, precisely so that a stolen localStorage file
 * does not hand over the credentials with it. That means a test of whether the *stored* password is right
 * has to stand up the store too — and without this the blob silently falls back to a scheme that proves
 * nothing, which is the exact failure this file exists to catch.
 */
function fakeIndexedDb(): void {
  const dbs = new Map<string, Map<string, unknown>>();
  (globalThis as any).indexedDB = {
    open(name: string) {
      const store = dbs.get(name) || new Map<string, unknown>();
      dbs.set(name, store);
      const db: any = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => undefined,
        transaction() {
          return {
            objectStore() {
              const settle = <T>(result: T) => {
                const req: any = { result, onsuccess: null, onerror: null };
                queueMicrotask(() => req.onsuccess?.());
                return req;
              };
              return {
                put(value: unknown, key: string) {
                  store.set(key, value);
                  return settle(key);
                },
                get(key: string) {
                  return settle(store.get(key));
                },
              };
            },
          };
        },
      };
      const request: any = { result: db, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      // `openDb` waits for onsuccess and then reads `request.result`, so both have to be in place before
      // it is called rather than being assigned onto the request afterwards
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}
fakeIndexedDb();

const OLD = 'pass123456';
const NEXT = 'hunter2hunter2';

describe('the own-message cache across a password change', () => {
  it('still opens under the new password afterwards', async () => {
    // written under the old one, the way a running tab has them
    rememberOwnMessageText('msgid1234567', 'what I wrote yesterday');
    await rekeyOwnMessageCache(OLD);

    // the tab still remembers them, because it typed them
    expect(recallOwnMessageText('msgid1234567')).toBe('what I wrote yesterday');

    await rekeyOwnMessageCache(NEXT);

    // and the copy on disk is under the new password: a reader with the old one gets nothing
    const raw = store.get('wn_own_dm_text');
    expect(raw).toBeTruthy();
    const { secureGet } = await import('../../src/secureStore');
    expect(await secureGet<Record<string, string>>('wn_own_dm_text', NEXT)).toBeTruthy();
    expect(await secureGet<Record<string, string>>('wn_own_dm_text', OLD)).toBeNull();
  });

  it('forgets them on signing out rather than leaving them under a live password', async () => {
    rememberOwnMessageText('msgid7654321', 'something private');
    await rekeyOwnMessageCache(OLD);
    await rekeyOwnMessageCache('');
    expect(recallOwnMessageText('msgid7654321')).toBeNull();
    const { secureGet } = await import('../../src/secureStore');
    expect(await secureGet('wn_own_dm_text', OLD)).toBeNull();
  });
});

describe('the private key blob across a password change', () => {
  it('reopens under the new password and not the old one', async () => {
    const { generateKeyPair } = await import('../../src/crypto');
    const keys = await generateKeyPair();

    const underOld = await encryptPrivateKey(keys.privateKey, OLD);
    await expect(decryptPrivateKey(underOld, OLD)).resolves.toBeTruthy();

    // the app rewrites the blob under the new password, since the legacy envelope needs it readable
    const underNew = await encryptPrivateKey(keys.privateKey, NEXT);
    const reopened = await decryptPrivateKey(underNew, NEXT);
    const original = JSON.stringify(keys.privateKey);
    expect(JSON.stringify(reopened)).toBe(original);
    await expect(decryptPrivateKey(underNew, OLD)).rejects.toBeTruthy();
  });
});

/**
 * The check that the current password is right, before anything is re-wrapped under a new one.
 *
 * This was wrong in a way worth pinning down. The old check sealed a blob with whatever was typed and
 * opened it again — which succeeds for *any* string, because it was sealed with that very string. So a
 * wrong password passed, and the change went on to re-wrap good key material under a password nobody
 * knew. The account was unreachable afterwards, with no way back.
 *
 * What is used now opens the blob this device actually had, which is sealed under the password the
 * account is genuinely on, so a wrong one cannot get past it.
 */
describe('checking the current password', () => {
  it('accepts the one the device is signed in with', async () => {
    await storePassword('someone', OLD);
    await expect(verifyStoredAuth(OLD)).resolves.toEqual({ ok: true });
  });

  it('rejects a wrong one, and says so rather than "no credentials"', async () => {
    await storePassword('someone', OLD);
    await expect(verifyStoredAuth('not-the-password')).resolves.toEqual({ ok: false, reason: 'wrong' });
    // these two have to be distinguishable: one means try again, the other means sign in first
    await expect(verifyStoredAuth('')).resolves.toEqual({ ok: false, reason: 'wrong' });
  });

  it('says so when the device has nothing stored to check against', async () => {
    clearStoredAuth();
    await expect(verifyStoredAuth(OLD)).resolves.toEqual({ ok: false, reason: 'none' });
  });

  it('refuses the change before touching anything when the password is wrong', async () => {
    await storePassword('someone', OLD);
    // the ratchet never starts, so there is nothing on disk to have been re-wrapped
    await expect(changeAccountPassword({
      nickname: 'someone', oldPassword: 'wrong', newPassword: NEXT,
    })).rejects.toThrow(/current password is wrong/);

    // and the old password still opens the stored credentials, which is the whole point
    await expect(verifyStoredAuth(OLD)).resolves.toEqual({ ok: true });
  });

  it('refuses a change that is not a change', async () => {
    await storePassword('someone', OLD);
    await expect(changeAccountPassword({
      nickname: 'someone', oldPassword: OLD, newPassword: OLD,
    })).rejects.toThrow(/unchanged/);
  });
});

describe('what a new password is accepted on', () => {
  it('rejects an empty, too short or mistyped one, and agrees on the two of them', () => {
    expect(validateNewPassword('', '')).toBe('password_required');
    expect(validateNewPassword('short', 'short')).toBe('password_too_short');
    expect(validateNewPassword('12345678', '87654321')).toBe('password_mismatch');
    expect(validateNewPassword('longenough', 'longenough')).toBeNull();
  });

  it('does not judge a password beyond length and agreement', () => {
    // a rule that rejects what somebody genuinely chose teaches them to reach for the one that passes,
    // so nothing else is checked here
    expect(validateNewPassword('aaaaaaaa', 'aaaaaaaa')).toBeNull();
    expect(validateNewPassword('Passw0rd!', 'Passw0rd!')).toBeNull();
  });
});

describe('client message ids', () => {
  it('are checked before anything is written under them', () => {
    // these come off the wire in the echo of an outgoing message, so a hostile or broken id must not
    // become a key in a store that gets encrypted to disk
    expect(isValidClientMessageId('../../wn_auth')).toBe(false);
    expect(isValidClientMessageId('')).toBe(false);
    expect(isValidClientMessageId('short')).toBe(false);
    expect(isValidClientMessageId('msgid1234567')).toBe(true);
  });
});