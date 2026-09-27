export const RATE_LIMIT_WINDOW = 60_000;
export const MAX_AUTH_ATTEMPTS = 30;
export const MIN_MESSAGE_INTERVAL = 500;
export const MAX_SESSIONS_PER_USER = 3;
/** Unauthenticated sockets only, and deliberately generous: a whole cafe or office shares one address. */
export const MAX_CONNECTIONS_PER_IP = 100;
/** Counted per account, so one user cannot flood the server with tabs. */
export const MAX_CONNECTIONS_PER_USER = 10;
export const MAX_FAILED_LOGINS = 5;
export const ACCOUNT_LOCKOUT_DURATION = 300_000;
export const FAILED_LOGIN_RETENTION_MS = 60 * 60 * 1000;
export const MAX_WS_PAYLOAD_SIZE = 4 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 2000;

export const HEARTBEAT_INTERVAL = 15_000;
export const CLIENT_TIMEOUT = 90_000;

export const PREKEY_BUNDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PREKEY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const REPORT_CAP = 1000;

export const MAX_UPLOAD_SIZE = 1000 * 1024 * 1024;
export const MAX_MEDIA_STREAM = MAX_UPLOAD_SIZE + 1024 * 1024;
export const UPLOAD_RATE_LIMIT = 120;
export const UPLOAD_RATE_WINDOW = 60_000;
export const MEDIA_RATE_LIMIT = 240;
export const MEDIA_RATE_WINDOW = 60_000;
/** Overridable: the real ceiling is the machine's memory and file descriptors, not this number. */
export const MAX_TOTAL_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 10000);

export const DM_TTL_ALLOWED_MS: Record<number, number> = {
  86400: 24 * 60 * 60 * 1000,
  604800: 7 * 24 * 60 * 60 * 1000,
  2592000: 30 * 24 * 60 * 60 * 1000,
};

export const FTS_TABLE = 'messages_fts';

// an avatar travels as a base64 data url inside one websocket frame, so the raw byte ceiling is
// lower than the frame limit: 2 MB of pixels becomes roughly 2.7 MB of base64
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_PAYLOAD = 4 * 1024 * 1024;
export const AVATAR_CHANGE_INTERVAL_MS = 60_000;
export const AVATAR_EXTS = ['png', 'jpeg', 'webp', 'gif'] as const;