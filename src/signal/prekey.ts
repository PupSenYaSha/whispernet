import type { PreKeyRecord, SignedPreKeyRecord, PreKeyBundle } from './types';
import {
  generateIdentityKeyPair,
  generateSignedPreKeyRecord,
  generateOneTimePreKeys,
} from './keys';
import {
  PBKDF2_ITER,
  SIGNED_PREKEY_ROTATION_MS,
  MIN_ONE_TIME_PREKEYS,
  MAX_ONE_TIME_PREKEYS,
  PREKEY_BUNDLE_VERSION,
  KEY_PREFIX,
  storageKey,
} from './constants';
import { wipe } from './wipe';

/**
 * Signed prekeys this account has already rotated away from, kept long enough to still answer a message
 * that was built against one of them.
 *
 * The window is real: a sender fetches a bundle, and the message carrying the handshake may not arrive
 * for a while. If the recipient rotated in between, deriving the shared secret from its *current*
 * signed prekey produces a different secret, the first message never opens, and the conversation is
 * dead with nothing to retry against. Retaining the recent past of the rotation is what makes that
 * window survivable - it is the same reason the specification keeps old prekeys around.
 */
/** Roughly two rotation periods, which is longer than any plausible delivery delay. */
const SPK_HISTORY_MAX = 5;
const SPK_HISTORY_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Base64 in slices.
 *
 * `String.fromCharCode(...bytes)` throws once the array is long enough to exceed the argument limit. That
 * is bounded here by `MAX_ONE_TIME_PREKEYS` and so is not reachable today, but the failure it would cause is
 * worth naming: this is the encoder for every value the prekey store writes, the throw would land inside the
 * `catch` that wraps the save, and the store would stop being written *entirely* with nothing anywhere
 * saying so. `session.ts` hit exactly this and carries its own chunked copy for the same reason.
 */
const B64_CHUNK = 0x8000;
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + B64_CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  // The password as bytes, cleared as soon as the import has taken it. `secureStore.ts` does the same for its
  // identical buffer and this did not, which makes the omission a difference between two copies of one habit
  // rather than a decision. See ./wipe for what clearing does and does not buy - the `password` string is
  // still there either way.
  const passwordBytes = new TextEncoder().encode(password);
  let passKey: CryptoKey;
  try {
    passKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
  } finally {
    wipe(passwordBytes);
  }
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptValue(key: CryptoKey, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)
  );
  return JSON.stringify({ iv: bufToBase64(iv.buffer), data: bufToBase64(ciphertext) });
}

/**
 * Whether a stored value has the shape of an encrypted envelope.
 *
 * A shape test rather than a decryption attempt, and the difference matters: a wrong password and a
 * plaintext value both make `decryptValue` return null, but only one of them is a secret sitting on disk
 * that should be deleted rather than retried.
 */
function looksEncrypted(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed?.iv === 'string' && typeof parsed?.data === 'string';
  } catch {
    return false;
  }
}

async function decryptValue(key: CryptoKey, encrypted: string): Promise<string | null> {
  try {
    const { iv, data } = JSON.parse(encrypted);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(iv)) }, key, base64ToBuf(data)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function now(): number {
  return Date.now();
}

function isPreKeyExpired(createdAt: number, maxAgeMs: number): boolean {
  return now() - createdAt > maxAgeMs;
}

export class PreKeyManager {
  private identityKeyPair: ReturnType<typeof generateIdentityKeyPair> | null = null;
  /**
   * Bumped on `init` and `destroy`. Timers can be cancelled, but a promise that has already passed an `await`
   * cannot - so a save or a load that resumes after this manager has moved on writes into whatever owns the
   * storage now. See the same field on `SessionManager` for the long version.
   */
  private generation = 0;
  private signedPreKey: SignedPreKeyRecord | null = null;
  /** Signed prekeys that have been rotated out of `signedPreKey` but can still answer a message. */
  private signedPreKeyHistory: SignedPreKeyRecord[] = [];
  private oneTimePreKeys: PreKeyRecord[] = [];
  private publishedOpkKeyId: number | null = null;
  /**
   * The id the next generated one-time prekey gets.
   *
   * Monotonic on purpose, and it has to be a separate piece of state rather than something derived from
   * `oneTimePreKeys.length`. That length used to be the source, and keys are consumed from the *front* of
   * the array, so every time fifty of a hundred were spent the count fell to fifty and the next fifty were
   * handed ids fifty-one to a hundred - ids that were still in use by the keys sitting further down the
   * same array. `peekOneTimePreKey` and `consumeOneTimePreKey` both match on the first id they find, so an
   * initiator whose published bundle named one of those ids was answered with whichever of the two
   * happened to come first. If that was not the pair the server actually published, the handshake derives
   * a different secret on the far side and the conversation simply never opens - intermittently, and with
   * nothing in the logs to say why. The supply also grew past the hundred it is capped at, a generation at
   * a time.
   *
   * It is persisted with the keys and raised past whatever is already stored, so it survives a reload and
   * cannot be rewound by a state written before it existed.
   */
  private nextOpkKeyId = 1;
  private encryptionKey: CryptoKey | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The account this manager's store belongs to, and the storage keys it resolves to.
   *
   * Per account, and the reason is not tidiness. One namespace for the whole browser profile is one
   * namespace for every account that has ever been signed in to it, and the failure is not a lost
   * conversation but a *given away* one: the second account's password fails to decrypt the first account's
   * identity key, `loadEncrypted` leaves `this.identityKeyPair` as it was - the first account's - and
   * `initialize()` returns early because a key is already there. This device then publishes the first
   * account's identity key, signed prekey and one-time prekey to the second account's server row, so every
   * contact who does X3DH against it builds their session on somebody else's identity key.
   *
   * An empty id means the bare legacy keys, which only a manager built outside the app ever uses.
   */
  private accountId = '';
  private ikKey: string = KEY_PREFIX.identityKey;
  private spkKey: string = KEY_PREFIX.signedPreKey;
  private spkHistoryKey: string = KEY_PREFIX.signedPreKeyHistory;
  private opkKey: string = KEY_PREFIX.oneTimePreKeys;
  private prekeySaltKey: string = KEY_PREFIX.prekeySalt;

  constructor() {}

  async init(password: string, accountId?: string): Promise<void> {
    // Taken as a number, not `this.generation++`, because the awaits below are checked against *this* call.
    // `deriveKey` is slow enough for a `destroy()` to land inside it, and without the check a torn-down
    // manager is handed a key again and goes on to load a store into itself.
    const generation = this.generation + 1;
    this.generation = generation;
    this.accountId = accountId ?? '';
    this.ikKey = storageKey(KEY_PREFIX.identityKey, this.accountId);
    this.spkKey = storageKey(KEY_PREFIX.signedPreKey, this.accountId);
    this.spkHistoryKey = storageKey(KEY_PREFIX.signedPreKeyHistory, this.accountId);
    this.opkKey = storageKey(KEY_PREFIX.oneTimePreKeys, this.accountId);
    this.prekeySaltKey = storageKey(KEY_PREFIX.prekeySalt, this.accountId);
    const saltB64 = localStorage.getItem(this.prekeySaltKey);
    let salt: Uint8Array;
    if (saltB64) {
      salt = new Uint8Array(base64ToBuf(saltB64));
    } else {
      salt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem(this.prekeySaltKey, bufToBase64(salt.buffer as ArrayBuffer));
    }
    this.encryptionKey = await deriveKey(password, salt);
    if (generation !== this.generation) return;
    await this.loadEncrypted();
    if (generation !== this.generation) return;
    this.startRotationTimer();
  }

  private startRotationTimer(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rotationTimer = setInterval(() => this.maybeRotatePreKeys(), 6 * 60 * 60 * 1000);
    this.maybeRotatePreKeys();
  }

  private async maybeRotatePreKeys(): Promise<void> {
    if (this.signedPreKey && isPreKeyExpired(this.signedPreKey.createdAt, SIGNED_PREKEY_ROTATION_MS)) {
      await this.rotateSignedPreKey();
    }

    if (this.oneTimePreKeys.length < MIN_ONE_TIME_PREKEYS) {
      await this.replenishOneTimePreKeys();
    }
  }

  async rotateSignedPreKey(): Promise<void> {
    if (!this.identityKeyPair || !this.encryptionKey) return;

    const newSpk = generateSignedPreKeyRecord(
      this.identityKeyPair.ed25519PrivateKey,
      (this.signedPreKey?.keyId || 0) + 1
    );
    // the outgoing one goes into the history rather than being dropped, so a handshake already in
    // flight when the rotation happened can still be answered
    if (this.signedPreKey) this.signedPreKeyHistory.unshift(this.signedPreKey);
    this.pruneSignedPreKeyHistory();
    this.signedPreKey = newSpk;
    await this.save();
  }

  private pruneSignedPreKeyHistory(): void {
    const now = Date.now();
    this.signedPreKeyHistory = this.signedPreKeyHistory
      .filter((k) => now - (k.createdAt || 0) <= SPK_HISTORY_MAX_AGE_MS)
      .slice(0, SPK_HISTORY_MAX);
  }

  /**
   * The signed prekey a message was built against, current or rotated out.
   *
   * Falls back to the current one when the id is unknown, which is the best that can be done for a
   * message built against material this account no longer has.
   */
  getSignedPreKeyById(keyId: number | undefined): SignedPreKeyRecord | null {
    if (!this.signedPreKey) return null;
    if (keyId == null || !Number.isFinite(keyId)) return this.signedPreKey;
    if (this.signedPreKey.keyId === keyId) return this.signedPreKey;
    return this.signedPreKeyHistory.find((k) => k.keyId === keyId) || this.signedPreKey;
  }

  getSignedPreKeyHistoryCount(): number {
    return this.signedPreKeyHistory.length;
  }

  async replenishOneTimePreKeys(): Promise<void> {
    if (!this.identityKeyPair) return;

    const needed = MAX_ONE_TIME_PREKEYS - this.oneTimePreKeys.length;
    if (needed <= 0) return;

    // a contiguous run off the counter, and the counter moves with it - see the note on `nextOpkKeyId`
    const first = this.nextOpkKeyId;
    this.nextOpkKeyId = first + needed;
    this.oneTimePreKeys.push(...generateOneTimePreKeys(first, needed));
    await this.save();
  }

  async ensurePreKeysForBundle(): Promise<void> {
    await this.maybeRotatePreKeys();
    if (this.oneTimePreKeys.length === 0) {
      await this.replenishOneTimePreKeys();
    }
  }

  private async loadEncrypted(): Promise<void> {
    const generation = this.generation;
    try {
      const ikData = localStorage.getItem(this.ikKey);
      // An unencrypted value is a store written by a build that fell back to plaintext, and it holds the
      // account's private identity key. It cannot be read as a ciphertext, so there is nothing to keep -
      // and leaving it would mean a private key outliving the fix by however long nobody opens the app.
      if (ikData && this.encryptionKey && !looksEncrypted(ikData)) {
        console.warn('[signal] found unencrypted identity key material; removing it');
        this.clearMaterial();
        localStorage.removeItem(this.ikKey);
        localStorage.removeItem(this.spkKey);
        localStorage.removeItem(this.spkHistoryKey);
        localStorage.removeItem(this.opkKey);
        return;
      }
      if (ikData && this.encryptionKey) {
        const decrypted = await decryptValue(this.encryptionKey, ikData);
        // The store this read belongs to may have been torn down while it was being decrypted.
        if (generation !== this.generation) return;
        if (decrypted) {
          const parsed = JSON.parse(decrypted);
          this.identityKeyPair = {
            privateKey: new Uint8Array(parsed.privateKey),
            publicKey: new Uint8Array(parsed.publicKey),
            registrationId: parsed.registrationId,
            ed25519PublicKey: parsed.ed25519PublicKey ? new Uint8Array(parsed.ed25519PublicKey) : new Uint8Array(0),
            ed25519PrivateKey: parsed.ed25519PrivateKey ? new Uint8Array(parsed.ed25519PrivateKey) : new Uint8Array(0),
          };
        } else {
          // Encrypted, and it does not open under this account's password.
          //
          // The material this manager already holds belongs to whoever was signed in before it, and the
          // `if (decrypted)` guard used to step over it: the fields kept their previous values, so a
          // `destroy()` that cleared nothing left the *previous account's* identity key in place, and
          // `initialize()`'s `if (this.identityKeyPair) return` then declined to make this account one of
          // its own. What got published to the server afterwards was somebody else's key.
          //
          // An unopenable blob is not recoverable, so there is nothing to salvage; keeping foreign material
          // in memory to try again later is the part that cannot be justified.
          this.clearMaterial();
        }
      } else if (ikData) {
        const parsed = JSON.parse(ikData);
        this.identityKeyPair = {
          privateKey: new Uint8Array(parsed.privateKey),
          publicKey: new Uint8Array(parsed.publicKey),
          registrationId: parsed.registrationId,
          ed25519PublicKey: parsed.ed25519PublicKey ? new Uint8Array(parsed.ed25519PublicKey) : new Uint8Array(0),
          ed25519PrivateKey: parsed.ed25519PrivateKey ? new Uint8Array(parsed.ed25519PrivateKey) : new Uint8Array(0),
        };
      }

      const spkData = localStorage.getItem(this.spkKey);
      if (spkData && this.encryptionKey) {
        const decrypted = await decryptValue(this.encryptionKey, spkData);
        // Same rule as the identity key above: a blob that does not open is not "leave what was there".
        if (!decrypted) this.signedPreKey = null;
        if (decrypted) {
          const parsed = JSON.parse(decrypted);
          this.signedPreKey = {
            keyId: parsed.keyId,
            keyPair: {
              privateKey: new Uint8Array(parsed.privateKey),
              publicKey: new Uint8Array(parsed.publicKey),
            },
            signature: new Uint8Array(parsed.signature),
            createdAt: parsed.createdAt,
          };
        }
      } else if (spkData) {
        const parsed = JSON.parse(spkData);
        this.signedPreKey = {
          keyId: parsed.keyId,
          keyPair: {
            privateKey: new Uint8Array(parsed.privateKey),
            publicKey: new Uint8Array(parsed.publicKey),
          },
          signature: new Uint8Array(parsed.signature),
          createdAt: parsed.createdAt,
        };
      }

      const history = await this.loadSignedPreKeyHistory();
      // An unreadable history is an empty one; never the previous account's.
      if (generation !== this.generation) return;
      this.signedPreKeyHistory = history;

      const opkData = localStorage.getItem(this.opkKey);
      if (opkData && this.encryptionKey) {
        const decrypted = await decryptValue(this.encryptionKey, opkData);
        if (!decrypted) {
          // The supply and the two counters beside it go together: the id counter is persisted *with* the
          // keys so that a state written before it existed cannot rewind the numbering, which means keeping
          // a counter whose keys have just been discarded would hand out ids that are already spent.
          this.oneTimePreKeys = [];
          this.publishedOpkKeyId = null;
          this.nextOpkKeyId = 1;
        }
        if (decrypted) {
          const parsed = JSON.parse(decrypted);
          if (Array.isArray(parsed)) {
            this.oneTimePreKeys = parsed.map((k: any) => ({
              keyId: k.keyId,
              keyPair: {
                privateKey: new Uint8Array(k.privateKey),
                publicKey: new Uint8Array(k.publicKey),
              },
            }));
          } else {
            this.oneTimePreKeys = Array.isArray(parsed.keys) ? parsed.keys.map((k: any) => ({
              keyId: k.keyId,
              keyPair: {
                privateKey: new Uint8Array(k.privateKey),
                publicKey: new Uint8Array(k.publicKey),
              },
            })) : [];
            this.publishedOpkKeyId = typeof parsed.publishedKeyId === 'number' ? parsed.publishedKeyId : null;
            this.nextOpkKeyId = typeof parsed.nextKeyId === 'number' && parsed.nextKeyId > 0 ? parsed.nextKeyId : 1;
          }
        }
      } else if (opkData) {
        const parsed = JSON.parse(opkData);
        if (Array.isArray(parsed)) {
          this.oneTimePreKeys = parsed.map((k: any) => ({
            keyId: k.keyId,
            keyPair: {
              privateKey: new Uint8Array(k.privateKey),
              publicKey: new Uint8Array(k.publicKey),
            },
          }));
        } else {
          this.oneTimePreKeys = Array.isArray(parsed.keys) ? parsed.keys.map((k: any) => ({
            keyId: k.keyId,
            keyPair: {
              privateKey: new Uint8Array(k.privateKey),
              publicKey: new Uint8Array(k.publicKey),
            },
          })) : [];
          this.publishedOpkKeyId = typeof parsed.publishedKeyId === 'number' ? parsed.publishedKeyId : null;
          this.nextOpkKeyId = typeof parsed.nextKeyId === 'number' && parsed.nextKeyId > 0 ? parsed.nextKeyId : 1;
        }
      }
    } catch (e) {
      // Fail closed, the same way `SessionManager.loadEncrypted` does. A store that could not be read has to
      // leave nothing behind, because what it leaves behind would be treated as this account's.
      this.clearMaterial();
      console.error('[signal] failed to load prekey material:', e);
    }
  }

  /**
   * Empties every field of loaded prekey material.
   *
   * The point is not that a *load* can fail - it is what happens afterwards. Nothing in this class can tell a
   * freshly loaded key from one that was left over, so a key that survived a failed load is a key that gets
   * published, signed with, and treated as this account's own until something overwrites it.
   */
  private clearMaterial(): void {
    this.identityKeyPair = null;
    this.signedPreKey = null;
    this.signedPreKeyHistory = [];
    this.oneTimePreKeys = [];
    this.publishedOpkKeyId = null;
    this.nextOpkKeyId = 1;
  }

  private toStoredSpk(k: SignedPreKeyRecord): Record<string, unknown> {
    return {
      keyId: k.keyId,
      privateKey: Array.from(k.keyPair.privateKey),
      publicKey: Array.from(k.keyPair.publicKey),
      signature: Array.from(k.signature),
      createdAt: k.createdAt,
    };
  }

  private fromStoredSpk(parsed: any): SignedPreKeyRecord | null {
    if (!parsed || typeof parsed.keyId !== 'number' || !Array.isArray(parsed.privateKey)) return null;
    return {
      keyId: parsed.keyId,
      keyPair: { privateKey: new Uint8Array(parsed.privateKey), publicKey: new Uint8Array(parsed.publicKey || []) },
      signature: new Uint8Array(parsed.signature || []),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  }

  private async loadSignedPreKeyHistory(): Promise<SignedPreKeyRecord[]> {
    const raw = localStorage.getItem(this.spkHistoryKey);
    if (!raw) return [];
    let decoded: any = raw;
    if (this.encryptionKey) {
      const plain = await decryptValue(this.encryptionKey, raw);
      if (!plain) return [];
      decoded = plain;
    }
    try {
      const parsed = JSON.parse(decoded);
      if (!Array.isArray(parsed)) return [];
      const out = parsed.map((k) => this.fromStoredSpk(k)).filter((k): k is SignedPreKeyRecord => !!k);
      // never keep one that has fallen out of the retention window
      const now = Date.now();
      return out.filter((k) => now - (k.createdAt || 0) <= SPK_HISTORY_MAX_AGE_MS).slice(0, SPK_HISTORY_MAX);
    } catch {
      return [];
    }
  }

  save(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.doSave(), 500);
  }

  /**
   * Writes the pending state out now rather than in half a second.
   *
   * Losing an identity key is worse than losing a session: every conversation that was ever opened with
   * it can no longer be read by this device, and there is no key left anywhere to fix that. Every way of
   * leaving goes through here.
   */
  flush(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    void this.doSave();
  }

  /**
   * Re-encrypts the prekey store under a different account password.
   *
   * Same reasoning as the session store: the material is already in memory, so this is a re-wrap under a
   * fresh salt. Losing this would be worse than losing sessions - without the private prekeys no incoming
   * message could be opened at all, and every conversation would be permanently unreadable.
   */
  async rekey(newPassword: string): Promise<void> {
    const SALT = this.prekeySaltKey;
    const salt = crypto.getRandomValues(new Uint8Array(16));

    // Everything needed to undo this, taken before anything is touched.
    const oldSalt = localStorage.getItem(SALT);
    const oldValues: [string, string | null][] = [
      [this.ikKey, localStorage.getItem(this.ikKey)],
      [this.spkKey, localStorage.getItem(this.spkKey)],
      [this.spkHistoryKey, localStorage.getItem(this.spkHistoryKey)],
      [this.opkKey, localStorage.getItem(this.opkKey)],
    ];
    const previousKey = this.encryptionKey;

    try {
      // Derive first, then write the material, and only then move the salt.
      //
      // It used to write the salt first, which made one failed write unrecoverable rather than merely
      // unsuccessful: a new salt over material still sealed under the old key means the next launch derives
      // a different key, cannot open the store, and there is nothing left anywhere to recover it from - the
      // private prekeys are simply gone, and no incoming message can ever be opened again. Quota is the
      // realistic way to hit that, and a password change is exactly the moment the store is largest.
      //
      // The salt going last is what makes the failure repairable. While the old salt is still in charge the
      // only thing out of step is the blob, and the blob is the part this function can put back.
      const newKey = await deriveKey(newPassword, salt);
      this.encryptionKey = newKey;
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      await this.doSave();

      // Confirm every value reads back under the new key before committing the salt, so a store that was
      // partly written is caught here rather than on the next launch, when nothing can be done about it.
      //
      // All four, and by decrypting rather than by checking the shape. `doSave` swallows a write failure of
      // its own accord, and a shape check passes on the *old* ciphertext just as happily as on the new - so a
      // partial rewrite would sail through it and then strand one blob under a key the salt no longer names.
      for (const key of [this.ikKey, this.spkKey, this.spkHistoryKey, this.opkKey]) {
        const written = localStorage.getItem(key);
        if (written === null) continue;
        if (!(await decryptValue(this.encryptionKey, written))) {
          throw new Error(`the rewrapped ${key} did not read back`);
        }
      }
      localStorage.setItem(SALT, bufToBase64(salt.buffer as ArrayBuffer));
    } catch (e) {
      this.encryptionKey = previousKey;
      for (const [key, value] of oldValues) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
      if (oldSalt === null) localStorage.removeItem(SALT);
      else localStorage.setItem(SALT, oldSalt);
      throw e;
    }
  }

  private async doSave(): Promise<void> {
    const generation = this.generation;
    try {
      const ikData = this.identityKeyPair ? JSON.stringify({
        privateKey: Array.from(this.identityKeyPair.privateKey),
        publicKey: Array.from(this.identityKeyPair.publicKey),
        registrationId: this.identityKeyPair.registrationId,
        ed25519PublicKey: Array.from(this.identityKeyPair.ed25519PublicKey),
        ed25519PrivateKey: Array.from(this.identityKeyPair.ed25519PrivateKey),
      }) : null;

      const spkData = this.signedPreKey ? JSON.stringify(this.toStoredSpk(this.signedPreKey)) : null;
      const spkHistoryData = JSON.stringify(this.signedPreKeyHistory.map((k) => this.toStoredSpk(k)));

      const opkData = JSON.stringify({
        publishedKeyId: this.publishedOpkKeyId,
        nextKeyId: this.nextOpkKeyId,
        keys: this.oneTimePreKeys.map((k) => ({
          keyId: k.keyId,
          privateKey: Array.from(k.keyPair.privateKey),
          publicKey: Array.from(k.keyPair.publicKey),
        })),
      });

      // Refused rather than written in the clear, and the failure is loud. This used to fall through to storing
      // the identity key pair and every prekey as raw JSON, so a save with no key available would have put
      // the account's private signing and agreement keys into `localStorage` in the clear.
      //
      // Unlike the session manager's version of this, it was never reachable either: `initialize()` - the
      // only thing that populates the state - is called after `init()` has set the key, and `destroy()`
      // leaves the key in place. But this manager is the one that *does* expose `initialize()` as a public
      // method, so the ordering that protects it is a fact about two call sites rather than something the
      // class enforces. A leaked identity key is not a lost conversation, it is the thing that would let
      // somebody else read as this account, so the refusal is not optional.
      if (!this.encryptionKey) {
        console.error('[signal] refusing to persist prekey material unencrypted; discarding instead');
        localStorage.removeItem(this.ikKey);
        localStorage.removeItem(this.spkKey);
        localStorage.removeItem(this.spkHistoryKey);
        localStorage.removeItem(this.opkKey);
        return;
      }
      if (ikData) localStorage.setItem(this.ikKey, await encryptValue(this.encryptionKey, ikData));
      // Four awaits, so four chances for `destroy()` to land mid-write. Checked once here and then again
      // before the last write, because a partial set of keys belonging to a torn-down manager is worse than
      // none: it is a store that will not open under any password.
      if (generation !== this.generation) return;
      if (spkData) localStorage.setItem(this.spkKey, await encryptValue(this.encryptionKey, spkData));
      if (spkHistoryData) localStorage.setItem(this.spkHistoryKey, await encryptValue(this.encryptionKey, spkHistoryData));
      if (generation !== this.generation) return;
      localStorage.setItem(this.opkKey, await encryptValue(this.encryptionKey, opkData));
    } catch (e) {
      console.error('[signal] failed to persist prekey material:', e);
    }
  }

  destroy(): void {
    // Invalidates the promise chain, not just the timers. See `generation`.
    this.generation++;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    // The in-memory material goes with them. This is "turn every key off" and "sign out", and it is the whole
    // reason `App.tsx`'s `logout()` calls `stopSignalState()`: without it the previous account's private
    // identity key, prekeys and every chain key stayed loaded for whoever signed in next, in a tab that
    // looked signed out.
    this.clearMaterial();
  }

  /**
   * The store this manager would write, as `[key, value]` pairs.
   *
   * For `rekeySignalState`, which has to roll *both* stores back together: each manager's own `rekey`
   * restores only its own half, which is what let a failure in the second one leave the first committed.
   */
  storageSnapshot(): [string, string | null][] {
    return [
      [this.prekeySaltKey, localStorage.getItem(this.prekeySaltKey)],
      [this.ikKey, localStorage.getItem(this.ikKey)],
      [this.spkKey, localStorage.getItem(this.spkKey)],
      [this.spkHistoryKey, localStorage.getItem(this.spkHistoryKey)],
      [this.opkKey, localStorage.getItem(this.opkKey)],
    ];
  }

  /** Puts back a `storageSnapshot`, including removing keys that were not there. */
  restoreStorage(snapshot: [string, string | null][]): void {
    for (const [key, value] of snapshot) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  }

  initialize(): void {
    if (this.identityKeyPair) return;

    this.identityKeyPair = generateIdentityKeyPair();
    this.signedPreKey = generateSignedPreKeyRecord(
      this.identityKeyPair.ed25519PrivateKey,
      1
    );
    this.nextOpkKeyId = 1;
    this.oneTimePreKeys = generateOneTimePreKeys(1, MAX_ONE_TIME_PREKEYS);
    this.nextOpkKeyId = MAX_ONE_TIME_PREKEYS + 1;

    this.save();
    this.startRotationTimer();
  }

  getIdentityKeyPair(): ReturnType<typeof generateIdentityKeyPair> | null {
    return this.identityKeyPair;
  }

  getSignedPreKey(): SignedPreKeyRecord | null {
    return this.signedPreKey;
  }

  getOneTimePreKeysCount(): number {
    return this.oneTimePreKeys.length;
  }

  consumeOneTimePreKey(keyId?: number): PreKeyRecord | undefined {
    let index: number;
    if (keyId != null) {
      index = this.oneTimePreKeys.findIndex((k) => k.keyId === keyId);
      if (index < 0) return undefined;
    } else {
      index = 0;
    }
    const [opk] = this.oneTimePreKeys.splice(index, 1);
    if (!opk) return undefined;
    if (this.publishedOpkKeyId === opk.keyId) this.publishedOpkKeyId = null;
    this.save();
    return opk;
  }

  /**
   * The same lookup without spending the key.
   *
   * Consuming a one-time prekey is a one-way door: once it is gone, a message that turns out not to
   * authenticate can never be answered with it again. A server that replays a captured handshake could
   * therefore walk an account's whole supply away a hundred times over, after which every new
   * conversation starts without the one-time contribution and the forward secrecy it buys is gone. So
   * the key is only looked at while the handshake is being answered, and spent once the first message
   * has actually opened.
   */
  peekOneTimePreKey(keyId?: number): PreKeyRecord | undefined {
    if (keyId == null) return this.oneTimePreKeys[0];
    return this.oneTimePreKeys.find((k) => k.keyId === keyId);
  }

  private selectPublishedOpk(): PreKeyRecord | null {
    if (this.publishedOpkKeyId != null) {
      const existing = this.oneTimePreKeys.find((k) => k.keyId === this.publishedOpkKeyId);
      if (existing) return existing;
    }
    const opk = this.oneTimePreKeys[0] ?? null;
    if (opk) {
      this.publishedOpkKeyId = opk.keyId;
      this.save();
    }
    return opk;
  }

  async generatePreKeyBundle(): Promise<PreKeyBundle | null> {
    if (!this.identityKeyPair || !this.signedPreKey) return null;

    await this.ensurePreKeysForBundle();

    const bundle: PreKeyBundle = {
      bundleVersion: PREKEY_BUNDLE_VERSION,
      registrationId: this.identityKeyPair.registrationId,
      identityKey: this.identityKeyPair.publicKey,
      ed25519PublicKey: this.identityKeyPair.ed25519PublicKey,
      signedPreKey: {
        keyId: this.signedPreKey.keyId,
        publicKey: this.signedPreKey.keyPair.publicKey,
        signature: this.signedPreKey.signature,
        createdAt: this.signedPreKey.createdAt,
      },
    };

    const opk = this.selectPublishedOpk();
    if (opk) {
      bundle.oneTimePreKey = {
        keyId: opk.keyId,
        publicKey: opk.keyPair.publicKey,
      };
    }

    return bundle;
  }

  async getPublicKeyForServer(): Promise<{
    version: number;
    identityKey: string;
    ed25519PublicKey: string;
    signedPreKey: { keyId: number; publicKey: string; signature: string; createdAt: number };
    oneTimePreKey?: { keyId: number; publicKey: string };
  } | null> {
    if (!this.identityKeyPair || !this.signedPreKey) return null;

    await this.ensurePreKeysForBundle();

    const result: any = {
      version: PREKEY_BUNDLE_VERSION,
      identityKey: arrayToBase64(this.identityKeyPair.publicKey),
      ed25519PublicKey: arrayToBase64(this.identityKeyPair.ed25519PublicKey),
      signedPreKey: {
        keyId: this.signedPreKey.keyId,
        publicKey: arrayToBase64(this.signedPreKey.keyPair.publicKey),
        signature: Array.from(this.signedPreKey.signature),
        createdAt: this.signedPreKey.createdAt,
      },
    };

    const opk = this.selectPublishedOpk();
    if (opk) {
      result.oneTimePreKey = {
        keyId: opk.keyId,
        publicKey: arrayToBase64(opk.keyPair.publicKey),
      };
    }

    return result;
  }
}

function arrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}