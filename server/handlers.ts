import { WebSocket } from 'ws';
import { getUserByNickname, saveMessage, getRecentMessages, getMessageById, createUser, getAllPublicKeys, getPublicKeysByIds, getDmChannelId, getDmHistory, getDmContacts, deleteGeneralMessages, getAllUsers, updatePublicKey, setPreKeyBundle, getPreKeyBundle, getKeyBackup, saveKeyBackup, searchMessages, deleteMessage, addReaction, removeReaction, getReactionsForMessage, getReactionsForMessages, updateMessageText, getUserBanned, getBlockedUserIds, setUserBlocked, setUserBannedByIdent, getUserById, getUserProfile, getIdentityKeyB64, setUserAvatar, removeUserAvatar, getAvatarDir, getDataDir, addReport, getReports, removeReportsForTarget, getBannedUsers, isAdminNickname, getAllSessions, upsertSession, markSessionRevoked, touchSession, type StoredSession, getChannelMediaKey } from './database.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import fs from 'fs';
import path from 'path';
import { nextMondayMidnightMSK } from './time.js';
import {
  RATE_LIMIT_WINDOW,
  MAX_AUTH_ATTEMPTS,
  MIN_MESSAGE_INTERVAL,
  MAX_SESSIONS_PER_USER,
  MAX_CONNECTIONS_PER_IP,
  MAX_FAILED_LOGINS,
  ACCOUNT_LOCKOUT_DURATION,
  FAILED_LOGIN_RETENTION_MS,
  MAX_WS_PAYLOAD_SIZE,
  HEARTBEAT_INTERVAL,
  CLIENT_TIMEOUT,
  DM_TTL_ALLOWED_MS,
  MAX_AVATAR_BYTES,
  MAX_AVATAR_PAYLOAD,
  AVATAR_CHANGE_INTERVAL_MS,
} from './constants.js';

const SECURITY_LOG = () => path.join(getDataDir(), 'security.log');

function logSecurity(event: string, details: Record<string, any>) {
  const entry = `[${new Date().toISOString()}] ${event} ${JSON.stringify(details)}\n`;
  try {
    const file = SECURITY_LOG();
    try { mkdirSync(path.dirname(file), { recursive: true }); } catch {}
    appendFileSync(file, entry);
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






function reconcileActiveSessions(): void {
  for (const client of clients.values()) {
    const m = sessionRecords.get(client.userId);
    const rec = m?.get(client.deviceId);
    if (!rec || rec.revoked) {
      registerSession({ userId: client.userId, deviceId: client.deviceId, nickname: client.nickname, deviceInfo: client.deviceInfo || '', firstSeen: rec?.firstSeen || client.lastHeartbeat, lastActive: client.lastHeartbeat, revoked: false });
    }
  }
}

function registerSession(record: StoredSession): void {
  let m = sessionRecords.get(record.userId);
  if (!m) { m = new Map(); sessionRecords.set(record.userId, m); }
  m.set(record.deviceId, record);
  void upsertSession(record).catch(() => {});
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


function unregisterDevice(deviceId: string): void {
  const client = clients.get(deviceId);
  if (!client) return;
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
const failedLogins = new Map<string, { count: number; lockedUntil: number; lastActive: number }>();

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

function recordFailedLogin(lockKey: string, count: number, lockedUntil: number): void {
  failedLogins.set(lockKey, { count, lockedUntil, lastActive: Date.now() });
  
  if (failedLogins.size > 5000) {
    const cutoff = Date.now() - FAILED_LOGIN_RETENTION_MS;
    for (const [key, entry] of failedLogins) {
      if (entry.lastActive < cutoff) failedLogins.delete(key);
    }
  }
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

function isPrivatePeer(ip: string): boolean {
  if (ip === 'unknown' || ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^(fc|fd|fe80)/.test(ip)) return true;
  return false;
}

function getClientIp(ws: WebSocket, upgradeRequest?: any): string {
  // @fastify/websocket hands the upgrade request to the route handler as the second argument, and
  // the ws socket itself does not keep it, so the forwarded headers are only reachable from here
  const req = upgradeRequest || (ws as any).req || (ws as any)._req;
  const socketIp = normalizeIp(req?.socket?.remoteAddress || (ws as any)._socket?.remoteAddress);
  const headers = req?.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === 'string' ? forwarded.split(',')[0] : '';
  const realIp = typeof headers['x-real-ip'] === 'string' ? headers['x-real-ip'] : '';
  // behind a tunnel or reverse proxy every socket arrives from the proxy itself, so the address
  // was identical for all users and they shared one rate limit bucket. Trust the forwarding
  // header only when the direct peer is private, otherwise anyone could spoof their way past it.
  if ((first || realIp) && isPrivatePeer(socketIp)) {
    const candidate = normalizeIp(first || realIp);
    if (candidate !== 'unknown') return candidate;
  }
  return socketIp;
}

function checkMessageRateLimit(ip: string): boolean {
  if (RATE_LIMITS_DISABLED) return true;
  const now = Date.now();
  const last = lastMessageTime.get(ip) || 0;
  if (now - last < MIN_MESSAGE_INTERVAL) return false;
  lastMessageTime.set(ip, now);
  return true;
}

const RATE_LIMITS_DISABLED = process.env.DISABLE_RATE_LIMITS === '1';

/** Milliseconds left before the auth limit for this ip expires, 0 when there is no active limit. */
function authRateRemainingMs(ip: string): number {
  const entry = authAttempts.get(ip);
  if (!entry) return 0;
  return Math.max(0, entry.resetAt - Date.now());
}

function checkAuthRateLimit(ip: string): boolean {
  if (RATE_LIMITS_DISABLED) return true;
  if (authRateRemainingMs(ip) === 0) return true;
  return (authAttempts.get(ip)?.count ?? 0) < MAX_AUTH_ATTEMPTS;
}

/** Only rejected credentials count towards the limit, so reconnects and autologin stay free. */
function recordAuthFailure(ip: string): void {
  if (RATE_LIMITS_DISABLED) return;
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

function checkConnectionLimit(ip: string): boolean {
  if (RATE_LIMITS_DISABLED) return true;
  const count = connectionCounts.get(ip) || 0;
  if (count >= MAX_CONNECTIONS_PER_IP) return false;
  connectionCounts.set(ip, count + 1);
  return true;
}

function releaseConnection(ip: string): void {
  const count = connectionCounts.get(ip) || 0;
  if (count <= 1) connectionCounts.delete(ip);
  else connectionCounts.set(ip, count - 1);
  totalConnections = Math.max(0, totalConnections - 1);
}

function sanitize(input: string): string {
  return input
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[<>&"']/g, '')
    .trim();
}

function sanitizeText(input: string): string {
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

function preKeyBundleDiagnostics(bundle: any): Record<string, any> {
  if (!bundle || typeof bundle !== 'object') return { present: false };
  const spk = bundle.signedPreKey;
  return {
    present: true,
    keys: Object.keys(bundle).join(','),
    jsonLen: (() => { try { return JSON.stringify(bundle).length; } catch { return -1; } })(),
    identityKeyType: typeof bundle.identityKey,
    identityKeyLen: typeof bundle.identityKey === 'string' ? bundle.identityKey.length : -1,
    ed25519Type: typeof bundle.ed25519PublicKey,
    ed25519Len: typeof bundle.ed25519PublicKey === 'string' ? bundle.ed25519PublicKey.length : -1,
    spkType: spk === null ? 'null' : typeof spk,
    spkPublicKeyType: spk && typeof spk === 'object' ? typeof spk.publicKey : 'n/a',
    signatureIsArray: Array.isArray(spk && spk.signature),
    signatureLen: Array.isArray(spk && spk.signature) ? spk.signature.length : -1,
    oneTimePreKeyType: bundle.oneTimePreKey === undefined ? 'undefined' : typeof bundle.oneTimePreKey,
    version: typeof bundle.version,
    bundleVersion: typeof bundle.bundleVersion,
  };
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
  // клиент шлёт "version", legacy-формат использовал "bundleVersion"
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
  totalConnections++;

  if (!checkConnectionLimit(ip)) {
    logSecurity('CONNECTION_LIMIT', { ip });
    send(ws, { type: 'error', payload: { code: 'CONNECTION_LIMIT', message: 'Too many connections from your IP' }, timestamp: Date.now() });
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
    handleDisconnect(currentDeviceId, currentUserId);
    releaseConnection(ip);
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
      case 'sealed_send':
        if (userId) await handleSealedSend(userId, ws, message.payload);
        break;
      case 'dm_history':
        if (userId) await handleDmHistory(userId, ws, message.payload);
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

    const lockKey = cleanNick.toLowerCase();
    
    
    const purgeCutoff = Date.now() - FAILED_LOGIN_RETENTION_MS;
    for (const [key, entry] of failedLogins) {
      if (entry.lastActive < purgeCutoff) failedLogins.delete(key);
    }
    const lockEntry = failedLogins.get(lockKey);
    if (lockEntry && lockEntry.lockedUntil > Date.now()) {
      const remaining = Math.ceil((lockEntry.lockedUntil - Date.now()) / 60000);
      logSecurity('LOGIN_LOCKED', { nickname: cleanNick, ip, remainingMin: remaining });
      send(ws, { type: 'auth_failure', payload: { reason: `Account locked. Try again in ${remaining} minute(s).` }, timestamp: Date.now() });
      return;
    }

    const user = await getUserByNickname(cleanNick);
    if (!user || typeof password !== 'string' || !user.passwordHash) {
      
      
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      const newCount = lockEntry ? lockEntry.count + 1 : 1;
      const lockedUntil = newCount >= MAX_FAILED_LOGINS ? Date.now() + ACCOUNT_LOCKOUT_DURATION : 0;
      recordFailedLogin(lockKey, newCount, lockedUntil);
      recordAuthFailure(ip);
      logSecurity('LOGIN_FAILED', { nickname: cleanNick, ip, attempts: newCount, locked: lockedUntil > 0 });
      send(ws, { type: 'auth_failure', payload: { reason: 'Invalid nickname or password' }, timestamp: Date.now() });
      return;
    }
    if (!(await bcrypt.compare(String(password), user.passwordHash))) {
      const newCount = lockEntry ? lockEntry.count + 1 : 1;
      const lockedUntil = newCount >= MAX_FAILED_LOGINS ? Date.now() + ACCOUNT_LOCKOUT_DURATION : 0;
      recordFailedLogin(lockKey, newCount, lockedUntil);
      recordAuthFailure(ip);
      logSecurity('LOGIN_FAILED', { nickname: cleanNick, ip, attempts: newCount, locked: lockedUntil > 0 });
      send(ws, { type: 'auth_failure', payload: { reason: 'Invalid nickname or password' }, timestamp: Date.now() });
      return;
    }

    logSecurity('LOGIN_SUCCESS', { nickname: cleanNick, ip });
    failedLogins.delete(lockKey);
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

    const now = Date.now();
    registerSession({ userId: user.id, deviceId, nickname: user.nickname, deviceInfo: typeof payload?.deviceInfo === 'string' ? payload.deviceInfo.slice(0, 60) : '', firstSeen: now, lastActive: now, revoked: false });
    currentUserId = user.id;
    currentDeviceId = deviceId;
    registerDevice(deviceId, { deviceId, ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip, deviceInfo: typeof payload?.deviceInfo === 'string' ? payload.deviceInfo.slice(0, 60) : '' });

    if (payload.preKeyBundle && isValidPreKeyBundle(payload.preKeyBundle)) {
      await setPreKeyBundle(user.id, payload.preKeyBundle);
    }

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

    if (typeof cleanPass !== 'string' || cleanPass.length < 8 || cleanPass.length > 32) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Password must be 8-32 characters' }, timestamp: Date.now() });
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

    if (payload.preKeyBundle && isValidPreKeyBundle(payload.preKeyBundle)) {
      await setPreKeyBundle(user.id, payload.preKeyBundle);
    }

    const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
      ? payload.deviceId : crypto.randomUUID();
    registerSession({ userId: user.id, deviceId, nickname: user.nickname, deviceInfo: typeof payload?.deviceInfo === 'string' ? payload.deviceInfo.slice(0, 60) : '', firstSeen: Date.now(), lastActive: Date.now(), revoked: false });
    currentUserId = user.id;
    currentDeviceId = deviceId;
    registerDevice(deviceId, { deviceId, ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip, deviceInfo: typeof payload?.deviceInfo === 'string' ? payload.deviceInfo.slice(0, 60) : '' });

    await onAuthenticated(user.id, user.nickname, ws, deviceId);
  }

  async function onAuthenticated(userId: string, nickname: string, ws: WebSocket, deviceId?: string): Promise<void> {
    const publicKeys = await getAllPublicKeys();
    const userMeta = await buildAvatarInfoMap();

    const seen = new Set<string>();
    const onlineUsers: { id: string; nickname: string; avatar: AvatarInfo | null }[] = [];
    for (const c of clients.values()) {
      if (!seen.has(c.userId)) { seen.add(c.userId); onlineUsers.push({ id: c.userId, nickname: c.nickname, avatar: avatarInfo(userMeta.get(c.userId)) }); }
    }

    send(ws, { type: 'auth_success', payload: { userId, nickname, deviceId, publicKeys, preKeyBundles: {}, onlineUsers, role: await isAdminNickname(nickname) ? 'admin' : 'user', channelMediaKey: await getChannelMediaKey() }, timestamp: Date.now() });

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
      },
      timestamp: Date.now(),
    });

    broadcast({ type: 'user_joined', payload: { userId, nickname, avatar: avatarInfo(userMeta.get(userId)) }, timestamp: Date.now() }, userId);
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
    if (!checkMessageRateLimit(ip) || !checkMessageRateLimit(senderId)) {
      logSecurity('RATE_LIMIT_MESSAGE', { ip, senderId });
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Max 2 messages per second.' }, timestamp: Date.now() });
      return;
    }

    const senderDevices = devicesForUser(senderId);
    const sender = senderDevices[0] || null;
    if (!sender) return;

    const text = typeof payload?.text === 'string' ? sanitizeText(payload.text) : '';
    if (!text) return;
    if (text.length > 4096) {
      send(ws, { type: 'error', payload: { code: 'MESSAGE_TOO_LONG', message: 'Message too long (max 4096 chars)' }, timestamp: Date.now() });
      return;
    }

    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    const fileKey = payload?.fileKey && typeof payload.fileKey === 'object' ? payload.fileKey : undefined;
    const expiresAt = resolveExpiry(payload?.ttl, timestamp);
    const quoted = payload?.quoted && typeof payload.quoted === 'object' && typeof payload.quoted.sender === 'string'
      ? { id: String(payload.quoted.id || ''), text: sanitizeText(String(payload.quoted.text || '')).slice(0, 4096), sender: sanitizeText(payload.quoted.sender).slice(0, 64) }
      : null;
    await saveMessage(messageId, senderId, sender.nickname, text, timestamp, undefined, 'general', fileKey, undefined, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined);

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
      quotedMessageText: quoted?.text,
      quotedMessageSender: quoted?.sender,
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
    if (!checkMessageRateLimit(ip)) {
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
    if (payload?.toKey && typeof payload.toKey === 'object' && payload.toKey.kty) {
      const keysMap = await getAllPublicKeys();
      const keyStr = canonicalJwk(payload.toKey);
      let rid: string | null = null;
      for (const [uid, jwk] of Object.entries(keysMap)) {
        if (jwk && canonicalJwk(jwk) === keyStr) { rid = uid; break; }
      }
      if (rid) recipientUser = { id: rid, nickname: '', publicKey: null };
    } else if (payload?.to) {
      recipientUser = await getUserByNickname(payload.to) || (await getAllUsers()).find(u => u.id === payload.to);
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
    const fileKey = payload?.fileKey && typeof payload.fileKey === 'object' ? payload.fileKey : undefined;
    const isSealed = !!payload?.sealed;
    const isEncrypted = !!payload?.encrypted;
    const isSignalEncrypted = !!payload?.signalEncrypted;
    const expiresAt = resolveExpiry(payload?.ttl, timestamp);
    const quoted = payload?.quoted && typeof payload.quoted === 'object' && typeof payload.quoted.sender === 'string'
      ? { id: String(payload.quoted.id || ''), text: sanitizeText(String(payload.quoted.text || '')).slice(0, 4096), sender: sanitizeText(payload.quoted.sender).slice(0, 64) }
      : null;

    const x3dhMessage = payload?.x3dhMessage && typeof payload.x3dhMessage === 'object' ? payload.x3dhMessage : null;
    const ratchetPublicKey = Array.isArray(payload?.ratchetPublicKey) ? payload.ratchetPublicKey : null;
    // the sender cannot decrypt its own ratchet ciphertext, so the client tags the message with an
    // id of its own and recognises the echo and the history entry by it
    const clientId = typeof payload?.clientId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(payload.clientId) ? payload.clientId : undefined;

    if (isSignalEncrypted) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, undefined, channelId, fileKey, undefined, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined, payload.signalEncrypted, x3dhMessage, ratchetPublicKey, clientId);
    } else if (isSealed) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, undefined, channelId, fileKey, payload.sealed, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined, undefined, undefined, undefined, clientId);
    } else if (isEncrypted) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, payload.encrypted, channelId, fileKey, undefined, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined, undefined, undefined, undefined, clientId);
    } else {
      send(ws, { type: 'error', payload: { code: 'ENCRYPTION_REQUIRED', message: 'Direct messages must be encrypted' }, timestamp: Date.now() });
      logSecurity('PLAINTEXT_DM_REJECTED', { from: senderId, to: recipientUser.id });
      return;
    }

    const dmPayload = {
      id: messageId,
      senderId,
      senderNickname: sender.nickname,
      senderAvatar: avatarInfo(await getProfileMeta(senderId)),
      text: '',
      encrypted: isEncrypted ? payload.encrypted : null,
      signalEncrypted: isSignalEncrypted ? payload.signalEncrypted : null,
      x3dhMessage,
      ratchetPublicKey,
      sealed: isSealed ? payload.sealed : null,
      timestamp,
      channel: channelId,
      fileKey,
      expiresAt,
      quotedMessageId: quoted?.id,
      quotedMessageText: quoted?.text,
      quotedMessageSender: quoted?.sender,
      clientId,
      reactions: await getReactionsForMessage(messageId),
    };
    for (const dev of recipientDevices) {
      send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: false }, timestamp });
    }
    send(ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: true }, timestamp });
    for (const dev of senderDevices) {
      if (dev.ws === ws || dev.ws.readyState !== WebSocket.OPEN) continue;
      send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: true }, timestamp });
    }
  }

function resolveExpiry(ttl: unknown, timestamp: number): number | undefined {
  if (typeof ttl !== 'number' || !DM_TTL_ALLOWED_MS[ttl]) return undefined;
  return timestamp + DM_TTL_ALLOWED_MS[ttl];
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

function b64ToBytes(b64: string): Buffer | null {
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Safety number в формате клиента (X3DH identity keys):
 * sort(self, peer) -> SHA-256 -> первые 24 байта -> 6 групп по 4 байта, upper-case.
 * Должен совпадать с generateX3dhSafetyNumber() на клиенте.
 */
function formatSafetyNumber(selfB64: string, peerB64: string | null): string | null {
  const self = b64ToBytes(selfB64);
  if (!self) return null;
  const peer = peerB64 ? b64ToBytes(peerB64) : null;
  const data = peer
    ? (Buffer.compare(self, peer) <= 0 ? Buffer.concat([self, peer]) : Buffer.concat([peer, self]))
    : self;
  const digest = crypto.createHash('sha256').update(data).digest();
  const groups: string[] = [];
  for (let i = 0; i < 24; i += 4) {
    groups.push(digest.subarray(i, i + 4).toString('hex').toUpperCase());
  }
  return groups.join(' ');
}

async function computeSafetyNumber(viewerId: string, targetId: string): Promise<string | null> {
  const selfId = await getIdentityKeyB64(viewerId);
  if (!selfId) return null;
  if (targetId === viewerId) return formatSafetyNumber(selfId, null);
  const peerId = await getIdentityKeyB64(targetId);
  if (!peerId) return null;
  return formatSafetyNumber(selfId, peerId);
}

   async function handleSealedSend(senderId: string, ws: WebSocket, payload: any): Promise<void> {
    await handleDmSend(senderId, ws, { ...payload, sealed: payload?.sealed || true });
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
      if (!target.channel || target.channel === 'general') {
        broadcast(message, actorUserId);
        for (const dev of devicesForUser(actorUserId)) send(dev.ws, message);
        return;
      }
      const parts = target.channel.split(':');
      for (const participantId of parts) {
        for (const dev of devicesForUser(participantId)) {
          if (dev.ws.readyState === WebSocket.OPEN) dev.ws.send(JSON.stringify(message));
        }
      }
    })();
  }

async function handleDmHistory(userId: string, ws: WebSocket, payload: { with: string }): Promise<void> {
    if (!payload?.with || typeof payload.with !== 'string') return;
    if (payload.with === userId) return;
    const channel = getDmChannelId(userId, payload.with);
    const parts = channel.split(':');
    if (parts.length !== 2 || (parts[0] !== userId && parts[1] !== userId)) return;
    const messages = await getDmHistory(userId, payload.with, 100);
    const publicKeys = await getPublicKeysByIds([userId, payload.with]);
    const userMeta = await buildAvatarInfoMap();
    send(ws, {
      type: 'dm_history',
      payload: {
        channel,
        with: payload.with,
        publicKeys,
        messages: await handleDmHistoryMessages(userId, messages, userMeta),
      },
      timestamp: Date.now(),
    });
  }

  
  async function handleDmHistoryMessages(userId: string, messages: any[], userMeta: Map<string, { avatarExt: string | null; avatarUpdatedAt: number | null }>): Promise<any[]> {
    const reactionsById = await getReactionsForMessages(messages.map((m) => m.id));
    return messages.map(m => ({
      id: m.id,
      senderId: m.senderId,
      senderNickname: m.senderNickname,
      senderAvatar: avatarInfo(userMeta.get(m.senderId)),
   text: m.text || '',
   encrypted: m.encrypted || null,
   signalEncrypted: m.signalEncrypted || null,
   x3dhMessage: m.x3dhMessage || null,
   ratchetPublicKey: m.ratchetPublicKey || null,
   sealed: m.sealed || null,
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
    const deleted = await deleteMessage(payload.messageId, userId);
    if (deleted) {
      send(ws, { type: 'message_deleted', payload: { messageId: payload.messageId }, timestamp: Date.now() });
      broadcast({ type: 'message_deleted', payload: { messageId: payload.messageId }, timestamp: Date.now() }, userId);
    } else {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
    }
  }

  async function handleEditMessage(userId: string, ws: WebSocket, payload: { messageId: string; text: string }): Promise<void> {
    if (!payload?.messageId || !payload?.text || typeof payload.text !== 'string') {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'messageId and text required' }, timestamp: Date.now() });
      return;
    }
    const text = sanitizeText(payload.text);
    if (!text || text.length > 4096) {
      send(ws, { type: 'error', payload: { code: 'MESSAGE_TOO_LONG', message: 'Message too long (max 4096 chars)' }, timestamp: Date.now() });
      return;
    }
    const target = await getMessageById(payload.messageId);
    if (!target || target.channel !== 'general' || target.encrypted) {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
      return;
    }
    const updated = await updateMessageText(payload.messageId, userId, text);
    if (updated) {
      const timestamp = Date.now();
      send(ws, { type: 'message_edited', payload: { messageId: payload.messageId, text, editedAt: timestamp }, timestamp });
      broadcast({ type: 'message_edited', payload: { messageId: payload.messageId, text, editedAt: timestamp }, timestamp: Date.now() }, userId);
    } else {
      send(ws, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Message not found or not yours' }, timestamp: Date.now() });
    }
  }

  async function handleAuthUpdateKey(userId: string, ws: WebSocket, payload: { publicKey: any }): Promise<void> {
    if (payload?.publicKey && isValidPublicKey(payload.publicKey)) {
      await updatePublicKey(userId, payload.publicKey);
      send(ws, { type: 'key_updated', payload: {}, timestamp: Date.now() });
      broadcast({ type: 'public_key_updated', payload: { userId, publicKey: payload.publicKey }, timestamp: Date.now() }, userId);
    }
  }

  async function handlePreKeyUpload(userId: string, ws: WebSocket, payload: { bundle: any }): Promise<void> {
    if (payload?.bundle && isValidPreKeyBundle(payload.bundle)) {
      await setPreKeyBundle(userId, payload.bundle);
      send(ws, { type: 'prekey_uploaded', payload: {}, timestamp: Date.now() });
    } else {
      logSecurity('PREKEY_REJECTED', { userId, ...preKeyBundleDiagnostics(payload?.bundle) });
    }
  }

  async function handlePreKeyFetch(userId: string, ws: WebSocket, payload: { userIds?: string[] }): Promise<void> {
    if (!payload?.userIds || !Array.isArray(payload.userIds) || payload.userIds.length === 0) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'userIds array required' }, timestamp: Date.now() });
      return;
    }
    const bundles: Record<string, any> = {};
    for (const id of payload.userIds.slice(0, 100)) {
      const bundle = await getPreKeyBundle(id);
      if (bundle) bundles[id] = bundle;
    }
    send(ws, { type: 'prekey_bundles', payload: { bundles }, timestamp: Date.now() });
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
    const safetyNumber = await computeSafetyNumber(userId, targetId);
    if (!safetyNumber && !isMe) {
      logSecurity('SAFETY_NUMBER_UNAVAILABLE', { viewer: userId, target: targetId, selfBundle: !!(await getIdentityKeyB64(userId)), peerBundle: !!(await getIdentityKeyB64(targetId)) });
    }
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
          safetyNumber,
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

  function handleDisconnect(deviceId: string | null, userId: string | null): void {
    if (!deviceId) return;

    const client = clients.get(deviceId);
    unregisterDevice(deviceId);

    if (client) {
      sessionLastActive(client.userId, deviceId, Date.now());
      void touchSession(client.userId, deviceId).catch(() => {});
      broadcast({ type: 'user_left', payload: { userId: client.userId, nickname: client.nickname }, timestamp: Date.now() });
    }
  }
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
    const ok = await setUserBannedByIdent(targetId, typeof payload?.nickname === 'string' ? payload.nickname : null, true);
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

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of authAttempts) {
      if (now > entry.resetAt) authAttempts.delete(ip);
    }
    for (const [ip, last] of lastMessageTime) {
      if (now - last > RATE_LIMIT_WINDOW) lastMessageTime.delete(ip);
    }
    for (const [key, entry] of failedLogins) {
      if (entry.lockedUntil > 0 && now > entry.lockedUntil) failedLogins.delete(key);
    }
   for (const [uid, last] of lastAvatarChange) {
   if (now - last > AVATAR_CHANGE_INTERVAL_MS) lastAvatarChange.delete(uid);
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
