export const RATE_LIMIT_WINDOW = 60_000;
export const MAX_AUTH_ATTEMPTS = 5;
export const MIN_MESSAGE_INTERVAL = 500;
export const MAX_SESSIONS_PER_USER = 3;
export const MAX_CONNECTIONS_PER_IP = 10;
export const MAX_FAILED_LOGINS = 5;
export const ACCOUNT_LOCKOUT_DURATION = 300_000;
export const FAILED_LOGIN_RETENTION_MS = 60 * 60 * 1000;
export const MAX_WS_PAYLOAD_SIZE = 65536;

export const HEARTBEAT_INTERVAL = 15_000;
export const CLIENT_TIMEOUT = 90_000;

export const PREKEY_BUNDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PREKEY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const REPORT_CAP = 1000;

export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
export const MAX_MEDIA_STREAM = 5 * 1024 * 1024;
export const UPLOAD_RATE_LIMIT = 10;
export const UPLOAD_RATE_WINDOW = 60_000;
export const MEDIA_RATE_LIMIT = 30;
export const MEDIA_RATE_WINDOW = 60_000;
export const MAX_TOTAL_CONNECTIONS = 500;

export const DM_TTL_ALLOWED_MS: Record<number, number> = {
  86400: 24 * 60 * 60 * 1000,
  604800: 7 * 24 * 60 * 60 * 1000,
  2592000: 30 * 24 * 60 * 60 * 1000,
};

export const FTS_TABLE = 'messages_fts';