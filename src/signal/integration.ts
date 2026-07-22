import { PreKeyManager } from './prekey';
import { SessionManager } from './session';
import type { PreKeyBundle, KeyPair, SignalPreKeyMessage } from './types';

const preKeyManager = new PreKeyManager();
const sessionManager = new SessionManager();

export function initializeSignal(): void {
  preKeyManager.initialize();
}

export function getMyIdentityKeyPair(): KeyPair | null {
  const ik = preKeyManager.getIdentityKeyPair();
  if (!ik) return null;
  return { privateKey: ik.privateKey, publicKey: ik.publicKey };
}

export function getPreKeyBundleForServer() {
  return preKeyManager.getPublicKeyForServer();
}

export function getPreKeyBundle() {
  return preKeyManager.generatePreKeyBundle();
}

export function createSessionWithRemote(
  myId: string,
  remoteId: string,
  remoteBundle: PreKeyBundle
): { x3dhMessage: SignalPreKeyMessage; ratchetPublicKey: Uint8Array } | null {
  const ik = preKeyManager.getIdentityKeyPair();
  if (!ik) return null;

  const identityKey: KeyPair = { privateKey: ik.privateKey, publicKey: ik.publicKey };
  const result = sessionManager.createInitiatorSession(myId, remoteId, identityKey, remoteBundle);

  return {
    x3dhMessage: result.x3dhMessage,
    ratchetPublicKey: result.ratchetPublicKey,
  };
}

export function createResponderSession(
  myId: string,
  remoteId: string,
  x3dhMessage: SignalPreKeyMessage,
  aliceRatchetPublicKey: Uint8Array
): boolean {
  const ik = preKeyManager.getIdentityKeyPair();
  const spk = preKeyManager.getSignedPreKey();
  if (!ik || !spk) return false;

  const identityKey: KeyPair = { privateKey: ik.privateKey, publicKey: ik.publicKey };
  const signedPreKey: KeyPair = { privateKey: spk.keyPair.privateKey, publicKey: spk.keyPair.publicKey };

  let oneTimePreKey: KeyPair | null = null;
  if (x3dhMessage.oneTimePreKey) {
    const consumed = preKeyManager.consumeOneTimePreKey();
    if (consumed) {
      oneTimePreKey = { privateKey: consumed.keyPair.privateKey, publicKey: consumed.keyPair.publicKey };
    }
  }

  sessionManager.createResponderSessionFromMessage(
    myId,
    remoteId,
    identityKey,
    signedPreKey,
    oneTimePreKey,
    x3dhMessage,
    aliceRatchetPublicKey,
    new Uint8Array(0),
    0
  );

  return true;
}

export function getSessionId(userId1: string, userId2: string): string {
  return sessionManager.getSessionId(userId1, userId2);
}

export async function encryptWithSignal(
  sessionId: string,
  plaintext: string
): Promise<{ ciphertext: string; ratchetPublicKey: string; messageNumber: number }> {
  const ciphertext = await sessionManager.encryptMessage(sessionId, plaintext);
  const session = sessionManager.getSession(sessionId);
  if (!session) throw new Error('No session');

  return {
    ciphertext: arrayToBase64(ciphertext),
    ratchetPublicKey: arrayToBase64(session.state.currentRatchetPublicKey || new Uint8Array(0)),
    messageNumber: session.state.sendingMessageNumber - 1,
  };
}

export async function decryptWithSignal(
  sessionId: string,
  ciphertext: string,
  ratchetPublicKey: string,
  messageNumber: number
): Promise<string> {
  return sessionManager.decryptMessage(
    sessionId,
    base64ToArray(ciphertext),
    messageNumber,
    base64ToArray(ratchetPublicKey)
  );
}

export function hasSession(userId1: string, userId2: string): boolean {
  const id = sessionManager.getSessionId(userId1, userId2);
  return !!sessionManager.getSession(id);
}

function arrayToBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToArray(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function consumeOneTimePreKey() {
  return preKeyManager.consumeOneTimePreKey();
}
