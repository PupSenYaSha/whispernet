import type { PreKeyRecord, SignedPreKeyRecord, PreKeyBundle } from './types';
import {
  generateIdentityKeyPair,
  generateSignedPreKeyRecord,
  generateOneTimePreKeys,
} from './keys';

const IK_KEY = 'wn_signal_ik';
const SPK_KEY = 'wn_signal_spk';
const OPK_KEY = 'wn_signal_opk';
const PBKDF2_ITER = 600_000;

const SIGNED_PREKEY_ROTATION_DAYS = 14;
const MIN_ONE_TIME_PREKEYS = 50;
const MAX_ONE_TIME_PREKEYS = 100;
const PREKEY_BUNDLE_VERSION = 2;

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
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
  private signedPreKey: SignedPreKeyRecord | null = null;
  private oneTimePreKeys: PreKeyRecord[] = [];
  private encryptionKey: CryptoKey | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {}

  async init(password: string): Promise<void> {
    const saltB64 = localStorage.getItem('wn_signal_prekey_salt');
    let salt: Uint8Array;
    if (saltB64) {
      salt = new Uint8Array(base64ToBuf(saltB64));
    } else {
      salt = crypto.getRandomValues(new Uint8Array(16));
      localStorage.setItem('wn_signal_prekey_salt', bufToBase64(salt.buffer as ArrayBuffer));
    }
    this.encryptionKey = await deriveKey(password, salt);
    await this.loadEncrypted();
    this.startRotationTimer();
  }

  private startRotationTimer(): void {
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    this.rotationTimer = setInterval(() => this.maybeRotatePreKeys(), 6 * 60 * 60 * 1000);
    this.maybeRotatePreKeys();
  }

  private async maybeRotatePreKeys(): Promise<void> {
    const spkMaxAge = SIGNED_PREKEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;

    if (this.signedPreKey && isPreKeyExpired(this.signedPreKey.createdAt, spkMaxAge)) {
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
    this.signedPreKey = newSpk;
    await this.save();
  }

  async replenishOneTimePreKeys(): Promise<void> {
    if (!this.identityKeyPair) return;

    const needed = MAX_ONE_TIME_PREKEYS - this.oneTimePreKeys.length;
    if (needed <= 0) return;

    const newKeys = generateOneTimePreKeys(
      this.oneTimePreKeys.length + 1,
      this.oneTimePreKeys.length + needed
    );
    this.oneTimePreKeys.push(...newKeys);
    await this.save();
  }

  async ensurePreKeysForBundle(): Promise<void> {
    await this.maybeRotatePreKeys();
    if (this.oneTimePreKeys.length === 0) {
      await this.replenishOneTimePreKeys();
    }
  }

  private async loadEncrypted(): Promise<void> {
    try {
      const ikData = localStorage.getItem(IK_KEY);
      if (ikData && this.encryptionKey) {
        const decrypted = await decryptValue(this.encryptionKey, ikData);
        if (decrypted) {
          const parsed = JSON.parse(decrypted);
          this.identityKeyPair = {
            privateKey: new Uint8Array(parsed.privateKey),
            publicKey: new Uint8Array(parsed.publicKey),
            registrationId: parsed.registrationId,
            ed25519PublicKey: parsed.ed25519PublicKey ? new Uint8Array(parsed.ed25519PublicKey) : new Uint8Array(0),
            ed25519PrivateKey: parsed.ed25519PrivateKey ? new Uint8Array(parsed.ed25519PrivateKey) : new Uint8Array(0),
          };
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

      const spkData = localStorage.getItem(SPK_KEY);
      if (spkData && this.encryptionKey) {
        const decrypted = await decryptValue(this.encryptionKey, spkData);
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

      const opkData = localStorage.getItem(OPK_KEY);
      if (opkData && this.encryptionKey) {
        const decrypted = await decryptValue(this.encryptionKey, opkData);
        if (decrypted) {
          const parsed = JSON.parse(decrypted);
          this.oneTimePreKeys = parsed.map((k: any) => ({
            keyId: k.keyId,
            keyPair: {
              privateKey: new Uint8Array(k.privateKey),
              publicKey: new Uint8Array(k.publicKey),
            },
          }));
        }
      } else if (opkData) {
        const parsed = JSON.parse(opkData);
        this.oneTimePreKeys = parsed.map((k: any) => ({
          keyId: k.keyId,
          keyPair: {
            privateKey: new Uint8Array(k.privateKey),
            publicKey: new Uint8Array(k.publicKey),
          },
        }));
      }
    } catch {
    }
  }

  save(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.doSave(), 500);
  }

  private async doSave(): Promise<void> {
    try {
      const ikData = this.identityKeyPair ? JSON.stringify({
        privateKey: Array.from(this.identityKeyPair.privateKey),
        publicKey: Array.from(this.identityKeyPair.publicKey),
        registrationId: this.identityKeyPair.registrationId,
        ed25519PublicKey: Array.from(this.identityKeyPair.ed25519PublicKey),
        ed25519PrivateKey: Array.from(this.identityKeyPair.ed25519PrivateKey),
      }) : null;

      const spkData = this.signedPreKey ? JSON.stringify({
        keyId: this.signedPreKey.keyId,
        privateKey: Array.from(this.signedPreKey.keyPair.privateKey),
        publicKey: Array.from(this.signedPreKey.keyPair.publicKey),
        signature: Array.from(this.signedPreKey.signature),
        createdAt: this.signedPreKey.createdAt,
      }) : null;

      const opkData = JSON.stringify(
        this.oneTimePreKeys.map((k) => ({
          keyId: k.keyId,
          privateKey: Array.from(k.keyPair.privateKey),
          publicKey: Array.from(k.keyPair.publicKey),
        }))
      );

      if (this.encryptionKey) {
        if (ikData) localStorage.setItem(IK_KEY, await encryptValue(this.encryptionKey, ikData));
        if (spkData) localStorage.setItem(SPK_KEY, await encryptValue(this.encryptionKey, spkData));
        localStorage.setItem(OPK_KEY, await encryptValue(this.encryptionKey, opkData));
      } else {
        if (ikData) localStorage.setItem(IK_KEY, ikData);
        if (spkData) localStorage.setItem(SPK_KEY, spkData);
        localStorage.setItem(OPK_KEY, opkData);
      }
    } catch {
    }
  }

  destroy(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    if (this.rotationTimer) clearInterval(this.rotationTimer);
  }

  initialize(): void {
    if (this.identityKeyPair) return;

    this.identityKeyPair = generateIdentityKeyPair();
    this.signedPreKey = generateSignedPreKeyRecord(
      this.identityKeyPair.ed25519PrivateKey,
      1
    );
    this.oneTimePreKeys = generateOneTimePreKeys(1, MAX_ONE_TIME_PREKEYS);

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

  consumeOneTimePreKey(): PreKeyRecord | undefined {
    const opk = this.oneTimePreKeys.shift();
    if (opk) this.save();
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

    if (this.oneTimePreKeys.length > 0) {
      const opk = this.oneTimePreKeys.shift()!;
      this.save();
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

    if (this.oneTimePreKeys.length > 0) {
      const opk = this.oneTimePreKeys.shift()!;
      this.save();
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