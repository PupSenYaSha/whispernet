export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface IdentityKeyPair extends KeyPair {
  registrationId: number;
  ed25519PublicKey: Uint8Array;
  ed25519PrivateKey: Uint8Array;
}

export interface PreKeyBundle {
  registrationId: number;
  identityKey: Uint8Array;
  ed25519PublicKey: Uint8Array;
  signedPreKey: {
    keyId: number;
    publicKey: Uint8Array;
    signature: Uint8Array;
  };
  oneTimePreKey?: {
    keyId: number;
    publicKey: Uint8Array;
  };
}

export interface PreKeyRecord {
  keyId: number;
  keyPair: KeyPair;
}

export interface SignedPreKeyRecord {
  keyId: number;
  keyPair: KeyPair;
  signature: Uint8Array;
  createdAt: number;
}

export interface SessionState {
  version: 3;
  registrationId: number;
  currentRatchetPublicKey: Uint8Array | null;
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array | null;
  receivingChainKey: Uint8Array | null;
  sendingRatchetKey: KeyPair | null;
  receivingRatchetPublicKey: Uint8Array | null;
  previousSendingChainLength: number;
  sendingMessageNumber: number;
  receivingMessageNumber: number;
  skippedMessageKeys: Map<number, Uint8Array>;
}

export interface Session {
  sessionId: string;
  state: SessionState;
  version: 3;
}

export interface SignalMessage {
  ciphertext: Uint8Array;
  ratchetPublicKey: Uint8Array;
  previousChainLength: number;
  messageNumber: number;
}

export interface SignalPreKeyMessage {
  identityKey: Uint8Array;
  signedPreKey: {
    keyId: number;
    publicKey: Uint8Array;
  };
  oneTimePreKey?: {
    keyId: number;
    publicKey: Uint8Array;
  };
  baseKey: Uint8Array;
  message: SignalMessage;
}
