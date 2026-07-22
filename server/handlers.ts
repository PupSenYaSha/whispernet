import { WebSocket } from 'ws';
import { getUserByNickname, saveMessage, getRecentMessages, createUser, getAllPublicKeys, getPublicKeysByIds, getDmChannelId, getDmHistory, getDmContacts, deleteGeneralMessages, getAllUsers, updatePublicKey, setPreKeyBundle, getPreKeyBundle, getAllPreKeyBundles } from './database.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { appendFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  ws: WebSocket;
  userId: string;
  nickname: string;
  lastHeartbeat: number;
  ip: string;
}

const clients = new Map<string, ConnectedClient>();
let totalConnections = 0;

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
  const req = (ws as any).req || (ws as any)._socket?.remoteAddress || 'unknown';
  if (typeof req === 'string' && req.includes('::ffff:')) return req.split('::ffff:')[1] || req;
  return String(req);
}

function checkMessageRateLimit(ip: string): boolean {
  const now = Date.now();
  const last = lastMessageTime.get(ip) || 0;
  if (now - last < MIN_MESSAGE_INTERVAL) return false;
  lastMessageTime.set(ip, now);
  return true;
}

function checkAuthRateLimit(ip: string): boolean {
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

function isValidNickname(nick: string): boolean {
  return /^[a-zA-Z0-9_-]{3,16}$/.test(nick);
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
    handleDisconnect(currentUserId);
    releaseConnection(ip);
  });
  ws.on('error', () => {
    handleDisconnect(currentUserId);
    releaseConnection(ip);
  });

  ws.on('pong', () => {
    if (currentUserId) {
      const client = clients.get(currentUserId);
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
      case 'dm_history':
        if (userId) await handleDmHistory(userId, ws, message.payload);
        break;
      case 'dm_contacts':
        if (userId) await handleDmContacts(userId, ws);
        break;
      case 'search_users':
        if (userId) await handleSearchUsers(userId, ws, message.payload);
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
        if (userId) {
          const client = clients.get(userId);
          if (client) client.lastHeartbeat = Date.now();
          send(ws, { type: 'heartbeat_ack', payload: {}, timestamp: Date.now() });
        }
        break;
      case 'get_sessions':
        if (userId) handleGetSessions(userId, ws);
        break;
      case 'revoke_session':
        if (userId) handleRevokeSession(userId, ws, message.payload);
        break;
      default:
        send(ws, { type: 'error', payload: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' }, timestamp: Date.now() });
    }
  }

  async function handleAuthLogin(ws: WebSocket, payload: { nickname: string; password: string; preKeyBundle?: any }): Promise<void> {
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

    const existingClient = clients.get(user.id);
    if (existingClient && existingClient.ws !== ws) {
      existingClient.ws.close(4001, 'Logged in from another device');
      clients.delete(user.id);
      logSecurity('SESSION_KICKED', { nickname: cleanNick, ip, oldIp: existingClient.ip });
    }

    currentUserId = user.id;
    const client: ConnectedClient = { ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip };
    clients.set(user.id, client);

    if (payload.preKeyBundle && typeof payload.preKeyBundle === 'object') {
      await setPreKeyBundle(user.id, payload.preKeyBundle);
    }

    await onAuthenticated(user.id, user.nickname, ws);
  }

  async function handleAuthRegister(ws: WebSocket, payload: { nickname: string; password: string; publicKey?: any; preKeyBundle?: any }): Promise<void> {
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

    if (payload.publicKey && (typeof payload.publicKey !== 'object' || payload.publicKey.kty !== 'RSA' || (payload.publicKey.alg !== 'RSA-OAEP' && payload.publicKey.alg !== 'RSA-OAEP-256'))) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Invalid public key' }, timestamp: Date.now() });
      return;
    }

    const user = await createUser(cleanNick, cleanPass, payload.publicKey);
    if (!user) {
      send(ws, { type: 'auth_failure', payload: { reason: 'Nickname already taken' }, timestamp: Date.now() });
      return;
    }

    if (payload.preKeyBundle && typeof payload.preKeyBundle === 'object') {
      await setPreKeyBundle(user.id, payload.preKeyBundle);
    }

    currentUserId = user.id;
    const client: ConnectedClient = { ws, userId: user.id, nickname: user.nickname, lastHeartbeat: Date.now(), ip };
    clients.set(user.id, client);

    await onAuthenticated(user.id, user.nickname, ws);
  }

  async function onAuthenticated(userId: string, nickname: string, ws: WebSocket): Promise<void> {
    const publicKeys = await getAllPublicKeys();
    const preKeyBundles = await getAllPreKeyBundles();

    const onlineUsers = Array.from(clients.values()).map(c => ({ id: c.userId, nickname: c.nickname }));

    send(ws, { type: 'auth_success', payload: { userId, nickname, publicKeys, preKeyBundles, onlineUsers }, timestamp: Date.now() });

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
        })),
      },
      timestamp: Date.now(),
    });

    broadcast({ type: 'user_joined', payload: { userId, nickname }, timestamp: Date.now() }, userId);
    broadcastSystem(`${nickname} joined the chat`, userId);
  }

  async function handleChatMessage(senderId: string, ws: WebSocket, payload: { text: string; fileKey?: Record<string, string> }): Promise<void> {
    if (!checkMessageRateLimit(ip)) {
      logSecurity('RATE_LIMIT_MESSAGE', { ip, senderId });
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down. Max 1 message per second.' }, timestamp: Date.now() });
      return;
    }

    const sender = clients.get(senderId);
    if (!sender) return;

    const text = typeof payload?.text === 'string' ? sanitize(payload.text) : '';
    if (!text) return;
    if (text.length > 4096) {
      send(ws, { type: 'error', payload: { code: 'MESSAGE_TOO_LONG', message: 'Message too long (max 4096 chars)' }, timestamp: Date.now() });
      return;
    }

    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    const fileKey = payload?.fileKey && typeof payload.fileKey === 'object' ? payload.fileKey : undefined;
    await saveMessage(messageId, senderId, sender.nickname, text, timestamp, undefined, 'general', fileKey);

    const messagePayload = {
      id: messageId,
      senderId,
      senderNickname: sender.nickname,
      text,
      timestamp,
      isOwn: false,
      fileKey,
    };

    broadcast({ type: 'chat_message', payload: { ...messagePayload, channel: 'general' }, timestamp }, senderId);
    send(ws, { type: 'chat_message', payload: { ...messagePayload, isOwn: true, channel: 'general' }, timestamp });
  }

  async function handleDmSend(senderId: string, ws: WebSocket, payload: { to: string; text: string; encrypted?: any; signalEncrypted?: any; fileKey?: Record<string, string>; sealed?: string }): Promise<void> {
    if (!checkMessageRateLimit(ip)) {
      send(ws, { type: 'error', payload: { code: 'RATE_LIMITED', message: 'Slow down.' }, timestamp: Date.now() });
      return;
    }

    const sender = clients.get(senderId);
    if (!sender) return;
    if (!payload?.to || typeof payload.to !== 'string' || payload.to === senderId) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Missing recipient' }, timestamp: Date.now() });
      return;
    }

    const recipientUser = await getUserByNickname(payload.to) || (await getAllUsers()).find(u => u.id === payload.to);
    if (!recipientUser) {
      send(ws, { type: 'error', payload: { code: 'INVALID_PAYLOAD', message: 'Recipient not found' }, timestamp: Date.now() });
      return;
    }

    const recipient = clients.get(recipientUser.id);

    const channelId = getDmChannelId(senderId, recipientUser.id);
    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    const fileKey = payload?.fileKey && typeof payload.fileKey === 'object' ? payload.fileKey : undefined;
    const isSealed = !!payload?.sealed;
    const isEncrypted = !!payload?.encrypted;
    const isSignalEncrypted = !!payload?.signalEncrypted;

    if (isSignalEncrypted) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, undefined, channelId, fileKey);
    } else if (isSealed) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, undefined, channelId, fileKey, payload.sealed);
    } else if (isEncrypted) {
      await saveMessage(messageId, senderId, sender.nickname, '', timestamp, payload.encrypted, channelId, fileKey);
    } else {
      const text = sanitize(payload.text || '');
      if (!text) return;
      if (text.length > 4096) {
        send(ws, { type: 'error', payload: { code: 'MESSAGE_TOO_LONG', message: 'Message too long' }, timestamp: Date.now() });
        return;
      }
      await saveMessage(messageId, senderId, sender.nickname, text, timestamp, undefined, channelId, fileKey);
    }

    if (recipient) {
      send(recipient.ws, { type: 'dm_message', payload: {
        id: messageId, senderId, senderNickname: sender.nickname,
        text: '',
        encrypted: isEncrypted ? payload.encrypted : null,
        signalEncrypted: isSignalEncrypted ? payload.signalEncrypted : null,
        sealed: isSealed ? payload.sealed : null,
        timestamp, isOwn: false, channel: channelId, fileKey,
      }, timestamp });
    }
    send(ws, { type: 'dm_message', payload: {
      id: messageId, senderId, senderNickname: sender.nickname,
      text: '',
      encrypted: isEncrypted ? payload.encrypted : null,
      signalEncrypted: isSignalEncrypted ? payload.signalEncrypted : null,
      sealed: isSealed ? payload.sealed : null,
      timestamp, isOwn: true, channel: channelId, fileKey,
    }, timestamp });
  }

  async function handleDmHistory(userId: string, ws: WebSocket, payload: { with: string }): Promise<void> {
    if (!payload?.with || typeof payload.with !== 'string') return;
    if (payload.with === userId) return;
    const channel = getDmChannelId(userId, payload.with);
    const parts = channel.split(':');
    if (parts.length !== 2 || (parts[0] !== userId && parts[1] !== userId)) return;
    const messages = await getDmHistory(userId, payload.with, 100);
    const publicKeys = await getAllPublicKeys();
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
        })),
      },
      timestamp: Date.now(),
    });
  }

  async function handleDmContacts(userId: string, ws: WebSocket): Promise<void> {
    const contacts = await getDmContacts(userId);
    const publicKeys = await getAllPublicKeys();
    const onlineIds = new Set(Array.from(clients.keys()));
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
    const onlineIds = new Set(Array.from(clients.keys()));
    const results = users
      .filter((u: { id: string; nickname: string }) => u.nickname.toLowerCase().includes(query))
      .slice(0, 20)
      .map((u: { id: string; nickname: string }) => ({ id: u.id, nickname: u.nickname, online: onlineIds.has(u.id) }));
    send(ws, { type: 'search_results', payload: { results }, timestamp: Date.now() });
  }

  async function handleAuthUpdateKey(userId: string, ws: WebSocket, payload: { publicKey: any }): Promise<void> {
    if (payload?.publicKey && typeof payload.publicKey === 'object' && payload.publicKey.kty === 'RSA' && (payload.publicKey.alg === 'RSA-OAEP' || payload.publicKey.alg === 'RSA-OAEP-256')) {
      await updatePublicKey(userId, payload.publicKey);
      send(ws, { type: 'key_updated', payload: {}, timestamp: Date.now() });
      broadcast({ type: 'public_key_updated', payload: { userId, publicKey: payload.publicKey }, timestamp: Date.now() }, userId);
    }
  }

  async function handlePreKeyUpload(userId: string, ws: WebSocket, payload: { bundle: any }): Promise<void> {
    if (payload?.bundle && typeof payload.bundle === 'object') {
      await setPreKeyBundle(userId, payload.bundle);
      send(ws, { type: 'prekey_uploaded', payload: {}, timestamp: Date.now() });
    }
  }

  async function handlePreKeyFetch(userId: string, ws: WebSocket, payload: { userIds?: string[] }): Promise<void> {
    if (payload?.userIds && Array.isArray(payload.userIds)) {
      const bundles: Record<string, any> = {};
      for (const id of payload.userIds.slice(0, 100)) {
        const bundle = await getPreKeyBundle(id);
        if (bundle) bundles[id] = bundle;
      }
      send(ws, { type: 'prekey_bundles', payload: { bundles }, timestamp: Date.now() });
    } else {
      const allBundles = await getAllPreKeyBundles();
      send(ws, { type: 'prekey_bundles', payload: { bundles: allBundles }, timestamp: Date.now() });
    }
  }

  function handleDisconnect(userId: string | null): void {
    if (!userId) return;

    const client = clients.get(userId);
    if (!client) return;

    clients.delete(userId);

    broadcast({ type: 'user_left', payload: { userId, nickname: client.nickname }, timestamp: Date.now() });
    broadcastSystem(`${client.nickname} left the chat`);
  }
}

function broadcastSystem(text: string, excludeUserId?: string): void {
  broadcast({ type: 'system_message', payload: { text }, timestamp: Date.now() }, excludeUserId);
}

function handleGetSessions(userId: string, ws: WebSocket): void {
  const sessions: { id: string; nickname: string; ip: string; lastActive: number; current: boolean }[] = [];
  for (const [uid, client] of clients) {
    sessions.push({ id: uid, nickname: client.nickname, ip: client.ip, lastActive: client.lastHeartbeat, current: uid === userId });
  }
  send(ws, { type: 'sessions_list', payload: { sessions }, timestamp: Date.now() });
}

function handleRevokeSession(userId: string, ws: WebSocket, payload: { sessionId?: string }): void {
  const targetId = payload?.sessionId || userId;
  if (targetId === userId) {
    send(ws, { type: 'error', payload: { code: 'CANNOT_REVOKE_SELF', message: 'Cannot revoke your own session' }, timestamp: Date.now() });
    return;
  }
  const target = clients.get(targetId);
  if (target) {
    target.ws.close(4001, 'Session revoked');
    clients.delete(targetId);
    send(ws, { type: 'session_revoked', payload: { sessionId: targetId }, timestamp: Date.now() });
  } else {
    send(ws, { type: 'error', payload: { code: 'SESSION_NOT_FOUND', message: 'Session not found' }, timestamp: Date.now() });
  }
}

export function startHeartbeatCheck(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [userId, client] of clients) {
      if (now - client.lastHeartbeat > CLIENT_TIMEOUT) {
        client.ws.terminate();
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
  const now = new Date();
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  nextMonday.setHours(0, 0, 0, 0);

  const msUntilMonday = nextMonday.getTime() - now.getTime();

  setTimeout(async () => {
    const deleted = await deleteGeneralMessages();
    logSecurity('WEEKLY_CLEANUP', { deletedMessages: deleted });
    console.log(`[Cleanup] Deleted ${deleted} general chat messages`);

    scheduleWeeklyCleanup();
  }, msUntilMonday);
}
