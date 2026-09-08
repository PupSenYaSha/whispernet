import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import fs from 'fs';
import { readFile, writeFile } from 'fs/promises';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
let USERS_FILE = path.join(DATA_DIR, 'users.json');
let MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
let PREKEYS_FILE = path.join(DATA_DIR, 'prekeys.json');
let KEYBACKUP_FILE = path.join(DATA_DIR, 'keybackups.json');
let REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
let ADMINS_FILE = path.join(DATA_DIR, 'admins.json');
let MEDIA_DIR = path.join(DATA_DIR, 'media');

let usersMutex = { v: false };
let messagesMutex = { v: false };
let preKeysMutex = { v: false };
let keyBackupMutex = { v: false };
let reportsMutex = { v: false };
let adminsMutex = { v: false };

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const PREKEY_BUNDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PREKEY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

async function withMutex<T>(flag: { v: boolean }, fn: () => Promise<T>): Promise<T> {
  while (flag.v) await new Promise(r => setTimeout(r, 5));
  flag.v = true;
  try {
    return await fn();
  } finally {
    flag.v = false;
  }
}

// Resilient atomic write: some environments (Windows + OneDrive/antivirus)
// briefly lock files, causing rename to fail with EPERM. Retry the rename and
// fall back to a direct overwrite so persistence never hard-fails a request.
async function atomicWrite(target: string, data: string): Promise<void> {
  const tmp = target + '.tmp';
  await writeFile(tmp, data);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      if (attempt === 5) {
        try { fs.writeFileSync(target, data); return; } catch { throw e; }
      }
      await new Promise(r => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

export function setDataDir(dir: string): void {
  DATA_DIR = dir;
  USERS_FILE = path.join(DATA_DIR, 'users.json');
  MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
  PREKEYS_FILE = path.join(DATA_DIR, 'prekeys.json');
  KEYBACKUP_FILE = path.join(DATA_DIR, 'keybackups.json');
  REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
  ADMINS_FILE = path.join(DATA_DIR, 'admins.json');
  MEDIA_DIR = path.join(DATA_DIR, 'media');
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
}

export function getMediaDir(): string {
  return MEDIA_DIR;
}

interface StoredUser {
  id: string;
  nickname: string;
  passwordHash: string;
  publicKey: Record<string, any>;
  createdAt?: number;
  isBanned?: boolean;
  blocked?: string[];
}

interface StoredMessage {
  id: string;
  senderId: string;
  senderNickname: string;
  text: string;
  timestamp: number;
  channel?: string;
  encrypted?: any;
  fileKey?: any;
sealed?: string;
  quotedMessageId?: string;
  quotedMessageText?: string;
  quotedMessageSender?: string;
  editedAt?: number;
  expiresAt?: number;
}

function isValidUser(u: any): u is StoredUser {
  return typeof u === 'object' && u !== null
    && typeof u.id === 'string' && u.id.length > 0
    && typeof u.nickname === 'string' && u.nickname.length > 0
    && typeof u.passwordHash === 'string' && u.passwordHash.length > 0
    && typeof u.publicKey === 'object' && u.publicKey !== null;
}

function isValidMessage(m: any): m is StoredMessage {
  return typeof m === 'object' && m !== null
    && typeof m.id === 'string' && m.id.length > 0
    && typeof m.senderId === 'string'
    && typeof m.senderNickname === 'string'
    && typeof m.text === 'string'
    && typeof m.timestamp === 'number' && m.timestamp > 0;
}

interface StoredReaction {
  messageId: string;
  userId: string;
  emoji: string;
  timestamp: number;
}

function isValidReaction(r: any): r is StoredReaction {
  return typeof r === 'object' && r !== null
    && typeof r.messageId === 'string'
    && typeof r.userId === 'string'
    && typeof r.emoji === 'string'
    && typeof r.timestamp === 'number';
}

interface StoredPreKeyBundle {
  userId: string;
  bundle: any;
  createdAt: number;
}

function isValidPreKeyBundleEntry(e: any): e is StoredPreKeyBundle {
  return typeof e === 'object' && e !== null
    && typeof e.userId === 'string' && e.userId.length > 0
    && typeof e.bundle === 'object' && e.bundle !== null
    && typeof e.createdAt === 'number' && e.createdAt > 0;
}

async function loadPreKeyBundles(): Promise<Record<string, StoredPreKeyBundle>> {
  if (!existsSync(PREKEYS_FILE)) return {};
  try {
    const data = await readFile(PREKEYS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return {};
    const map: Record<string, StoredPreKeyBundle> = {};
    for (const entry of parsed) {
      if (isValidPreKeyBundleEntry(entry)) map[entry.userId] = entry;
    }
    return map;
  } catch {
    return {};
  }
}

async function savePreKeyBundles(bundles: Record<string, StoredPreKeyBundle>): Promise<void> {
  await atomicWrite(PREKEYS_FILE, JSON.stringify(Object.values(bundles), null, 2));
}

// Encrypted private-key backup (A+C cross-device). The server stores only the
// ciphertext blob (encrypted client-side with a password-derived key) and never
// sees the plaintext private key. Used so a new device can restore the same
// identity and decrypt synced history.
interface StoredKeyBackup { userId: string; blob: string; updatedAt: number; }

async function loadKeyBackups(): Promise<Record<string, StoredKeyBackup>> {
  if (!existsSync(KEYBACKUP_FILE)) return {};
  try {
    const data = await readFile(KEYBACKUP_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return {};
    const map: Record<string, StoredKeyBackup> = {};
    for (const entry of parsed) {
      if (entry && typeof entry.userId === 'string' && typeof entry.blob === 'string') map[entry.userId] = entry;
    }
    return map;
  } catch {
    return {};
  }
}

async function saveKeyBackups(map: Record<string, StoredKeyBackup>): Promise<void> {
  await atomicWrite(KEYBACKUP_FILE, JSON.stringify(Object.values(map), null, 2));
}

export async function saveKeyBackup(userId: string, blob: string): Promise<void> {
  return withMutex(keyBackupMutex, async () => {
    const map = await loadKeyBackups();
    map[userId] = { userId, blob, updatedAt: Date.now() };
    await saveKeyBackups(map);
  });
}

export async function getKeyBackup(userId: string): Promise<string | null> {
  const map = await loadKeyBackups();
  return map[userId]?.blob || null;
}

export async function deleteKeyBackup(userId: string): Promise<void> {
  return withMutex(keyBackupMutex, async () => {
    const map = await loadKeyBackups();
    if (map[userId]) { delete map[userId]; await saveKeyBackups(map); }
  });
}

async function loadUsers(): Promise<StoredUser[]> {
  if (!existsSync(USERS_FILE)) return [];
  try {
    const data = await readFile(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidUser);
  } catch {
    return [];
  }
}

async function saveUsers(users: StoredUser[]): Promise<void> {
  await atomicWrite(USERS_FILE, JSON.stringify(users, null, 2));
}

async function loadMessages(): Promise<StoredMessage[]> {
  if (!existsSync(MESSAGES_FILE)) return [];
  try {
    const data = await readFile(MESSAGES_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMessage);
  } catch {
    return [];
  }
}

async function saveMessages(messages: StoredMessage[]): Promise<void> {
  await atomicWrite(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

async function loadReactions(): Promise<StoredReaction[]> {
  const REACTIONS_FILE = path.join(DATA_DIR, 'reactions.json');
  if (!existsSync(REACTIONS_FILE)) return [];
  try {
    const data = await readFile(REACTIONS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidReaction);
  } catch {
    return [];
  }
}

async function saveReactions(reactions: StoredReaction[]): Promise<void> {
  const REACTIONS_FILE = path.join(DATA_DIR, 'reactions.json');
  await atomicWrite(REACTIONS_FILE, JSON.stringify(reactions, null, 2));
}

export async function cleanupExpiredPreKeys(): Promise<number> {
  return withMutex(preKeysMutex, async () => {
    const bundles = await loadPreKeyBundles();
    const now = Date.now();
    let deleted = 0;
    for (const [userId, entry] of Object.entries(bundles)) {
      if (now - entry.createdAt > PREKEY_BUNDLE_TTL_MS) {
        delete bundles[userId];
        deleted++;
      }
    }
    if (deleted > 0) await savePreKeyBundles(bundles);
    return deleted;
  });
}

export async function cleanupExpiredMessages(): Promise<number> {
  return withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    const now = Date.now();
    const initialLength = messages.length;
    const remaining = messages.filter(m => !m.expiresAt || m.expiresAt > now);
    if (remaining.length !== initialLength) {
      await saveMessages(remaining);
    }
    return initialLength - remaining.length;
  });
}

export async function startCleanupJobs(): Promise<void> {
  setInterval(() => cleanupExpiredPreKeys().then(n => n && console.log(`Cleaned ${n} expired prekeys`)), PREKEY_CLEANUP_INTERVAL_MS);
  setInterval(() => cleanupExpiredMessages().then(n => n && console.log(`Cleaned ${n} expired messages`)), MESSAGE_CLEANUP_INTERVAL_MS);
}

export async function createUser(nickname: string, password: string, publicKey?: any): Promise<{ id: string; nickname: string } | null> {
  return withMutex(usersMutex, async () => {
    const users = await loadUsers();
    const passwordHash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    const createdAt = Date.now();

    if (users.find(u => u.nickname === nickname)) {
      return null;
    }

    users.push({ id, nickname, passwordHash, createdAt, publicKey: publicKey || null, isBanned: false, blocked: [] });
    await saveUsers(users);
    return { id, nickname };
  });
}

export async function getUserByNickname(nickname: string): Promise<{ id: string; nickname: string; passwordHash: string; publicKey: any } | null> {
  const users = await loadUsers();
  const user = users.find(u => u.nickname === nickname);
  return user ? { id: user.id, nickname: user.nickname, passwordHash: user.passwordHash, publicKey: user.publicKey || null } : null;
}

export async function getUserById(id: string): Promise<{ id: string; nickname: string; publicKey: any } | null> {
  const users = await loadUsers();
  const user = users.find(u => u.id === id);
  return user ? { id: user.id, nickname: user.nickname, publicKey: user.publicKey || null } : null;
}

export async function getAllPublicKeys(): Promise<Record<string, any>> {
  const users = await loadUsers();
  const keys: Record<string, any> = {};
  for (const user of users) {
    if (user.publicKey) keys[user.id] = user.publicKey;
  }
  return keys;
}

export async function getPublicKeysByIds(ids: string[]): Promise<Record<string, any>> {
  const users = await loadUsers();
  const keys: Record<string, any> = {};
  for (const user of users) {
    if (ids.includes(user.id) && user.publicKey) keys[user.id] = user.publicKey;
  }
  return keys;
}

export async function updatePublicKey(userId: string, publicKey: any): Promise<void> {
    await withMutex(usersMutex, async () => {
      const users = await loadUsers();
      const user = users.find(u => u.id === userId);
      if (user) {
        user.publicKey = publicKey;
        await saveUsers(users);
      }
    });
  }

  export async function setPreKeyBundle(userId: string, bundle: any): Promise<void> {
    await withMutex(preKeysMutex, async () => {
      const bundles = await loadPreKeyBundles();
      bundles[userId] = { userId, bundle, createdAt: Date.now() };
      await savePreKeyBundles(bundles);
    });
  }

export async function getPreKeyBundle(userId: string): Promise<any | null> {
  const bundles = await loadPreKeyBundles();
  return bundles[userId]?.bundle || null;
}

export async function getAllPreKeyBundles(): Promise<Record<string, any>> {
  const bundles = await loadPreKeyBundles();
  const result: Record<string, any> = {};
  for (const [userId, entry] of Object.entries(bundles)) {
    result[userId] = entry.bundle;
  }
  return result;
}

  export async function getAllUsers(): Promise<{ id: string; nickname: string }[]> {
  return (await loadUsers()).map(u => ({ id: u.id, nickname: u.nickname }));
}

export function getDmChannelId(userId1: string, userId2: string): string {
  return [userId1, userId2].sort().join(':');
}

export async function saveMessage(
  id: string,
  senderId: string,
  senderNickname: string,
  text: string,
  timestamp: number,
  encrypted?: any,
  channel: string = 'general',
  fileKey?: Record<string, string>,
  sealed?: string,
  quotedMessageId?: string,
  editedAt?: number,
  expiresAt?: number,
  quotedMessageText?: string,
  quotedMessageSender?: string
): Promise<void> {
  await withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    messages.push({ id, senderId, senderNickname, text, timestamp, encrypted: encrypted || null, channel, fileKey: fileKey || null, sealed: sealed || undefined, quotedMessageId, quotedMessageText, quotedMessageSender, editedAt, expiresAt });
    if (messages.length > 5000) messages.splice(0, messages.length - 5000);
    await saveMessages(messages);
  });
}

export async function updateMessageText(messageId: string, senderId: string, newText: string): Promise<boolean> {
  return withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    const idx = messages.findIndex(m => m.id === messageId && m.senderId === senderId);
    if (idx === -1) return false;
    messages[idx].text = newText;
    messages[idx].editedAt = Date.now();
    await saveMessages(messages);
    return true;
  });
}

export async function getRecentMessages(limit: number = 100, channel: string = 'general'): Promise<any[]> {
  const messages = await loadMessages();
  return messages.filter(m => m.channel === channel).slice(-limit);
}

export async function getMessageById(messageId: string): Promise<StoredMessage | null> {
  const messages = await loadMessages();
  return messages.find(m => m.id === messageId) || null;
}

export async function getDmHistory(userId1: string, userId2: string, limit: number = 100): Promise<any[]> {
  const channelId = getDmChannelId(userId1, userId2);
  const messages = await loadMessages();
  return messages.filter(m => m.channel === channelId).slice(-limit);
}

export async function getDmContacts(userId: string): Promise<{ id: string; nickname: string; lastMessage: number }[]> {
  const messages = await loadMessages();
  const contactMap = new Map<string, number>();

  for (const m of messages) {
    if (!m.channel || m.channel === 'general') continue;
    const parts = m.channel.split(':');
    if (parts.length !== 2) continue;
    const otherId = parts[0] === userId ? parts[1] : parts[1] === userId ? parts[0] : null;
    if (!otherId) continue;
    const existing = contactMap.get(otherId) || 0;
    if (m.timestamp > existing) contactMap.set(otherId, m.timestamp);
  }

  const users = await loadUsers();
  const result: { id: string; nickname: string; lastMessage: number }[] = [];
  for (const [otherId, lastMessage] of contactMap) {
    const user = users.find(u => u.id === otherId);
    if (user) {
      result.push({ id: user.id, nickname: user.nickname, lastMessage });
    }
  }
  return result.sort((a, b) => b.lastMessage - a.lastMessage);
}

export async function searchMessages(query: string, channel?: string, limit: number = 50, userId?: string): Promise<any[]> {
  const messages = await loadMessages();
  const q = query.toLowerCase();
  return messages
    .filter(m => {
      if (!m.text || typeof m.text !== 'string') return false;
      if (userId) {
        if (m.channel === 'general' || !m.channel) {
          if (channel && channel !== 'general') return false;
        } else if (m.channel.includes(':')) {
          if (channel && m.channel !== channel) return false;
          const parts = m.channel.split(':');
          if (parts.length !== 2 || (parts[0] !== userId && parts[1] !== userId)) return false;
        } else {
          if (channel && m.channel !== channel) return false;
          if (m.channel !== userId) return false;
        }
      } else if (channel && m.channel !== channel) {
        return false;
      }
      return m.text.toLowerCase().includes(q);
    })
    .slice(-limit);
}

export async function deleteMessage(messageId: string, userId: string): Promise<boolean> {
  return withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    const idx = messages.findIndex(m => m.id === messageId && m.senderId === userId);
    if (idx === -1) return false;
    messages.splice(idx, 1);
    await saveMessages(messages);
    return true;
  });
}

export async function deleteGeneralMessages(): Promise<number> {
  return withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    const generalCount = messages.filter(m => !m.channel || m.channel === 'general').length;
    const remaining = messages.filter(m => m.channel && m.channel !== 'general');
    await saveMessages(remaining);
    return generalCount;
  });
}

const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

export async function deleteOldGeneralMessages(): Promise<number> {
  return withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    const cutoff = Date.now() - ONE_WEEK;
    const deleted = messages.filter(m => (!m.channel || m.channel === 'general') && m.timestamp < cutoff).length;
    const remaining = messages.filter(m => (m.channel && m.channel !== 'general') || m.timestamp >= cutoff);
    await saveMessages(remaining);
    return deleted;
  });
}

export function startAutoCleanup(): void {
  setInterval(async () => {
    try {
      const deleted = await deleteOldGeneralMessages();
      if (deleted > 0) console.log(`Auto-cleaned ${deleted} old general messages`);
    } catch (e) {
      console.error('Auto-cleanup failed:', e);
    }
  }, ONE_WEEK);
}

export function initializeDatabase(): void {
}

export async function addReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  return withMutex(messagesMutex, async () => {
    let reactions = await loadReactions();
    // One reaction per user per message: re-adding replaces the previous emoji.
    reactions = reactions.filter(r => !(r.messageId === messageId && r.userId === userId));
    if (reactions.filter(r => r.messageId === messageId).length >= 50) return;
    reactions.push({ messageId, userId, emoji, timestamp: Date.now() });
    await saveReactions(reactions);
  });
}

export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  return withMutex(messagesMutex, async () => {
    let reactions = await loadReactions();
    reactions = reactions.filter(r => !(r.messageId === messageId && r.userId === userId && r.emoji === emoji));
    await saveReactions(reactions);
  });
}

// --- Moderation & blocking (release-readiness) ---

export async function setUserBannedByIdent(userId: string | null, nickname: string | null, banned: boolean): Promise<boolean> {
  return withMutex(usersMutex, async () => {
    const users = await loadUsers();
    const user = userId
      ? users.find(u => u.id === userId)
      : (nickname ? users.find(u => u.nickname === nickname) : null);
    if (!user) return false;
    user.isBanned = banned;
    await saveUsers(users);
    return true;
  });
}

export async function getUserBanned(userId: string): Promise<boolean> {
  const users = await loadUsers();
  const user = users.find(u => u.id === userId);
  return !!user?.isBanned;
}

export async function getBannedUsers(): Promise<{ userId: string; nickname: string; bannedAt: number }[]> {
  const users = await loadUsers();
  return users
    .filter(u => u.isBanned)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(u => ({ userId: u.id, nickname: u.nickname, bannedAt: u.createdAt || 0 }));
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  const users = await loadUsers();
  const user = users.find(u => u.id === userId);
  return Array.isArray(user?.blocked) ? (user.blocked as string[]) : [];
}

export async function setUserBlocked(userId: string, blockedId: string, blocked: boolean): Promise<void> {
  return withMutex(usersMutex, async () => {
    const users = await loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return;
    const list = Array.isArray(user.blocked) ? (user.blocked as string[]) : [];
    user.blocked = blocked
      ? Array.from(new Set([...list, blockedId]))
      : list.filter(x => x !== blockedId);
    await saveUsers(users);
  });
}

interface StoredReport {
  id: string;
  reporterId: string;
  reporterNick?: string;
  targetId: string;
  targetNick?: string;
  channel: string;
  messageId?: string;
  messageText?: string;
  reason: string;
  timestamp: number;
}

async function loadReports(): Promise<StoredReport[]> {
  if (!existsSync(REPORTS_FILE)) return [];
  try {
    const data = await readFile(REPORTS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveReports(reports: StoredReport[]): Promise<void> {
  await atomicWrite(REPORTS_FILE, JSON.stringify(reports, null, 2));
}

export async function addReport(report: StoredReport): Promise<void> {
  return withMutex(reportsMutex, async () => {
    const reports = await loadReports();
    reports.push(report);
    if (reports.length > 1000) reports.splice(0, reports.length - 1000);
    await saveReports(reports);
  });
}

export async function getReports(): Promise<StoredReport[]> {
  return loadReports();
}

export async function removeReportsForTarget(targetId: string): Promise<number> {
  return withMutex(reportsMutex, async () => {
    const reports = await loadReports();
    const remaining = reports.filter(r => r.targetId !== targetId);
    const removed = reports.length - remaining.length;
    if (removed > 0) await saveReports(remaining);
    return removed;
  });
}

// --- Admins by nickname (server-side moderation identity) ---
// Nicknames are stored lowercased in data/admins.json. The file is created with
// a default entry when the server first starts, so the owner can hand roles to
// specific accounts without sharing the ADMIN_KEY. Case-insensitive membership.

const DEFAULT_ADMINS = ['admin'];

async function loadAdmins(): Promise<string[]> {
  if (!existsSync(ADMINS_FILE)) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      await atomicWrite(ADMINS_FILE, JSON.stringify(DEFAULT_ADMINS, null, 2));
    } catch {}
    return [...DEFAULT_ADMINS];
  }
  try {
    const data = await readFile(ADMINS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === 'string').map((x: string) => x.toLowerCase()) : [];
  } catch {
    return [];
  }
}

export async function getAdminNicknames(): Promise<string[]> {
  return withMutex(adminsMutex, async () => (await loadAdmins()).map(n => n.toLowerCase()));
}

export async function isAdminNickname(nickname: string): Promise<boolean> {
  if (!nickname) return false;
  const admins = await getAdminNicknames();
  return admins.includes(nickname.toLowerCase());
}

export async function addAdminNickname(nickname: string): Promise<void> {
  return withMutex(adminsMutex, async () => {
    const admins = await loadAdmins();
    const n = nickname.toLowerCase();
    if (!admins.includes(n)) {
      admins.push(n);
      await atomicWrite(ADMINS_FILE, JSON.stringify(admins, null, 2));
    }
  });
}

export async function removeAdminNickname(nickname: string): Promise<boolean> {
  return withMutex(adminsMutex, async () => {
    const admins = await loadAdmins();
    const idx = admins.indexOf(nickname.toLowerCase());
    if (idx === -1) return false;
    admins.splice(idx, 1);
    await atomicWrite(ADMINS_FILE, JSON.stringify(admins, null, 2));
    return true;
  });
}

export async function getReactionsForMessage(messageId: string): Promise<StoredReaction[]> {
  const reactions = await loadReactions();
  return reactions.filter(r => r.messageId === messageId);
}
