import { WebSocket } from 'ws';
import { getUserByNickname, saveMessage, getRecentMessages, getMessageById, createUser, getAllPublicKeys, getPublicKeysByIds, getDmChannelId, getDmHistory, getDmContacts, deleteGeneralMessages, getAllUsers, updatePublicKey, setPreKeyBundle, getPreKeyBundle, getAllPreKeyBundles, getKeyBackup, saveKeyBackup, searchMessages, deleteMessage, addReaction, removeReaction, getReactionsForMessage, updateMessageText, cleanupExpiredPreKeys, cleanupExpiredMessages, startCleanupJobs, getUserBanned, getBlockedUserIds, setUserBlocked, setUserBannedByIdent, getUserById, addReport, getReports } from './database.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { appendFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nextMondayMidnightMSK } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../data');
const SECURITY_LOG = path.join(LOG_DIR, 'security.log');

function logSecurity(event: string, details: Record<string, any>) {
  const entry = `[${new Date().toISOString()}] ${event} ${JSON.stringify(details)}\n`;
  try {
    appendFileSync(SECURITY_LOG, entry);
  } catch (e) {
    console.error('Failed to write security log:', e);
  }
}

export interface ConnectedClient {
  deviceId: string;
  ws: WebSocket;
  userId: string;
  nickname: string;
  lastHeartbeat: number;
  ip: string;
}

// Keyed by deviceId: a single user account may have several connected devices.
const clients = new Map<string, ConnectedClient>();
// userId -> set of currently connected deviceIds (used for fan-out delivery + online status).
const userDevices = new Map<string, Set<string>>();
let totalConnections = 0;

// All connected devices that belong to a given user.
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

// Register (or reconnect) a device. Replaces any prior socket for the same deviceId.
function registerDevice(deviceId: string, client: ConnectedClient): void {
  const prev = clients.get(deviceId);
  if (prev && prev.ws !== client.ws) {
    try { prev.ws.close(4001, 'Reconnected from another socket'); } catch {}
  }
  clients.set(deviceId, client);
  if (!userDevices.has(client.userId)) userDevices.set(client.userId, new Set());
  userDevices.get(client.userId)!.add(deviceId);
}

// Remove a device from the connection tables (called on disconnect / revoke).
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

const HEARTBEAT_INTERVAL = 15000;
const CLIENT_TIMEOUT = 90000;

const RATE_LIMIT_WINDOW = 60000;
const MAX_AUTH_ATTEMPTS = 5;
const MIN_MESSAGE_INTERVAL = 1000;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_FAILED_LOGINS = 5;
const ACCOUNT_LOCKOUT_DURATION = 300000;
const MAX_WS_PAYLOAD_SIZE = 65536;

const authAttempts = new Map<string, { count: number; resetAt: number }>();
const lastMessageTime = new Map<string, number>();
const connectionCounts = new Map<string, number>();
const failedLogins = new Map<string, { count: number; lockedUntil: number }>();

interface ServerMessage {
  type: string;
  payload: any;
  timestamp: number;
}

interface ClientMessage {
  type: string;
  payload: any;
}

function getClientIp(ws: WebSocket): string {
  const req = (ws as any).req;
  const socketIp = req?.socket?.remoteAddress || (ws as any)._socket?.remoteAddress;
  if (!socketIp) return 'unknown';
  return socketIp.replace(/^::ffff:/, '');
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

function checkAuthRateLimit(ip: string): boolean {
  if (RATE_LIMITS_DISABLED) return true;
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= MAX_AUTH_ATTEMPTS) return false;
  entry.count++;
  return true;
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

function isValidPreKeyBundle(bundle: any): boolean {
  if (typeof bundle !== 'object' || bundle === null) return false;
  const MAX_BUNDLE_SIZE = 10000;
  const str = JSON.stringify(bundle);
  if (str.length > MAX_BUNDLE_SIZE) return false;
  if (hasUnsafeOwnKeys(bundle)) return false;
  if (typeof bundle.identityKey !== 'string') return false;
  if (typeof bundle.ed25519PublicKey !== 'string') return false;
  if (typeof bundle.signedPreKey !== 'object' || bundle.signedPreKey === null) return false;
  if (hasUnsafeOwnKeys(bundle.signedPreKey)) return false;
  if (typeof bundle.signedPreKey.publicKey !== 'string') return false;
  if (!Array.isArray(bundle.signedPreKey.signature)) return false;
  if (bundle.oneTimePreKey && typeof bundle.oneTimePreKey !== 'object') return false;
  if (typeof bundle.bundleVersion !== 'number' || bundle.bundleVersion < 1) return false;
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

export function handleConnection(ws: WebSocket): void {
  let currentUserId: string | null = null;
  let currentDeviceId: string | null = null;
  const ip = getClientIp(ws);
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
      const message: ClientMessage = { type: sanitize(parsed.type), payload: parsed.payload };
      handleMessage(ws, currentUserId, message).catch((err) => {
        console.error('Handler error:', err);
        send(ws, { type: 'error', payload: { code: 'INTERNAL', message: 'Internal server error' }, timestamp: Date.now() });
      });
    } catch {
      send(ws, { type: 'error', payload: { code: 'INVALID_JSON', message: 'Invalid JSON' }, timestamp: Date.now() });
    }
  });

  ws.on('close', () => {
    handleDisconnect(currentDeviceId, currentUserId);
    releaseConnection(ip);
  });
  ws.on('error', () => {
    handleDisconnect(currentDeviceId, currentUserId);
    releaseConnection(ip);
  });

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
        if (userId) await handleAdminBan(ws, message.payload);
        break;
      case 'admin_unban':
        if (userId) await handleAdminUnban(ws, message.payload);
        break;
      case 'admin_reports':
        if (userId) await handleAdminReports(ws, message.payload);
        break;
      default:
        send(ws, { type: 'error', payload: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' }, timestamp: Date.now() });
    }
  }

  async function handleAuthLogin(ws: WebSocket, payload: { nickname: string; password: string; preKeyBundle?: any; deviceId?: string }): Promise<void> {
    if (!checkAuthRateLimit(ip)) {
      logSecurity('RATE_LIMIT_AUTH', { ip });
      send(ws, { type: 'auth_failure', payload: { reason: 'Too many attempts. Try again in 1 minute.' }, timestamp: Date.now() });
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
    const lockEntry = failedLogins.get(lockKey);
    if (lockEntry && lockEntry.lockedUntil > Date.now()) {
      const remaining = Math.ceil((lockEntry.lockedUntil - Date.now()) / 60000);
      logSecurity('LOGIN_LOCKED', { nickname: cleanNick, ip, remainingMin: remaining });
      send(ws, { type: 'auth_failure', payload: { reason: `Account locked. Try again in ${remaining} minute(s).` }, timestamp: Date.now() });
      return;
    }

    const user = await getUserByNickname(cleanNick);
    if (!user || typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
      const newCount = lockEntry ? lockEntry.count + 1 : 1;
      const lockedUntil = newCount >= MAX_FAILED_LOGINS ? Date.now() + ACCOUNT_LOCKOUT_DURATION : 0;

      if (lockEntry) {
        lockEntry.count = newCount;
        lockEntry.lockedUntil = lockedUntil;
      } else {
        failedLogins.set(lockKey, { count: newCount, lockedUntil });
      }

      logSecurity('LOGIN_FAILED', { nickname: cleanNick, ip, attempts: newCount, locked: lockedUntil > 0 });
      send(ws, { type: 'auth_failure', payload: { reason: 'Invalid nickname or password' }, timestamp: Date.now() });
      return;
    }

    logSecurity('LOGIN_SUCCESS', { nickname: cleanNick, ip });
    failedLogins.delete(lockKey);

    if (await getUserBanned(user.id)) {
      logSecurity('LOGIN_BANNED', { nickname: cleanNick, ip });
      send(ws, { type: 'auth_failure', payload: { reason: 'Account banned' }, timestamp: Date.now() });
      return;
    }

    const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
      ? payload.deviceId : crypto.randomUUID();
    currentUserId = user.id;
    currentDeviceId = deviceId;
    registerDevice(deviceId, { deviceId, ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip });

    if (payload.preKeyBundle && isValidPreKeyBundle(payload.preKeyBundle)) {
      await setPreKeyBundle(user.id, payload.preKeyBundle);
    }

    await onAuthenticated(user.id, user.nickname, ws, deviceId);
  }

  async function handleAuthRegister(ws: WebSocket, payload: { nickname: string; password: string; publicKey?: any; preKeyBundle?: any; deviceId?: string }): Promise<void> {
    if (!checkAuthRateLimit(ip)) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Too many attempts. Try again in 1 minute.' }, timestamp: Date.now() });
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

    if (payload.preKeyBundle && isValidPreKeyBundle(payload.preKeyBundle)) {
      await setPreKeyBundle(user.id, payload.preKeyBundle);
    }

    const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.length > 0 && payload.deviceId.length <= 64
      ? payload.deviceId : crypto.randomUUID();
    currentUserId = user.id;
    currentDeviceId = deviceId;
    registerDevice(deviceId, { deviceId, ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip });

    await onAuthenticated(user.id, user.nickname, ws, deviceId);
  }

  async function onAuthenticated(userId: string, nickname: string, ws: WebSocket, deviceId?: string): Promise<void> {
    const publicKeys = await getAllPublicKeys();

    const seen = new Set<string>();
    const onlineUsers: { id: string; nickname: string }[] = [];
    for (const c of clients.values()) {
      if (!seen.has(c.userId)) { seen.add(c.userId); onlineUsers.push({ id: c.userId, nickname: c.nickname }); }
    }

    send(ws, { type: 'auth_success', payload: { userId, nickname, deviceId, publicKeys, preKeyBundles: {}, onlineUsers }, timestamp: Date.now() });

    const history = await getRecentMessages(100);
    send(ws, {
      type: 'chat_history',
      payload: {
        channel: 'general',
        messages: history.map(m => ({
          id: m.id,
          senderId: m.senderId,
          senderNickname: m.senderNickname,
          text: m.text,
          encrypted: m.encrypted || null,
          timestamp: m.timestamp,
          isOwn: m.senderId === userId,
          fileKey: m.fileKey || null,
          expiresAt: m.expiresAt || null,
        })),
      },
      timestamp: Date.now(),
    });

    broadcast({ type: 'user_joined', payload: { userId, nickname }, timestamp: Date.now() }, userId);
    broadcastSystem(`${nickname} joined the chat`, userId);
  }

  // --- Cross-device key backup (A+C) ---
  // The client encrypts its private key bundle with a password-derived key and
  // uploads only the ciphertext. The server never sees the plaintext key.
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
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Max 1 message per second.' }, timestamp: Date.now() });
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
      text,
      timestamp,
      isOwn: false,
      fileKey,
      expiresAt,
      quotedMessageId: quoted?.id,
      quotedMessageText: quoted?.text,
      quotedMessageSender: quoted?.sender,
    };

    broadcast({ type: 'chat_message', payload: { ...messagePayload, channel: 'general' }, timestamp }, senderId);
    send(ws, { type: 'chat_message', payload: { ...messagePayload, isOwn: true, channel: 'general' }, timestamp });
  }

    async function handleDmSend(senderId: string, ws: WebSocket, payload: { to?: string; toKey?: any; text: string; encrypted?: any; signalEncrypted?: any; fileKey?: Record<string, string>; sealed?: string; ttl?: number; reaction?: { messageId: string; userId: string; emoji: string }; quoted?: { id?: string; text?: string; sender?: string } }): Promise<void> {
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

    // Resolve the recipient. When `toKey` (the recipient's public key) is present we route
    // by public key instead of by username/userId, so a network observer of the WS stream
    // cannot see who a direct message is addressed to (sealed-sender style metadata hiding).
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

    // Blocking: a direct message is only delivered when neither party has blocked the other.
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

    if (payload?.reaction && typeof payload.reaction === 'object') {
      const { messageId, userId, emoji } = payload.reaction;
      await addReaction(messageId, userId, emoji);
      const reactions = await getReactionsForMessage(messageId);
      broadcast({ type: 'reaction_update', payload: { messageId, reactions, userId }, timestamp: Date.now() }, userId);
      for (const dev of recipientDevices) send(dev.ws, { type: 'reaction_update', payload: { messageId, reactions, userId }, timestamp: Date.now() });
      return;
    }

    if (isSignalEncrypted) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, undefined, channelId, fileKey, undefined, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined);
    } else if (isSealed) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, undefined, channelId, fileKey, payload.sealed, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined);
    } else if (isEncrypted) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, payload.encrypted, channelId, fileKey, undefined, quoted ? quoted.id : undefined, undefined, expiresAt, quoted ? quoted.text : undefined, quoted ? quoted.sender : undefined);
    } else {
      send(ws, { type: 'error', payload: { code: 'ENCRYPTION_REQUIRED', message: 'Direct messages must be encrypted' }, timestamp: Date.now() });
      logSecurity('PLAINTEXT_DM_REJECTED', { from: senderId, to: recipientUser.id });
      return;
    }

    const dmPayload = {
      id: messageId,
      senderId,
      senderNickname: sender.nickname,
      text: '',
      encrypted: isEncrypted ? payload.encrypted : null,
      signalEncrypted: isSignalEncrypted ? payload.signalEncrypted : null,
      sealed: isSealed ? payload.sealed : null,
      timestamp,
      channel: channelId,
      fileKey,
      expiresAt,
      quotedMessageId: quoted?.id,
      quotedMessageText: quoted?.text,
      quotedMessageSender: quoted?.sender,
    };
    for (const dev of recipientDevices) {
      send(dev.ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: false }, timestamp });
    }
    send(ws, { type: 'dm_message', payload: { ...dmPayload, isOwn: true }, timestamp });
  }

const ALLOWED_TTL_MS: Record<number, number> = {
  86400: 24 * 60 * 60 * 1000,
  604800: 7 * 24 * 60 * 60 * 1000,
  2592000: 30 * 24 * 60 * 60 * 1000,
};

function resolveExpiry(ttl: unknown, timestamp: number): number | undefined {
  if (typeof ttl !== 'number' || !ALLOWED_TTL_MS[ttl]) return undefined;
  return timestamp + ALLOWED_TTL_MS[ttl];
}

function isValidEmoji(emoji: unknown): emoji is string {
  return typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 16
    && /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F]/u.test(emoji);
}

// Stable string form of a JWK (key order independent) for public-key based routing lookups.
function canonicalJwk(jwk: any): string {
  const sorted: Record<string, any> = {};
  for (const k of Object.keys(jwk || {}).sort()) sorted[k] = jwk[k];
  return JSON.stringify(sorted);
}

   async function handleSealedSend(senderId: string, ws: WebSocket, payload: any): Promise<void> {
    await handleDmSend(senderId, ws, { ...payload, sealed: payload?.sealed || true });
  }

  async function handleAddReaction(userId: string, ws: WebSocket, payload: { messageId: string; emoji: string }): Promise<void> {
    if (!payload?.messageId || typeof payload.messageId !== 'string') return;
    if (!isValidEmoji(payload.emoji)) return;
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
    await removeReaction(payload.messageId, userId, payload.emoji);
    const reactions = await getReactionsForMessage(payload.messageId);
    broadcastToMessageAudience(payload.messageId, userId, {
      type: 'reaction_update',
      payload: { messageId: payload.messageId, emoji: payload.emoji, userId, action: 'remove', reactions },
      timestamp: Date.now(),
    });
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
    send(ws, {
      type: 'dm_history',
      payload: {
        channel,
        with: payload.with,
        publicKeys,
        messages: messages.map(m => ({
          id: m.id,
          senderId: m.senderId,
          senderNickname: m.senderNickname,
          text: m.text || '',
          encrypted: m.encrypted || null,
          sealed: m.sealed || null,
          timestamp: m.timestamp,
          isOwn: m.senderId === userId,
          fileKey: m.fileKey || null,
          expiresAt: m.expiresAt || null,
        })),
      },
      timestamp: Date.now(),
    });
  }

  async function handleDmContacts(userId: string, ws: WebSocket): Promise<void> {
    const contacts = await getDmContacts(userId);
    const publicKeys = await getPublicKeysByIds([userId, ...contacts.map(c => c.id)]);
    const onlineIds = new Set(userDevices.keys());
    const contactsWithOnline = contacts.map(c => ({ ...c, online: onlineIds.has(c.id) }));
    send(ws, { type: 'dm_contacts', payload: { contacts: contactsWithOnline, publicKeys }, timestamp: Date.now() });
  }

  async function handleSearchUsers(userId: string, ws: WebSocket, payload: { query: string }): Promise<void> {
    const query = sanitize(payload?.query || '').toLowerCase();
    if (query.length < 1) {
      send(ws, { type: 'search_results', payload: { results: [] }, timestamp: Date.now() });
      return;
    }
    const allUsers = await getAllUsers();
    const users = allUsers.filter((u: { id: string; nickname: string }) => u.id !== userId);
    const onlineIds = new Set(userDevices.keys());
    const results = users
      .filter((u: { id: string; nickname: string }) => u.nickname.toLowerCase().includes(query))
      .slice(0, 20)
      .map((u: { id: string; nickname: string }) => ({ id: u.id, nickname: u.nickname, online: onlineIds.has(u.id) }));
    send(ws, { type: 'search_results', payload: { results }, timestamp: Date.now() });
  }

  async function handleSearchMessages(userId: string, ws: WebSocket, payload: { query: string; channel?: string }): Promise<void> {
    const query = sanitize(payload?.query || '');
    if (query.length < 2) {
      send(ws, { type: 'message_search_results', payload: { results: [] }, timestamp: Date.now() });
      return;
    }
    const results = await searchMessages(query, payload.channel, 50, userId);
    send(ws, { type: 'message_search_results', payload: { results }, timestamp: Date.now() });
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

  function handleDisconnect(deviceId: string | null, userId: string | null): void {
    if (!deviceId) return;

    const client = clients.get(deviceId);
    unregisterDevice(deviceId);

    if (client) {
      broadcast({ type: 'user_left', payload: { userId: client.userId, nickname: client.nickname }, timestamp: Date.now() });
      broadcastSystem(`${client.nickname} left the chat`);
    }
  }
}

function broadcastSystem(text: string, excludeUserId?: string): void {
  broadcast({ type: 'system_message', payload: { text }, timestamp: Date.now() }, excludeUserId);
}

  function handleGetSessions(userId: string, ws: WebSocket, currentDeviceId: string | null): void {
    const sessions: { id: string; nickname: string; lastActive: number; current: boolean }[] = [];
    for (const [deviceId, client] of clients) {
      if (client.userId === userId) {
        sessions.push({ id: deviceId, nickname: client.nickname, lastActive: client.lastHeartbeat, current: deviceId === currentDeviceId });
      }
    }
    send(ws, { type: 'sessions_list', payload: { sessions }, timestamp: Date.now() });
  }

  function handleRevokeSession(userId: string, ws: WebSocket, payload: { sessionId?: string }, currentDeviceId: string | null): void {
    const targetId = payload?.sessionId || currentDeviceId;
    if (!targetId) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Missing session id' }, timestamp: Date.now() });
      return;
    }
    const target = clients.get(targetId);
    if (!target) {
      send(ws, { type: 'error', payload: { code: 'SESSION_NOT_FOUND', message: 'Session not found' }, timestamp: Date.now() });
      return;
    }
    if (target.userId !== userId) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Can only revoke your own sessions' }, timestamp: Date.now() });
      return;
    }
    target.ws.close(4001, 'Session revoked');
    unregisterDevice(targetId);
    send(ws, { type: 'session_revoked', payload: { sessionId: targetId }, timestamp: Date.now() });
  }

  // --- Blocking (user-level privacy) ---

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

  // --- Reporting + admin moderation ---

  const ADMIN_KEY = process.env.ADMIN_KEY || '';

  function adminAuthorized(ws: WebSocket, payload: { key?: string }): boolean {
    if (!ADMIN_KEY) return false;
    return typeof payload?.key === 'string' && payload.key === ADMIN_KEY;
  }

  async function handleReportUser(userId: string, ws: WebSocket, payload: { targetId?: string; messageId?: string; reason?: string }): Promise<void> {
    const targetId = typeof payload?.targetId === 'string' ? payload.targetId : '';
    const reason = typeof payload?.reason === 'string' ? sanitizeText(payload.reason).slice(0, 500) : '';
    if (!targetId || targetId === userId || !reason) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Invalid report' }, timestamp: Date.now() });
      return;
    }
    const reporter = clients.get([...userDevices.get(userId) || []][0] || '') || null;
    const reporterNick = reporter ? reporter.nickname : 'unknown';
    await addReport({
      id: crypto.randomUUID(),
      reporterId: userId,
      reporterNick,
      targetId,
      channel: 'dm',
      messageId: typeof payload?.messageId === 'string' ? payload.messageId : undefined,
      reason,
      timestamp: Date.now(),
    });
    send(ws, { type: 'report_received', payload: { ok: true }, timestamp: Date.now() });
  }

  async function handleAdminBan(ws: WebSocket, payload: { key?: string; userId?: string; nickname?: string }): Promise<void> {
    if (!adminAuthorized(ws, payload)) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const ok = await setUserBannedByIdent(typeof payload?.userId === 'string' ? payload.userId : null, typeof payload?.nickname === 'string' ? payload.nickname : null, true);
    if (!ok) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    logSecurity('ADMIN_BAN', { admin: '', target: payload?.userId || payload?.nickname });
    // Force-disconnect any online devices of the banned user.
    const targetId = payload?.userId || (payload?.nickname ? (await getUserByNickname(payload.nickname))?.id : null);
    if (targetId) {
      for (const c of devicesForUser(targetId)) {
        c.ws.close(4003, 'Account banned');
      }
      for (const id of [...(userDevices.get(targetId) || [])]) unregisterDevice(id);
    }
    send(ws, { type: 'admin_action', payload: { ok: true, action: 'ban' }, timestamp: Date.now() });
  }

  async function handleAdminUnban(ws: WebSocket, payload: { key?: string; userId?: string; nickname?: string }): Promise<void> {
    if (!adminAuthorized(ws, payload)) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const ok = await setUserBannedByIdent(typeof payload?.userId === 'string' ? payload.userId : null, typeof payload?.nickname === 'string' ? payload.nickname : null, false);
    if (!ok) {
      send(ws, { type: 'error', payload: { code: 'USER_NOT_FOUND', message: 'User not found' }, timestamp: Date.now() });
      return;
    }
    logSecurity('ADMIN_UNBAN', { admin: '', target: payload?.userId || payload?.nickname });
    send(ws, { type: 'admin_action', payload: { ok: true, action: 'unban' }, timestamp: Date.now() });
  }

  async function handleAdminReports(ws: WebSocket, payload: { key?: string }): Promise<void> {
    if (!adminAuthorized(ws, payload)) {
      send(ws, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Unauthorized' }, timestamp: Date.now() });
      return;
    }
    const reports = await getReports();
    send(ws, { type: 'admin_reports', payload: { reports }, timestamp: Date.now() });
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
