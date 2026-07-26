import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
let USERS_FILE = path.join(DATA_DIR, 'users.json');
let MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
let PREKEYS_FILE = path.join(DATA_DIR, 'prekeys.json');

let usersMutex = { v: false };
let messagesMutex = { v: false };
let preKeysMutex = { v: false };

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

export function setDataDir(dir: string): void {
  DATA_DIR = dir;
  USERS_FILE = path.join(DATA_DIR, 'users.json');
  MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
  mkdirSync(DATA_DIR, { recursive: true });
}

interface StoredUser {
  id: string;
  nickname: string;
  passwordHash: string;
  publicKey: Record<string, any>;
  createdAt?: number;
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
  editedAt?: number;
  expiresAt?: number;
  sealedSender?: boolean;
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
  const tmp = USERS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(users, null, 2));
  const { renameSync } = await import('fs');
  renameSync(tmp, USERS_FILE);
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
  const tmp = MESSAGES_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(messages, null, 2));
  const { renameSync } = await import('fs');
  renameSync(tmp, MESSAGES_FILE);
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
  const tmp = REACTIONS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(reactions, null, 2));
  const { renameSync } = await import('fs');
  renameSync(tmp, REACTIONS_FILE);
}

export async function cleanupExpiredPreKeys(): Promise<number> {
  return withMutex(preKeysMutex, async () => {
    await loadPreKeyBundles();
    const now = Date.now();
    let deleted = 0;
    for (const [userId, bundle] of Object.entries(preKeyBundles)) {
      if (now - bundle.createdAt > PREKEY_BUNDLE_TTL_MS) {
        delete preKeyBundles[userId];
        deleted++;
      }
    }
    if (deleted > 0) await savePreKeyBundles();
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

    users.push({ id, nickname, passwordHash, createdAt, publicKey: publicKey || null });
    await saveUsers(users);
    return { id, nickname };
  });
}

export async function getUserByNickname(nickname: string): Promise<{ id: string; nickname: string; passwordHash: string; publicKey: any } | null> {
  const users = await loadUsers();
  const user = users.find(u => u.nickname === nickname);
  return user ? { id: user.id, nickname: user.nickname, passwordHash: user.passwordHash, publicKey: user.publicKey || null } : null;
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

export async function getUserById(id: string): Promise<{ id: string; nickname: string; publicKey: any } | null> {
  const users = await loadUsers();
  const user = users.find(u => u.id === id);
  return user ? { id: user.id, nickname: user.nickname, publicKey: user.publicKey || null } : null;
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
    await setPreKeyBundle(userId, bundle);
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
  editedAt?: number
): Promise<void> {
  await withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    messages.push({ id, senderId, senderNickname, text, timestamp, encrypted: encrypted || null, channel, fileKey: fileKey || null, sealed: sealed || undefined, quotedMessageId, editedAt });
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

export async function searchMessages(query: string, channel?: string, limit: number = 50): Promise<any[]> {
  const messages = await loadMessages();
  const q = query.toLowerCase();
  return messages
    .filter(m => {
      if (channel && m.channel !== channel) return false;
      if (!m.text || typeof m.text !== 'string') return false;
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
    const reactions = await loadReactions();
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

export async function getReactionsForMessage(messageId: string): Promise<StoredReaction[]> {
  const reactions = await loadReactions();
  return reactions.filter(r => r.messageId === messageId);
}
