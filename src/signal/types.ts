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
    createdAt: number;
  };
  oneTimePreKey?: {
    keyId: number;
    publicKey: Uint8Array;
  };
  bundleVersion: number;
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
  /**
   * How far this side had got on the sending chain it has just stepped off, and the message keys for
   * the tail of it.
   *
   * A ratchet step happens when the far end's key changes, which can be while messages are still in
   * flight in the other direction. Without these, the first message to arrive after the step clears the
   * chain and every message behind it - already sent, already paid for, still in transit - becomes
   * unreadable. The specification keeps them for exactly this window, and so does this.
   */
  previousSendingRatchetPublicKey: Uint8Array | null;
  previousSendingSkippedKeys: Map<number, Uint8Array>;
  /**
   * The message keys this side has used on the chain it is sending on right now, most recent last.
   *
   * Kept because a ratchet step abandons the chain, and a message already sent on it may still be in
   * transit: without these, the first such message to arrive after the step moves the session onto a new
   * receiving chain and everything behind it becomes unreadable. Holding them costs nothing in exposure
   * - anyone reading this memory can already derive the whole chain from the key sitting beside them.
   */
  sentMessageKeys: Map<number, Uint8Array>;
  sendingMessageNumber: number;
  receivingMessageNumber: number;
  skippedMessageKeys: Map<number, Uint8Array>;
  createdAt: number;
  lastActivity: number;
  /**
   * A hash of the handshake this session was born from, which both ends derive the same way.
   *
   * It goes into the associated data of every message, so a body cannot be moved to a different
   * conversation or replayed into a fresh one even by whoever is relaying it.
   */
  transcriptHash: Uint8Array | null;
  /**
   * The identity key the far end was pinned to when the session was created.
   *
   * Kept so a later bundle that names a different identity for the same account is caught rather than
   * quietly carried on with - a reinstall, or a server handing out a key nobody expected.
   */
  remoteIdentityKey: Uint8Array | null;
}

export interface Session {
  sessionId: string;
  state: SessionState;
  version: 3;
  protocolVersion: number;
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
