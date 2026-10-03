/**
 * Which contacts have had their key checked.
 *
 * Recorded locally, per device. Verification is a person reading the same number on two screens in the
 * same room; there is nothing for a server to hold about it, and putting it there would be a record of
 * who trusts whom.
 *
 * The mark it produces is the point. A number on a screen protects nobody by existing - it protects them
 * when somebody acts on it. So the check is only recorded once the person has said they compared it, and
 * until then the contact is visibly unchecked, because an unexamined conversation and an examined one are
 * not the same thing and the interface should not pretend they are.
 */

const VERIFIED_KEY = 'wn_verified_keys';

interface VerifiedRecord {
  /**
   * The account-level identity key that was checked, so a later change clears the mark by itself.
   *
   * Account-level rather than a device's, because that is what the safety number is derived from and the
   * number has to come out the same on every device the account owns. A mark tied to one device's key
   * would clear itself the first time the person checked the contact from their other phone, which is
   * the opposite of what a verification mark is for.
   */
  key: string;
  at: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): Record<string, VerifiedRecord> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(VERIFIED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, VerifiedRecord> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const rec = v as VerifiedRecord;
      // an older record held a digest of the number rather than the key; it cannot be compared and is
      // dropped rather than guessed at
      if (rec && typeof rec.key === 'string' && typeof rec.at === 'number') out[k] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: Record<string, VerifiedRecord>): void {
  const s = storage();
  if (!s) return;
  try { s.setItem(VERIFIED_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}

/**
 * Whether this contact has been verified against the key they are publishing now.
 *
 * Keyed on the peer's own identity key, so a contact whose key was replaced afterwards is unchecked
 * again - which is exactly the case somebody needs to notice, and the reason the mark is not a sticky
 * badge on a name.
 */
export function isPeerVerified(peerId: string, peerIdentityKey: string | null | undefined): boolean {
  if (!peerId || !peerIdentityKey) return false;
  const record = read()[peerId];
  return !!record && record.key === peerIdentityKey;
}

export function markVerified(peerId: string, peerIdentityKey: string | null | undefined): void {
  if (!peerId || !peerIdentityKey) return;
  const map = read();
  map[peerId] = { key: peerIdentityKey, at: Date.now() };
  write(map);
}

export function clearVerification(peerId: string): void {
  const map = read();
  if (peerId in map) {
    delete map[peerId];
    write(map);
  }
}

export function verifiedCount(): number {
  return Object.keys(read()).length;
}

/** Ids of every contact currently marked verified, for the settings list. */
export function verifiedPeers(): string[] {
  return Object.keys(read());
}
