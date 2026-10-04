import { WebSocket } from 'ws';
import { issueUploadToken } from './uploadTokens.js';
import { getUserByNickname, saveMessage, getRecentMessages, getMessageById, createUser, getAllPublicKeys, getPublicKeysByIds, getDmChannelId, getDmHistory, getDmContacts, deleteGeneralMessages, getAllUsers, updatePublicKey, setPreKeyBundle, getPreKeyBundlesByIds, getIdentityKeyB64, setIdentityKeyB64, getIdentityKeysByIds, getKeyBackup, saveKeyBackup, searchMessages, deleteMessage, updateEncryptedMessage, addReaction, removeReaction, getReactionsForMessage, getReactionsForMessages, updateMessageText, getUserBanned, getBlockedUserIds, setUserBlocked, setUserBannedByIdent, getUserById, getUserProfile, setUserAvatar, removeUserAvatar, getAvatarDir, addReport, getReports, removeReportsForTarget, getBannedUsers, isAdminNickname, getAllSessions, upsertSession, markSessionRevoked, touchSession, StoredSession, getChannelMediaKey } from './database.js';
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
  MAX_FAILED_LOGINS,
  ACCOUNT_LOCKOUT_DURATION,
  MAX_FAILED_LOGINS_GLOBAL,
  ACCOUNT_LOCKOUT_DURATION_GLOBAL,
  MAX_REGISTRATIONS_PER_IP,
  REGISTRATION_WINDOW_MS,
  FAILED_LOGIN_RETENTION_MS,
  MAX_WS_PAYLOAD_SIZE,
  HEARTBEAT_INTERVAL,
  CLIENT_TIMEOUT,
  DM_TTL_ALLOWED_MS,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_PAYLOAD,
  AVATAR_CHANGE_INTERVAL_MS,
} from './constants.js';

import { pseudonymizeAddress, coarsenDeviceLabel, appendSecurityLine } from './privacy.js';

/**
 * One line in the security log.
 *
 * The address is a daily-rotating pseudonym and the device string is a coarse label, both applied here
 * rather than at each call site. That module existed and was described in the documentation, but
 * nothing called it: every entry went to disk with the caller's real address in it and the full user
 * agent stored beside it, which is the largest map of who used this server and from where an operator
 * could ask for. Applied once, here, it cannot be forgotten at a new call site.
 */
function logSecurity(event: string, details: Record<string, any>) {
  const safe: Record<string, any> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'ip') safe[key] = pseudonymizeAddress(String(value ?? ''));
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
    sessionRegistryPromise = (async () => {
      const all = await getAllSessions();
      for (const rec of all) {
        let m = sessionRecords.get(rec.userId);
        if (!m) { m = new Map(); sessionRecords.set(rec.userId, m); }
        m.set(rec.deviceId, rec);
      }
    })();
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
let totalConnections = 0;


function devicesForUser(userId: string): ConnectedClient[] {
  const ids = userDevices.get(userId);
  if (!ids) return [];
  const out: ConnectedClient[] = [];
  for (const id of ids) {
    const c = clients.get(id);
    if (c) out.push(c);
  }
  return out;
}

function isUserOnline(userId: string): boolean {
  const ids = userDevices.get(userId);
  return !!ids && ids.size > 0;
}





function registerDevice(deviceId: string, client: ConnectedClient): void {
  const prev = clients.get(deviceId);
  if (prev && prev.ws !== client.ws) {
    try { prev.ws.close(4001, 'Reconnected from another socket'); } catch {}
  }
  clients.set(deviceId, client);
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
 */
function unregisterDevice(deviceId: string, expectedWs?: WebSocket): void {
    const client = clients.get(deviceId);
    if (!client) return;
    if (expectedWs && client.ws !== expectedWs) return;
    clients.delete(deviceId);
    const set = userDevices.get(client.userId);
    if (set) {
      set.delete(deviceId);
      if (set.size === 0) userDevices.delete(client.userId);
    }
  }

export function getTotalConnections(): number {
  return totalConnections;
}




const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H8dQYhC1Bcye0e7o3mN0q0VWcZBp4eXmJzVQyGpL3uTIC';

const authAttempts = new Map<string, { count: number; resetAt: number }>();
const lastMessageTime = new Map<string, number>();
const connectionCounts = new Map<string, number>();
/**
 * Wrong passwords, keyed by nickname and address together.
 *
 * It used to be keyed by nickname alone, which is a denial of service rather than a security measure:
 * anybody who knew a name could lock the account for five minutes at a time and hold it there for as
 * long as they cared to. Keying on the pair means a family, an office or a school behind one router no
 * longer locks each other out, while a spray at one name from one machine still runs into a wall.
 */
const failedLogins = new Map<string, { count: number; lockedUntil: number; lastActive: number }>();
/** The same mistakes counted for one nickname across every address, which is what a spray runs into. */
const nicknameFailures = new Map<string, { count: number; lockedUntil: number; lastActive: number }>();
/** Accounts one address has created, and when, so a spammer cannot fill the users table. */
const registrationsByIp = new Map<string, number[]>();

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

/** Drops expired entries once the table is big enough to be worth the pass. */
function pruneCounters(now: number): void {
  const cutoff = now - FAILED_LOGIN_RETENTION_MS;
  for (const [key, entry] of failedLogins) {
    if (entry.lastActive < cutoff && (!entry.lockedUntil || entry.lockedUntil < now)) failedLogins.delete(key);
  }
  for (const [key, entry] of nicknameFailures) {
    if (entry.lastActive < cutoff && (!entry.lockedUntil || entry.lockedUntil < now)) nicknameFailures.delete(key);
  }
  if (failedLogins.size > 5000 || nicknameFailures.size > 5000) pruneCounters(now);
}

/**
 * Counts one wrong password against both the nickname and address pair and the name on its own.
 *
 * The pair is what refuses an attempt; the cross-address total is the slower, higher ceiling that
 * only matters to somebody spraying one name from many machines.
 */
function recordFailedLogin(pairKey: string, nicknameKey: string): { count: number; lockedUntil: number } {
  const now = Date.now();
  pruneCounters(now);

  const pair = failedLogins.get(pairKey);
  const pairCount = pair && (!pair.lockedUntil || pair.lockedUntil < now) ? pair.count + 1 : 1;
  const pairLockedUntil = pairCount >= MAX_FAILED_LOGINS ? now + ACCOUNT_LOCKOUT_DURATION : 0;
  failedLogins.set(pairKey, { count: pairCount, lockedUntil: pairLockedUntil, lastActive: now });

  const global = nicknameFailures.get(nicknameKey);
  const globalCount = global && (!global.lockedUntil || global.lockedUntil < now) ? global.count + 1 : 1;
  const globalLockedUntil = globalCount >= MAX_FAILED_LOGINS_GLOBAL ? now + ACCOUNT_LOCKOUT_DURATION_GLOBAL : 0;
  nicknameFailures.set(nicknameKey, { count: globalCount, lockedUntil: globalLockedUntil, lastActive: now });

  return { count: pairCount, lockedUntil: pairLockedUntil };
}

/** Forgets a nickname's failures once the right password came through. */
function clearFailedLogins(nicknameKey: string): void {
  nicknameFailures.delete(nicknameKey);
  for (const key of [...failedLogins.keys()]) {
    if (key.endsWith('|' + nicknameKey)) failedLogins.delete(key);
  }
}

/**
 * Whether this attempt is the one that stops answering.
 *
 * Only a *wrong* password is ever refused here. A lockout that can turn away the correct password is a
 * way to lock somebody out of their own account, so the check runs after the comparison succeeds and
 * the right password always gets in, however many failures the name has collected.
 */
function loginLockedOut(pairKey: string, nicknameKey: string): number {
  const now = Date.now();
  const pair = failedLogins.get(pairKey);
  if (pair && pair.lockedUntil > now) return Math.ceil((pair.lockedUntil - now) / 60000);
  const global = nicknameFailures.get(nicknameKey);
  if (global && global.lockedUntil > now) return Math.ceil((global.lockedUntil - now) / 60000);
  return 0;
}

/**
 * How many accounts this address may still create in the window.
 *
 * The window is long on purpose: a short one punishes a shared address rather than a spammer, which is
 * the same mistake the auth backstop used to make. A ceiling of zero lifts it entirely.
 */
function registrationAllowed(ip: string): { allowed: boolean; retryHours: number } {
  if (MAX_REGISTRATIONS_PER_IP <= 0) return { allowed: true, retryHours: 0 };
  const now = Date.now();
  const since = now - REGISTRATION_WINDOW_MS;
  const recent = (registrationsByIp.get(ip) || []).filter(t => t > since);
  registrationsByIp.set(ip, recent);
  if (recent.length < MAX_REGISTRATIONS_PER_IP) return { allowed: true, retryHours: 0 };
  const oldest = Math.min(...recent);
  return { allowed: false, retryHours: Math.max(1, Math.ceil((oldest + REGISTRATION_WINDOW_MS - now) / 3600000)) };
}

/** Charges an account to the address that created it, but only once one really exists. */
function recordRegistration(ip: string): void {
  if (MAX_REGISTRATIONS_PER_IP <= 0) return;
  const recent = registrationsByIp.get(ip) || [];
  recent.push(Date.now());
  registrationsByIp.set(ip, recent);
}

/** How many reports one account may file in the window, and why the ceiling exists. */
const MAX_REPORTS_PER_USER = 10;
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const reportsByUser = new Map<string, number[]>();

/** How many prekey fetches one account may make in the window, and why the ceiling exists. */
const MAX_PREKEY_FETCHES = 300;
const PREKEY_FETCH_WINDOW_MS = 60 * 60 * 1000;
const preKeyFetches = new Map<string, number[]>();

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

/** Read once at load: the flag is process configuration, not something a request can move. */
const TRUST_PROXY_ENABLED = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');

/**
 * Whether a forwarding header may be believed.
 *
 * Behind a tunnel every socket arrives from the proxy itself, so the address was identical for all
 * users and they shared one rate limit bucket - which is why the header is read at all. Reading it
 * unconditionally is just as bad in the other direction: an instance bound to a network address is
 * reachable by anyone on it, and every one of those clients could put an arbitrary address in the
 * header and walk past the per-address auth limit, the per-address registration limit and the
 * connection cap. So the header is only honoured when the operator has said there is a proxy, or when
 * the immediate peer is loopback - which is a tunnel on this machine and nothing else.
 */
function proxyHeadersTrusted(socketIp: string): boolean {
  if (TRUST_PROXY_ENABLED) return true;
  return socketIp === 'unknown' || socketIp === '::1' || socketIp === '127.0.0.1'
    || socketIp === '::ffff:127.0.0.1' || socketIp.startsWith('127.');
}

function getClientIp(ws: WebSocket, upgradeRequest?: any): string {
  // @fastify/websocket hands the upgrade request to the route handler as the second argument, and
  // the ws socket itself does not keep it, so the forwarded headers are only reachable from here
  const req = upgradeRequest || (ws as any).req || (ws as any)._req;
  const socketIp = normalizeIp(req?.socket?.remoteAddress || (ws as any)._socket?.remoteAddress);
  if (!proxyHeadersTrusted(socketIp)) return socketIp;
  const headers = req?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === 'string' ? forwarded.split(',')[0] : '';
  const realIp = typeof headers['x-real-ip'] === 'string' ? headers['x-real-ip'] : '';
  const candidate = normalizeIp(first || realIp);
  if (candidate !== 'unknown') return candidate;
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

function clearAuthRateLimit(ip: string): void {
  authAttempts.delete(ip);
}

function authLimitReason(ip: string): string {
  const seconds = Math.max(1, Math.ceil(authRateRemainingMs(ip) / 1000));
  return `Too many attempts. Try again in ${seconds} second(s).`;
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
    keys: Object.keys(bundle).join(','),
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
 */
function bodyForDevice(stored: any, deviceId?: string | null): any {
  if (!isValidDeviceBodies(stored)) return stored || null;
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
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(message: ServerMessage, excludeUserId?: string): void {
  const data = JSON.stringify(message);
  for (const client of clients.values()) {
    if (client.userId !== excludeUserId && client.ws.readyState === WebSocket.OPEN) {
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
    if (currentDeviceId) {
      const client = clients.get(currentDeviceId);
      if (client) client.lastHeartbeat = Date.now();
    }
  });

  async function handleMessage(ws: WebSocket, userId: string | null, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'auth_login':
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
        if (currentDeviceId) {
          const client = clients.get(currentDeviceId);
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
        if (userId) handleGetSessions(userId, ws, currentDeviceId);
        break;
      case 'revoke_session':
        if (userId) handleRevokeSession(userId, ws, message.payload, currentDeviceId);
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

    const user = await getUserByNickname(cleanNick);

    // A name that does not exist still gets the full comparison, so a miss is indistinguishable from a
    // wrong password in both the answer and the time it takes.
    const passwordMatches = user && user.passwordHash && typeof password === 'string'
      ? await bcrypt.compare(String(password), user.passwordHash)
      : false;
    if (!passwordMatches) {
      // A name that does not exist still pays for the full comparison, so a miss is indistinguishable
      // from a wrong password in both the answer and the time it takes.
      await bcrypt.compare(String(password || ''), DUMMY_PASSWORD_HASH);
    }

    if (!passwordMatches || !user) {
      const lockedMinutes = loginLockedOut(pairKey, nicknameKey);
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

    if (await isAdminNickname(cleanNick)) {
      send(ws, { type: 'auth_failure', payload: { reason: 'This nickname is reserved' }, timestamp: Date.now() });
      logSecurity('RESERVED_NICK_REGISTER', { nick: cleanNick, ip });
      return;
    }

    const sameNick = await getUserByNickname(cleanNick.toLowerCase()) || (await getAllUsers()).find(u => u.nickname.toLowerCase() === cleanNick.toLowerCase());
    if (sameNick) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Nickname already taken' }, timestamp: Date.now() });
      return;
    }

    // Checked only once the name is genuinely free: a refusal that happens before the account exists
    // must not spend the budget, or one person holding a name could stop a whole network registering.
    const registration = registrationAllowed(ip);
    if (!registration.allowed) {
      send(ws, { type: 'auth_failure', payload: { reason: `Too many accounts created from this network. Try again in ${registration.retryHours} hour(s).` }, timestamp: Date.now() });
      logSecurity('REGISTRATION_LIMIT', { ip, limit: MAX_REGISTRATIONS_PER_IP, retryHours: registration.retryHours });
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
    recordRegistration(ip);

    const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
      ? payload.deviceId : crypto.randomUUID();
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
  if (fallbackChannel === 'general' && target.channel !== 'general') return null;
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

  function canAccessMessage(userId: string, msg: { channel?: string | null }): boolean {
    if (!msg.channel || msg.channel === 'general') return true;
    if (msg.channel.includes(':')) {
      const parts = msg.channel.split(':');
      return parts.length === 2 && (parts[0] === userId || parts[1] === userId);
    }
    return msg.channel === userId;
  }

  function broadcastToMessageAudience(messageId: string, actorUserId: string, message: ServerMessage): void {
    void (async () => {
      const target = await getMessageById(messageId);
      if (!target) return;
      deliverToChannel(target.channel, actorUserId, message);
    })();
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
    const query = sanitize(payload?.query || '').toLowerCase();
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
    const query = sanitize(payload?.query || '');
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
      deliverToChannel(target.channel, userId, notice);
      send(ws, notice);
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
      send(ws, { type: 'message_edited', payload: edit, timestamp });
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
      broadcast({ type: 'message_edited', payload: { messageId: payload.messageId, text, editedAt: timestamp }, timestamp }, userId);
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
      const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 ? payload.deviceId : currentDeviceId;
      if (deviceId) await setPreKeyBundle(userId, deviceId, payload.bundle);
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
    const bundles = await getPreKeyBundlesByIds(ids);
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
    if (!deviceId) return;

    const client = clients.get(deviceId);
    unregisterDevice(deviceId, ws);

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
        const live = clients.get(rec.deviceId);
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
    void markSessionRevoked(userId, targetId).catch(() => {});
    
    const live = clients.get(targetId);
    if (live && live.userId === userId) {
      try { live.ws.close(4001, 'Session revoked'); } catch {}
      unregisterDevice(targetId);
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
    const ids = userDevices.get(userId);
    const client = ids ? clients.get([...ids][0] || '') : null;
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
    const reporter = clients.get([...userDevices.get(userId) || []][0] || '') || null;
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
        messageText = sanitizeText(msg.text || '').slice(0, 100) || undefined;
      }
    }
    await addReport({
      id: crypto.randomUUID(),
      reporterId: userId,
      reporterNick,
      targetId,
      targetNick,
      channel,
      messageId: source === 'message' && typeof payload?.messageId === 'string' ? payload.messageId : undefined,
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
    const actingNickname = userId
      ? ((userDevices.get(userId) ? clients.get([...userDevices.get(userId)!][0] || '') : null)?.nickname ?? null)
      : null;
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
        c.ws.close(4003, 'Account banned');
      }
      for (const id of [...(userDevices.get(targetId) || [])]) unregisterDevice(id);
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
  setInterval(() => {
    const now = Date.now();
    for (const [deviceId, client] of clients) {
      if (now - client.lastHeartbeat > CLIENT_TIMEOUT) {
        client.ws.terminate();
        unregisterDevice(deviceId);
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
    for (const [key, entry] of failedLogins) {
      if (entry.lockedUntil > 0 && now > entry.lockedUntil) failedLogins.delete(key);
    }
    for (const [key, entry] of nicknameFailures) {
      if (entry.lockedUntil > 0 && now > entry.lockedUntil) nicknameFailures.delete(key);
    }
    for (const [uid, last] of lastAvatarChange) {
      if (now - last > AVATAR_CHANGE_INTERVAL_MS) lastAvatarChange.delete(uid);
    }
    for (const [ip, times] of registrationsByIp) {
      const recent = times.filter((t) => now - t <= REGISTRATION_WINDOW_MS);
      if (recent.length === 0) registrationsByIp.delete(ip);
      else registrationsByIp.set(ip, recent);
    }
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
    const deleted = await deleteGeneralMessages();
    logSecurity('WEEKLY_CLEANUP', { deletedMessages: deleted });
    console.log(`[Cleanup] Deleted ${deleted} general chat messages (Moscow 00:00 Monday)`);
    broadcast({ type: 'chat_cleared', payload: { channel: 'general' }, timestamp: Date.now() });

    scheduleWeeklyCleanup();
  }, msUntilMonday);
}
