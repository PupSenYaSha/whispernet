import { iterationsFor } from '../pbkdf2';

/**
 * PBKDF2 cost for the two stores that hold private key material.
 *
 * Sourced from the shared table rather than written out here. It used to be a fourth copy of the same
 * number, which meant the environment override and `tests/unit/pbkdf2-iterations.test.ts` described
 * everything *except* the two stores holding the private prekeys and every message key on the account -
 * so a run that lowered the cost to keep the suite fast was still paying full price in the two places
 * that mattered, and a change made in `src/pbkdf2.ts` would never have reached them.
 *
 * Read once at module load, like every other figure here.
 */
export const PBKDF2_ITER = iterationsFor('localStore');

export const SIGNED_PREKEY_ROTATION_MS = 14 * 24 * 60 * 60 * 1000;
export const MIN_ONE_TIME_PREKEYS = 50;
export const MAX_ONE_TIME_PREKEYS = 100;
export const PREKEY_BUNDLE_VERSION = 2;

/**
 * The shape of a persisted session.
 *
 * Bumped at 4 for `previousReceivingRatchetPublicKey`/`previousReceivingSkippedKeys` (the receiving-side
 * answer to what the sending side already had). `sessionFromJson` reads this tag, refuses anything it does
 * not recognise, and migrates the one version it knows how to. It used to be read into a local and thrown
 * away, so the tag protected nothing at all - survivable only because the content checks below it happen to
 * catch everything the version was supposed to catch.
 */
export const SESSION_STATE_VERSION = 4;

/** The tag value this build writes, and the one below it that `sessionFromJson` can still migrate. */
export const SESSION_STATE_VERSION_LEGACY = 3;

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const REKEY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INACTIVITY_MS = 60 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PROTOCOL_VERSION = 2;

export const MAX_SKIP = 2000;
export const MAX_SKIPPED_MESSAGE_KEYS = 2000;

/**
 * How many keys of the chain just stepped off are kept, on the receiving side.
 *
 * Same reasoning as `MAX_SKIPPED_MESSAGE_KEYS` and the same reason it is separate: the two maps hold
 * different chains, and losing one does not imply losing the other.
 */
export const MAX_PREVIOUS_RECEIVING_KEYS = 256;
export const MAX_SESSIONS = 200;

/**
 * The storage keys, before the account id is put on them.
 *
 * Every one of these is namespaced per account in the two managers (see `storageKey`). One namespace for
 * the whole browser profile is one namespace for every account that has ever been signed in to it: the
 * second account to sign in derives a key from *its* password, fails to open the first account's store,
 * and the failure handling that protects a truncated write - which is to delete the blob - then destroys
 * every conversation the first account had on this device.
 */
export const KEY_PREFIX = {
  identityKey: 'wn_signal_ik',
  signedPreKey: 'wn_signal_spk',
  signedPreKeyHistory: 'wn_signal_spk_history',
  oneTimePreKeys: 'wn_signal_opk',
  prekeySalt: 'wn_signal_prekey_salt',
  sessions: 'wn_signal_sessions',
  sessionsSalt: 'wn_signal_sessions_salt',
} as const;

/**
 * The storage key for one account's store.
 *
 * Account ids are server-issued UUIDs, so there is nothing here to escape and nothing here that could make
 * two accounts share a key. An absent id yields the bare name, which is the pre-existing behaviour: a
 * manager built without an account id is not one the app builds (`startRatchet` always has the signed-in
 * id) and is used by tests that are deliberately talking about a single shared profile.
 */
export function storageKey(base: string, accountId: string): string {
  return accountId ? `${base}:${accountId}` : base;
}