import crypto from 'crypto';

const UPLOAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const tokens = new Map<string, { userId: string; expiresAt: number }>();

/**
 * The upload endpoint is reached over plain HTTP, where the websocket session does not exist, so the
 * client sends a short lived token from the auth payload. It lets the server count uploads per
 * account: keying them by address alone meant one person uploading photos could throttle everyone
 * else behind the same router, cafe or carrier nat.
 */
export function issueUploadToken(userId: string): string {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId, expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS });
  if (tokens.size > 50000) {
    const now = Date.now();
    for (const [key, entry] of tokens) if (entry.expiresAt < now) tokens.delete(key);
  }
  return token;
}

export function resolveUploadTokenUser(headerValue: unknown): string | null {
  const token = Array.isArray(headerValue) ? headerValue[0] : typeof headerValue === 'string' ? headerValue : '';
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}
