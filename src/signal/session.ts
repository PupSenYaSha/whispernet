import type { Session, KeyPair, PreKeyBundle, SignalPreKeyMessage } from './types';
import { generateKeyPair } from './keys';
import { x3dhInit, x3dhRespond } from './x3dh';
import {
  initializeRatchetAsReceiver,
  advanceSendingChain,
  advanceReceivingChain,
  ratchetStep,
  createRatchetState,
  MAX_SESSIONS,
} from './ratchet';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const SESSIONS_KEY = 'wn_signal_sessions';
const INFO_ROOT = new TextEncoder().encode('WhisperNetRoot');

export class SessionManager {
  private sessions: Map<string, Session> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const data = localStorage.getItem(SESSIONS_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        for (const [id, session] of Object.entries(parsed)) {
          const s = session as any;
          if (s.state.skippedMessageKeys && !(s.state.skippedMessageKeys instanceof Map)) {
            const entries = Object.entries(s.state.skippedMessageKeys) as [string, number[]][];
            s.state.skippedMessageKeys = new Map(
              entries.map(([k, v]) => [parseInt(k), new Uint8Array(v)])
            );
          }
          this.sessions.set(id, s as Session);
        }
      }
    } catch (e) {
      console.error('Failed to load sessions from localStorage:', e);
    }
  }

  save(): void {
    try {
      const obj: Record<string, any> = {};
      for (const [id, session] of this.sessions) {
        const s: any = { ...session };
        s.state = { ...s.state };
        if (s.state.skippedMessageKeys instanceof Map) {
          const entries: [number, Uint8Array][] = Array.from(s.state.skippedMessageKeys.entries());
          s.state.skippedMessageKeys = Object.fromEntries(
            entries.map(([k, v]) => [k, Array.from(v)])
          );
        }
        obj[id] = s;
      }
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(obj));
    } catch (e) {
      console.error('Failed to save sessions:', e);
    }
  }

  private evictOldestSession(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const firstKey = this.sessions.keys().next().value;
    if (firstKey) this.sessions.delete(firstKey);
  }

  getSessionId(userId1: string, userId2: string): string {
    return [userId1, userId2].sort().join(':');
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  createInitiatorSession(
    myId: string,
    remoteId: string,
    identityKey: KeyPair,
    remoteBundle: PreKeyBundle
  ): { session: Session; x3dhMessage: SignalPreKeyMessage; ratchetPublicKey: Uint8Array } {
    const sessionId = this.getSessionId(myId, remoteId);

    const ratchetKeyPair = generateKeyPair();
    const { sharedSecret, message: x3dhMessage } = x3dhInit(identityKey, remoteBundle, ratchetKeyPair.publicKey);

    const derived = hkdf(sha256, sharedSecret, new Uint8Array(32), INFO_ROOT, 64);
    const rootKey = derived.slice(0, 32);
    const chainKey = derived.slice(32, 64);

    const state = createRatchetState();
    state.rootKey = rootKey;
    state.sendingChainKey = chainKey;
    state.sendingRatchetKey = ratchetKeyPair;
    state.currentRatchetPublicKey = ratchetKeyPair.publicKey;
    state.sendingMessageNumber = 0;

    const session: Session = { sessionId, state, version: 3 };
    this.evictOldestSession();
    this.sessions.set(sessionId, session);
    this.save();

    return { session, x3dhMessage, ratchetPublicKey: ratchetKeyPair.publicKey };
  }

  createResponderSessionFromMessage(
    myId: string,
    remoteId: string,
    identityKey: KeyPair,
    signedPreKey: KeyPair,
    oneTimePreKey: KeyPair | null,
    x3dhMessage: SignalPreKeyMessage,
    aliceRatchetPublicKey: Uint8Array,
    _firstMessageCiphertext: Uint8Array,
    _firstMessageNumber: number
  ): Session {
    const sessionId = this.getSessionId(myId, remoteId);
    const sharedSecret = x3dhRespond(identityKey, signedPreKey, oneTimePreKey, x3dhMessage);

    const { state } = initializeRatchetAsReceiver(sharedSecret, aliceRatchetPublicKey);

    const session: Session = { sessionId, state, version: 3 };
    this.evictOldestSession();
    this.sessions.set(sessionId, session);
    this.save();

    return session;
  }

  async encryptMessage(sessionId: string, plaintext: string): Promise<Uint8Array> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('No session');

    const messageKey = advanceSendingChain(session.state);

    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    const iv = crypto.getRandomValues(new Uint8Array(12));

    const keyMaterial = new Uint8Array(32);
    keyMaterial.set(messageKey);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      data
    );

    const result = new Uint8Array(4 + iv.length + encrypted.byteLength);
    result[0] = iv.length;
    result.set(iv, 1);
    result.set(new Uint8Array(encrypted), 1 + iv.length);
    return result;
  }

  async decryptMessage(
    sessionId: string,
    ciphertext: Uint8Array,
    messageNumber: number,
    ratchetPublicKey: Uint8Array
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('No session');

    const currentRemoteKey = session.state.receivingRatchetPublicKey;
    const keysEqual = currentRemoteKey &&
      currentRemoteKey.length === ratchetPublicKey.length &&
      currentRemoteKey.every((v, i) => v === ratchetPublicKey[i]);

    if (!keysEqual) {
      ratchetStep(session.state, ratchetPublicKey);
    }

    const messageKey = advanceReceivingChain(session.state, messageNumber);
    if (!messageKey) throw new Error('No message key available');

    const ivLength = ciphertext[0];
    const iv = ciphertext.slice(1, 1 + ivLength);
    const data = ciphertext.slice(1 + ivLength);

    const keyMaterial = new Uint8Array(32);
    keyMaterial.set(messageKey);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyMaterial.buffer as ArrayBuffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      data
    );

    return new TextDecoder().decode(decrypted);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.save();
  }
}
