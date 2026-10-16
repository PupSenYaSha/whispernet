export const RATE_LIMIT_WINDOW = 60_000;
/**
 * A coarse backstop for one address, counted before anybody has proved who they are.
 *
 * It used to be 30, which is wrong for a self-hosted messenger: a whole office, school or mobile
 * carrier shares one address, so thirty wrong passwords anywhere in the building locked out every
 * login through it for the rest of the minute. This is now high enough that a shared address never
 * notices it, and the limit that does the real work is MAX_FAILED_LOGINS, which is counted per
 * nickname rather than per address.
 */
export const MAX_AUTH_ATTEMPTS = Number(process.env.MAX_AUTH_ATTEMPTS || 300);
/**
 * A ceiling on *work*, which is not the same ceiling as MAX_AUTH_ATTEMPTS.
 *
 * That one counts rejected credentials, so it is only ever spent by somebody who is already getting it
 * wrong - and the work behind it is a bcrypt comparison at cost 12, which `bcryptjs` computes
 * synchronously: about 310 ms in which the single Node thread does nothing else. A limit on failures is
 * therefore not a limit on cost. At 300 a minute one address could ask for roughly ninety seconds of hard
 * blocking per minute and nothing would refuse it, because the limit only bites once the budget is gone.
 *
 * This one is charged on every `auth_login` frame whatever the outcome, which is what makes it a bound on
 * the work rather than on the mistakes. It was set to twenty a minute, which reads comfortably against
 * "one person typing their password" and is far too tight against the other case: the client re-sends
 * `auth_login` on **every** websocket reconnect, so twenty sign-ins a minute is twenty reconnects a minute.
 * A NAT-shared address - one office, one school, one flat behind one router, which is the situation
 * `MAX_CONNECTIONS_PER_IP` next door exists to reason about - clears that on an ordinary morning. Everyone
 * behind it is then refused for up to a minute with a message that is deliberately indistinguishable from a
 * failed password, so the fix an operator reaches for is to disable the limit.
 *
 * A hundred and twenty a minute still caps the work at about half a second of blocked event loop per address
 * per minute, which is the bound that actually matters here, and it is no longer something an ordinary
 * reconnect storm can reach. The tests that care about the ceiling set it explicitly.
 */
export const MAX_AUTH_ATTEMPTS_PER_ADDRESS = Number(process.env.MAX_AUTH_ATTEMPTS_PER_ADDRESS || 120);
export const MIN_MESSAGE_INTERVAL = 500;
export const MAX_SESSIONS_PER_USER = 3;
/** Unauthenticated sockets only, and deliberately generous: a whole cafe or office shares one address. */
export const MAX_CONNECTIONS_PER_IP = 100;
/** Counted per account, so one user cannot flood the server with tabs. */
export const MAX_CONNECTIONS_PER_USER = 10;
export const MAX_FAILED_LOGINS = 5;
export const ACCOUNT_LOCKOUT_DURATION = 300_000;
/**
 * The same counter counted for one nickname across every address, which is what a spray from many
 * machines runs into.
 */
export const MAX_FAILED_LOGINS_GLOBAL = 20;
export const ACCOUNT_LOCKOUT_DURATION_GLOBAL = 900_000;
export const FAILED_LOGIN_RETENTION_MS = 60 * 60 * 1000;
export const MAX_WS_PAYLOAD_SIZE = 4 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 2000;

/**
 * A budget on how many frames one socket may send, and one account may send across its sockets.
 *
 * Every kind has a cost, and only two of them were ever metered: `chat_message` and `dm_send`. So a
 * connected socket could send `typing`, `dm_read`, `search_messages`, `prekey_upload`, `get_sessions` or
 * anything else as fast as it could write, and the widest of those reach every client on the server
 * (`typing` on the general channel is a broadcast), turning one socket into a fan-out of up to
 * MAX_TOTAL_CONNECTIONS.
 *
 * Sized well above what a client uses, not at it: sending is capped at two a second already, typing goes out
 * every three, and a sign-in that opens a dozen conversations fetches a dozen prekey bundles at once. Twenty
 * frames a second per socket and sixty per account is comfortably past any of that, and a flood is unbounded
 * by definition - so this stops the flood and never touches a person.
 */
export const WS_FRAME_WINDOW_MS = 10_000;
export const WS_FRAME_LIMIT_PER_CONNECTION = Number(process.env.WS_FRAME_LIMIT_PER_CONNECTION || 200);
export const WS_FRAME_LIMIT_PER_ACCOUNT = Number(process.env.WS_FRAME_LIMIT_PER_ACCOUNT || 600);

/**
 * How much a socket may have queued before a broadcast stops writing to it.
 *
 * `ws.send()` does not block and does not fail: it appends to an in-process buffer and the kernel writes
 * it out later. A client that stops reading - asleep, on a stalled mobile link, or deliberately - therefore
 * does not slow the broadcast down, it makes the server hold the message for it. Ten thousand of those is
 * the server's heap spent on frames nobody is waiting for, so a client over the ceiling is skipped instead
 * of queued. It will catch up on the next frame that gets through.
 */
export const WS_SEND_BUFFER_LIMIT = 1024 * 1024;

export const HEARTBEAT_INTERVAL = 15_000;
export const CLIENT_TIMEOUT = 90_000;

export const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const REPORT_CAP = 1000;

/**
 * How many accounts one address may create, and over what period.
 *
 * The window is long on purpose: a short one punishes a shared address rather than a spammer, which is the
 * same mistake the auth backstop used to make. Override with MAX_REGISTRATIONS_PER_IP=0 to lift it.
 *
 * Raised from 20 to 40 because an address is a poor stand-in for a person - a whole office, a school or a
 * mobile carrier shares one, and a residential address is a rotating pool behind CGNAT. It stays as a
 * backstop against one host filling the users table in a hurry, not as the main limit, which is now per
 * device.
 */
export const MAX_REGISTRATIONS_PER_IP = Number(process.env.MAX_REGISTRATIONS_PER_IP || 40);
export const REGISTRATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many accounts one device may create, over the same window.
 *
 * New, and the more meaningful of the two. The normal arrangement is one account per device, so the ceiling
 * is set well above that to leave room for the legitimate cases rather than to police them: a second or
 * third account for somebody who keeps separate ones for work and personal, a shared family tablet, and a
 * browser profile that has outlived several sign-outs.
 *
 * Worth being clear about what this does and does not do. A device id is a value the *client* generates
 * and sends, so it is not a credential: anyone determined to make more accounts simply presents a new one,
 * and clearing site data has the same effect for free. Compared with the address limit it is still the
 * better signal, because a person with several devices tends to keep the same one, whereas a person wanting
 * many accounts has to work at it. Treat it as a speed bump that raises the cost, not as a wall.
 *
 * Override with MAX_ACCOUNTS_PER_DEVICE=0 to lift it.
 */
export const MAX_ACCOUNTS_PER_DEVICE = Number(process.env.MAX_ACCOUNTS_PER_DEVICE || 6);

/**
 * How many leading zero bits a registration proof must have, and how long a challenge stays valid.
 *
 * Creating an account used to cost nothing but picking a nickname, which left the address and device caps
 * as the only brakes - and both are bypassed by sending a different value in a header. This is the brake
 * that cannot be spoofed: the client has to search for a hash, and a hundred accounts cost a hundred
 * searches.
 *
 * The number is in bits rather than hex characters so it can be dialled in fine steps, because the cost
 * doubles with every bit. Measured on a desktop browser at roughly 330,000 hashes a second, the defaults
 * below are about 3 seconds for an honest person; a phone two or three times slower than that machine will
 * take closer to ten, which is the trade - paid once, at registration, with progress shown and no way to
 * get stuck. `POW_BITS=0` turns it off, which is only sensible for a local instance on a trusted network.
 */
export const POW_BITS = Number(process.env.POW_BITS || 20);

/** How long an issued challenge may be answered. Long enough for a slow phone, short enough not to be a hoard. */
export const POW_CHALLENGE_TTL_MS = Number(process.env.POW_CHALLENGE_TTL_MS || 10 * 60 * 1000);

/** Issued challenges kept in memory at once, so a flood of requests cannot grow the map without bound. */
export const POW_MAX_CHALLENGES = Number(process.env.POW_MAX_CHALLENGES || 5000);

export const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE || 1000 * 1024 * 1024);export const MAX_MEDIA_STREAM = MAX_UPLOAD_SIZE + 1024 * 1024;
export const UPLOAD_RATE_LIMIT = 120;
export const UPLOAD_RATE_WINDOW = 60_000;
/**
 * How many of one account's uploads may be in the air at once, and how many bytes it may send a day.
 *
 * `UPLOAD_RATE_LIMIT` counts requests, never bytes, and `MAX_UPLOAD_SIZE` is a gigabyte, so a hundred and
 * twenty of them inside one minute meant a hundred and twenty concurrent gigabyte temp files under
 * os.tmpdir() and a hundred and twenty concurrent fifteen-minute sockets to the media host - from a single
 * sign-in. Both halves needed a bound: the first caps how much of the machine is held at once, the second
 * caps how much of somebody else's disk and bandwidth one account can take in a day.
 *
 * Four at once leaves a client uploading a handful of pictures with room to spare and is far below what
 * the disk has to survive. Override both for a local instance that is deliberately open.
 */
export const MAX_CONCURRENT_UPLOADS = Number(process.env.MAX_CONCURRENT_UPLOADS || 4);
export const UPLOAD_DAILY_BYTES = Number(process.env.UPLOAD_DAILY_BYTES || 5 * 1024 * 1024 * 1024);

/**
 * Issued upload tokens held at once, evicted oldest-first.
 *
 * The expiry pass alone does not bound the map: it ran only when the map passed fifty thousand and only
 * removed entries that had already expired, so an account signing in repeatedly outran it and the map grew
 * without limit for as long as the process ran. Evicting on insert bounds it whatever the traffic.
 */
export const MAX_UPLOAD_TOKENS = Number(process.env.MAX_UPLOAD_TOKENS || 50000);
export const MEDIA_RATE_LIMIT = 240;
export const MEDIA_RATE_WINDOW = 60_000;
/** Overridable: the real ceiling is the machine's memory and file descriptors, not this number. */
export const MAX_TOTAL_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 10000);

/**
 * How often one account may search, and how long a query may be.
 *
 * Search was the one frame with no meter at all, and it is the most expensive thing an account can ask
 * for: it reads a search index, and on the fallback path it reads every row in the server. A quote in the
 * query was enough to force that fallback deliberately, every time.
 */
export const SEARCH_RATE_LIMIT = Number(process.env.SEARCH_RATE_LIMIT || 30);
export const SEARCH_RATE_WINDOW = 60_000;
export const MAX_SEARCH_QUERY_CHARS = 128;

/**
 * How many proxies sit between the client and this process, and therefore how far into
 * `X-Forwarded-For` the real address is.
 *
 * One for the ordinary nginx-or-Caddy-in-front-of-this-process arrangement. The chain is read from the
 * right, so anything the client itself put in the header is ignored; raise it only if there really are
 * that many hops, since every extra hop is one more element of the header believed.
 *
 * The header is not believed at all unless TRUST_PROXY says there is a proxy - see `proxyHeadersTrusted`.
 */
export const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS || 1);

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

/** A device that has not been seen for this long no longer counts against the session cap. */
export const INACTIVE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How long a published prekey bundle is trusted before it is dropped.
 *
 * A bundle is what lets a stranger open a ratchet, so a stale one is worse than none: a sender would
 * build a session against key material its owner rotated away months ago, and the conversation would
 * be unreadable on the other side. Clients refresh well inside this.
 */
export const PREKEY_BUNDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
