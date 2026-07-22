const PBKDF2_ITERATIONS = 600_000;
const SALT_LEN = 16;
const IV_LEN = 12;

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
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export interface EncryptedKeyBundle {
  v: number;
  salt: string;
  iv: string;
  data: string;
  publicKey: JsonWebKey;
}

export async function encryptPrivateKey(
  privateKey: JsonWebKey,
  password: string
): Promise<EncryptedKeyBundle> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(privateKey));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return {
    v: 1,
    salt: bufToBase64(salt.buffer),
    iv: bufToBase64(iv.buffer),
    data: bufToBase64(ciphertext),
    publicKey: {} as JsonWebKey,
  };
}

export async function decryptPrivateKey(
  bundle: EncryptedKeyBundle,
  password: string
): Promise<JsonWebKey> {
  const salt = new Uint8Array(base64ToBuf(bundle.salt));
  const iv = new Uint8Array(base64ToBuf(bundle.iv));
  const key = await deriveKey(password, salt);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBuf(bundle.data));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function isEncryptedBundle(data: unknown): data is EncryptedKeyBundle {
  return (
    typeof data === 'object' &&
    data !== null &&
    'v' in data &&
    'salt' in data &&
    'iv' in data &&
    'data' in data &&
    (data as any).v === 1
  );
}

export interface KeyBackup {
  version: number;
  type: 'whispernet-key-backup';
  createdAt: string;
  nickname: string;
  publicKey: JsonWebKey;
  encryptedPrivateKey: EncryptedKeyBundle;
}

export function createBackup(
  nickname: string,
  publicKey: JsonWebKey,
  encryptedBundle: EncryptedKeyBundle
): KeyBackup {
  return {
    version: 1,
    type: 'whispernet-key-backup',
    createdAt: new Date().toISOString(),
    nickname,
    publicKey,
    encryptedPrivateKey: encryptedBundle,
  };
}

export function downloadBackup(backup: KeyBackup): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `whispernet-backup-${backup.nickname}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function isKeyBackup(data: unknown): data is KeyBackup {
  return (
    typeof data === 'object' &&
    data !== null &&
    'type' in data &&
    (data as any).type === 'whispernet-key-backup' &&
    'encryptedPrivateKey' in data
  );
}
