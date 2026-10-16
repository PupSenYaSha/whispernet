import { WebSocket } from 'ws';
import { issueUploadToken } from './uploadTokens.js';
import { getUserByNickname, saveMessage, getRecentMessages, getMessageById, createUser, getAllPublicKeys, getPublicKeysByIds, getDmChannelId, getDmHistory, getDmContacts, deleteGeneralMessages, getAllUsers, updatePublicKey, setPreKeyBundle, getPreKeyBundlesByIds, takePreKeyBundlesForSender, resetIssuedPreKeys, getIdentityKeyB64, setIdentityKeyB64, getIdentityKeysByIds, getKeyBackup, saveKeyBackup, searchMessages, deleteMessage, updateEncryptedMessage, addReaction, removeReaction, getReactionsForMessage, getReactionsForMessages, updateMessageText, getUserBanned, getBlockedUserIds, setUserBlocked, setUserBannedByIdent, getUserById, getUserProfile, setUserAvatar, removeUserAvatar, getAvatarDir, addReport, getReports, removeReportsForTarget, getBannedUsers, isAdminNickname, getAllSessions, upsertSession, markSessionRevoked, touchSession, StoredSession, getChannelMediaKey, countRegistrations, oldestRegistration, recordRegistrationEvent } from './database.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { nextMondayMidnightMSK } from './time.js';
import {
  RATE_LIMIT_WINDOW,
  MAX_AUTH_ATTEMPTS,
  MAX_MESSAGE_CHARS,
  MIN_MESSAGE_INTERVAL,
  MAX_SESSIONS_PER_USER,
  MAX_CONNECTIONS_PER_IP,
  MAX_CONNECTIONS_PER_USER,
  MAX_REGISTRATIONS_PER_IP,
  MAX_ACCOUNTS_PER_DEVICE,
  POW_BITS,
  POW_CHALLENGE_TTL_MS,
  POW_MAX_CHALLENGES,
  REGISTRATION_WINDOW_MS,
  MAX_WS_PAYLOAD_SIZE,
  HEARTBEAT_INTERVAL,
  CLIENT_TIMEOUT,
  DM_TTL_ALLOWED_MS,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_PAYLOAD,
  AVATAR_CHANGE_INTERVAL_MS,
  WS_FRAME_WINDOW_MS,
  WS_FRAME_LIMIT_PER_CONNECTION,
  WS_FRAME_LIMIT_PER_ACCOUNT,
  WS_SEND_BUFFER_LIMIT,
  SEARCH_RATE_LIMIT,
  SEARCH_RATE_WINDOW,
  MAX_SEARCH_QUERY_CHARS,
  TRUSTED_PROXY_HOPS,
  INACTIVE_SESSION_TTL_MS,
} from './constants.js';

import { pseudonymizeAddress, stablePseudonymizeAddress, pseudonymizeDevice, coarsenDeviceLabel, appendSecurityLine } from './privacy.js';
import { pruneUploadTokens } from './uploadTokens.js';
import {
  recordFailedLogin,
  clearFailedLogins,
  loginLockedOut,
  pruneCounters,
  collectExpiredLocks,
  authCounterSizes,
  recordAuthAttempt,
  authAttemptRemainingMs,
} from './authCounters.js';

/**
 * One line in the security log.
 *
 * The address is a daily-rotating pseudonym and the device string is a coarse label, both applied here
 * rather than at each call site. That module existed and was described in the documentation, but
 * nothing called it: every entry went to disk with the caller's real address in it and the full user
 * agent stored beside it, which is the largest map of who used this server and from where an operator
 * could ask for. Applied once, here, it cannot be forgotten at a new call site.
 *
 * The nickname and the device id are pseudonymised too, and for the same reason the address is. They were
 * passed through in cleartext on every sign-in line, which quietly undid the rotation: an operator could
 * join one `nickname` across every day the file holds and read one person's movement over weeks, which is
 * exactly what the daily salt exists to prevent. Within a day the three still correlate, which is the log's
 * remaining value; across days they do not. The plaintext nickname stays in the `users` table, where it is
 * already joined to the account and has to be for the product to work.
 */
function logSecurity(event: string, details: Record<string, any>) {
  const safe: Record<string, any> = {};
  for (const [key, value] of Object.entries(details)) {
    // Keyed by key, and the list is exact on purpose. Anything not named here is written verbatim, so a
    // caller that spells a nickname `nick` or `target` rather than `nickname` bypasses the mapping
    // entirely - which it did, for every ban and unban, and the point of pseudonymising the rest is defeated
    // by the call site nobody read. A nickname is a nickname under all three spellings.
    if (key === 'ip') safe[key] = pseudonymizeAddress(String(value ?? ''));
    else if (key === 'nickname' || key === 'nick' || key === 'admin') safe[key] = pseudonymizeAddress(String(value ?? ''));
    else if (key === 'target') safe[key] = pseudonymizeAddress(String(value ?? ''));
    else if (key === 'deviceId') safe[key] = pseudonymizeDevice(String(value ?? ''));
    else if (key === 'deviceInfo') safe[key] = coarsenDeviceLabel(value);
    else safe[key] = value;
  }
  const entry = `[${new Date().toISOString()}] ${event} ${JSON.stringify(safe)}\n`;
  try {
    appendSecurityLine(entry);
  } catch (e) {
    console.error('Failed to write security log:', (e as Error).message);
  }
}

export interface ConnectedClient {
  deviceId: string;
  ws: WebSocket;
  userId: string;
  nickname: string;
  lastHeartbeat: number;
  ip: string;
  deviceInfo: string;
}

const clients = new Map<string, ConnectedClient>();

const userDevices = new Map<string, Set<string>>();

const sessionRecords = new Map<string, Map<string, StoredSession>>();
let sessionRegistryPromise: Promise<void> | null = null;

async function ensureSessionRegistry(): Promise<void> {
  if (!sessionRegistryPromise) {
    // A failure here is transient - a locked database, a busy file past `busy_timeout` - and the memo
    // used to keep the *rejection* forever. Every later call re-awaited the same rejected promise, so a
    // single blip took sign-in down for every account in the process until it was restarted, and
    // `sessionCapReached` sits right on the login path. The memo is dropped on the way out so the next
    // caller rebuilds it.
    sessionRegistryPromise = (async () => {
      const all = await getAllSessions();
      for (const rec of all) {
        let m = sessionRecords.get(rec.userId);
        if (!m) { m = new Map(); sessionRecords.set(rec.userId, m); }
        m.set(rec.deviceId, rec);
      }
    })().catch((e) => { sessionRegistryPromise = null; throw e; });
  }
  await sessionRegistryPromise;
  reconcileActiveSessions();
}

/**
 * Only fills in a record for a device that has none.
 *
 * This used to re-register anything that was missing or marked revoked, with `revoked: false`. That
 * meant a revocation the owner had just made could be undone by any later call from any account on the
 * server, which is not what "revoke" is supposed to mean.
 */
function reconcileActiveSessions(): void {
  for (const client of clients.values()) {
    const m = sessionRecords.get(client.userId);
    const rec = m?.get(client.deviceId);
    if (rec) continue;
    registerSession({
      userId: client.userId,
      deviceId: client.deviceId,
      nickname: client.nickname,
      deviceInfo: client.deviceInfo || '',
      firstSeen: client.lastHeartbeat,
      lastActive: client.lastHeartbeat,
      revoked: false,
    });
  }
}

/**
 * Records a device, keeping the two fields a fresh sign-in must not overwrite.
 *
 * `firstSeen` is when the device was added to the account, which is what the owner reads in Settings to
 * decide which session to revoke - resetting it on every login made every device look new. And a
 * revoked device stays revoked: revocation is the one thing in this table that a later login by the
 * same account must not undo.
 */
function registerSession(record: StoredSession): void {
  let m = sessionRecords.get(record.userId);
  if (!m) { m = new Map(); sessionRecords.set(record.userId, m); }
  const existing = m.get(record.deviceId);
  const merged: StoredSession = existing
    ? { ...record, firstSeen: existing.firstSeen, revoked: existing.revoked }
    : record;
  m.set(record.deviceId, merged);
  void upsertSession(merged).catch(() => {});
}

function sessionLastActive(userId: string, deviceId: string, ts: number): void {
  const m = sessionRecords.get(userId);
  const rec = m?.get(deviceId);
  if (rec) rec.lastActive = ts;
}

/**
 * Drops records the database has already forgotten.
 *
 * `sessionRecords` is a full copy of the `sessions` table for every account that has ever signed in, and
 * `pruneInactiveSessions` deletes the rows - but only the rows. The mirror kept every record for the
 * lifetime of the process, so an account that had ever signed in left a permanent per-device entry behind
 * whether or not the device still existed. Anything past INACTIVE_SESSION_TTL_MS is dead weight by the same
 * rule the sweep uses, and is dropped from here too.
 *
 * A record for a *live* socket is always kept regardless of age: it is what `get_sessions` reads to show the
 * current device, and the database sweep has not run over it yet in any case.
 */
function pruneSessionRegistry(now: number): void {
  const cutoff = now - INACTIVE_SESSION_TTL_MS;
  for (const [userId, records] of sessionRecords) {
    for (const [deviceId, rec] of records) {
      if (rec.lastActive < cutoff && !clients.has(clientKey(userId, deviceId))) records.delete(deviceId);
    }
    if (records.size === 0) sessionRecords.delete(userId);
  }
}
let totalConnections = 0;

/**
 * The socket registry is keyed by account *and* device together.
 *
 * `deviceId` is client-supplied and, on the client, stored once per browser rather than per account - so two
 * accounts signed in on the same machine legitimately present the same one. Keyed by device alone, the
 * second account to connect evicted the first one's socket with `close(4001)`, and the map then held only
 * whichever connected last: a second login in the same browser silently disconnected the first, and
 * receipts or typing updates for the first account were routed to the second account's socket.
 *
 * The pair is joined with a NUL, which cannot occur in either half, so `alice` + `bob` cannot be made to
 * collide with `al` + `icebob` by choosing ids.
 */
function clientKey(userId: string, deviceId: string): string {
  return `${userId}\u0000${deviceId}`;
}

function devicesForUser(userId: string): ConnectedClient[] {
  const ids = userDevices.get(userId);
  if (!ids) return [];
  const out: ConnectedClient[] = [];
  for (const id of ids) {
    const c = clients.get(clientKey(userId, id));
    if (c) out.push(c);
  }
  return out;
}

/** The first live socket for an account, for the few places that only need somebody to ask. */
function firstClientFor(userId: string | null | undefined): ConnectedClient | null {
  if (!userId) return null;
  const ids = userDevices.get(userId);
  if (!ids) return null;
  for (const id of ids) {
    const c = clients.get(clientKey(userId, id));
    if (c) return c;
  }
  return null;
}

function isUserOnline(userId: string): boolean {
  const ids = userDevices.get(userId);
  return !!ids && ids.size > 0;
}

function registerDevice(deviceId: string, client: ConnectedClient): void {
  const key = clientKey(client.userId, deviceId);
  const prev = clients.get(key);
  // Only ever a reconnect of the *same* account. Two accounts on one browser share a device id, so the
  // comparison has to be there: without it, signing in a second account kicks the first one off, and with
  // the id trusted at face value, guessing one would let anyone disconnect anyone.
  if (prev && prev.ws !== client.ws) {
    try { prev.ws.close(4001, 'Reconnected from another socket'); } catch {}
  }
  clients.set(key, client);
  if (!userDevices.has(client.userId)) userDevices.set(client.userId, new Set());
  userDevices.get(client.userId)!.add(deviceId);
}

async function sessionCapReached(userId: string, deviceId: string | null): Promise<boolean> {
  await ensureSessionRegistry();
  const reg = sessionRecords.get(userId);
  if (!reg) return false;
  if (deviceId) {
    const rec = reg.get(deviceId);
    if (rec) {
      if (rec.revoked) return true; 
      return false; 
    }
  }
  let active = 0;
  for (const rec of reg.values()) if (!rec.revoked) active++;
  return active >= MAX_SESSIONS_PER_USER;
}

/**
 * Drops a device from the live tables.
 *
 * `expectedWs` is what stops a reload from going deaf. The device id lives in localStorage, so a second
 * tab or a refresh sends the same one; the new socket takes the slot and the old socket is closed, and
 * when that old socket runs its close handler it looks its id up again. Without the check it finds the
 * *new* connection by id and unregisters that one instead, leaving the client that just logged in with
 * no socket registered at all.
 *
 * `userId` is part of the lookup for the same reason it is part of the key: a device id on its own is not
 * an identity, and two accounts in one browser share one.
 */
function unregisterDevice(userId: string | null, deviceId: string, expectedWs?: WebSocket): void {
    if (!userId) return;
    const key = clientKey(userId, deviceId);
    const client = clients.get(key);
    if (!client) return;
    if (expectedWs && client.ws !== expectedWs) return;
    clients.delete(key);
    const set = userDevices.get(client.userId);
    if (set) {
      set.delete(deviceId);
      if (set.size === 0) userDevices.delete(client.userId);
    }
  }

export function getTotalConnections(): number {
  return totalConnections;
}

/**
 * Drops every live socket at once, for the way out.
 *
 * `app.close()` closes them gracefully, and a graceful close is a handshake: the frame goes out and the
 * server waits for the other end to answer. A client that has gone away without a clean goodbye - a dropped
 * mobile link, a killed tab - never answers, so a restart would sit waiting on it for `ws`'s own timeout
 * instead of finishing. `terminate()` drops the socket without asking.
 */
export function terminateAllConnections(): void {
  for (const client of [...clients.values()]) {
    try { client.ws.terminate(); } catch { /* already gone */ }
  }
}

/**
 * Writes out the session activity that is still only in memory, for the way out.
 *
 * Only for sockets that are actually connected. A record whose socket has gone is left alone on purpose:
 * `touchSession` stamps the current time, so writing every record would move a device that has not been seen
 * in weeks up to the present and hand it months of life it had already spent. A live socket is the one case
 * where "now" is the honest value for `last_active`.
 *
 * On an ordinary restart the sweep and this are seconds apart, so it is mostly belt and braces; it matters
 * when the shutdown is fast, which is what a SIGTERM from the supervisor is.
 */
export async function flushSessionWrites(): Promise<void> {
  const writes: Promise<void>[] = [];
  for (const client of clients.values()) {
    writes.push(touchSession(client.userId, client.deviceId));
  }
  await Promise.allSettled(writes);
}

const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H8dQYhC1Bcye0e7o3mN0q0VWcZBp4eXmJzVQyGpL3uTIC';

const authAttempts = new Map<string, { count: number; resetAt: number }>();
const lastMessageTime = new Map<string, number>();
const connectionCounts = new Map<string, number>();

/** Accounts one address has created, and when, so a spammer cannot fill the users table. */
// The old in-memory registration counters, gone. Account creation is now counted from rows in the

const lastAvatarChange = new Map<string, number>();

interface AvatarInfo {
  ext: string;
  updatedAt: number | null;
}

function avatarInfo(u: { avatarExt: string | null; avatarUpdatedAt: number | null } | null | undefined): AvatarInfo | null {
  if (!u || !u.avatarExt) return null;
  return { ext: u.avatarExt, updatedAt: u.avatarUpdatedAt };
}

async function getProfileMeta(userId: string): Promise<{ avatarExt: string | null; avatarUpdatedAt: number | null } | null> {
  const u = await getUserById(userId);
  return u ? { avatarExt: u.avatarExt, avatarUpdatedAt: u.avatarUpdatedAt } : null;
}

async function buildAvatarInfoMap(): Promise<Map<string, { avatarExt: string | null; avatarUpdatedAt: number | null }>> {
  const users = await getAllUsers();
  return new Map(users.map(u => [u.id, { avatarExt: u.avatarExt, avatarUpdatedAt: u.avatarUpdatedAt }]));
}

function avatarRateOk(userId: string): boolean {
  const last = lastAvatarChange.get(userId) || 0;
  if (Date.now() - last < AVATAR_CHANGE_INTERVAL_MS) return false;
  lastAvatarChange.set(userId, Date.now());
  return true;
}

const AVATAR_MAGIC: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8,
  webp: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  gif: (b) => b.length > 6 && b.toString('ascii', 0, 3) === 'GIF',
};

function decodeAvatarDataUrl(dataUrl: unknown): { ext: string; buffer: Buffer } | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_AVATAR_PAYLOAD) return null;
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  const ext = m[1];
  const body = m[2];
  if (body.length % 4 === 1) return null;
  let buffer: Buffer;
  try { buffer = Buffer.from(body, 'base64'); } catch { return null; }
  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) return null;
  const check = AVATAR_MAGIC[ext];
  if (!check || !check(buffer)) return null;
  return { ext, buffer };
}

/**
 * How many accounts one subject may still create in the window, for a subject of the given scope.
 *
 * Counted from rows on disk rather than a Map in memory. That was the bug this replaced: the count lived
 * only as long as the process, so every restart - a deploy, an OOM kill, a crash - handed everybody a full
 * allowance again. It also means the number can be looked at afterwards rather than trusted, and that two
 * processes sharing a database would agree on it.
 *
 * A ceiling of zero lifts the limit entirely, checked here so every caller gets it for free.
 */
async function creationLimit(scope: 'ip' | 'device', subject: string, ceiling: number): Promise<{ allowed: boolean; retryHours: number }> {
  if (ceiling <= 0) return { allowed: true, retryHours: 0 };
  const used = await countRegistrations(scope, subject, REGISTRATION_WINDOW_MS);
  if (used < ceiling) return { allowed: true, retryHours: 0 };
  const oldest = await oldestRegistration(scope, subject, REGISTRATION_WINDOW_MS);
  // No oldest means no rows, which cannot happen alongside a non-zero count - but answering "free now" is
  // the safe failure, where "wait forever" would strand somebody who is in fact under the cap.
  const waitMs = oldest == null ? 0 : oldest + REGISTRATION_WINDOW_MS - Date.now();
  return { allowed: false, retryHours: Math.max(1, Math.ceil(waitMs / 3600000)) };
}

/**
 * Whether this address and this device may both create another account.
 *
 * Reported together because the person being refused needs one answer rather than two, and because the two
 * limits answer different questions: the device one is about *this* machine, the address one about a whole
 * network behind a single IP.
 */
async function registrationAllowed(ip: string, deviceId: string): Promise<{ allowed: boolean; retryHours: number; reason: 'ip' | 'device' }> {
  // Device first on purpose: its ceiling is much lower, so it is what refuses a normal person sooner, and
  // an address limit should not be the reason a household is turned away.
  const byDevice = await creationLimit('device', pseudonymizeDevice(deviceId), MAX_ACCOUNTS_PER_DEVICE);
  if (!byDevice.allowed) return { ...byDevice, reason: 'device' };
  // The stable pseudonym, not the rotating one: these rows are counted, and a counter keyed on a value
  // that changes at midnight would reset itself every night. See stablePseudonymizeAddress.
  const byIp = await creationLimit('ip', stablePseudonymizeAddress(ip), MAX_REGISTRATIONS_PER_IP);
  if (!byIp.allowed) return { ...byIp, reason: 'ip' };
  return { allowed: true, retryHours: 0, reason: 'device' };
}

/**
 * Charges the new account to both, but only once one really exists.
 *
 * Both or neither. A limit that charged one subject and not the other would be bypassable by holding the
 * other at its ceiling, and the two are meant to be independent.
 */
async function recordRegistration(ip: string, deviceId: string): Promise<void> {
  const at = Date.now();
  if (MAX_ACCOUNTS_PER_DEVICE > 0) await recordRegistrationEvent('device', pseudonymizeDevice(deviceId), at);
  if (MAX_REGISTRATIONS_PER_IP > 0) await recordRegistrationEvent('ip', stablePseudonymizeAddress(ip), at);
}

/**
 * Serialises the check-then-act, so a burst cannot walk past a ceiling it has already reached.
 *
 * `registrationAllowed` counted rows, then `createUser` made one, and only then did `recordRegistration`
 * write the row - with an await between every step. N `auth_register` frames arriving together therefore
 * all read the count *before* any of them wrote one, and all N were allowed: the ceiling was checked and
 * then not enforced, which is the one thing a ceiling cannot be. Holding a lock across all three steps
 * closes it.
 *
 * This is an in-process mutex, and that is enough here because the server is a single process: the limits
 * themselves are counted from rows on disk so they survive a restart, and a second process against the same
 * database would need a database-level lock instead - which is a different deployment, not a different
 * version of this. Nothing else holds these keys, so the table is emptied as the last holder of each one
 * releases, and it cannot grow.
 */
const registrationLocks = new Map<string, Promise<void>>();

async function lockRegistrationSubjects(keys: string[]): Promise<() => void> {
  // Sorted, so two callers whose key sets overlap always take them in the same order and cannot deadlock
  // against each other.
  const ordered = [...new Set(keys)].sort();
  // Read every tail before writing any of them. The two halves are synchronous, which is what makes the
  // pair atomic: a yield between them would let two callers both read the old tail and both proceed.
  const waitedFor: Promise<void>[] = [];
  for (const key of ordered) {
    const tail = registrationLocks.get(key);
    if (tail) waitedFor.push(tail);
  }
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  for (const key of ordered) registrationLocks.set(key, mine);
  for (const tail of waitedFor) await tail;
  return () => {
    // Only clear a key this caller still owns: a later caller overwrote it, and deleting its tail would let
    // a third through in front of it.
    for (const key of ordered) {
      if (registrationLocks.get(key) === mine) registrationLocks.delete(key);
    }
    release();
  };
}

/**
 * Registration proofs, waiting to be answered.
 *
 * Held in memory and that is right: losing them on a restart costs an honest person at most one repeat of
 * a search, while putting them in the database would make them a durable record of who was about to create
 * an account and when - which is the opposite of what this project stores.
 *
 * `solved` is what makes a proof single-use. Without it one search would authorise any number of accounts,
 * which would leave the cost of the hundredth identical to the cost of the first.
 */
const powChallenges = new Map<string, { bits: number; createdAt: number; solved?: boolean }>();

/** Counts leading zero bits, matching the client's definition exactly - see src/registerPow.ts. */
function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i];
    if (b === 0) { bits += 8; continue; }
    bits += Math.clz32(b) - 24;
    return bits;
  }
  return bits;
}

/** Drops challenges nobody answered, and forgets which ones have been spent. */
function prunePowChallenges(): void {
  const now = Date.now();
  for (const [challenge, entry] of powChallenges) {
    if (now - entry.createdAt > POW_CHALLENGE_TTL_MS) powChallenges.delete(challenge);
  }
  // Bound the map by refusing new ones once it is full. Better to turn an honest person away for a few
  // seconds than to let a flood of unanswered requests consume memory without limit.
  while (powChallenges.size >= POW_MAX_CHALLENGES) {
    const oldest = powChallenges.keys().next().value;
    if (oldest === undefined) break;
    powChallenges.delete(oldest);
  }
}

/** Issues a challenge and tells the client what difficulty to reach. */
function issuePowChallenge(ws: WebSocket): void {
  if (POW_BITS <= 0) return;
  prunePowChallenges();
  const challenge = crypto.randomBytes(16).toString('hex');
  powChallenges.set(challenge, { bits: POW_BITS, createdAt: Date.now() });
  send(ws, { type: 'auth_pow_challenge', payload: { challenge, bits: POW_BITS }, timestamp: Date.now() });
}

/**
 * Whether a registration carries a proof good enough to proceed.
 *
 * Answers false for a missing, wrong, expired, replayed or under-difficulty proof alike - from the server's
 * point of view they are the same event, and distinguishing them would tell whoever is probing how far they
 * got. The client re-reads the difficulty from the challenge it was issued and simply tries again.
 */
function checkPow(ws: WebSocket, payload: any): boolean {
  if (POW_BITS <= 0) return true;
  const challenge = typeof payload?.powChallenge === 'string' ? payload.powChallenge : '';
  const nonce = Number(payload?.powNonce);
  const entry = challenge ? powChallenges.get(challenge) : undefined;
  if (!entry || entry.solved) return false;
  if (Date.now() - entry.createdAt > POW_CHALLENGE_TTL_MS) {
    powChallenges.delete(challenge);
    return false;
  }
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  // The difficulty is the one *this* challenge was issued at, never the one in the request: accepting the
  // client's figure would make the whole thing optional.
  if (leadingZeroBits(crypto.createHash('sha256').update(`${nonce}:${challenge}`).digest()) < entry.bits) return false;
  // Spent, whether or not the rest of the registration goes on to succeed. Otherwise a solved proof could
  // be replayed until the account behind it failed for some unrelated reason.
  entry.solved = true;
  return true;
}

/** How many reports one account may file in the window, and why the ceiling exists. */
const MAX_REPORTS_PER_USER = 10;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const reportsByUser = new Map<string, number[]>();

/** How many prekey fetches one account may make in the window, and why the ceiling exists. */
const MAX_PREKEY_FETCHES = 300;
const PREKEY_FETCH_WINDOW_MS = 60 * 60 * 1000;
const preKeyFetches = new Map<string, number[]>();

/**
 * How often one account may search, per window.
 *
 * Search is the most expensive thing an authenticated account can ask for and the only one with no meter at
 * all. Two costs stack here: the query itself is answered from an FTS5 index, and the fallback is an
 * unindexable `instr(lower(text), ?)` scan over every row in the server. That fallback is taken whenever the
 * index returns nothing - a query simply has no hits - so an account that searched for a word nobody ever
 * typed paid for a scan of the whole server, once per keystroke's worth of patience. This is the meter that
 * bounds it; `stripFtsOperators` below keeps the common queries on the index path.
 */
const searchAttempts = new Map<string, number[]>();

function searchAllowed(userId: string): boolean {
  if (rateLimitsDisabled()) return true;
  const now = Date.now();
  const since = now - SEARCH_RATE_WINDOW;
  const recent = (searchAttempts.get(userId) || []).filter((t) => t > since);
  if (recent.length >= SEARCH_RATE_LIMIT) {
    searchAttempts.set(userId, recent);
    return false;
  }
  recent.push(now);
  searchAttempts.set(userId, recent);
  return true;
}

/**
 * A keyword with every FTS5 operator character taken out.
 *
 * Measured against the SQLite this ships with: doubling a quote - `"a""b"` - is *valid* FTS5 escaping and
 * does not throw, so a quote is not what forced the fallback. What does force it is a query the index simply
 * does not match: `searchMessages` treats zero rows as "the index cannot answer this" and re-runs the same
 * search as `instr(lower(text), ?) > 0 LIMIT 5000`, which no index can serve and which touches every row in
 * the server. So the characters removed here are the ones that can make a well-formed query match nothing -
 * a bare `NEAR`, `(`, or `^` reads as syntax inside the phrase - and `searchAllowed` above is what actually
 * bounds the damage from the queries that still come back empty.
 */
function stripFtsOperators(keyword: string): string {
  return keyword.replace(/["*()^]/g, '').trim();
}

function preKeyFetchAllowed(userId: string): boolean {
  if (rateLimitsDisabled()) return true;
  const now = Date.now();
  const since = now - PREKEY_FETCH_WINDOW_MS;
  const recent = (preKeyFetches.get(userId) || []).filter((t) => t > since);
  if (recent.length >= MAX_PREKEY_FETCHES) {
    preKeyFetches.set(userId, recent);
    return false;
  }
  recent.push(now);
  preKeyFetches.set(userId, recent);
  return true;
}

function reportAllowed(userId: string): boolean {
  const now = Date.now();
  const since = now - REPORT_WINDOW_MS;
  const recent = (reportsByUser.get(userId) || []).filter((t) => t > since);
  if (recent.length >= MAX_REPORTS_PER_USER) {
    reportsByUser.set(userId, recent);
    return false;
  }
  recent.push(now);
  reportsByUser.set(userId, recent);
  return true;
}

interface ServerMessage {
  type: string;
  payload: any;
  timestamp: number;
}

interface ClientMessage {
  type: string;
  payload: any;
}

function normalizeIp(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  let ip = raw.trim().toLowerCase();
  if (!ip) return 'unknown';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }
  return ip.replace(/^::ffff:/, '');
}

/**
 * Read at call time, like `rateLimitsDisabled` below: the flag is process state, and capturing it at
 * import made behaviour depend on which test file happened to load the module first.
 */
function trustProxyEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
}

/**
 * Whether a forwarding header may be believed.
 *
 * Behind a tunnel every socket arrives from the proxy itself, so the address was identical for all
 * users and they shared one rate limit bucket - which is why the header is read at all.
 *
 * It used to be honoured whenever the immediate peer was loopback, on the reasoning that a loopback peer
 * is a tunnel on this machine and nothing else. That holds for a same-host nginx, and it also holds for
 * anything else that binds a port on the same host: a second instance, a debugging tool, a container
 * publishing the port, a client connecting over loopback. Under any of those, one header was enough to
 * choose your own address, which walks straight past MAX_AUTH_ATTEMPTS, past the per-address registration
 * limit and past the connection cap. Trust is now a decision the operator makes by setting TRUST_PROXY,
 * and is not inferred from anything the request or the peer says about itself.
 */
function proxyHeadersTrusted(_socketIp: string): boolean {
  return trustProxyEnabled();
}

/**
 * The address this connection really came from.
 *
 * When a proxy is trusted, the chain is walked from the *right* for TRUSTED_PROXY_HOPS entries. The
 * leftmost element is what the client sent: a standard proxy appends the address it saw to whatever
 * arrived, so reading the left end means believing the client's own claim, which is the entire problem.
 *
 * `x-real-ip` is believed only where it agrees with that entry. It used to simply win, on the reasoning
 * that a proxy which sets it is stating the client's address outright rather than extending a list - true,
 * and beside the point: the header has no way to be genuine, because most proxies (Caddy, Traefik,
 * cloudflared, the usual hosting panels) do not set it at all, so whatever arrives is whatever the client
 * sent. `deploy.sh` ships `TRUST_PROXY=1`, which made this the configuration that ships, and it put every
 * per-address limit here - auth attempts, registrations, connections - one header away from being bypassed.
 * Agreeing with the chain is what makes it evidence rather than an assertion, and a proxy that sets both
 * consistently, as the common ones do, is unaffected.
 *
 * `app.ts` was making the same promotion on the HTTP side, into the header `req.ip` is derived from, which
 * had the same effect for the media and upload limits; that is gone too.
 */
function getClientIp(ws: WebSocket, upgradeRequest?: any): string {
  // @fastify/websocket hands the upgrade request to the route handler as the second argument, and
  // the ws socket itself does not keep it, so the forwarded headers are only reachable from here
  const req = upgradeRequest || (ws as any).req || (ws as any)._req;
  const socketIp = normalizeIp(req?.socket?.remoteAddress || (ws as any)._socket?.remoteAddress);
  if (!proxyHeadersTrusted(socketIp)) return socketIp;
  const headers = req?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : typeof forwarded === 'string' ? forwarded : '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const hops = Math.max(1, TRUSTED_PROXY_HOPS);
  const fromRight = chain.length > 0 ? chain[Math.max(0, chain.length - hops)] : '';
  const chosen = normalizeIp(fromRight.trim());
  // the chain is believed on its own. `x-real-ip` is read only to be checked against it, never to replace
  // it: where the two agree the answer is the same either way, and where they disagree the chain is the one
  // a real proxy wrote. An `x-real-ip` with no `x-forwarded-for` behind it is an assertion with nothing to
  // corroborate it, so it does not get one.
  if (chosen !== 'unknown') return chosen;
  return socketIp;
}

function checkMessageRateLimit(key: string): boolean {
  if (rateLimitsDisabled()) return true;
  const now = Date.now();
  const last = lastMessageTime.get(key) || 0;
  if (now - last < MIN_MESSAGE_INTERVAL) return false;
  lastMessageTime.set(key, now);
  return true;
}

// read at call time: the flag is process state, and capturing it at import made behaviour depend on
// which test file happened to load the module first
function rateLimitsDisabled(): boolean {
  return process.env.DISABLE_RATE_LIMITS === '1';
}

/** Milliseconds left before the auth limit for this ip expires, 0 when there is no active limit. */
function authRateRemainingMs(ip: string): number {
  const entry = authAttempts.get(ip);
  if (!entry) return 0;
  return Math.max(0, entry.resetAt - Date.now());
}

function checkAuthRateLimit(ip: string): boolean {
  if (rateLimitsDisabled()) return true;
  if (authRateRemainingMs(ip) === 0) return true;
  return (authAttempts.get(ip)?.count ?? 0) < MAX_AUTH_ATTEMPTS;
}

/** Only rejected credentials count towards the limit, so reconnects and autologin stay free. */
function recordAuthFailure(ip: string): void {
  if (rateLimitsDisabled()) return;
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return;
  }
  entry.count++;
}

/**
 * Forgets this address's *failed* attempts, so a correct password starts the next minute clean.
 *
 * Deliberately does not touch the work budget above. Clearing that one on success would hand an attacker who
 * has the password exactly what they need: sign in correctly, which resets the counter, and sign in again as
 * often as the loop allows - every one of them a full blocking bcrypt. So a successful sign-in spends the
 * budget like any other attempt and only the window gives it back, which is the same answer a sprayed
 * address already gets from MAX_AUTH_ATTEMPTS.
 */
function clearAuthRateLimit(ip: string): void {
  authAttempts.delete(ip);
}

function authLimitReason(ip: string): string {
  const seconds = Math.max(1, Math.ceil(authRateRemainingMs(ip) / 1000));
  return `Too many attempts. Try again in ${seconds} second(s).`;
}

/**
 * The budget on sign-in *work*, answered with the same string as the budget on failures.
 *
 * Deliberately not a new message: a caller that could tell "you have done too much work" from "you have
 * failed too much" learns which of the two counters it is up against, and a client picking names to spray
 * is exactly who should not get that. The two limits are told apart by the wait, not by the words.
 */
function authWorkLimitReason(ip: string): string {
  const seconds = Math.max(1, Math.ceil(authAttemptRemainingMs(ip) / 1000));
  return `Too many attempts. Try again in ${seconds} second(s).`;
}

/**
 * Charges every sign-in attempt against this address, before any of them touches bcrypt.
 *
 * `recordAuthFailure` above only ever counted rejections, which made MAX_AUTH_ATTEMPTS a ceiling on
 * *mistakes* rather than on cost - and the cost is the point, because a `bcryptjs` comparison at cost 12
 * is computed synchronously and takes about 310 ms of the single Node thread. Successes and attempts made
 * during a lockout were free, so an address could ask for a great deal of that. See
 * MAX_AUTH_ATTEMPTS_PER_ADDRESS.
 */
function recordAuthFrame(ip: string): boolean {
  if (rateLimitsDisabled()) return true;
  return recordAuthAttempt(ip);
}

/**
 * A frame budget, counted in a sliding window and metered before the frame is dispatched.
 *
 * Per connection and per account rather than per address, for the same reason the connection cap moves from
 * the address to the account once it authenticates: a shared network must not throttle unrelated people, and
 * one account must not be able to spend its budget across a dozen tabs to get twelve times the rate.
 */
const frameCounts = new Map<string, { count: number; resetAt: number }>();
let frameSlotCounter = 0;

function frameBudgetOk(key: string, limit: number): boolean {
  if (rateLimitsDisabled()) return true;
  const now = Date.now();
  const entry = frameCounts.get(key);
  if (!entry || now > entry.resetAt) {
    frameCounts.set(key, { count: 1, resetAt: now + WS_FRAME_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

/**
 * Sockets are counted per address only until they authenticate, because a whole cafe, office or
 * mobile carrier shares one public address. After the handshake the slot moves to the account, so
 * the limit tracks the person rather than the network they happen to sit behind.
 */
function claimConnection(key: string, cap: number): boolean {
  if (rateLimitsDisabled()) return true;
  const count = connectionCounts.get(key) || 0;
  if (count >= cap) return false;
  connectionCounts.set(key, count + 1);
  return true;
}

function releaseConnectionKey(key: string): void {
  const count = connectionCounts.get(key) || 0;
  if (count <= 1) connectionCounts.delete(key);
  else connectionCounts.set(key, count - 1);
}

/** Free slot for an authenticated user, without touching the per address counters. */
function userConnections(userId: string): number {
  return connectionCounts.get('user:' + userId) || 0;
}

/**
 * Both sanitizers coerce rather than trusting their argument.
 *
 * A client is free to send an object where a string belongs, and these are called on almost every frame.
 * Passing that straight to .replace() threw inside the handler, which cost the caller its answer for
 * that request; the socket recovered but the frame never came. Anything that is not a string is simply
 * empty, which is what the caller would have got from a missing field anyway.
 */
function sanitize(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[<>&"']/g, '')
    .trim();
}

function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim();
}

function isValidNickname(nick: string): boolean {
  return /^[a-zA-Z0-9_-]{3,16}$/.test(nick);
}

function hasUnsafeOwnKeys(obj: any): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  return Object.keys(obj).some(k => k === '__proto__' || k === 'constructor' || k === 'prototype');
}

/**
 * What a rejected bundle looked like, for the log.
 *
 * A client on an older build, or one whose crypto failed to initialise, used to send nothing useful
 * here, and the server answered with silence in both cases. Recording the shape is the only way to tell
 * those apart after the fact.
 */
function preKeyBundleDiagnostics(bundle: any): Record<string, any> {
  if (!bundle || typeof bundle !== 'object') return { present: false };
  const spk = bundle.signedPreKey;
  return {
    present: true,
    // Bounded, because this runs on the *reject* path - which is exactly where the bundle's own size
    // cap no longer applies. Joining every key name meant a hostile frame could put megabytes of
    // attacker-chosen strings into a line that `appendFileSync` then writes while holding the event
    // loop. The shape is all this is for, so a handful of truncated names says it just as well.
    keys: Object.keys(bundle).slice(0, 32).map((k) => k.slice(0, 64)).join(','),
    keyCount: Object.keys(bundle).length,
    jsonLen: (() => { try { return JSON.stringify(bundle).length; } catch { return -1; } })(),
    identityKeyType: typeof bundle.identityKey,
    identityKeyLen: typeof bundle.identityKey === 'string' ? bundle.identityKey.length : -1,
    spkType: spk === null ? 'null' : typeof spk,
    spkPublicKeyType: spk && typeof spk === 'object' ? typeof spk.publicKey : 'n/a',
    signatureIsArray: Array.isArray(spk && spk.signature),
    signatureLen: Array.isArray(spk && spk.signature) ? spk.signature.length : -1,
    oneTimePreKeyType: bundle.oneTimePreKey === undefined ? 'undefined' : typeof bundle.oneTimePreKey,
    version: typeof bundle.version,
    bundleVersion: typeof bundle.bundleVersion,
  };
}

/**
 * Records one device's prekey material, and its account-level identity key.
 *
 * Two different keys with two different jobs. The identity key is what a safety number is computed from,
 * so it belongs to the account and has to be identical on every device - a number that changed per
 * device would prove nothing. The bundle's own keys are per device, because a ratchet session is
 * between two devices and sharing it across three of them would put one device's chain keys on the
 * others. The first sign-in establishes the account key and later ones leave it alone: it is the one
 * piece of key material here that must not move under a conversation that was pinned to it.
 */
async function storePreKeys(userId: string, deviceId: string | null | undefined, payload: any): Promise<void> {
  if (isValidPreKeyBundle(payload?.preKeyBundle) && deviceId) {
    // a fresh bundle carries fresh one-time prekeys, so what was spent against the old ids does not apply
    // to these; keeping the old record would only grow, and worse would mark ids that now mean something
    // else as already spent
    await resetIssuedPreKeys(userId, deviceId);
    await setPreKeyBundle(userId, deviceId, payload.preKeyBundle);
  }
  const accountKey = payload?.identityKey;
  if (isValidIdentityKey(accountKey) && !(await getIdentityKeyB64(userId))) {
    await setIdentityKeyB64(userId, accountKey);
  }
}

/** A base64 public key of the size the identity keys actually are, and nothing longer. */
function isValidIdentityKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function isValidPreKeyBundle(bundle: any): boolean {
  if (typeof bundle !== 'object' || bundle === null) return false;
  const MAX_BUNDLE_SIZE = 10000;
  const str = JSON.stringify(bundle);
  if (str.length > MAX_BUNDLE_SIZE) return false;
  if (hasUnsafeOwnKeys(bundle)) return false;
  if (typeof bundle.identityKey !== 'string' || bundle.identityKey.length === 0) return false;
  if (typeof bundle.ed25519PublicKey !== 'string') return false;
  if (typeof bundle.signedPreKey !== 'object' || bundle.signedPreKey === null) return false;
  if (hasUnsafeOwnKeys(bundle.signedPreKey)) return false;
  if (typeof bundle.signedPreKey.publicKey !== 'string') return false;
  if (!Array.isArray(bundle.signedPreKey.signature)) return false;
  if (bundle.oneTimePreKey && typeof bundle.oneTimePreKey !== 'object') return false;
  // the client sends "version"; the legacy format used "bundleVersion"
  const version = typeof bundle.bundleVersion === 'number' ? bundle.bundleVersion
    : typeof bundle.version === 'number' ? bundle.version
      : 0;
  if (version < 1) return false;
  return true;
}

function isValidPublicKey(key: any): boolean {
  if (typeof key !== 'object' || key === null) return false;
  const MAX_KEY_SIZE = 5000;
  const str = JSON.stringify(key);
  if (str.length > MAX_KEY_SIZE) return false;
  if (hasUnsafeOwnKeys(key)) return false;
  if (key.kty !== 'RSA') return false;
  if (key.alg !== 'RSA-OAEP' && key.alg !== 'RSA-OAEP-256') return false;
  if (typeof key.n !== 'string' || typeof key.e !== 'string') return false;
  return true;
}

/**
 * The ceiling on one encrypted body.
 *
 * The websocket frame is four megabytes, and whatever arrives in it goes straight into a column. A
 * client that ignored the shape check used to be able to file a four-megabyte "message" per send, which
 * is a cheap way to fill somebody's disk. A real body is a few hundred bytes of text plus one wrapped
 * key per recipient, so this is generous by an order of magnitude.
 */
const MAX_ENCRYPTED_BODY_BYTES = 64 * 1024;
const MAX_FILE_KEY_ENTRIES = 512;

/** How many devices one message may carry a body for. Three is the session cap, plus headroom. */
const MAX_DEVICE_BODIES = 8;

function isValidEncryptedBody(body: any): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  if (hasUnsafeOwnKeys(body)) return false;
  let size: number;
  try {
    size = JSON.stringify(body).length;
  } catch {
    return false;
  }
  if (size > MAX_ENCRYPTED_BODY_BYTES) return false;
  if (typeof body.ciphertext !== 'string' || body.ciphertext.length === 0) return false;
  if (body.iv !== undefined && typeof body.iv !== 'string') return false;
  if (body.encryptedKeys !== undefined) {
    if (typeof body.encryptedKeys !== 'object' || body.encryptedKeys === null || Array.isArray(body.encryptedKeys)) return false;
    if (hasUnsafeOwnKeys(body.encryptedKeys)) return false;
    if (Object.keys(body.encryptedKeys).length > MAX_FILE_KEY_ENTRIES) return false;
    for (const value of Object.values(body.encryptedKeys)) {
      if (typeof value !== 'string' || value.length > 4096) return false;
    }
  }
  // the ratchet header travels beside the body and is bounded the same way
  if (body.ratchetPublicKey !== undefined) {
    if (typeof body.ratchetPublicKey !== 'string' || body.ratchetPublicKey.length > 512) return false;
  }
  if (body.messageNumber !== undefined && !Number.isInteger(body.messageNumber)) return false;
  if (body.messageNumber !== undefined && (body.messageNumber as number) < 0) return false;
  return true;
}

/**
 * The device fan-out: one sealed body per device the conversation reaches.
 *
 * A shape of `{ kind: 'devices', bodies: [{ deviceId, body }] }` rather than a bare body, and the
 * distinction is checked rather than assumed - a sender on an older build sends the bare form and must
 * still be able to reach somebody. Everything inside is validated exactly as a single body would be, so
 * the wrapper cannot be used to smuggle something past the size limit or to carry a key where a
 * ciphertext belongs.
 */
function isValidDeviceBodies(value: any): value is { kind: 'devices'; bodies: { deviceId: string; body: any }[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (value.kind !== 'devices') return false;
  if (!Array.isArray(value.bodies) || value.bodies.length === 0 || value.bodies.length > MAX_DEVICE_BODIES) return false;
  let size = 0;
  const seen = new Set<string>();
  for (const entry of value.bodies) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    if (typeof entry.deviceId !== 'string' || entry.deviceId.length === 0 || entry.deviceId.length > 128) return false;
    // one body per device: a duplicate would be a second copy of the same words for no gain
    if (seen.has(entry.deviceId)) return false;
    seen.add(entry.deviceId);
    if (!isValidEncryptedBody(entry.body)) return false;
    try {
      size += JSON.stringify(entry.body).length;
    } catch {
      return false;
    }
  }
  // the total, not each body alone: eight legal bodies are still one oversized frame
  return size <= MAX_ENCRYPTED_BODY_BYTES;
}

/**
 * Whether this account may see this message at all.
 *
 * A direct channel is a pair of ids joined by a colon, and only that pair; a channel of any other shape is
 * reachable by nobody rather than by everybody. At module scope because every message operation asks it and
 * one of them - the reporter - is not a socket handler.
 */
function canAccessMessage(userId: string, msg: { channel?: string | null }): boolean {
  if (!msg.channel || msg.channel === 'general') return true;
  if (msg.channel.includes(':')) {
    const parts = msg.channel.split(':');
    return parts.length === 2 && (parts[0] === userId || parts[1] === userId);
  }
  return msg.channel === userId;
}

function isValidDmEncryptedPayload(value: any): boolean {
  return isValidEncryptedBody(value) || isValidDeviceBodies(value);
}

/**
 * The one body out of a stored fan-out that this device is meant to open.
 *
 * A bare body passes through untouched, so a conversation with a single device on each side is stored
 * and served exactly as it always was. A fan-out with no body for this device yields null, which the
 * client shows as a message it cannot read - and it is still counted, still reacted to and still
 * deletable, because a message nobody can open is not a message that did not happen.
 *
 * The three cases are kept apart deliberately, and the middle one refuses rather than falling through.
 * This used to ask only "is this a valid fan-out?", and hand the whole object back when the answer was
 * no - so a stored value that said `kind: 'devices'` but failed validation was treated as a bare body
 * and delivered whole. That is every device's ciphertext at once: the peer's laptop, the sender's other
 * phones. The write path (`handleDmSend`) and this read path run the same validator, so nothing in the
 * current code produces such a row, and that is exactly why it went unnoticed: the bug needed a legacy
 * row or one future tweak to the validator to fire, and would then leak silently and completely.
 */
function bodyForDevice(stored: any, deviceId?: string | null): any {
  // Not a fan-out: a bare body, or nothing at all.
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored) || stored.kind !== 'devices') {
    return stored || null;
  }
  // A fan-out that does not validate is never a bare body, whatever else it may be.
  if (!isValidDeviceBodies(stored)) return null;
  if (!deviceId) return null;
  return stored.bodies.find((entry) => entry.deviceId === deviceId)?.body ?? null;
}

function isValidFileKeyMap(fileKey: any): boolean {
  if (typeof fileKey !== 'object' || fileKey === null || Array.isArray(fileKey)) return false;
  if (hasUnsafeOwnKeys(fileKey)) return false;
  const entries = Object.entries(fileKey);
  if (entries.length > MAX_FILE_KEY_ENTRIES) return false;
  // each entry is "<iv>:<wrapped key>" and both halves are base64
  return entries.every(([, value]) =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && value.includes(':')
  );
}

/** How big a rejected payload was, for the log - the value itself is never worth keeping. */
function safeJsonLength(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s.length : -1;
  } catch {
    return -1;
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= WS_SEND_BUFFER_LIMIT) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Relays a frame to every connected client.
 *
 * The one client with a deep send buffer is skipped rather than queued. `ws.send()` appends to an
 * in-process buffer and never blocks, so a client that has stopped reading - asleep, on a dead mobile
 * link, or deliberately - does not slow this loop down, it just makes the server hold the frame for it.
 * With MAX_TOTAL_CONNECTIONS clients on the other end, `typing` on the general channel was a way to make
 * every one of them cost the server memory. Skipping a client that is already over the ceiling keeps the
 * cost flat; it picks the conversation back up on the next frame that gets through.
 */
function broadcast(message: ServerMessage, excludeUserId?: string): void {
  const data = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.userId !== excludeUserId && client.ws.readyState === WebSocket.OPEN
      && client.ws.bufferedAmount <= WS_SEND_BUFFER_LIMIT) {
      client.ws.send(data);
    }
  }
}

export function handleConnection(ws: WebSocket, upgradeRequest?: any): void {
   let currentUserId: string | null = null;
   let currentDeviceId: string | null = null;
   const ip = getClientIp(ws, upgradeRequest);
  const ipKey = 'ip:' + ip;
  let connectionKey: string = ipKey;
  // A key that does not move when the socket authenticates. `connectionKey` is deliberately reassigned at
  // sign-in (the slot moves from the shared address to the account), and a frame budget keyed on it would
  // hand out a fresh allowance at exactly that moment.
  const frameSlot = 'conn:' + (++frameSlotCounter);
  totalConnections++;

  if (!claimConnection(ipKey, MAX_CONNECTIONS_PER_IP)) {
    logSecurity('CONNECTION_LIMIT', { ip, scope: 'ip' });
    send(ws, { type: 'error', payload: { code: 'CONNECTION_LIMIT', message: 'Too many connections from your network' }, timestamp: Date.now() });
    ws.close(1008, 'Connection limit');
    totalConnections--;
    return;
  }

  ws.on('message', (data: Buffer) => {
    if (data.length > MAX_WS_PAYLOAD_SIZE) {
      send(ws, { type: 'error', payload: { code: 'PAYLOAD_TOO_LARGE', message: 'Message too large' }, timestamp: Date.now() });
      return;
    }

    // Before the frame is even parsed, and for every type: the per-type meters below only ever covered the
    // two kinds that write to a channel, so `typing`, `dm_read`, `search_messages`, `prekey_upload`,
    // `get_sessions` and the rest could be sent as fast as the socket would take them - and the first of
    // those is a broadcast to every client on the server. The per-account budget is only consulted once
    // there is an account to consult it against; before sign-in the connection's own budget is all there is.
    if (!frameBudgetOk(frameSlot, WS_FRAME_LIMIT_PER_CONNECTION)) {
      return;
    }
    if (currentUserId && !frameBudgetOk('wsacct:' + currentUserId, WS_FRAME_LIMIT_PER_ACCOUNT)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Too many frames.' }, timestamp: Date.now() });
      return;
    }

    try {
      const parsed = JSON.parse(data.toString());
      if (typeof parsed?.type !== 'string' || parsed.type.length > 64) {
        send(ws, { type: 'error', payload: { code: 'INVALID_JSON', message: 'Invalid message format' }, timestamp: Date.now() });
        return;
      }
      const payload = (parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)) ? parsed.payload : {};
      const message: ClientMessage = { type: sanitize(parsed.type), payload };
      handleMessage(ws, currentUserId, message).catch((err: unknown) => {
        const e = err as { message?: string; code?: string };
        console.error(`Handler error (${e?.code || 'n/a'}): ${e?.message || 'unknown'}`);
        send(ws, { type: 'error', payload: { code: 'INTERNAL', message: 'Internal server error' }, timestamp: Date.now() });
      });
    } catch {
      send(ws, { type: 'error', payload: { code: 'INVALID_JSON', message: 'Invalid JSON' }, timestamp: Date.now() });
    }
  });

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    handleDisconnect(currentDeviceId, currentUserId, ws);
    releaseConnectionKey(connectionKey);
    totalConnections = Math.max(0, totalConnections - 1);
  };
  ws.on('close', dispose);
  ws.on('error', dispose);

  ws.on('pong', () => {
    if (currentDeviceId && currentUserId) {
      const client = clients.get(clientKey(currentUserId, currentDeviceId));
      if (client) client.lastHeartbeat = Date.now();
    }
  });

  async function handleMessage(ws: WebSocket, userId: string | null, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'auth_login':
        // Refused rather than re-run: `auth_login` was dispatched with no check, so a socket that already
        // holds an account could sign in as a second one and `registerDevice` would add a *second* registry
        // entry pointing at the same socket - every later broadcast then delivered to it twice, and one of
        // its three session slots was spent without the owner ever seeing a device appear. Dropping the
        // stale entries first was the other option and is worse: a client that re-authenticates after a
        // token refresh would silently lose the registration its messages are routed by.
        if (currentUserId) {
          send(ws, { type: 'auth_failure', payload: { reason: 'Already signed in on this connection' }, timestamp: Date.now() });
          return;
        }
        await handleAuthLogin(ws, message.payload);
        break;
      case 'auth_register':
        await handleAuthRegister(ws, message.payload);
        break;
      case 'chat_message':
        if (userId) await handleChatMessage(userId, ws, message.payload);
        break;
      case 'dm_send':
        if (userId) await handleDmSend(userId, ws, message.payload);
        break;
      case 'key_backup_upload':
        if (userId) await handleKeyBackupUpload(userId, ws, message.payload);
        break;
      case 'key_backup_fetch':
        if (userId) await handleKeyBackupFetch(userId, ws);
        break;
      case 'dm_history':
      if (userId) await handleDmHistory(userId, ws, message.payload);
      break;
    case 'chat_history':
      if (userId) await handleChatHistory(userId, ws, message.payload);
      break;
      case 'dm_contacts':
        if (userId) await handleDmContacts(userId, ws);
        break;
      case 'search_users':
        if (userId) await handleSearchUsers(userId, ws, message.payload);
        break;
      case 'search_messages':
        if (userId) await handleSearchMessages(userId, ws, message.payload);
        break;
      case 'delete_message':
        if (userId) await handleDeleteMessage(userId, ws, message.payload);
        break;
      case 'edit_message':
        if (userId) await handleEditMessage(userId, ws, message.payload);
        break;
      case 'add_reaction':
        if (userId) await handleAddReaction(userId, ws, message.payload);
        break;
      case 'remove_reaction':
        if (userId) await handleRemoveReaction(userId, ws, message.payload);
        break;
      case 'auth_update_key':
        if (userId) await handleAuthUpdateKey(userId, ws, message.payload);
        break;
      case 'prekey_upload':
        if (userId) await handlePreKeyUpload(userId, ws, message.payload);
        break;
      case 'prekey_fetch':
        if (userId) await handlePreKeyFetch(userId, ws, message.payload);
        break;
      case 'heartbeat':
        if (currentDeviceId && userId) {
          const client = clients.get(clientKey(userId, currentDeviceId));
          if (client) client.lastHeartbeat = Date.now();
          send(ws, { type: 'heartbeat_ack', payload: {}, timestamp: Date.now() });
        }
        break;
      case 'typing':
        if (userId) await handleTyping(userId, ws, message.payload);
        break;
      case 'dm_read':
        if (userId) await handleDmRead(userId, ws, message.payload);
        break;
      case 'get_sessions':
        if (userId) await handleGetSessions(userId, ws, currentDeviceId);
        break;
      case 'revoke_session':
        if (userId) await handleRevokeSession(userId, ws, message.payload, currentDeviceId);
        break;
      case 'block_user':
        if (userId) await handleBlockUser(userId, ws, message.payload);
        break;
      case 'unblock_user':
        if (userId) await handleUnblockUser(userId, ws, message.payload);
        break;
      case 'get_blocked':
        if (userId) await handleGetBlocked(userId, ws);
        break;
      case 'report_user':
        if (userId) await handleReportUser(userId, ws, message.payload);
        break;
      case 'admin_ban':
        await handleAdminBan(userId, ws, message.payload);
        break;
      case 'admin_unban':
        await handleAdminUnban(userId, ws, message.payload);
        break;
      case 'admin_reports':
        await handleAdminReports(userId, ws, message.payload);
        break;
      case 'get_banned':
        await handleGetBanned(userId, ws, message.payload);
        break;
      case 'profile_get':
        if (userId) await handleProfileGet(userId, ws, message.payload);
        break;
      case 'avatar_set':
        if (userId) await handleAvatarSet(userId, ws, message.payload);
        break;
      case 'avatar_remove':
        if (userId) await handleAvatarRemove(userId, ws);
        break;
      default:
        logSecurity('UNKNOWN_COMMAND', { type: message.type, auth: !!userId, ip });
        send(ws, { type: 'error', payload: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' }, timestamp: Date.now() });
    }
  }

  async function handleAuthLogin(ws: WebSocket, payload: { nickname: string; password: string; preKeyBundle?: any; deviceId?: string; deviceInfo?: string }): Promise<void> {
    if (!checkAuthRateLimit(ip)) {
      logSecurity('RATE_LIMIT_AUTH', { ip, nickname: typeof payload?.nickname === 'string' ? payload.nickname.slice(0, 32) : '' });
      send(ws, { type: 'auth_failure', payload: { reason: authLimitReason(ip) }, timestamp: Date.now() });
      return;
    }

    // Charged before anything is hashed, and charged whatever the outcome. This is the ceiling on *work*,
    // as opposed to checkAuthRateLimit above, which is a ceiling on failures and is therefore only ever
    // spent after the bcrypt has already happened. Refusing here is what stops one unauthenticated socket
    // from asking for a minute of solid CPU time by guessing, because `bcryptjs` computes the KDF
    // synchronously and a cost-12 comparison takes about 310 ms of the single Node thread.
    if (!recordAuthFrame(ip)) {
      logSecurity('RATE_LIMIT_AUTH', { ip, nickname: typeof payload?.nickname === 'string' ? payload.nickname.slice(0, 32) : '' });
      send(ws, { type: 'auth_failure', payload: { reason: authWorkLimitReason(ip) }, timestamp: Date.now() });
      return;
    }

    const { nickname, password } = payload;

    if (!nickname || !password) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Nickname and password required' }, timestamp: Date.now() });
      return;
    }

    const cleanNick = sanitize(nickname);
    if (!isValidNickname(cleanNick)) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Invalid nickname: 3-16 chars, letters/numbers/_-' }, timestamp: Date.now() });
      return;
    }

    const nicknameKey = cleanNick.toLowerCase();
    const pairKey = ip + '|' + nicknameKey;

    // Asked before the comparison rather than after it. It used to be consulted only once the comparison
    // had already been paid for, so an address sitting on a lockout - which is precisely where an attacker
    // wants to be - was buying a full cost-12 comparison per attempt and getting nothing for it, twice over
    // because the dummy compare below ran as well.
    //
    // What this deliberately does *not* do is refuse the attempt. Refusing here would mean a lockout could
    // turn away the correct password, which is a denial of service against the account's owner rather than
    // a slower guess: anybody who knew a name could hold it shut for five minutes at a time. So the real
    // comparison still runs - that is what lets the right password in however many failures have piled up -
    // and what the lockout buys is that the *dummy* comparison, the one that exists only to make a miss
    // indistinguishable from a wrong password, is skipped. For a name that does not exist - the case a spray
    // spends its time in - that is the whole cost, so a locked-out spray now hashes nothing at all.
    // The remaining cost per attempt is bounded by the per-address work budget charged above.
    const lockedBeforeCompare = loginLockedOut(pairKey, nicknameKey);

    const user = await getUserByNickname(cleanNick);

    // A name that does not exist still gets the full comparison, so a miss is indistinguishable from a
    // wrong password in both the answer and the time it takes.
    const passwordMatches = user && user.passwordHash && typeof password === 'string'
      ? await bcrypt.compare(String(password), user.passwordHash)
      : false;
    if (!passwordMatches && lockedBeforeCompare === 0) {
      // A name that does not exist still pays for the full comparison, so a miss is indistinguishable
      // from a wrong password in both the answer and the time it takes.
      await bcrypt.compare(String(password || ''), DUMMY_PASSWORD_HASH);
    }

    if (!passwordMatches || !user) {
      const lockedMinutes = lockedBeforeCompare > 0 ? lockedBeforeCompare : loginLockedOut(pairKey, nicknameKey);
      if (lockedMinutes > 0) {
        recordAuthFailure(ip);
        logSecurity('LOGIN_LOCKED', { nickname: cleanNick, ip, remainingMin: lockedMinutes });
        send(ws, { type: 'auth_failure', payload: { reason: `Account locked. Try again in ${lockedMinutes} minute(s).` }, timestamp: Date.now() });
        return;
      }
      const { count, lockedUntil } = recordFailedLogin(pairKey, nicknameKey);
      recordAuthFailure(ip);
      logSecurity('LOGIN_FAILED', { nickname: cleanNick, ip, attempts: count, locked: lockedUntil > 0 });
      send(ws, { type: 'auth_failure', payload: { reason: 'Invalid nickname or password' }, timestamp: Date.now() });
      return;
    }

    logSecurity('LOGIN_SUCCESS', { nickname: cleanNick, ip });
    clearFailedLogins(nicknameKey);
    clearAuthRateLimit(ip);

    if (await getUserBanned(user.id)) {
      logSecurity('LOGIN_BANNED', { nickname: cleanNick, ip });
      send(ws, { type: 'auth_failure', payload: { reason: 'Account banned' }, timestamp: Date.now() });
      return;
    }

    const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
      ? payload.deviceId : crypto.randomUUID();

    if (await sessionCapReached(user.id, deviceId)) {
      logSecurity('SESSION_LIMIT', { nickname: cleanNick, ip, deviceId });
      send(ws, { type: 'auth_failure', payload: { reason: `Session limit reached (${MAX_SESSIONS_PER_USER} max). Log out on another device or revoke one in Settings.` }, timestamp: Date.now() });
      return;
    }

    if (userConnections(user.id) >= MAX_CONNECTIONS_PER_USER) {
      logSecurity('CONNECTION_LIMIT', { nickname: cleanNick, ip, scope: 'user' });
      send(ws, { type: 'auth_failure', payload: { reason: `Too many open clients for this account (${MAX_CONNECTIONS_PER_USER} max). Close some tabs or devices.` }, timestamp: Date.now() });
      return;
    }

    // the slot now belongs to the account instead of the shared address behind it
    releaseConnectionKey(connectionKey);
    connectionKey = 'user:' + user.id;
    claimConnection(connectionKey, MAX_CONNECTIONS_PER_USER);

    const now = Date.now();
    registerSession({ userId: user.id, deviceId, nickname: user.nickname, deviceInfo: coarsenDeviceLabel(payload?.deviceInfo), firstSeen: now, lastActive: now, revoked: false });
    currentUserId = user.id;
    currentDeviceId = deviceId;
    registerDevice(deviceId, { deviceId, ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip, deviceInfo: coarsenDeviceLabel(payload?.deviceInfo) });

// Stored before the sign-in reply, not after. The reply carries this account's own identity key, so a
    // client that published its first one here would otherwise be told it has none and would show an
    // unverifiable contact until the next sign-in.
    await storePreKeys(user.id, deviceId, payload);
    await onAuthenticated(user.id, user.nickname, ws, deviceId);
  }

  async function handleAuthRegister(ws: WebSocket, payload: { nickname: string; password: string; publicKey?: any; preKeyBundle?: any; deviceId?: string; deviceInfo?: string }): Promise<void> {
    if (!checkAuthRateLimit(ip)) {
      send(ws, { type: 'auth_failure', payload: { reason: authLimitReason(ip) }, timestamp: Date.now() });
      return;
    }

    const { nickname, password } = payload;

    if (!nickname || !password) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Nickname and password required' }, timestamp: Date.now() });
      return;
    }

    const cleanNick = sanitize(nickname);
    const cleanPass = password;

    if (!isValidNickname(cleanNick)) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Nickname: 3-16 chars, letters/numbers/_-' }, timestamp: Date.now() });
      return;
    }

    // Read here rather than further down, because the creation limit needs it: the device cap is checked
    // before the account is made, so the id has to be in hand by then. The bound matters - it is what keeps
    // an untrusted client from putting a megabyte of text into a pseudonym that gets written down.
    const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
      ? payload.deviceId : crypto.randomUUID();

    // Before anything expensive, and before any of the per-address and per-device counting, so that being
    // asked for a proof costs nothing and answers nothing. The search itself is the brake.
    if (!checkPow(ws, payload)) {
      issuePowChallenge(ws);
      return;
    }

    if (await isAdminNickname(cleanNick)) {
      send(ws, { type: 'auth_failure', payload: { reason: 'This nickname is reserved' }, timestamp: Date.now() });
      logSecurity('RESERVED_NICK_REGISTER', { nick: cleanNick, ip });
      return;
    }

    // The second lookup is not a fallback for a broken first one - it is the only case-insensitive
    // uniqueness check in the system. `users.nickname` is declared `UNIQUE`, and SQLite's UNIQUE is
    // case-sensitive, so on its own it happily holds `Ana` and `ana` at once. The indexed lookup above asks
    // for the lower-cased name and misses whenever a name was stored with capitals, which is why the scan
    // exists. Two accounts differing only in case would break nickname addressing everywhere else - DMs,
    // blocking, the admin check - so this cost is worth paying and the row count is bounded by the
    // per-address registration limit above it.
    const sameNick = await getUserByNickname(cleanNick.toLowerCase()) || (await getAllUsers()).find(u => u.nickname.toLowerCase() === cleanNick.toLowerCase());
    if (sameNick) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Nickname already taken' }, timestamp: Date.now() });
      return;
    }

    // Checked only once the name is genuinely free: a refusal that happens before the account exists
    // must not spend the budget, or one person holding a name could stop a whole network registering.
    //
    // The lock is taken before the count and released after the row is written, so the three steps below
    // cannot interleave with another registration for the same address or the same device. Without it
    // every one of a burst read the count before any of them wrote one, and all of them were allowed -
    // a ceiling that is checked and then not enforced. Both subjects are held at once, because a limit
    // that only covered one of them would be bypassable by exhausting the other.
    const releaseSubjects = await lockRegistrationSubjects([
      'device:' + pseudonymizeDevice(deviceId),
      'ip:' + stablePseudonymizeAddress(ip),
    ]);
    try {
      const registration = await registrationAllowed(ip, deviceId);
      if (!registration.allowed) {
        const byDevice = registration.reason === 'device';
        send(ws, {
          type: 'auth_failure',
          payload: {
            // Naming which limit fired, because they are not interchangeable: "this device" is something the
            // person can do something about by signing out or switching accounts, while "this network" is
            // shared with everyone else behind the same address and is not theirs to raise.
            reason: byDevice
              ? `Too many accounts from this device. Try again in ${registration.retryHours} hour(s), or sign in to an existing account.`
              : `Too many accounts created from this network. Try again in ${registration.retryHours} hour(s).`,
          },
          timestamp: Date.now(),
        });
        logSecurity('REGISTRATION_LIMIT', {
          ip,
          scope: registration.reason,
          limit: byDevice ? MAX_ACCOUNTS_PER_DEVICE : MAX_REGISTRATIONS_PER_IP,
          retryHours: registration.retryHours,
        });
        return;
      }

      if (typeof cleanPass !== 'string' || cleanPass.length < 8 || cleanPass.length > 64) {
        send(ws, { type: 'auth_failure', payload: { reason: 'Password must be 8-64 characters' }, timestamp: Date.now() });
        return;
      }

      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(cleanPass)) {
        send(ws, { type: 'auth_failure', payload: { reason: 'Password contains invalid characters' }, timestamp: Date.now() });
        return;
      }

      if (!/[a-zA-Z]/.test(cleanPass) || !/[0-9]/.test(cleanPass)) {
        send(ws, { type: 'auth_failure', payload: { reason: 'Password must contain letters and numbers' }, timestamp: Date.now() });
        return;
      }

      if (payload.publicKey && !isValidPublicKey(payload.publicKey)) {
        send(ws, { type: 'auth_failure', payload: { reason: 'Invalid public key' }, timestamp: Date.now() });
        return;
      }

      const user = await createUser(cleanNick, cleanPass, payload.publicKey);
      if (!user) {
        send(ws, { type: 'auth_failure', payload: { reason: 'Nickname already taken' }, timestamp: Date.now() });
        return;
      }

      clearAuthRateLimit(ip);
      await recordRegistration(ip, deviceId);

      registerSession({ userId: user.id, deviceId, nickname: user.nickname, deviceInfo: coarsenDeviceLabel(payload?.deviceInfo), firstSeen: Date.now(), lastActive: Date.now(), revoked: false });
      releaseConnectionKey(connectionKey);
      connectionKey = 'user:' + user.id;
      claimConnection(connectionKey, MAX_CONNECTIONS_PER_USER);
      currentUserId = user.id;
      currentDeviceId = deviceId;
      registerDevice(deviceId, { deviceId, ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip, deviceInfo: coarsenDeviceLabel(payload?.deviceInfo) });

      // Same ordering as sign-in: the account's identity key has to be recorded before the reply that
      // reports it back, or a brand new account reads as having none.
      await storePreKeys(user.id, deviceId, payload);
      await onAuthenticated(user.id, user.nickname, ws, deviceId);
    } finally {
      // Released on every exit, including the refusals above: a lock left held by an early return would
      // make the next registration for that address wait for a turn that never comes.
      releaseSubjects();
    }
  }

  async function onAuthenticated(userId: string, nickname: string, ws: WebSocket, deviceId?: string): Promise<void> {
    // Only this account's own key, not the whole directory.
    //
    // Signing in used to hand every client the RSA public key of every account on the server. Nothing
    // needed it: a peer's key arrives with the conversation it belongs to (`dm_contacts`,
    // `dm_history`) or in a `public_key_updated` when it changes. Beyond being a directory of every
    // account handed to every account on every sign-in, it was one more thing standing between a private
    // message and being wrapped to a stranger.
    const me = await getUserById(userId);
    const publicKeys: Record<string, any> = {};
    if (me?.publicKey) publicKeys[userId] = me.publicKey;
    const userMeta = await buildAvatarInfoMap();
    // This account's own prekey material, one entry per device it has signed in. A client needs its own
    // devices listed for a reason the recipient cannot supply: to seal a copy of each outgoing message
    // to the account's other devices, which is what makes a conversation readable on a second screen.
    // Without that fan-out there is no way to sync, and the alternative is the long-lived envelope this
    // replaced.
    const preKeyBundles = await getPreKeyBundlesByIds([userId]);
    // The account-level identity key, which is what a safety number is derived from, so it is handed
    // over on sign-in rather than costing a round trip later.
    const identityKeys: Record<string, string> = {};
    const myIdentityKey = await getIdentityKeyB64(userId);
    if (myIdentityKey) identityKeys[userId] = myIdentityKey;

    const seen = new Set<string>();
    const onlineUsers: { id: string; nickname: string; avatar: AvatarInfo | null }[] = [];
    for (const c of clients.values()) {
      if (!seen.has(c.userId)) { seen.add(c.userId); onlineUsers.push({ id: c.userId, nickname: c.nickname, avatar: avatarInfo(userMeta.get(c.userId)) }); }
    }

    send(ws, { type: 'auth_success', payload: { userId, nickname, deviceId, uploadToken: issueUploadToken(userId), publicKeys, identityKeys, preKeyBundles, onlineUsers, role: await isAdminNickname(nickname) ? 'admin' : 'user', channelMediaKey: await getChannelMediaKey() }, timestamp: Date.now() });

    const history = await getRecentMessages(100);
    const reactionsById = await getReactionsForMessages(history.map((m) => m.id));
    const messages = history.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderNickname: m.senderNickname,
      senderAvatar: avatarInfo(userMeta.get(m.senderId)),
      text: m.text,
      encrypted: m.encrypted || null,
      timestamp: m.timestamp,
      isOwn: m.senderId === userId,
      fileKey: m.fileKey || null,
      expiresAt: m.expiresAt || null,
      quotedMessageId: m.quotedMessageId ?? null,
      quotedMessageText: m.quotedMessageText ?? null,
      quotedMessageSender: m.quotedMessageSender ?? null,
      reactions: reactionsById.get(m.id) || [],
    }));
    send(ws, {
      type: 'chat_history',
      payload: {
        channel: 'general',
        messages,
        hasMore: history.length === 100,
      },
      timestamp: Date.now(),
    });

    broadcast({ type: 'user_joined', payload: { userId, nickname, avatar: avatarInfo(userMeta.get(userId)) }, timestamp: Date.now() }, userId);
  }

  /** Older pages of the general chat, so the client is not limited to the newest hundred messages. */
  async function handleChatHistory(userId: string, ws: WebSocket, payload: { before?: number; limit?: number }): Promise<void> {
    const before = Number.isFinite(payload?.before) ? Number(payload?.before) : undefined;
    const limit = Math.min(Math.max(Number(payload?.limit) || 50, 1), 100);
    // An empty or nonsensical slice is still answered, and answered as a page. Returning nothing left the
    // client waiting on a request that was never going to be answered, and left "load earlier" on screen
    // for good because the paging window was never told there was nothing older.
    if (before !== undefined && before <= 0) {
      send(ws, { type: 'chat_history_page', payload: { channel: 'general', messages: [], hasMore: false }, timestamp: Date.now() });
      return;
    }
    const history = await getRecentMessages(limit, 'general', before);
    if (history.length === 0) {
      send(ws, { type: 'chat_history_page', payload: { channel: 'general', messages: [], hasMore: false }, timestamp: Date.now() });
      return;
    }
    const userMeta = await buildAvatarInfoMap();
    const reactionsById = await getReactionsForMessages(history.map((m) => m.id));
    const messages = history.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderNickname: m.senderNickname,
      senderAvatar: avatarInfo(userMeta.get(m.senderId)),
      text: m.text,
      timestamp: m.timestamp,
      isOwn: m.senderId === userId,
      fileKey: m.fileKey || null,
      expiresAt: m.expiresAt || null,
      quotedMessageId: m.quotedMessageId ?? null,
      quotedMessageText: m.quotedMessageText ?? null,
      quotedMessageSender: m.quotedMessageSender ?? null,
      reactions: reactionsById.get(m.id) || [],
    }));
    send(ws, { type: 'chat_history_page', payload: { channel: 'general', messages, hasMore: history.length === limit }, timestamp: Date.now() });
  }

  async function handleKeyBackupUpload(userId: string, ws: WebSocket, payload: { blob?: string }): Promise<void> {
    if (typeof payload?.blob !== 'string' || payload.blob.length === 0 || payload.blob.length > 200000) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Invalid backup blob' }, timestamp: Date.now() });
      return;
    }
    await saveKeyBackup(userId, payload.blob);
    send(ws, { type: 'key_backup_saved', payload: { ok: true }, timestamp: Date.now() });
  }

  async function handleKeyBackupFetch(userId: string, ws: WebSocket): Promise<void> {
    const blob = await getKeyBackup(userId);
    send(ws, { type: 'key_backup', payload: { blob: blob || null }, timestamp: Date.now() });
  }

  async function handleChatMessage(senderId: string, ws: WebSocket, payload: { text: string; fileKey?: Record<string, string>; ttl?: number; quoted?: { id?: string; text?: string; sender?: string } }): Promise<void> {
    // per account, never per address: a shared network must not throttle unrelated people
    if (!checkMessageRateLimit(senderId)) {
      logSecurity('RATE_LIMIT_MESSAGE', { ip, senderId });
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Max 2 messages per second.' }, timestamp: Date.now() });
      return;
    }

    const senderDevices = devicesForUser(senderId);
    const sender = senderDevices[0] || null;
    if (!sender) return;

    const text = typeof payload?.text === 'string' ? sanitizeText(payload.text) : '';
    if (!text) return;
    if (text.length > MAX_MESSAGE_CHARS) {
      send(ws, { type: 'error', payload: { code: 'MESSAGE_TOO_LONG', message: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` }, timestamp: Date.now() });
      return;
    }

    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    const fileKey = isValidFileKeyMap(payload?.fileKey) ? payload.fileKey : undefined;
    const expiresAt = resolveExpiry(payload?.ttl, timestamp);
    const quoted = await resolveQuote(senderId, payload?.quoted, 'general');
    await saveMessage(messageId, senderId, sender.nickname, text, timestamp, undefined, 'general', fileKey, quoted ? quoted.id : undefined, undefined, expiresAt, (quoted ? quoted.text : undefined) ?? undefined, (quoted ? quoted.sender : undefined) ?? undefined);

    const messagePayload = {
      id: messageId,
      senderId,
      senderNickname: sender.nickname,
      senderAvatar: avatarInfo(await getProfileMeta(senderId)),
      text,
      timestamp,
      isOwn: false,
      fileKey,
      expiresAt,
      quotedMessageId: quoted?.id,
      quotedMessageText: quoted?.text ?? undefined,
      quotedMessageSender: quoted?.sender ?? undefined,
      reactions: await getReactionsForMessage(messageId),
    };

    broadcast({ type: 'chat_message', payload: { ...messagePayload, channel: 'general' }, timestamp }, senderId);
    send(ws, { type: 'chat_message', payload: { ...messagePayload, isOwn: true, channel: 'general' }, timestamp });
    for (const dev of senderDevices) {
      if (dev.ws === ws || dev.ws.readyState !== WebSocket.OPEN) continue;
      send(dev.ws, { type: 'chat_message', payload: { ...messagePayload, isOwn: true, channel: 'general' }, timestamp });
    }
  }

    async function handleDmSend(senderId: string, ws: WebSocket, payload: { to?: string; toKey?: any; text: string; encrypted?: any; signalEncrypted?: any; x3dhMessage?: any; ratchetPublicKey?: number[]; fileKey?: Record<string, string>; sealed?: string; ttl?: number; clientId?: string; quoted?: { id?: string; text?: string; sender?: string } }): Promise<void> {
    if (!checkMessageRateLimit(senderId)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down.' }, timestamp: Date.now() });
      return;
    }

    const senderDevices = devicesForUser(senderId);
    const sender = senderDevices[0] || null;
    if (!sender) return;
    if (!payload?.toKey && (!payload?.to || typeof payload.to !== 'string')) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Missing recipient' }, timestamp: Date.now() });
      return;
    }

    let recipientUser: any = null;
    if (payload?.to && typeof payload.to === 'string') {
      // Named directly, which is one row to read rather than the whole key table. The full row is
      // needed, not the summary one: the key has to be here to be checked against the key that came
      // with the message.
      recipientUser = await getUserByNickname(payload.to) || (await getUserById(payload.to));
      if (recipientUser && payload?.toKey && typeof payload.toKey === 'object' && payload.toKey.kty) {
        if (canonicalJwk(payload.toKey) !== canonicalJwk(recipientUser.publicKey)) {
          send(ws, { type: 'error', payload: { code: 'STALE_KEY', message: 'Recipient key changed, reopen the chat and send again' }, timestamp: Date.now() });
          logSecurity('DM_STALE_KEY', { from: senderId, to: recipientUser.id });
          return;
        }
      }
    }
    if (!recipientUser && payload?.toKey && typeof payload.toKey === 'object' && payload.toKey.kty) {
      // Only for a client that names the recipient by key alone. Bounded, because it walks the table.
      const keysMap = await getAllPublicKeys();
      const keyStr = canonicalJwk(payload.toKey);
      for (const [uid, jwk] of Object.entries(keysMap)) {
        if (uid !== senderId && jwk && canonicalJwk(jwk) === keyStr) { recipientUser = { id: uid, nickname: '', publicKey: jwk }; break; }
      }
    }
    if (recipientUser && recipientUser.id === senderId) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Cannot message yourself' }, timestamp: Date.now() });
      return;
    }
    if (!recipientUser) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Recipient not found' }, timestamp: Date.now() });
      return;
    }

    const recvBlocked = await getBlockedUserIds(recipientUser.id);
    const senderBlocked = await getBlockedUserIds(senderId);
    if (recvBlocked.includes(senderId)) {
      send(ws, { type: 'error', payload: { code: 'BLOCKED', message: 'You cannot message this user' }, timestamp: Date.now() });
      return;
    }
    if (senderBlocked.includes(recipientUser.id)) {
      send(ws, { type: 'error', payload: { code: 'BLOCKED', message: 'Unblock this user to message them' }, timestamp: Date.now() });
      return;
    }

    const recipientDevices = devicesForUser(recipientUser.id);

    const channelId = getDmChannelId(senderId, recipientUser.id);
    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    const fileKey = isValidFileKeyMap(payload?.fileKey) ? payload.fileKey : undefined;
    const isEncrypted = isValidDmEncryptedPayload(payload?.encrypted);
    const expiresAt = resolveExpiry(payload?.ttl, timestamp);
    const quoted = await resolveQuote(senderId, payload?.quoted, channelId);

    // the sender cannot decrypt its own ratchet ciphertext, so the client tags the message with an
    // id of its own and recognises the echo and the history entry by it
    const clientId = typeof payload?.clientId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(payload.clientId) ? payload.clientId : undefined;

    if (!isEncrypted) {
      send(ws, { type: 'error', payload: { code: 'ENCRYPTION_REQUIRED', message: 'Direct messages must be encrypted' }, timestamp: Date.now() });
      logSecurity('PLAINTEXT_DM_REJECTED', { from: senderId, to: recipientUser.id, bytes: safeJsonLength(payload?.encrypted) });
      return;
    }
    await saveMessage(messageId, senderId, sender.nickname, '', timestamp, payload.encrypted, channelId, fileKey, quoted ? quoted.id : undefined, undefined, expiresAt, (quoted ? quoted.text : undefined) ?? undefined, (quoted ? quoted.sender : undefined) ?? undefined, clientId);

    const dmPayload = {
      id: messageId,
      senderId,
      senderNickname: sender.nickname,
      senderAvatar: avatarInfo(await getProfileMeta(senderId)),
      text: '',
      encrypted: isEncrypted ? payload.encrypted : null,
      timestamp,
      channel: channelId,
      fileKey,
      expiresAt,
      quotedMessageId: quoted?.id,
      quotedMessageText: quoted?.text ?? undefined,
      quotedMessageSender: quoted?.sender ?? undefined,
      clientId,
      reactions: await getReactionsForMessage(messageId),
    };
    if (isValidDeviceBodies(payload.encrypted)) {
      // Routed by the device each body was sealed for, rather than broadcast.
      //
      // Two reasons, and the first is the important one: a device that receives a body meant for another
      // device learns that the message exists twice over and has to try to open something it cannot,
      // and every one of those failures is a place where the app's only honest answer is "encrypted".
      // The second is that the same routing delivers a sender's copy to the sender's own other devices,
      // which is how a conversation reaches a second screen without any shared key material.
      //
      // Every device is told the message arrived, with the bodies it alone can open. A device left out of
      // the loop entirely would show a conversation that silently stops rather than one that says it
      // cannot read this, which is the difference between a key problem and a delivery problem.
      const byDevice = new Map(payload.encrypted.bodies.map((e) => [e.deviceId, e.body]));
      for (const dev of recipientDevices) {
        send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, encrypted: byDevice.get(dev.deviceId) ?? null, isOwn: false }, timestamp });
      }
      for (const dev of senderDevices) {
        if (dev.ws.readyState !== WebSocket.OPEN) continue;
        send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, encrypted: byDevice.get(dev.deviceId) ?? null, isOwn: true }, timestamp });
      }
      } else {
      for (const dev of recipientDevices) {
        send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: false }, timestamp });
      }
      send(ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: true }, timestamp });
      for (const dev of senderDevices) {
        if (dev.ws === ws || dev.ws.readyState !== WebSocket.OPEN) continue;
        send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: true }, timestamp });
      }
    }
  }

function resolveExpiry(ttl: unknown, timestamp: number): number | undefined {
  // Only the three durations the interface offers, looked up through the prototype chain rather than
  // indexed directly: a plain object literal answers to `constructor` and `toString`, so `ttl` of
  // "toString" would otherwise be a duration of NaN milliseconds in the past.
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return undefined;
  const allowed = DM_TTL_ALLOWED_MS[ttl as unknown as number];
  return typeof allowed === 'number' && allowed > 0 ? timestamp + allowed : undefined;
}

/**
 * The quote a message carries, resolved from what is actually stored.
 *
 * The client used to send the quoted words and the quoted sender's name alongside the id, and the server
 * took them at face value. Anybody could therefore post a message showing a quote bubble reading
 * "@admin: give me the money" attributed to a conversation that never happened - the words came from the
 * sender, not from the row they claim to be quoting. Only the id is trusted now; the words and the name
 * are read back off the message being quoted, and a quote of something the sender cannot see is dropped
 * rather than invented.
 *
 * A quote of a private message carries the name and the id but no words, because a private message is
 * stored as ciphertext and there is nothing here to read. The client resolves those from the
 * conversation it already has; that is the right place for it, since only the two ends can read it.
 */
async function resolveQuote(
  userId: string,
  quoted: any,
  fallbackChannel: string
): Promise<{ id: string; text: string | null; sender: string | null } | null> {
  if (!quoted || typeof quoted !== 'object') return null;
  const id = typeof quoted.id === 'string' ? quoted.id : '';
  if (!id || id.length > 64) return null;
  const target = await getMessageById(id);
  if (!target || !canAccessMessage(userId, target)) return null;
  // The quote has to belong to the conversation it is being posted into, not merely to one the sender can
  // see. The check used to be written for the public channel only, so a quote id taken from any other
  // conversation - including a private one - was accepted when posting to a DM, and the quoted id and the
  // quoted sender's nickname were carried across into a conversation they were never in. No words leak
  // (a DM row stores `text = ''`), but the id and the name did. The two call sites pass either 'general'
  // or the DM's own channel, so one equality test covers both.
  if (target.channel !== fallbackChannel) return null;
  const text = sanitizeText(target.text || '').slice(0, MAX_MESSAGE_CHARS);
  const sender = sanitizeText(String(target.senderNickname || '')).slice(0, 64);
  // an empty string would be stored as null anyway, and telling the client there are no words is not the
  // same as telling it there are empty words
  return { id, text: text || null, sender: sender || null };
}

function isValidEmoji(emoji: unknown): emoji is string {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 16
    && /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F]/u.test(emoji);
}

function canonicalJwk(jwk: any): string {
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(jwk || {}).sort()) sorted[k] = jwk[k];
  return JSON.stringify(sorted);
}

async function handleAddReaction(userId: string, ws: WebSocket, payload: { messageId: string; emoji: string }): Promise<void> {
    if (!payload?.messageId || typeof payload.messageId !== 'string') return;
    if (!isValidEmoji(payload.emoji)) return;

    const target = await getMessageById(payload.messageId);
    if (!target || !canAccessMessage(userId, target)) return;
    await addReaction(payload.messageId, userId, payload.emoji);
    const reactions = await getReactionsForMessage(payload.messageId);
    broadcastToMessageAudience(payload.messageId, userId, {
      type: 'reaction_update',
      payload: { messageId: payload.messageId, emoji: payload.emoji, userId, action: 'add', reactions },
      timestamp: Date.now(),
    });
  }

  async function handleRemoveReaction(userId: string, ws: WebSocket, payload: { messageId: string; emoji: string }): Promise<void> {
    if (!payload?.messageId || typeof payload.messageId !== 'string') return;
    if (!isValidEmoji(payload.emoji)) return;
    const target = await getMessageById(payload.messageId);
    if (!target || !canAccessMessage(userId, target)) return;
    await removeReaction(payload.messageId, userId, payload.emoji);
    const reactions = await getReactionsForMessage(payload.messageId);
    broadcastToMessageAudience(payload.messageId, userId, {
      type: 'reaction_update',
      payload: { messageId: payload.messageId, emoji: payload.emoji, userId, action: 'remove', reactions },
      timestamp: Date.now(),
    });
  }

  function broadcastToMessageAudience(messageId: string, actorUserId: string, message: ServerMessage): void {
    // The rejection handler is not decoration. This promise is deliberately not awaited by the reaction and
    // edit handlers - they have already answered the client - and Node's default for an unhandled rejection
    // is to throw, which takes the process down. Any SQLite error on this one read path - a locked database,
    // a corrupt row - would have ended the server for every user on it.
    void (async () => {
      const target = await getMessageById(messageId);
      if (!target) return;
      deliverToChannel(target.channel, actorUserId, message);
    })().catch((err: unknown) => {
      console.error(`Audience broadcast failed (${messageId}):`, (err as Error)?.message);
    });
  }

  /**
   * Hands a frame to exactly the accounts a channel belongs to.
   *
   * A direct channel is a pair of ids joined by a colon, and only that pair. Splitting it without
   * checking there are exactly two halves would let a malformed channel name fan a private message out
   * to accounts it has nothing to do with, so the shape is checked rather than assumed.
   */
  function deliverToChannel(channel: string | null | undefined, actorUserId: string, message: ServerMessage): void {
    if (!channel || channel === 'general') {
      broadcast(message, actorUserId);
      for (const dev of devicesForUser(actorUserId)) send(dev.ws, message);
      return;
    }
    const parts = channel.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      // a channel that is not a recognisable pair is not relayed to anybody
      return;
    }
    for (const participantId of parts) {
      for (const dev of devicesForUser(participantId)) {
        if (dev.ws.readyState !== WebSocket.OPEN) continue;
        dev.ws.send(JSON.stringify(routeForDevice(message, dev.deviceId)));
      }
    }
  }

  /**
   * Hands a device the one body out of a fan-out that it can open.
   *
   * An edit and a deletion both go out over the same audience as the message they act on, and a corrected
   * private message is now sealed per device like any other. So a device has to be given its own copy
   * rather than the whole set: every body in it but one is bytes this device cannot read, and handing
   * those out on a broadcast is how a phone learns what a laptop was sent.
   *
   * The stored row keeps the whole fan-out, because the next sign-in of any device still has to find its
   * own copy in history.
   */
  function routeForDevice(message: ServerMessage, deviceId: string): ServerMessage {
    const payload = message.payload as any;
    if (!payload || !isValidDeviceBodies(payload.encrypted)) return message;
    return { ...message, payload: { ...payload, encrypted: bodyForDevice(payload.encrypted, deviceId) } };
  }

  async function handleDmHistory(userId: string, ws: WebSocket, payload: { with: string; before?: number; limit?: number }): Promise<void> {
    const before = Number.isFinite(payload?.before) ? Number(payload?.before) : undefined;
    const limit = Math.min(Math.max(Number(payload?.limit) || 50, 1), 100);
    if (!payload?.with || typeof payload.with !== 'string' || payload.with === userId) {
      // answered as an empty conversation rather than ignored, so the client clears the chat it asked
      // about instead of showing whatever was there before
      send(ws, {
        type: before === undefined ? 'dm_history' : 'dm_history_page',
        payload: { channel: getDmChannelId(userId, String(payload?.with || userId)), with: payload?.with, publicKeys: {}, hasMore: false, messages: [] },
        timestamp: Date.now(),
      });
      return;
    }
    const channel = getDmChannelId(userId, payload.with);
    const parts = channel.split(':');
    if (parts.length !== 2 || (parts[0] !== userId && parts[1] !== userId)) return;
    const messages = await getDmHistory(userId, payload.with, limit, before);
    const publicKeys = await getPublicKeysByIds([userId, payload.with]);
    const userMeta = await buildAvatarInfoMap();
    const page = {
      channel,
      with: payload.with,
      publicKeys,
      // a short page means the beginning has been reached, which is the only way the client learns to
      // stop offering "load earlier" on a conversation that will never have more
      hasMore: messages.length === limit,
      // history is filtered for the asking device, for the same reason the live frame is: a stored
      // fan-out carries one body per device of both accounts, and handing a phone the copies sealed for a
      // laptop tells it things about the account it has no way to learn and gives it bytes it can only
      // fail to open
      messages: await handleDmHistoryMessages(userId, messages, userMeta, currentDeviceId),
    };
    // An older slice has to be announced as a page. Answering it with the plain type made the client
    // replace the whole conversation with this slice, and an empty page blanked the chat entirely.
    send(ws, { type: before === undefined ? 'dm_history' : 'dm_history_page', payload: page, timestamp: Date.now() });
  }

  async function handleDmHistoryMessages(
    userId: string,
    messages: any[],
    userMeta: Map<string, { avatarExt: string | null; avatarUpdatedAt: number | null }>,
    deviceId?: string | null,
  ): Promise<any[]> {
    const reactionsById = await getReactionsForMessages(messages.map((m) => m.id));
    return messages.map(m => ({
      id: m.id,
      senderId: m.senderId,
      senderNickname: m.senderNickname,
      senderAvatar: avatarInfo(userMeta.get(m.senderId)),
   text: m.text || '',
   encrypted: bodyForDevice(m.encrypted, deviceId),
      timestamp: m.timestamp,
      isOwn: m.senderId === userId,
      fileKey: m.fileKey || null,
      expiresAt: m.expiresAt || null,
      quotedMessageId: m.quotedMessageId ?? null,
      quotedMessageText: m.quotedMessageText ?? null,
      quotedMessageSender: m.quotedMessageSender ?? null,
      clientId: m.clientId ?? null,
      reactions: reactionsById.get(m.id) || [],
    }));
  }

  async function handleDmContacts(userId: string, ws: WebSocket): Promise<void> {
    const contacts = await getDmContacts(userId);
    const publicKeys = await getPublicKeysByIds([userId, ...contacts.map(c => c.id)]);
    const onlineIds = new Set(userDevices.keys());
    const userMeta = await buildAvatarInfoMap();
    const contactsWithOnline = contacts.map(c => ({ ...c, online: onlineIds.has(c.id), avatar: avatarInfo(userMeta.get(c.id)) }));
    send(ws, { type: 'dm_contacts', payload: { contacts: contactsWithOnline, publicKeys }, timestamp: Date.now() });
  }

  async function handleSearchUsers(userId: string, ws: WebSocket, payload: { query: string }): Promise<void> {
    if (!searchAllowed(userId)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Try again shortly.' }, timestamp: Date.now() });
      return;
    }
    const query = sanitize(payload?.query || '').toLowerCase().slice(0, MAX_SEARCH_QUERY_CHARS);
    if (query.length < 1) {
      send(ws, { type: 'search_results', payload: { results: [] }, timestamp: Date.now() });
      return;
    }
    const allUsers = await getAllUsers();
    const userMeta = new Map(allUsers.map(u => [u.id, u]));
    const users = allUsers.filter((u: { id: string; nickname: string }) => u.id !== userId);
    const onlineIds = new Set(userDevices.keys());
    const results = users
      .filter((u: { id: string; nickname: string }) => u.nickname.toLowerCase().includes(query))
      .slice(0, 20)
      .map((u: { id: string; nickname: string }) => ({ id: u.id, nickname: u.nickname, online: onlineIds.has(u.id), avatar: avatarInfo(userMeta.get(u.id)) }));
    send(ws, { type: 'search_results', payload: { results }, timestamp: Date.now() });
  }

  async function handleSearchMessages(userId: string, ws: WebSocket, payload: { query: string; channel?: string }): Promise<void> {
    if (!searchAllowed(userId)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Try again shortly.' }, timestamp: Date.now() });
      return;
    }
    // Bounded before it reaches the database, and stripped of the characters that would send the query down
    // the `instr()` fallback. See `stripFtsOperators` for why the fallback was the expensive path.
    const query = sanitize(payload?.query || '')
      .slice(0, MAX_SEARCH_QUERY_CHARS)
      .split(/\s+/)
      .map(stripFtsOperators)
      .filter(Boolean)
      .join(' ');
    if (query.length < 2) {
      send(ws, { type: 'message_search_results', payload: { results: [] }, timestamp: Date.now() });
      return;
    }
    const results = await searchMessages(query, payload.channel, 50, userId);
    const reactionsById = await getReactionsForMessages(results.map((m: any) => m.id));
    const resultsWithReactions = results.map((m: any) => ({ ...m, reactions: reactionsById.get(m.id) || [] }));
    send(ws, { type: 'message_search_results', payload: { results: resultsWithReactions }, timestamp: Date.now() });
  }

  async function handleDeleteMessage(userId: string, ws: WebSocket, payload: { messageId: string }): Promise<void> {
    if (!payload?.messageId || typeof payload.messageId !== 'string') {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'messageId required' }, timestamp: Date.now() });
      return;
    }
    // Only somebody who can see the message may hear that it went. Announcing a deletion to the whole
    // server handed every connected user the id and the fact of a private message nobody had any
    // business knowing existed.
    const target = await getMessageById(payload.messageId);
    if (!target || !canAccessMessage(userId, target)) {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
      return;
    }
    const deleted = await deleteMessage(payload.messageId, userId);
    if (deleted) {
      const notice = { type: 'message_deleted', payload: { messageId: payload.messageId }, timestamp: Date.now() };
      // the row is gone by now, so the channel it belonged to is the one captured above
      // `deliverToChannel` already reaches the actor's own devices - for the public channel it broadcasts
      // to everyone else and then loops over `devicesForUser(actorUserId)`, and for a private one it walks
      // both participants. The extra `send(ws, notice)` that used to follow handed the actor who pressed
      // the button a second copy of the same frame. Harmless while every handler is idempotent, which is
      // the only reason it survived: the moment one of them is not, the duplicate is a visible bug.
      deliverToChannel(target.channel, userId, notice);
    } else {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
    }
  }

  async function handleEditMessage(userId: string, ws: WebSocket, payload: { messageId: string; text?: string; encrypted?: any; ttl?: number }): Promise<void> {
    if (!payload?.messageId || typeof payload.messageId !== 'string') {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'messageId required' }, timestamp: Date.now() });
      return;
    }

    const target = await getMessageById(payload.messageId);
    if (!target || target.senderId !== userId) {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
      return;
    }

    // A private message is stored as ciphertext, so a correction arrives as a new encrypted body rather
    // than as words. The server checks that the account wrote the message and swaps the body; it never
    // sees either version of the text.
    if (target.encrypted) {
      // Either shape, because a correction is now sealed per device like any other message - and a
      // server that rejected the fan-out would push clients back to the long-lived envelope, which is
      // the thing that had to go
      if (!isValidDmEncryptedPayload(payload.encrypted)) {
        send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'An encrypted message must be edited as ciphertext' }, timestamp: Date.now() });
        return;
      }
      const expiresAt = resolveExpiry(payload.ttl, Date.now());
      const updated = await updateEncryptedMessage(payload.messageId, userId, payload.encrypted, expiresAt);
      if (!updated) {
        send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
        return;
      }
      const timestamp = Date.now();
      const edit = { messageId: payload.messageId, encrypted: payload.encrypted, editedAt: timestamp, expiresAt };
      broadcastToMessageAudience(payload.messageId, userId, { type: 'message_edited', payload: edit, timestamp });
      // no echo to the requesting socket: `broadcastToMessageAudience` reaches the actor's devices by way
      // of `deliverToChannel`, so a `send(ws, edit)` here was the same frame twice.
      return;
    }

    if (!payload.text || typeof payload.text !== 'string') {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'text required' }, timestamp: Date.now() });
      return;
    }
    const text = sanitizeText(payload.text);
    if (!text || text.length > MAX_MESSAGE_CHARS) {
      send(ws, { type: 'error', payload: { code: 'MESSAGE_TOO_LONG', message: `Message too long (max ${MAX_MESSAGE_CHARS} chars)` }, timestamp: Date.now() });
      return;
    }
    if (target.channel !== 'general') {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
      return;
    }
    const updated = await updateMessageText(payload.messageId, userId, text);
    if (updated) {
      const timestamp = Date.now();
      const edit = { messageId: payload.messageId, text, editedAt: timestamp };
      // `broadcast` skips *every* socket belonging to `userId`, which is right for the audience but
      // leaves the author out - and the author is the one who asked. The client does not apply the edit
      // optimistically, so without the echo below the person who just fixed their own typo kept seeing
      // the old text until they reloaded. The encrypted branch gets this right by sending to the
      // requesting socket after broadcasting; this one did not, and the asymmetry is what hid it.
      broadcast({ type: 'message_edited', payload: edit, timestamp }, userId);
      for (const dev of devicesForUser(userId)) send(dev.ws, { type: 'message_edited', payload: edit, timestamp });
    } else {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
    }
  }

  async function handleAuthUpdateKey(userId: string, ws: WebSocket, payload: { publicKey: any; preKeyBundle?: any; deviceId?: string; identityKey?: string }): Promise<void> {
    if (payload?.publicKey && isValidPublicKey(payload.publicKey)) {
      await updatePublicKey(userId, payload.publicKey);
      send(ws, { type: 'key_updated', payload: {}, timestamp: Date.now() });
      broadcast({ type: 'public_key_updated', payload: { userId, publicKey: payload.publicKey }, timestamp: Date.now() }, userId);
    }
    // A client whose identity changed is not just republishing an RSA key: it has new ratchet material
    // and possibly a new account key, and a peer holding the old ones has to hear about it rather than
    // keep sending into a session that can never open again.
    await storePreKeys(userId, currentDeviceId, payload);
    if (isValidPreKeyBundle(payload?.preKeyBundle)) {
      broadcast({ type: 'prekeys_changed', payload: { userId }, timestamp: Date.now() }, userId);
    }
  }

  /**
   * The bundle a stranger needs to open a ratchet with this account.
   *
   * It is public material, so the only thing worth checking is its shape: a bundle that arrives as the
   * wrong type used to be bound straight into the column, which threw inside the driver and lost the
   * message.
   */
  async function handlePreKeyUpload(userId: string, ws: WebSocket, payload: { bundle: any; deviceId?: string }): Promise<void> {
    if (payload?.bundle && isValidPreKeyBundle(payload.bundle)) {
      // Against the uploading device, not the account: two devices of one account hold different ratchet
      // keys, and a row keyed on the account alone would mean the second upload silently replaced the
      // first and every message would stop reaching it.
      // Bounded like every other place that takes a client-supplied device id (the auth paths check
      // `<= 64`). This one had no upper bound and the value goes straight into the `prekeys` primary
      // key, so one authenticated socket could insert a fresh row per frame - each with a
      // megabyte-scale id in it - and nothing reaps those for thirty days. The bundle's own size cap
      // does not help: it caps the bundle, not the column beside it.
      const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
        ? payload.deviceId : currentDeviceId;
      // through the same path as every other publish, so the bookkeeping that forgets spent one-time
      // prekeys cannot be applied in one place and forgotten in another
      await storePreKeys(userId, deviceId, { preKeyBundle: payload.bundle });
      send(ws, { type: 'prekey_uploaded', payload: {}, timestamp: Date.now() });
    } else {
      logSecurity('PREKEY_REJECTED', { userId, ...preKeyBundleDiagnostics(payload?.bundle) });
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Invalid prekey bundle' }, timestamp: Date.now() });
    }
  }

  /**
   * Fetches the bundles a conversation needs, capped so one frame cannot ask for the whole table.
   *
   * Also metered, because a bundle is public material for anybody who asks: unbounded, this is a way to
   * walk the whole user table - who has a published key at all, and since when - one hundred ids at a
   * time, from an account that registered for nothing else. A few hundred fetches an hour is far more
   * than a client needs to keep its conversations current.
   */
  async function handlePreKeyFetch(userId: string, ws: WebSocket, payload: { userIds?: string[] }): Promise<void> {
    if (!preKeyFetchAllowed(userId)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Try again shortly.' }, timestamp: Date.now() });
      return;
    }
    if (!payload?.userIds || !Array.isArray(payload.userIds) || payload.userIds.length === 0) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'userIds array required' }, timestamp: Date.now() });
      return;
    }
    const ids = payload.userIds.filter(id => typeof id === 'string').slice(0, 100);
    const bundles = await takePreKeyBundlesForSender(ids, userId);
    // Account identity keys ride along with the fetch, because a safety number needs the peer's and
    // asking for it separately would be one more round trip for something that changes once in years.
    const identityKeys = await getIdentityKeysByIds(ids);
    send(ws, { type: 'prekey_bundles', payload: { bundles, identityKeys }, timestamp: Date.now() });
  }

  async function handleProfileGet(userId: string, ws: WebSocket, payload: { userId?: string }): Promise<void> {
    const targetId = typeof payload?.userId === 'string' ? payload.userId : '';
    if (!targetId) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'userId required' }, timestamp: Date.now() });
      return;
    }
    const u = await getUserProfile(targetId);
    if (!u) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    const isMe = targetId === userId;
    const isBlockedByMe = !isMe && (await getBlockedUserIds(userId)).includes(targetId);
    const isBanned = await getUserBanned(targetId);
    send(ws, {
      type: 'profile',
      payload: {
        profile: {
          id: u.id,
          nickname: u.nickname,
          avatar: u.avatarExt ? { ext: u.avatarExt, updatedAt: u.avatarUpdatedAt } : null,
          createdAt: u.createdAt,
          online: isUserOnline(targetId),
          isMe,
          isBlockedByMe,
          isBanned,
          // The long-lived public half of this account's ratchet identity. A safety number is computed
          // from it on both sides, so reading the same number aloud is what rules out a server that
          // handed each of them a different key.
          identityKey: await getIdentityKeyB64(targetId),
        },
      },
      timestamp: Date.now(),
    });
  }

  async function handleAvatarSet(userId: string, ws: WebSocket, payload: { dataUrl?: string }): Promise<void> {
    const decoded = decodeAvatarDataUrl(payload?.dataUrl);
    if (!decoded) {
      send(ws, { type: 'error', payload: { code: 'INVALID_AVATAR', message: 'Invalid avatar image' }, timestamp: Date.now() });
      return;
    }
    if (!avatarRateOk(userId)) {
      send(ws, { type: 'error', payload: { code: 'AVATAR_RATE_LIMITED', message: 'You can change your avatar once a minute' }, timestamp: Date.now() });
      return;
    }
    const previous = await getUserProfile(userId);
    const updatedAt = await setUserAvatar(userId, decoded.ext);
    if (!updatedAt) {
      send(ws, { type: 'error', payload: { code: 'INTERNAL', message: 'Could not save avatar' }, timestamp: Date.now() });
      return;
    }
    try {
      await fs.promises.mkdir(getAvatarDir(), { recursive: true });
      await fs.promises.writeFile(path.join(getAvatarDir(), userId), decoded.buffer);
    } catch {
      if (previous?.avatarExt) await setUserAvatar(userId, previous.avatarExt);
      else await removeUserAvatar(userId);
      send(ws, { type: 'error', payload: { code: 'INTERNAL', message: 'Could not save avatar' }, timestamp: Date.now() });
      return;
    }
    const avatar = { ext: decoded.ext, updatedAt };
    broadcast({ type: 'user_avatar', payload: { userId, avatar }, timestamp: Date.now() }, userId);
    send(ws, { type: 'user_avatar', payload: { userId, avatar }, timestamp: Date.now() });
  }

  async function handleAvatarRemove(userId: string, ws: WebSocket): Promise<void> {
    if (!avatarRateOk(userId)) {
      send(ws, { type: 'error', payload: { code: 'AVATAR_RATE_LIMITED', message: 'You can change your avatar once a minute' }, timestamp: Date.now() });
      return;
    }
    await removeUserAvatar(userId);
    try { await fs.promises.rm(path.join(getAvatarDir(), userId), { force: true }); } catch {}
    broadcast({ type: 'user_avatar', payload: { userId, avatar: null }, timestamp: Date.now() }, userId);
    send(ws, { type: 'user_avatar', payload: { userId, avatar: null }, timestamp: Date.now() });
  }

  function handleDisconnect(deviceId: string | null, userId: string | null, ws?: WebSocket): void {
    if (!deviceId || !userId) return;

    const client = clients.get(clientKey(userId, deviceId));
    unregisterDevice(userId, deviceId, ws);

    // A socket that has already been replaced by a newer one for the same device is not a departure:
    // the reload it belongs to is already connected, and announcing user_left here would make every
    // other client show that person as offline.
    if (ws && client && client.ws !== ws) return;

    if (client) {
      sessionLastActive(client.userId, deviceId, Date.now());
      void touchSession(client.userId, deviceId).catch(() => {});
      broadcast({ type: 'user_left', payload: { userId: client.userId, nickname: client.nickname }, timestamp: Date.now() });
    }
  }
}

  /**
   * Relays "still typing" to whoever is in the conversation.
   *
   * Nothing is stored. The signal is only interesting while it is fresh, so keeping it would mean
   * holding a record of who was in which conversation and when, for no reason - the frame goes to the
   * other end and expires on a timer there.
   */
  async function handleTyping(userId: string, ws: WebSocket, payload: { channel?: string }): Promise<void> {
    const channel = typeof payload?.channel === 'string' ? payload.channel : 'general';
    if (channel === 'general') {
      broadcast({ type: 'typing', payload: { channel: 'general', userId }, timestamp: Date.now() }, userId);
      return;
    }
    // only a direct channel this account is actually one end of may be named
    const parts = channel.split(':');
    if (parts.length !== 2 || (parts[0] !== userId && parts[1] !== userId)) return;
    const otherId = parts[0] === userId ? parts[1] : parts[0];
    const frame = { type: 'typing', payload: { channel, userId, peerId: otherId }, timestamp: Date.now() };
    for (const dev of devicesForUser(otherId)) send(dev.ws, frame);
  }

  /**
   * Relays "I have read up to here" to the other end of a conversation.
   *
   * Deliberately not written down anywhere. A read receipt is a fact about one device, and the person
   * reading it only cares whether the conversation they are looking at has been seen; persisting it
   * would turn a convenience into a durable record of how far each conversation had been read, which is
   * exactly the sort of thing this server tries not to hold. Each of the reader's other devices says so
   * for itself.
   */
  async function handleDmRead(userId: string, ws: WebSocket, payload: { channel?: string; upTo?: number }): Promise<void> {
    const channel = typeof payload?.channel === 'string' ? payload.channel : '';
    const upTo = Number(payload?.upTo);
    if (!channel || !Number.isFinite(upTo) || upTo <= 0) return;
    const parts = channel.split(':');
    if (parts.length !== 2 || (parts[0] !== userId && parts[1] !== userId)) return;
    const otherId = parts[0] === userId ? parts[1] : parts[0];
    const frame = { type: 'dm_read', payload: { channel, userId, peerId: otherId, upTo }, timestamp: Date.now() };
    for (const dev of devicesForUser(otherId)) send(dev.ws, frame);
  }

  async function handleGetSessions(userId: string, ws: WebSocket, currentDeviceId: string | null): Promise<void> {
    await ensureSessionRegistry();
    const reg = sessionRecords.get(userId);
    const sessions: { id: string; nickname: string; name: string; lastActive: number; current: boolean; online: boolean }[] = [];
    if (reg) {
      const sorted = [...reg.values()].filter(s => !s.revoked).sort((a, b) => b.lastActive - a.lastActive);
      for (const rec of sorted) {
        const live = clients.get(clientKey(userId, rec.deviceId));
        sessions.push({
          id: rec.deviceId,
          nickname: rec.nickname,
          name: live?.deviceInfo || rec.deviceInfo || '',
          lastActive: live?.lastHeartbeat || rec.lastActive,
          current: rec.deviceId === currentDeviceId,
          online: !!live,
        });
      }
    }
    send(ws, { type: 'sessions_list', payload: { sessions }, timestamp: Date.now() });
  }

  async function handleRevokeSession(userId: string, ws: WebSocket, payload: { sessionId?: string }, currentDeviceId: string | null): Promise<void> {
    const targetId = payload?.sessionId || currentDeviceId;
    if (!targetId) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Missing session id' }, timestamp: Date.now() });
      return;
    }
    await ensureSessionRegistry();
    const reg = sessionRecords.get(userId);
    const rec = reg?.get(targetId);
    if (!rec) {
      send(ws, { type: 'error', payload: { code: 'SESSION_NOT_FOUND', message: 'Session not found' }, timestamp: Date.now() });
      return;
    }

    rec.revoked = true;
    // Awaited, not fire-and-forget. This is the one write that has to survive a restart: a revocation that
    // only reached memory was silently undone by the next deploy, because the row still said `revoked = 0`
    // and the device signed straight back in. `void ... .catch(() => {})` made the acknowledgement of a
    // revocation a promise about a write that might never happen.
    await markSessionRevoked(userId, targetId);

    // Scoped to this account. The registry used to be keyed by device id alone, so a revocation could turn
    // up a socket belonging to somebody else who happened to share that id - the `userId` guard below then
    // had to exist purely to refuse to close it. Now the lookup cannot return one.
    const live = clients.get(clientKey(userId, targetId));
    if (live) {
      // Announced here rather than left to the socket's own close handler. That handler looks the device up
      // in the registry, and by the time `close` has been processed the entry is already gone - so it found
      // nothing, skipped the broadcast, and every other client carried on showing that person as online for
      // the rest of the server's life. The same applies to a ban below.
      broadcast({ type: 'user_left', payload: { userId, nickname: live.nickname }, timestamp: Date.now() });
      try { live.ws.close(4001, 'Session revoked'); } catch {}
      unregisterDevice(userId, targetId);
    }
    send(ws, { type: 'session_revoked', payload: { sessionId: targetId }, timestamp: Date.now() });

    if (targetId !== currentDeviceId) await handleGetSessions(userId, ws, currentDeviceId);
  }

  async function sendBlockedList(userId: string, ws: WebSocket): Promise<void> {
    const blockedIds = await getBlockedUserIds(userId);
    const users = await getAllUsers();
    send(ws, {
      type: 'blocked_list',
      payload: { blockedIds, users: blockedIds.map(id => ({ id, nickname: (users.find(u => u.id === id)?.nickname) || 'unknown' })) },
      timestamp: Date.now(),
    });
  }

  async function handleBlockUser(userId: string, ws: WebSocket, payload: { userId?: string; nickname?: string }): Promise<void> {
    if (!payload || (typeof payload.userId !== 'string' && typeof payload.nickname !== 'string')) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Missing user id or nickname' }, timestamp: Date.now() });
      return;
    }
    const targetId = typeof payload.userId === 'string'
      ? payload.userId
      : (await getUserByNickname(sanitize(payload.nickname || '')))?.id || '';
    if (!targetId) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    if (targetId === userId) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Cannot block yourself' }, timestamp: Date.now() });
      return;
    }
    const target = await getUserById(targetId);
    if (!target) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    await setUserBlocked(userId, targetId, true);
    await sendBlockedList(userId, ws);
  }

  async function handleUnblockUser(userId: string, ws: WebSocket, payload: { userId?: string }): Promise<void> {
    if (!payload || typeof payload.userId !== 'string') {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Missing user id' }, timestamp: Date.now() });
      return;
    }
    await setUserBlocked(userId, payload.userId, false);
    await sendBlockedList(userId, ws);
  }

  async function handleGetBlocked(userId: string, ws: WebSocket): Promise<void> {
    await sendBlockedList(userId, ws);
  }

  const ADMIN_KEY = process.env.ADMIN_KEY || '';

  async function adminIdentity(userId: string | null, ws: WebSocket, payload: { key?: string }): Promise<string | null> {
    if (ADMIN_KEY && typeof payload?.key === 'string') {
      const a = Buffer.from(payload.key);
      const b = Buffer.from(ADMIN_KEY);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'admin';
    }
    if (!userId) return null;
    const client = firstClientFor(userId);
    const nick = client ? client.nickname : '';
    if (nick && await isAdminNickname(nick)) return nick;
    return null;
  }

  async function handleReportUser(userId: string, ws: WebSocket, payload: { targetId?: string; messageId?: string; reason?: string; source?: string }): Promise<void> {
    const targetId = typeof payload?.targetId === 'string' ? payload.targetId : '';
    const reason = typeof payload?.reason === 'string' ? sanitizeText(payload.reason).slice(0, 500) : '';
    if (!targetId || targetId === userId || !reason) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Invalid report' }, timestamp: Date.now() });
      return;
    }
    // The report table is capped, and the cap evicts the oldest row. One account filing a thousand
    // reports in a second therefore pushed out every genuine one a moderator had not read yet, which
    // makes the cap a weapon rather than a bound. A reporter gets a handful an hour.
    if (!reportAllowed(userId)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Too many reports, try again later' }, timestamp: Date.now() });
      return;
    }
    const source: 'profile' | 'message' = payload?.source === 'profile' ? 'profile' : 'message';
    const reporter = firstClientFor(userId);
    const reporterNick = reporter ? reporter.nickname : 'unknown';
    const target = await getUserById(targetId);
    const targetNick = target ? target.nickname : undefined;
    let channel = 'profile';
    let messageText: string | undefined;
    if (source === 'message' && typeof payload?.messageId === 'string') {
      const msg = await getMessageById(payload.messageId);
      if (msg) {
        if (!msg.channel || msg.channel === 'general') channel = 'general';
        else if (msg.channel === getDmChannelId(userId, targetId)) channel = 'dm';
        // The words are copied into the report row, and that row is read by moderators. Without this check
        // a reporter could name any message id on the server - a private conversation they are not part of -
        // and have a hundred characters of somebody else's message stored where an operator will read it.
        // Every other message operation asks `canAccessMessage` first; this one did not, and the id is
        // client-supplied and therefore guessable. The report itself is still filed: the point of it is that
        // an operator should decide, not the reporter.
        if (canAccessMessage(userId, msg)) {
          messageText = sanitizeText(msg.text || '').slice(0, 100) || undefined;
        }
      }
    }
    await addReport({
      id: crypto.randomUUID(),
      reporterId: userId,
      reporterNick,
      targetId,
      targetNick,
      channel,
      // Bounded like `reason` and `messageText` beside it, which are both sliced. This one was only
      // type-checked, so a multi-megabyte string went into `reports.message_id`. The table is capped
      // at a thousand *rows*, not row size, so a handful of throwaway accounts could put gigabytes of
      // operator-readable junk in front of a moderator. A real message id is a UUID - 36 characters.
      messageId: source === 'message' && typeof payload?.messageId === 'string' && payload.messageId.length <= 64
        ? payload.messageId : undefined,
      messageText,
      reason,
      source,
      timestamp: Date.now(),
    });
    send(ws, { type: 'report_received', payload: { ok: true, source } , timestamp: Date.now() });
  }

  async function handleAdminBan(userId: string | null, ws: WebSocket, payload: { key?: string; userId?: string; nickname?: string }): Promise<void> {
    const admin = await adminIdentity(userId, ws, payload);
    if (!admin) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const targetId = (typeof payload?.userId === 'string'
      ? payload.userId
      : (payload?.nickname ? (await getUserByNickname(sanitize(payload.nickname)))?.id : null)) || null;

    // An admin may not ban their own account.
    //
    // This is not a hypothetical guard. A ban is checked at sign-in and an admin reaches the ban button
    // through the same report list as everybody else, so one click on the wrong row - or a client that
    // sends the acting admin as the target - locks the only account that can lift it. There is no way back
    // through the interface: you cannot sign in to unban yourself, and the nickname is reserved so you
    // cannot simply register again. Recovering needs a database edit.
    //
    // Checked by id *and* by nickname, because the two are used interchangeably below and a request can
    // carry an id that resolves to nothing beside the nickname that resolves to the admin - in which case
    // the nickname branch is what would do the damage.
    //
    // The name arm compares against the acting account's own nickname, which is not the same thing as the
    // identity string above: with ADMIN_KEY and no session, `adminIdentity` answers with the role name
    // "admin" whether or not the caller is that account. Comparing against it would refuse banning anybody
    // called admin while letting a real admin ban themselves.
    //
    // With ADMIN_KEY and no session there is no way to tell who the caller is, so only the id arm applies.
    // That is not a hole in the guard — it is the reason the id arm exists.
    const targetNickname = typeof payload?.nickname === 'string' ? payload.nickname : null;
    const actingNickname = firstClientFor(userId)?.nickname ?? null;
    const selfById = !!targetId && !!userId && targetId === userId;
    const selfByName = !!targetNickname && !!actingNickname && targetNickname.toLowerCase() === actingNickname.toLowerCase();
    if (selfById || selfByName) {
      logSecurity('ADMIN_BAN_SELF_REFUSED', { admin, target: payload?.userId || payload?.nickname });
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'You cannot ban your own account' }, timestamp: Date.now() });
      return;
    }

    const ok = await setUserBannedByIdent(targetId, targetNickname, true);
    if (!ok) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    logSecurity('ADMIN_BAN', { admin, target: payload?.userId || payload?.nickname });

    if (targetId) {
      for (const c of devicesForUser(targetId)) {
        // Same ordering as a revocation: announced first, because the close handler finds nothing left to
        // look up once `unregisterDevice` below has run and so broadcasts nothing.
        broadcast({ type: 'user_left', payload: { userId: targetId, nickname: c.nickname }, timestamp: Date.now() });
        c.ws.close(4003, 'Account banned');
      }
      for (const id of [...(userDevices.get(targetId) || [])]) unregisterDevice(targetId, id);
    }

    const reportsRemoved = targetId ? await removeReportsForTarget(targetId) : 0;
    send(ws, { type: 'admin_action', payload: { ok: true, action: 'ban', targetId, reportsRemoved }, timestamp: Date.now() });
  }

  async function handleAdminUnban(userId: string | null, ws: WebSocket, payload: { key?: string; userId?: string; nickname?: string }): Promise<void> {
    const admin = await adminIdentity(userId, ws, payload);
    if (!admin) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const ok = await setUserBannedByIdent(typeof payload?.userId === 'string' ? payload.userId : null, typeof payload?.nickname === 'string' ? payload.nickname : null, false);
    if (!ok) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    logSecurity('ADMIN_UNBAN', { admin, target: payload?.userId || payload?.nickname });
    send(ws, { type: 'admin_action', payload: { ok: true, action: 'unban' }, timestamp: Date.now() });
  }

  async function handleAdminReports(userId: string | null, ws: WebSocket, payload: { key?: string }): Promise<void> {
    const admin = await adminIdentity(userId, ws, payload);
    if (!admin) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const reports = await getReports();
    send(ws, { type: 'admin_reports', payload: { reports }, timestamp: Date.now() });
  }

  async function handleGetBanned(userId: string | null, ws: WebSocket, payload: { key?: string }): Promise<void> {
    const admin = await adminIdentity(userId, ws, payload);
    if (!admin) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const banned = await getBannedUsers();
    send(ws, { type: 'banned_list', payload: { banned }, timestamp: Date.now() });
  }

export function startHeartbeatCheck(): void {
  /**
   * When the failed-sign-in tables are worth mentioning in the security log.
   *
   * Well above what one person fumbling with their own password can reach, because a correct sign-in
   * empties the name's entry and a wrong one from a single address trips the per-address backstop long
   * before this. Getting here means the attempts are spread over many addresses or many names.
   */
  const AUTH_COUNTER_NOTICE_SIZE = 4000;

  setInterval(() => {
    const now = Date.now();
    for (const client of clients.values()) {
      if (now - client.lastHeartbeat > CLIENT_TIMEOUT) {
        // Announced before the socket is torn down, and that ordering is the whole point. `terminate()`
        // fires `close` asynchronously, by which time `unregisterDevice` below has already removed the
        // entry - so `handleDisconnect` finds no client, takes the "not registered" branch and skips the
        // broadcast. Every other disconnect path announces first for exactly this reason; this one was
        // missed, so a client that went silent stayed on everyone's screen as online until they came
        // back on their own. `userDevices` was cleaned up regardless, which is why only the pushed
        // presence frame was lost and nothing looked obviously broken.
        broadcast({ type: 'user_left', payload: { userId: client.userId, nickname: client.nickname }, timestamp: Date.now() });
        client.ws.terminate();
        // The entry carries the account it belongs to, so a sweep can unregister it without having to
        // split the key back apart - which also removes any chance of the two halves being parsed wrong.
        unregisterDevice(client.userId, client.deviceId);
      } else if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL);

  // Every one of these tables is keyed by something a stranger controls - an address, an account id - so
  // none of them can be swept on disconnect alone. They used to be pruned only where a failure happened
  // to check, which left the registration table, the report table and the connection table growing for
  // as long as the process ran.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of authAttempts) {
      if (now > entry.resetAt) authAttempts.delete(ip);
    }
    for (const [key, last] of lastMessageTime) {
      if (now - last > RATE_LIMIT_WINDOW) lastMessageTime.delete(key);
    }
    // Drops the lockouts that have run out, then everything else the retention window has passed.
    // The second call is what collects entries that were never locked: they carry no marker for the
    // first to look at, so without it they would sit here until the next failed sign-in happened to
    // call for a pass - which, on a server nobody is attacking, is never.
    collectExpiredLocks(now);
    pruneCounters(now);
    // Both tables are keyed by things a stranger controls, so their size is a direct read on how much
    // guessing is going on. Worth a line once they are genuinely large, and silent below that: the
    // counters are emptied on every success, so a table this big means the attempts are spread over
    // thousands of distinct names, which is a spray rather than one person fumbling.
    const counters = authCounterSizes();
    if (counters.pairs + counters.names > AUTH_COUNTER_NOTICE_SIZE) {
      logSecurity('LOGIN_COUNTERS_LARGE', { pairEntries: counters.pairs, nameEntries: counters.names });
    }
    for (const [uid, last] of lastAvatarChange) {
      if (now - last > AVATAR_CHANGE_INTERVAL_MS) lastAvatarChange.delete(uid);
    }
    // Challenges nobody answered. Only the unanswered ones: a solved-but-unspent proof is kept until it
    // either times out or the sweep reaches it, so that a client which solved just as the sweep ran does not
    // lose its work to a race.
    for (const [challenge, entry] of powChallenges) {
      if (now - entry.createdAt > POW_CHALLENGE_TTL_MS && !entry.solved) powChallenges.delete(challenge);
    }
    // Registration counters used to be swept here. They are rows in registration_events now, pruned on
    // write by the database, so there is nothing in memory left to sweep - and a sweeper that could have
    // dropped a still-counting entry was a second way for the limit to fail open.
    for (const [uid, times] of reportsByUser) {
      const recent = times.filter((t) => now - t <= REPORT_WINDOW_MS);
      if (recent.length === 0) reportsByUser.delete(uid);
      else reportsByUser.set(uid, recent);
    }
    for (const [uid, times] of preKeyFetches) {
      const recent = times.filter((t) => now - t <= PREKEY_FETCH_WINDOW_MS);
      if (recent.length === 0) preKeyFetches.delete(uid);
      else preKeyFetches.set(uid, recent);
    }
    for (const [uid, times] of searchAttempts) {
      const recent = times.filter((t) => now - t <= SEARCH_RATE_WINDOW);
      if (recent.length === 0) searchAttempts.delete(uid);
      else searchAttempts.set(uid, recent);
    }
    // The frame budgets are keyed by a socket id and an account id, neither of which anything cleans up on
    // close, so without this they would be one entry per connection for the lifetime of the process.
    for (const [key, entry] of frameCounts) {
      if (now > entry.resetAt) frameCounts.delete(key);
    }
    pruneUploadTokens(now);
    pruneSessionRegistry(now);
    // a slot is only released on disconnect, so anything still at zero belongs to a socket that has
    // gone away without the release running
    for (const [key, count] of connectionCounts) {
      if (count <= 0) connectionCounts.delete(key);
    }
  }, RATE_LIMIT_WINDOW);

  scheduleWeeklyCleanup();
}

function scheduleWeeklyCleanup(): void {
  const msUntilMonday = nextMondayMidnightMSK() - Date.now();

  setTimeout(async () => {
    // The body used to be unguarded. A database error at Monday 00:00 MSK rejected out of this callback,
    // Node's default turned that into an uncaught exception, and the server died with the weekly sweep
    // never rescheduled - permanently, since the only thing that would have scheduled it was the line
    // below the throw. Wrapped, and rescheduled in `finally` so one bad week does not end the schedule.
    try {
      const deleted = await deleteGeneralMessages();
      logSecurity('WEEKLY_CLEANUP', { deletedMessages: deleted });
      console.log(`[Cleanup] Deleted ${deleted} general chat messages (Moscow 00:00 Monday)`);
      broadcast({ type: 'chat_cleared', payload: { channel: 'general' }, timestamp: Date.now() });
    } catch (e) {
      console.error('Weekly cleanup failed:', (e as Error).message);
    } finally {
      scheduleWeeklyCleanup();
    }
  }, msUntilMonday);
}
