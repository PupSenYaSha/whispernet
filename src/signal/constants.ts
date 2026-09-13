export const PBKDF2_ITER = 600_000;

export const SIGNED_PREKEY_ROTATION_MS = 14 * 24 * 60 * 60 * 1000;
export const MIN_ONE_TIME_PREKEYS = 50;
export const MAX_ONE_TIME_PREKEYS = 100;
export const PREKEY_BUNDLE_VERSION = 2;

export const SESSION_STATE_VERSION = 3;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const REKEY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INACTIVITY_MS = 60 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PROTOCOL_VERSION = 2;

export const MAX_SKIP = 2000;
export const MAX_SKIPPED_MESSAGE_KEYS = 2000;
export const MAX_SESSIONS = 200;

export const KEY_PREFIX = {
  identityKey: 'wn_signal_ik',
  signedPreKey: 'wn_signal_spk',
  oneTimePreKeys: 'wn_signal_opk',
  prekeySalt: 'wn_signal_prekey_salt',
  sessions: 'wn_signal_sessions',
  sessionsSalt: 'wn_signal_sessions_salt',
} as const;