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

let usersMutex = { v: false };
let messagesMutex = { v: false };
let preKeysMutex = { v: false };

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

async function loadUsers(): Promise<any[]> {
  if (!existsSync(USERS_FILE)) return [];
  try {
    const data = await readFile(USERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveUsers(users: any[]): Promise<void> {
  const tmp = USERS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(users, null, 2));
  const { renameSync } = await import('fs');
  renameSync(tmp, USERS_FILE);
}

async function loadMessages(): Promise<any[]> {
  if (!existsSync(MESSAGES_FILE)) return [];
  try {
    const data = await readFile(MESSAGES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveMessages(messages: any[]): Promise<void> {
  const tmp = MESSAGES_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(messages, null, 2));
  const { renameSync } = await import('fs');
  renameSync(tmp, MESSAGES_FILE);
}

export function initializeDatabase() {
  console.log('Database initialized at:', DATA_DIR);
}

let preKeyBundles: Record<string, any> = {};

async function loadPreKeyBundles(): Promise<void> {
  const filePath = path.join(DATA_DIR, 'prekeys.json');
  if (existsSync(filePath)) {
    try {
      const data = await readFile(filePath, 'utf-8');
      preKeyBundles = JSON.parse(data);
    } catch {
      preKeyBundles = {};
    }
  }
}

async function savePreKeyBundles(): Promise<void> {
  const filePath = path.join(DATA_DIR, 'prekeys.json');
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(preKeyBundles, null, 2));
  const { renameSync } = await import('fs');
  renameSync(tmp, filePath);
}

export async function setPreKeyBundle(userId: string, bundle: any): Promise<void> {
  await withMutex(preKeysMutex, async () => {
    await loadPreKeyBundles();
    preKeyBundles[userId] = bundle;
    await savePreKeyBundles();
  });
}

export async function getPreKeyBundle(userId: string): Promise<any> {
  return preKeyBundles[userId] || null;
}

export async function getAllPreKeyBundles(): Promise<Record<string, any>> {
  return { ...preKeyBundles };
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
  sealed?: string
): Promise<void> {
  await withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    messages.push({ id, senderId, senderNickname, text, timestamp, encrypted: encrypted || null, channel, fileKey: fileKey || null, sealed: sealed || null });
    if (messages.length > 5000) messages.splice(0, messages.length - 5000);
    await saveMessages(messages);
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

export async function deleteGeneralMessages(): Promise<number> {
  return withMutex(messagesMutex, async () => {
    const messages = await loadMessages();
    const generalCount = messages.filter(m => !m.channel || m.channel === 'general').length;
    const remaining = messages.filter(m => m.channel && m.channel !== 'general');
    await saveMessages(remaining);
    return generalCount;
  });
}
