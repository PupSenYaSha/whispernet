import { wipe } from './signal/wipe';

const ALGO_RSA = { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const ALGO_AES = { name: 'AES-GCM', length: 256 };

export interface EncryptedMessage {
  ciphertext: string;
  iv: string;
  encryptedKeys: Record<string, string>;
}

function bufToBase64(buf: ArrayBuffer): string {
  // chunked: the spread form passes one argument per byte and overflows the call stack on a buffer of any
  // real size, which a message-sized one easily is
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/**
 * What the content of an envelope is bound to: the set of accounts it was sealed for.
 *
 * Without this, `{ciphertext, iv}` was free-standing. Every recipient holds a wrapped copy of the same
 * content key and reads the same pair of fields, so the media host could take the pair out of one envelope
 * and put it into another: the tag verified, because nothing about the ciphertext had changed, and the
 * result was a body that authenticated as one thing and said another. That is not a break of
 * confidentiality - it never held any key material - but it does mean a server can move words between
 * conversations it holds, which is the whole thing the ratchet exists to prevent.
 *
 * The reader's own id is deliberately *not* in here, and that is not an oversight. One ciphertext serves
 * every recipient, so there is no single value both ends can compute at once: the sender knows the set, the
 * reader knows itself. What the reader does instead is require its id to be in the sealed set - it has to
 * be, or there is no wrapped key to unwrap - and then reproduce the set the sender sealed. So the pairing
 * of "this content" and "these recipients" is fixed at write time and checked at read time, which is what
 * closes the splice.
 *
 * The ids go in sorted, because the order they were inserted in is not something the reader can reproduce:
 * `encryptedKeys` comes back out of the server as an object and object key order is not part of what was
 * sealed. A set the two ends computed differently would refuse every message, which is a far louder failure
 * than the one this prevents, so the sort is load-bearing rather than cosmetic.
 */
function envelopeAad(recipientIds: string[]): Uint8Array<ArrayBuffer> {
  const ids = [...new Set(recipientIds)].sort();
  return new TextEncoder().encode(`wn-envelope-v1\n${ids.join('\n')}`);
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
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const encryptedKeys: Record<string, string> = {};

  // The wrapping happens before the sealing, because the associated data names the recipients and the
  // recipient set is what the wrapping produces. Doing it the other way round would mean either binding a
  // set that had not been decided yet or dropping the binding to keep the order convenient.
  for (const [userId, pubKeyJwk] of Object.entries(recipientPublicKeys)) {
    try {
      const pubKey = await crypto.subtle.importKey('jwk', pubKeyJwk, ALGO_RSA, false, ['encrypt']);
      const encKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, rawAesKey);
      encryptedKeys[userId] = bufToBase64(encKey);
    } catch {}
  }
  // The exported content key has done its job. It is a live 256-bit key in a plain ArrayBuffer, and every
  // recipient's wrapped copy is now derived from it, so the only remaining copy is one this tab does not
  // need. `finally`, not a straight call: a throw partway through the wrapping above used to leave it
  // sitting in a live buffer for the rest of the tab's life.
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: envelopeAad(Object.keys(encryptedKeys)) },
      aesKey,
      new TextEncoder().encode(text)
    );
  } finally {
    new Uint8Array(rawAesKey).fill(0);
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
  // in the same try as the import, so the `finally` below actually reaches it: a failure between the two
  // used to leave the unwrapped key sitting in the heap for the rest of the tab's life
  let aesKey: CryptoKey;
  try {
    aesKey = await crypto.subtle.importKey('raw', rawAesKey, ALGO_AES, false, ['decrypt']);
  } finally {
    wipe(rawAesKey);
  }

  const iv = new Uint8Array(base64ToBuf(encrypted.iv));
  const data = base64ToBuf(encrypted.ciphertext);
  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: envelopeAad(Object.keys(encrypted.encryptedKeys)) },
      aesKey,
      data
    );
  } catch {
    // Fall back to the unbound form, because envelopes written before the recipient list was bound into
    // the associated data cannot open any other way - and this build has certainly written some.
    //
    // GCM authenticates the AAD, so adding it makes every earlier message undecryptable at once. There is no
    // version field on `EncryptedMessage` telling the two apart, and the failure is invisible from the
    // outside: `openEnvelope` turns the throw into a null, the message renders as "not for this device", and
    // the history is simply gone with nothing in the output to say why. Silent, total, permanent data loss
    // on the one thing the file exists to protect.
    //
    // Trying the old shape second is safe: the second call only runs if the first failed its tag check, so a
    // tampered body is still refused - by whichever branch rejects it. This buys back every existing message
    // for the price of one extra AES-GCM call on bodies that were never ours to begin with.
    decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
  } finally {
    wipe(data);
  }

  return new TextDecoder().decode(decrypted);
}

/**
 * The number two people read aloud to be sure they are talking to each other.
 *
 * Derived from the long-lived identity keys, sorted so both sides reach the same answer without an
 * agreed order. A server that handed each of them a different key would produce a different number on
 * each side, which is the entire point of putting it on screen: it is the one check that does not depend
 * on the server being honest.
 *
 * It needs both keys. With only ours there is nothing to compare against, so no number is produced at
 * all - a solo digest used to be shown instead, and since it is derived from one key alone the two sides
 * could never match it. That is a false alarm on the one check people are told to trust, which teaches
 * them to wave it through. Better to say the number is not available yet.
 */
export async function generateSafetyNumber(
  selfIdentityB64: string,
  peerIdentityB64?: string | null
): Promise<string | null> {
  if (!peerIdentityB64) return null;
  const self = base64ToU8(selfIdentityB64);
  if (self.length === 0) return null;
  const peer = base64ToU8(peerIdentityB64);
  if (peer.length === 0) return null;
  const data = byteCompare(self, peer) <= 0 ? concatBytes(self, peer) : concatBytes(peer, self);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer));
  const groups: string[] = [];
  for (let i = 0; i < 24; i += 4) {
    groups.push(Array.from(hash.slice(i, i + 4)).map(b => b.toString(16).padStart(2, '0')).join(''));
  }
  return groups.join(' ').toUpperCase();
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function byteCompare(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
