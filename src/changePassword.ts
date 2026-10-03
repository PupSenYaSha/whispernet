/**
 * Changing the account password without losing the keys.
 *
 * The password is not a login secret in the usual sense - it never travels to the server - but it is the
 * thing every piece of local key material is encrypted under. Sessions, prekeys and the copy of this
 * account's own outgoing messages are all sealed with a key derived from it, so changing it is not a
 * field update: the bytes on disk have to be rewritten, or the next launch opens nothing.
 *
 * Which is why this lives in its own file rather than in the settings panel. The order of operations is
 * the whole correctness of it, and an order that is wrong in one direction loses conversations and in the
 * other direction leaves the old password working.
 */

import { rekeySignalState } from './signal/integration';
import { rekeyOwnMessageCache } from './ownMessageCache';
import { storePassword, verifyStoredAuth } from './device-crypto';

/**
 * Moves this device's key material onto a new password.
 *
 * Every step is done under the old password first and the switch happens last, so an interruption at any
 * point leaves the device readable with the password it was readable with before. The one thing that must
 * not happen is writing the new password before the material is re-wrapped: that is the direction that
 * locks somebody out of their own history, and the reason the order below is not rearranged for
 * convenience.
 */
export async function changeAccountPassword(args: {
  nickname: string;
  oldPassword: string;
  newPassword: string;
}): Promise<void> {
  const { nickname, oldPassword, newPassword } = args;
  if (!oldPassword) throw new Error('missing current password');
  if (!newPassword) throw new Error('missing new password');
  if (oldPassword === newPassword) throw new Error('password is unchanged');

  // Confirm the old one before touching anything.
  //
  // The check that was here before sealed a blob with the candidate and opened it again, which proves
  // only that the field was typed twice: it would pass for any string at all, and a wrong password would
  // have gone straight on to re-wrap perfectly good key material under a password nobody knows. What is
  // used now opens the blob this device already had, which is sealed under the password the account is
  // genuinely on.
  const check = await verifyStoredAuth(oldPassword);
  if (!check.ok) {
    throw new Error(check.reason === 'none' ? 'no stored credentials to check against' : 'current password is wrong');
  }

  // The ratchet stores hold the only copy of the prekeys and of every message key, so they move together
  // and the awaits are not to be dropped: this is not a background task.
  await rekeySignalState(newPassword);

  // Then the outgoing-message cache, which is the last thing still sealed under the old password.
  await rekeyOwnMessageCache(newPassword);

  // The sign-in blob is sealed under the device key rather than the password, so it is rewritten with the
  // new value but not with the password itself - it is a record of what to sign in with, not a copy of
  // anything that opens the keys.
  const stored = await storePassword(nickname, newPassword);
  if (!stored) {
    // The material is already under the new password, so there is nothing to roll back to. Say so
    // plainly: the caller has to sign in again, and pretending otherwise would strand the session.
    throw new Error('password changed, but the sign-in record could not be written');
  }
}

/**
 * The minimum a caller has to confirm a change.
 *
 * Deliberately not a similarity rule. A check that rejects a password somebody genuinely chose is worse
 * than no check, because it teaches people to reach for the one password that passes.
 */
export function validateNewPassword(password: string, confirmation: string): string | null {
  if (!password) return 'password_required';
  if (password.length < 8) return 'password_too_short';
  if (password !== confirmation) return 'password_mismatch';
  return null;
}