import type { PreKeyRecord, SignedPreKeyRecord, PreKeyBundle } from './types';
import {
  generateIdentityKeyPair,
  generateSignedPreKeyRecord,
  generateOneTimePreKeys,
} from './keys';

const IK_KEY = 'wn_signal_ik';
const SPK_KEY = 'wn_signal_spk';
const OPK_KEY = 'wn_signal_opk';

export class PreKeyManager {
  private identityKeyPair: ReturnType<typeof generateIdentityKeyPair> | null = null;
  private signedPreKey: SignedPreKeyRecord | null = null;
  private oneTimePreKeys: PreKeyRecord[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const ikData = localStorage.getItem(IK_KEY);
      if (ikData) {
        const parsed = JSON.parse(ikData);
        this.identityKeyPair = {
          privateKey: new Uint8Array(parsed.privateKey),
          publicKey: new Uint8Array(parsed.publicKey),
          registrationId: parsed.registrationId,
        };
      }

      const spkData = localStorage.getItem(SPK_KEY);
      if (spkData) {
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
      if (opkData) {
        const parsed = JSON.parse(opkData);
        this.oneTimePreKeys = parsed.map((k: any) => ({
          keyId: k.keyId,
          keyPair: {
            privateKey: new Uint8Array(k.privateKey),
            publicKey: new Uint8Array(k.publicKey),
          },
        }));
      }
    } catch {}
  }

  save(): void {
    if (this.identityKeyPair) {
      localStorage.setItem(
        IK_KEY,
        JSON.stringify({
          privateKey: Array.from(this.identityKeyPair.privateKey),
          publicKey: Array.from(this.identityKeyPair.publicKey),
          registrationId: this.identityKeyPair.registrationId,
        })
      );
    }

    if (this.signedPreKey) {
      localStorage.setItem(
        SPK_KEY,
        JSON.stringify({
          keyId: this.signedPreKey.keyId,
          privateKey: Array.from(this.signedPreKey.keyPair.privateKey),
          publicKey: Array.from(this.signedPreKey.keyPair.publicKey),
          signature: Array.from(this.signedPreKey.signature),
          createdAt: this.signedPreKey.createdAt,
        })
      );
    }

    localStorage.setItem(
      OPK_KEY,
      JSON.stringify(
        this.oneTimePreKeys.map((k) => ({
          keyId: k.keyId,
          privateKey: Array.from(k.keyPair.privateKey),
          publicKey: Array.from(k.keyPair.publicKey),
        }))
      )
    );
  }

  initialize(): void {
    if (this.identityKeyPair) return;

    this.identityKeyPair = generateIdentityKeyPair();
    this.signedPreKey = generateSignedPreKeyRecord(
      this.identityKeyPair.privateKey,
      1
    );
    this.oneTimePreKeys = generateOneTimePreKeys(1, 10);

    this.save();
  }

  getIdentityKeyPair(): ReturnType<typeof generateIdentityKeyPair> | null {
    return this.identityKeyPair;
  }

  getSignedPreKey(): SignedPreKeyRecord | null {
    return this.signedPreKey;
  }

  consumeOneTimePreKey(): PreKeyRecord | undefined {
    return this.oneTimePreKeys.shift();
  }

  generatePreKeyBundle(): PreKeyBundle | null {
    if (!this.identityKeyPair || !this.signedPreKey) return null;

    const bundle: PreKeyBundle = {
      registrationId: this.identityKeyPair.registrationId,
      identityKey: this.identityKeyPair.publicKey,
      signedPreKey: {
        keyId: this.signedPreKey.keyId,
        publicKey: this.signedPreKey.keyPair.publicKey,
        signature: this.signedPreKey.signature,
      },
    };

    if (this.oneTimePreKeys.length > 0) {
      bundle.oneTimePreKey = {
        keyId: this.oneTimePreKeys[0].keyId,
        publicKey: this.oneTimePreKeys[0].keyPair.publicKey,
      };
    }

    return bundle;
  }

  getPublicKeyForServer(): {
    identityKey: string;
    signedPreKey: { keyId: number; publicKey: string; signature: string };
    oneTimePreKey?: { keyId: number; publicKey: string };
  } | null {
    if (!this.identityKeyPair || !this.signedPreKey) return null;

    const result: any = {
      identityKey: arrayToBase64(this.identityKeyPair.publicKey),
      signedPreKey: {
        keyId: this.signedPreKey.keyId,
        publicKey: arrayToBase64(this.signedPreKey.keyPair.publicKey),
        signature: Array.from(this.signedPreKey.signature),
      },
    };

    if (this.oneTimePreKeys.length > 0) {
      const opk = this.oneTimePreKeys[0];
      this.oneTimePreKeys.shift();
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
