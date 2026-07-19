const ALGO_RSA = { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const ALGO_AES = { name: 'AES-GCM', length: 256 };

export interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  encryptedKeys: Record<string, string>;
}

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function generateKeyPair(): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(ALGO_RSA, true, ['encrypt', 'decrypt']);
  return {
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

export async function encryptMessage(
  text: string,
  recipientPublicKeys: Record<string, JsonWebKey>
): Promise<EncryptedMessage> {
  const aesKey = await crypto.subtle.generateKey(ALGO_AES, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(text)
  );

  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedKeys: Record<string, string> = {};

  for (const [userId, pubKeyJwk] of Object.entries(recipientPublicKeys)) {
    try {
      const pubKey = await crypto.subtle.importKey('jwk', pubKeyJwk, ALGO_RSA, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, rawAesKey);
      encryptedKeys[userId] = bufToBase64(encKey);
    } catch {}
  }

  return {
    ciphertext: bufToBase64(ciphertext),
    iv: bufToBase64(iv.buffer),
    encryptedKeys,
  };
}

export async function decryptMessage(
  encrypted: EncryptedMessage,
  userId: string,
  privateKeyJwk: JsonWebKey
): Promise<string> {
  const encAesKey = encrypted.encryptedKeys[userId];
  if (!encAesKey) throw new Error('No encrypted key for this user');

  const privateKey = await crypto.subtle.importKey('jwk', privateKeyJwk, ALGO_RSA, false, ['decrypt']);
  const rawAesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, base64ToBuf(encAesKey));
  const aesKey = await crypto.subtle.importKey('raw', rawAesKey, ALGO_AES, false, ['decrypt']);
  const iv = new Uint8Array(base64ToBuf(encrypted.iv));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, base64ToBuf(encrypted.ciphertext));

  return new TextDecoder().decode(decrypted);
}

export async function generateSafetyNumber(publicKey: JsonWebKey): Promise<string> {
  const keyData = new TextEncoder().encode(JSON.stringify(publicKey));
  const hash = await crypto.subtle.digest('SHA-256', keyData);
  const bytes = new Uint8Array(hash);
  const groups: string[] = [];
  for (let i = 0; i < 24; i += 4) {
    groups.push(Array.from(bytes.slice(i, i + 4)).map(b => b.toString(16).padStart(2, '0')).join(''));
  }
  return groups.join(' ').toUpperCase();
}


