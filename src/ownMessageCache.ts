/**
 * A direct message is encrypted to the recipient's key, so the sender cannot decrypt its own
 * ciphertext. The server therefore hands the message back with only the encrypted blob, and the
 * client would render "[encrypted]" for a picture the user just sent.
 *
 * To avoid that the client stamps every outgoing dm with an id of its own, keeps the plaintext
 * under that id, and uses it whenever decrypting its own message fails - both for the live echo and
 * for the history that comes back after a reload.
 */

const STORAGE_KEY = 'wn_own_dm_text';
const MAX_ENTRIES = 300;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function newClientMessageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function isValidClientMessageId(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

function getStorage(explicit?: StorageLike): StorageLike | null {
  if (explicit) return explicit;
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readAll(storage: StorageLike): Record<string, string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidClientMessageId(k) && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(storage: StorageLike, all: Record<string, string>): void {
  try {
    const keys = Object.keys(all);
    if (keys.length > MAX_ENTRIES) {
      // insertion order is enough here, the cache is a convenience and not an audit log
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* a full or disabled storage must not break sending */
  }
}

export function rememberOwnMessageText(id: string, text: string, storage?: StorageLike): void {
  if (!isValidClientMessageId(id) || !text) return;
  const s = getStorage(storage);
  if (!s) return;
  const all = readAll(s);
  all[id] = text;
  writeAll(s, all);
}

export function recallOwnMessageText(id: unknown, storage?: StorageLike): string | null {
  if (!isValidClientMessageId(id)) return null;
  const s = getStorage(storage);
  if (!s) return null;
  const value = readAll(s)[id as string];
  return value || null;
}

export function forgetOwnMessages(storage?: StorageLike): void {
  const s = getStorage(storage);
  if (!s) return;
  try { s.removeItem(STORAGE_KEY); } catch { /* nothing to clean up */ }
}
