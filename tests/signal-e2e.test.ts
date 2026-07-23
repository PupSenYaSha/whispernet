import { describe, it, expect } from 'vitest';
import { generateKeyPair, generateIdentityKeyPair, generateSignedPreKeyRecord, generateOneTimePreKeys, signKey, verifyKey, encodeKeyPair, decodeKeyPair } from '../src/signal/keys';
import { x3dhInit, x3dhRespond } from '../src/signal/x3dh';
import { createRatchetState, initializeRatchetAsSender, initializeRatchetAsReceiver, advanceSendingChain, advanceReceivingChain, ratchetStep } from '../src/signal/ratchet';
import { SessionManager } from '../src/signal/session';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const INFO_ROOT = new TextEncoder().encode('WhisperNetRoot');

describe('Signal Protocol E2E', () => {
  describe('Key Generation', () => {
    it('generates valid x25519 key pairs', () => {
      const kp = generateKeyPair();
      expect(kp.privateKey).toBeInstanceOf(Uint8Array);
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.privateKey.length).toBe(32);
      expect(kp.publicKey.length).toBe(32);
    });

    it('generates unique key pairs each time', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(kp1.privateKey).not.toEqual(kp2.privateKey);
      expect(kp1.publicKey).not.toEqual(kp2.publicKey);
    });

    it('generates identity key pairs with registration ID', () => {
      const ik = generateIdentityKeyPair();
      expect(ik.privateKey.length).toBe(32);
      expect(ik.publicKey.length).toBe(32);
      expect(typeof ik.registrationId).toBe('number');
      expect(ik.registrationId).toBeGreaterThanOrEqual(0);
    });

    it('generates signed pre-key records', () => {
      const ik = generateIdentityKeyPair();
      const spk = generateSignedPreKeyRecord(ik.ed25519PrivateKey, 1);
      expect(spk.keyId).toBe(1);
      expect(spk.keyPair.privateKey.length).toBe(32);
      expect(spk.signature.length).toBe(64);
      expect(spk.createdAt).toBeGreaterThan(0);
    });

    it('generates one-time pre-keys', () => {
      const opks = generateOneTimePreKeys(0, 5);
      expect(opks.length).toBe(5);
      opks.forEach((opk, i) => {
        expect(opk.keyId).toBe(i);
        expect(opk.keyPair.privateKey.length).toBe(32);
      });
    });
  });

  describe('Key Signing & Verification', () => {
    it('signs and verifies a key', () => {
      const ik = generateIdentityKeyPair();
      const kp = generateKeyPair();
      const sig = signKey(ik.ed25519PrivateKey, kp.publicKey);
      expect(sig.length).toBe(64);
      expect(verifyKey(ik.ed25519PublicKey, sig, kp.publicKey)).toBe(true);
    });

    it('rejects invalid signature', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      const ik1 = generateIdentityKeyPair();
      const ik2 = generateIdentityKeyPair();
      const sig = signKey(ik1.ed25519PrivateKey, kp1.publicKey);
      expect(verifyKey(ik2.ed25519PublicKey, sig, kp1.publicKey)).toBe(false);
    });
  });

  describe('Key Encode/Decode', () => {
    it('roundtrips key pair through encode/decode', () => {
      const kp = generateKeyPair();
      const encoded = encodeKeyPair(kp);
      const decoded = decodeKeyPair(encoded);
      expect(decoded.privateKey).toEqual(kp.privateKey);
      expect(decoded.publicKey).toEqual(kp.publicKey);
    });
  });

  describe('X3DH Key Agreement', () => {
    it('performs full X3DH handshake', () => {
      const aliceIK = generateIdentityKeyPair();
      const bobIK = generateIdentityKeyPair();
      const bobSPK = generateSignedPreKeyRecord(bobIK.ed25519PrivateKey, 1);
      const bobOPK = generateOneTimePreKeys(0, 1)[0];

      const bundle = {
        registrationId: bobIK.registrationId,
        identityKey: bobIK.publicKey,
        ed25519PublicKey: bobIK.ed25519PublicKey,
        signedPreKey: {
          keyId: bobSPK.keyId,
          publicKey: bobSPK.keyPair.publicKey,
          signature: bobSPK.signature,
        },
        oneTimePreKey: {
          keyId: bobOPK.keyId,
          publicKey: bobOPK.keyPair.publicKey,
        },
      };

      const aliceRatchetKP = generateKeyPair();
      const { sharedSecret, message } = x3dhInit(aliceIK, bundle, aliceRatchetKP.publicKey);

      expect(sharedSecret).toBeInstanceOf(Uint8Array);
      expect(sharedSecret.length).toBe(32);
      expect(message.baseKey).toBeInstanceOf(Uint8Array);
      expect(message.identityKey).toBeInstanceOf(Uint8Array);

      const bobSharedSecret = x3dhRespond(
        bobIK,
        { privateKey: bobSPK.keyPair.privateKey, publicKey: bobSPK.keyPair.publicKey },
        { privateKey: bobOPK.keyPair.privateKey, publicKey: bobOPK.keyPair.publicKey },
        message
      );

      expect(bobSharedSecret).toEqual(sharedSecret);
    });

    it('X3DH works without one-time pre-key', () => {
      const aliceIK = generateIdentityKeyPair();
      const bobIK = generateIdentityKeyPair();
      const bobSPK = generateSignedPreKeyRecord(bobIK.ed25519PrivateKey, 1);

      const bundle = {
        registrationId: bobIK.registrationId,
        identityKey: bobIK.publicKey,
        ed25519PublicKey: bobIK.ed25519PublicKey,
        signedPreKey: {
          keyId: bobSPK.keyId,
          publicKey: bobSPK.keyPair.publicKey,
          signature: bobSPK.signature,
        },
      };

      const aliceRatchetKP = generateKeyPair();
      const { sharedSecret, message } = x3dhInit(aliceIK, bundle, aliceRatchetKP.publicKey);

      const bobSharedSecret = x3dhRespond(
        bobIK,
        { privateKey: bobSPK.keyPair.privateKey, publicKey: bobSPK.keyPair.publicKey },
        null,
        message
      );

      expect(bobSharedSecret).toEqual(sharedSecret);
    });
  });

  describe('Double Ratchet', () => {
    it('initializes sender and receiver ratchet states', () => {
      const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
      const bobRatchetKP = generateKeyPair();

      const sender = initializeRatchetAsSender(sharedSecret, bobRatchetKP.publicKey);
      expect(sender.state.sendingChainKey).not.toBeNull();
      expect(sender.state.currentRatchetPublicKey).not.toBeNull();

      const receiver = initializeRatchetAsReceiver(sharedSecret, sender.state.currentRatchetPublicKey!, bobRatchetKP);
      expect(receiver.state.receivingChainKey).not.toBeNull();
    });

    it('sender and receiver produce matching message keys', () => {
      const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
      const bobRatchetKP = generateKeyPair();

      const sender = initializeRatchetAsSender(sharedSecret, bobRatchetKP.publicKey);
      const msgKey1 = advanceSendingChain(sender.state);

      const receiver = initializeRatchetAsReceiver(sharedSecret, sender.state.currentRatchetPublicKey!, bobRatchetKP);
      const recvKey1 = advanceReceivingChain(receiver.state, 0);

      expect(recvKey1).toEqual(msgKey1);
    });

    it('handles multiple messages in sequence', () => {
      const sharedSecret = crypto.getRandomValues(new Uint8Array(32));
      const bobRatchetKP = generateKeyPair();

      const sender = initializeRatchetAsSender(sharedSecret, bobRatchetKP.publicKey);
      const receiver = initializeRatchetAsReceiver(sharedSecret, sender.state.currentRatchetPublicKey!, bobRatchetKP);

      for (let i = 0; i < 5; i++) {
        const msgKey = advanceSendingChain(sender.state);
        const recvKey = advanceReceivingChain(receiver.state, i);
        expect(recvKey).toEqual(msgKey);
      }
    });
  });

  describe('Session Manager - Full Flow', () => {
    it('encrypts and decrypts messages between two users', async () => {
      const aliceSM = new SessionManager();
      const bobSM = new SessionManager();

      const aliceIK = generateIdentityKeyPair();
      const bobIK = generateIdentityKeyPair();
      const bobSPK = generateSignedPreKeyRecord(bobIK.ed25519PrivateKey, 1);
      const bobOPK = generateOneTimePreKeys(0, 1)[0];

      const bundle = {
        registrationId: bobIK.registrationId,
        identityKey: bobIK.publicKey,
        ed25519PublicKey: bobIK.ed25519PublicKey,
        signedPreKey: {
          keyId: bobSPK.keyId,
          publicKey: bobSPK.keyPair.publicKey,
          signature: bobSPK.signature,
        },
        oneTimePreKey: {
          keyId: bobOPK.keyId,
          publicKey: bobOPK.keyPair.publicKey,
        },
      };

      const aliceIdentityKey = { privateKey: aliceIK.privateKey, publicKey: aliceIK.publicKey };
      const { session: aliceSession, x3dhMessage, ratchetPublicKey } = aliceSM.createInitiatorSession(
        'alice', 'bob', aliceIdentityKey, bundle
      );

      const bobIdentityKey = { privateKey: bobIK.privateKey, publicKey: bobIK.publicKey };
      const bobSignedPreKey = { privateKey: bobSPK.keyPair.privateKey, publicKey: bobSPK.keyPair.publicKey };
      const bobOneTimePreKey = { privateKey: bobOPK.keyPair.privateKey, publicKey: bobOPK.keyPair.publicKey };

      bobSM.createResponderSessionFromMessage(
        'bob', 'alice', bobIdentityKey, bobSignedPreKey, bobOneTimePreKey,
        x3dhMessage, ratchetPublicKey, new Uint8Array(0), 0
      );

      const plaintext1 = 'Hello Bob!';
      const ciphertext1 = await aliceSM.encryptMessage(aliceSession.sessionId, plaintext1);

      const decrypted1 = await bobSM.decryptMessage(
        aliceSM.getSessionId('bob', 'alice'),
        ciphertext1,
        0,
        ratchetPublicKey
      );
      expect(decrypted1).toBe(plaintext1);

      const plaintext2 = 'Hi Alice!';
      const bobSession = bobSM.getSession(bobSM.getSessionId('bob', 'alice'));
      expect(bobSession).toBeDefined();

      const ciphertext2 = await bobSM.encryptMessage(bobSM.getSessionId('bob', 'alice'), plaintext2);

      const decrypted2 = await aliceSM.decryptMessage(
        aliceSession.sessionId,
        ciphertext2,
        0,
        bobSession!.state.currentRatchetPublicKey!
      );
      expect(decrypted2).toBe(plaintext2);
    });

    it('supports multiple messages in both directions', async () => {
      const aliceSM = new SessionManager();
      const bobSM = new SessionManager();

      const aliceIK = generateIdentityKeyPair();
      const bobIK = generateIdentityKeyPair();
      const bobSPK = generateSignedPreKeyRecord(bobIK.ed25519PrivateKey, 1);

      const bundle = {
        registrationId: bobIK.registrationId,
        identityKey: bobIK.publicKey,
        ed25519PublicKey: bobIK.ed25519PublicKey,
        signedPreKey: {
          keyId: bobSPK.keyId,
          publicKey: bobSPK.keyPair.publicKey,
          signature: bobSPK.signature,
        },
      };

      const aliceIdentityKey = { privateKey: aliceIK.privateKey, publicKey: aliceIK.publicKey };
      const { session: aliceSession, x3dhMessage, ratchetPublicKey } = aliceSM.createInitiatorSession(
        'alice', 'bob', aliceIdentityKey, bundle
      );

      const bobIdentityKey = { privateKey: bobIK.privateKey, publicKey: bobIK.publicKey };
      const bobSignedPreKey = { privateKey: bobSPK.keyPair.privateKey, publicKey: bobSPK.keyPair.publicKey };

      bobSM.createResponderSessionFromMessage(
        'bob', 'alice', bobIdentityKey, bobSignedPreKey, null,
        x3dhMessage, ratchetPublicKey, new Uint8Array(0), 0
      );

      const aliceSessionId = aliceSession.sessionId;
      const bobSessionId = bobSM.getSessionId('bob', 'alice');

      const messages = ['Hello 1', 'Hello 2', 'Hello 3'];
      for (let i = 0; i < messages.length; i++) {
        const ct = await aliceSM.encryptMessage(aliceSessionId, messages[i]);
        const pt = await bobSM.decryptMessage(bobSessionId, ct, i, ratchetPublicKey);
        expect(pt).toBe(messages[i]);
      }

      const replies = ['Reply 1', 'Reply 2', 'Reply 3'];
      const bobSession = bobSM.getSession(bobSessionId)!;
      for (let i = 0; i < replies.length; i++) {
        const ct = await bobSM.encryptMessage(bobSessionId, replies[i]);
        const pt = await aliceSM.decryptMessage(aliceSessionId, ct, i, bobSession.state.currentRatchetPublicKey!);
        expect(pt).toBe(replies[i]);
      }
    });
  });

  describe('HKDF Key Derivation', () => {
    it('derives unique keys from same secret with different info', () => {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const salt = new Uint8Array(32);
      const k1 = hkdf(sha256, secret, salt, new TextEncoder().encode('info1'), 32);
      const k2 = hkdf(sha256, secret, salt, new TextEncoder().encode('info2'), 32);
      expect(k1).not.toEqual(k2);
    });

    it('derives deterministic keys', () => {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const salt = new Uint8Array(32);
      const info = new TextEncoder().encode('test');
      const k1 = hkdf(sha256, secret, salt, info, 32);
      const k2 = hkdf(sha256, secret, salt, info, 32);
      expect(k1).toEqual(k2);
    });
  });
});
