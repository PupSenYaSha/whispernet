import crypto from 'crypto';
import { MAX_UPLOAD_TOKENS } from './constants.js';

/**
 * How long an issued token may be used.
 *
 * The websocket session has no fixed lifetime to borrow - a session stops counting against the cap after
 * INACTIVE_SESSION_TTL_MS, which is ninety days, and calling that a session lifetime would be a stretch -
 * so the TTL stays at a day rather than pretending to track something the server does not know. A day is
 * long enough that a client which signs in once a week still works, and short enough that a token read out
 * of a log is not a standing key to the upload endpoint.
 */
const UPLOAD_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const tokens = new Map<string, { userId: string; expiresAt: number }>();

/**
 * The upload endpoint is reached over plain HTTP, where the websocket session does not exist, so the
 * client sends a short lived token from the auth payload. It lets the server count uploads per
 * account: keying them by address alone meant one person uploading photos could throttle everyone
 * else behind the same router, cafe or carrier nat.
 *
 * What it is *not* is a session. It is not tied to one, it is not consumed on use, and signing out does
 * not invalidate it - a token stays good until it expires. Tying it to a session would need a server-side
 * record of which sockets are live, which this map deliberately does not hold: it would make every
 * upload write home before it could be served, and the socket that issued it is frequently not the socket
 * serving the image afterwards. So the honest bound is the TTL plus the map size, and both are enforced.
 */
export function issueUploadToken(userId: string): string {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { userId, expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS });

  // Bounded on insert, not only on the expiry pass. The pass used to run only when the map was already
  // past the ceiling and only removed entries that had expired, so an account signing in repeatedly added
  // entries faster than they aged out and the map grew for as long as the process ran. Evicting the oldest
  // first here means the ceiling holds whatever the traffic, and the worst case is that a token issued
  // more than MAX_UPLOAD_TOKENS sign-ins ago is no longer accepted - which for an upload token costs a
  // reconnection, not anything anybody loses.
  while (tokens.size > MAX_UPLOAD_TOKENS) {
    const oldest = tokens.keys().next().value;
    if (oldest === undefined) break;
    tokens.delete(oldest);
  }
  return token;
}

/**
 * Drops everything that has expired.
 *
 * Still worth doing on a timer even though the insert path now evicts: without it the entries of an
 * otherwise idle server linger for the whole TTL, and a server that has seen a burst of sign-ins should not
 * hold that burst's tokens until the next sign-in happens to push it back under the ceiling.
 */
export function pruneUploadTokens(now: number = Date.now()): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

/**
 * Accepts the token from a header or from the query string.
 *
 * The query string is not optional: media is fetched by `<img>` and `<video>`, which cannot carry a
 * header, so the client appends `?t=` to the URL. Dropping query acceptance would break every image on a
 * signed-in page.
 */
export function resolveUploadTokenUser(headerValue: unknown): string | null {
  const token = Array.isArray(headerValue) ? headerValue[0] : typeof headerValue === 'string' ? headerValue : '';
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return null;
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}