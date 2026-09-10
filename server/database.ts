import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
export const DB_FILE = 'whispernet.db';
let MEDIA_DIR = path.join(DATA_DIR, 'media');

let db: DatabaseSync | null = null;
let DB_PATH: string | null = null;
let migrationsDone = false;

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const PREKEY_BUNDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PREKEY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const json = (v: any): string | null => (v == null ? null : JSON.stringify(v));

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function getDb(): DatabaseSync {
  const p = path.join(DATA_DIR, DB_FILE);
  if (!db || DB_PATH !== p) {
    if (db) { try { db.close(); } catch {} }
    mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(p);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    DB_PATH = p;
  }
  return db;
}

function ensureSchema(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      public_key TEXT,
      created_at INTEGER NOT NULL,
      is_banned INTEGER NOT NULL DEFAULT 0,
      blocked TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      sender_nickname TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'general',
      encrypted TEXT,
      file_key TEXT,
      sealed TEXT,
      quoted_message_id TEXT,
      quoted_message_text TEXT,
      quoted_message_sender TEXT,
      edited_at INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at);
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS prekeys (
      user_id TEXT PRIMARY KEY,
      bundle TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS keybackups (
      user_id TEXT PRIMARY KEY,
      blob TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      reporter_nick TEXT,
      target_id TEXT NOT NULL,
      target_nick TEXT,
      channel TEXT NOT NULL,
      message_id TEXT,
      message_text TEXT,
      reason TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      device_info TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_active INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS admins (
      nickname TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// --- Legacy JSON -> SQLite migration ---
// Runs once when the SQLite database is first created and legacy JSON data
// files exist in the data directory. After a successful migration the JSON
// files are left untouched (safe archive) and SQLite becomes the only source
// of truth. No data is ever deleted.

function legacyJsonFileNames(): string[] {
  return ['users.json', 'messages.json', 'reactions.json', 'prekeys.json', 'keybackups.json', 'reports.json', 'sessions.json', 'admins.json', 'channel.json'];
}

function anyLegacyDataExists(): boolean {
  return legacyJsonFileNames().some((f) => existsSync(path.join(DATA_DIR, f)));
}

function readJsonSync(name: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf-8'));
  } catch { return null; }
}

function migrateLegacy(): void {
  const d = getDb();
  d.exec('BEGIN');
  try {
    // Channel media key
    try {
      if (!metaGet('channel_media_key')) {
        let legacyKey: string | null = null;
        try {
          const ck = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'channel.json'), 'utf-8'));
          if (typeof ck?.key === 'string' && ck.key.length >= 16) legacyKey = ck.key;
        } catch {}
        if (legacyKey) metaSet('channel_media_key', legacyKey);
        else metaSet('channel_media_key', crypto.randomBytes(32).toString('base64'));
      }
    } catch {}

    const users = readJsonSync('users.json');
    if (Array.isArray(users)) {
      const ins = d.prepare('INSERT OR IGNORE INTO users (id, nickname, password_hash, public_key, created_at, is_banned, blocked) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const u of users) {
        if (!u || typeof u.id !== 'string' || typeof u.nickname !== 'string') continue;
        ins.run(u.id, u.nickname, typeof u.passwordHash === 'string' ? u.passwordHash : '', json(u.publicKey), typeof u.createdAt === 'number' ? u.createdAt : Date.now(), u.isBanned ? 1 : 0, json(Array.isArray(u.blocked) ? u.blocked : []));
      }
    }

    const messages = readJsonSync('messages.json');
    if (Array.isArray(messages)) {
      const ins = d.prepare('INSERT OR IGNORE INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, sealed, quoted_message_id, quoted_message_text, quoted_message_sender, edited_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const m of messages) {
        if (!m || typeof m.id !== 'string') continue;
        ins.run(
          m.id,
          typeof m.senderId === 'string' ? m.senderId : '',
          typeof m.senderNickname === 'string' ? m.senderNickname : '',
          typeof m.text === 'string' ? m.text : '',
          typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
          typeof m.channel === 'string' ? m.channel : 'general',
          json(m.encrypted),
          json(m.fileKey),
          typeof m.sealed === 'string' ? m.sealed : null,
          m.quotedMessageId ?? null,
          m.quotedMessageText ?? null,
          m.quotedMessageSender ?? null,
          typeof m.editedAt === 'number' ? m.editedAt : null,
          typeof m.expiresAt === 'number' ? m.expiresAt : null,
        );
      }
    }

    const reactions = readJsonSync('reactions.json');
    if (Array.isArray(reactions)) {
      const ins = d.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, timestamp) VALUES (?, ?, ?, ?)');
      for (const r of reactions) {
        if (!r || typeof r.messageId !== 'string' || typeof r.userId !== 'string') continue;
        ins.run(r.messageId, r.userId, typeof r.emoji === 'string' ? r.emoji : '', typeof r.timestamp === 'number' ? r.timestamp : Date.now());
      }
    }

    const prekeys = readJsonSync('prekeys.json');
    if (Array.isArray(prekeys)) {
      const ins = d.prepare('INSERT OR IGNORE INTO prekeys (user_id, bundle, created_at) VALUES (?, ?, ?)');
      for (const e of prekeys) {
        if (!e || typeof e.userId !== 'string') continue;
        ins.run(e.userId, json(e.bundle), typeof e.createdAt === 'number' ? e.createdAt : Date.now());
      }
    }

    const keybackups = readJsonSync('keybackups.json');
    if (Array.isArray(keybackups)) {
      const ins = d.prepare('INSERT OR IGNORE INTO keybackups (user_id, blob, updated_at) VALUES (?, ?, ?)');
      for (const e of keybackups) {
        if (!e || typeof e.userId !== 'string' || typeof e.blob !== 'string') continue;
        ins.run(e.userId, e.blob, typeof e.updatedAt === 'number' ? e.updatedAt : Date.now());
      }
    }

    const reports = readJsonSync('reports.json');
    if (Array.isArray(reports)) {
      const ins = d.prepare('INSERT OR IGNORE INTO reports (id, reporter_id, reporter_nick, target_id, target_nick, channel, message_id, message_text, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of reports) {
        if (!r || typeof r.id !== 'string') continue;
        ins.run(r.id, r.reporterId ?? '', r.reporterNick ?? null, r.targetId ?? '', r.targetNick ?? null, r.channel ?? 'general', r.messageId ?? null, r.messageText ?? null, r.reason ?? '', typeof r.timestamp === 'number' ? r.timestamp : Date.now());
      }
    }

    const sessions = readJsonSync('sessions.json');
    if (Array.isArray(sessions)) {
      const ins = d.prepare('INSERT OR IGNORE INTO sessions (user_id, device_id, nickname, device_info, first_seen, last_active, revoked) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const s of sessions) {
        if (!s || typeof s.userId !== 'string' || typeof s.deviceId !== 'string') continue;
        ins.run(s.userId, s.deviceId, s.nickname ?? '', s.deviceInfo ?? '', typeof s.firstSeen === 'number' ? s.firstSeen : Date.now(), typeof s.lastActive === 'number' ? s.lastActive : Date.now(), s.revoked ? 1 : 0);
      }
    }

    const admins = readJsonSync('admins.json');
    if (Array.isArray(admins)) {
      const ins = d.prepare('INSERT OR IGNORE INTO admins (nickname) VALUES (?)');
      for (const n of admins) {
        if (typeof n === 'string') ins.run(n.toLowerCase());
      }
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    console.error('Legacy JSON migration failed:', e);
  }
}

function metaGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function metaSet(key: string, value: string): void {
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function setDataDir(dir: string): void {
  if (DB_PATH === path.join(dir, DB_FILE)) {
    DATA_DIR = dir;
    MEDIA_DIR = path.join(dir, 'media');
    return;
  }
  DATA_DIR = dir;
  MEDIA_DIR = path.join(dir, 'media');
  if (db) {
    try { db.close(); } catch {}
    db = null;
    DB_PATH = null;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
}

// General-chat media key: a persisted server-side channel key that every
// registered user receives at login, so media posted to the general channel
// can be decrypted by ANY member (including members who join later). The key
// is never exposed before authentication and is never sent to third parties.
export async function getChannelMediaKey(): Promise<string> {
  const existing = metaGet('channel_media_key');
  if (existing && existing.length >= 16) return existing;
  const key = crypto.randomBytes(32).toString('base64');
  metaSet('channel_media_key', key);
  return key;
}

export function getMediaDir(): string {
  return MEDIA_DIR;
}

// --- Users ---

export async function createUser(nickname: string, password: string, publicKey?: any): Promise<{ id: string; nickname: string } | null> {
  const d = getDb();
  const passwordHash = await bcrypt.hash(password, 12);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const exists = d.prepare('SELECT id FROM users WHERE nickname = ?').get(nickname);
  if (exists) return null;
  try {
    d.prepare('INSERT INTO users (id, nickname, password_hash, public_key, created_at, is_banned, blocked) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(id, nickname, passwordHash, json(publicKey), createdAt, json([]));
    return { id, nickname };
  } catch {
    return null;
  }
}

export async function getUserByNickname(nickname: string): Promise<{ id: string; nickname: string; passwordHash: string; publicKey: any } | null> {
  const row = getDb().prepare('SELECT id, nickname, password_hash as passwordHash, public_key as publicKey FROM users WHERE nickname = ?').get(nickname) as any;
  if (!row) return null;
  return { id: row.id, nickname: row.nickname, passwordHash: row.passwordHash, publicKey: parseJson(row.publicKey, null) };
}

export async function getUserById(id: string): Promise<{ id: string; nickname: string; publicKey: any } | null> {
  const row = getDb().prepare('SELECT id, nickname, public_key as publicKey FROM users WHERE id = ?').get(id) as any;
  if (!row) return null;
  return { id: row.id, nickname: row.nickname, publicKey: parseJson(row.publicKey, null) };
}

export async function getAllPublicKeys(): Promise<Record<string, any>> {
  const rows = getDb().prepare('SELECT id, public_key as publicKey FROM users WHERE public_key IS NOT NULL').all() as any[];
  const keys: Record<string, any> = {};
  for (const r of rows) {
    const k = parseJson(r.publicKey, null);
    if (k) keys[r.id] = k;
  }
  return keys;
}

export async function getPublicKeysByIds(ids: string[]): Promise<Record<string, any>> {
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id, public_key as publicKey FROM users WHERE id IN (${placeholders})`).all(...ids) as any[];
  const keys: Record<string, any> = {};
  for (const r of rows) {
    const k = parseJson(r.publicKey, null);
    if (k) keys[r.id] = k;
  }
  return keys;
}

export async function updatePublicKey(userId: string, publicKey: any): Promise<void> {
  getDb().prepare('UPDATE users SET public_key = ? WHERE id = ?').run(json(publicKey), userId);
}

export async function setPreKeyBundle(userId: string, bundle: any): Promise<void> {
  getDb().prepare('INSERT INTO prekeys (user_id, bundle, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET bundle = excluded.bundle, created_at = excluded.created_at')
    .run(userId, json(bundle), Date.now());
}

export async function getPreKeyBundle(userId: string): Promise<any | null> {
  const row = getDb().prepare('SELECT bundle FROM prekeys WHERE user_id = ?').get(userId) as any;
  return row ? parseJson(row.bundle, null) : null;
}

export async function getAllPreKeyBundles(): Promise<Record<string, any>> {
  const rows = getDb().prepare('SELECT user_id as userId, bundle FROM prekeys').all() as any[];
  const result: Record<string, any> = {};
  for (const r of rows) result[r.userId] = parseJson(r.bundle, null);
  return result;
}

export async function getAllUsers(): Promise<{ id: string; nickname: string }[]> {
  return getDb().prepare('SELECT id, nickname FROM users').all() as { id: string; nickname: string }[];
}

export async function saveKeyBackup(userId: string, blob: string): Promise<void> {
  getDb().prepare('INSERT INTO keybackups (user_id, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at')
    .run(userId, blob, Date.now());
}

export async function getKeyBackup(userId: string): Promise<string | null> {
  const row = getDb().prepare('SELECT blob FROM keybackups WHERE user_id = ?').get(userId) as any;
  return row?.blob ?? null;
}

export async function deleteKeyBackup(userId: string): Promise<void> {
  getDb().prepare('DELETE FROM keybackups WHERE user_id = ?').run(userId);
}

// --- Messages ---

export function getDmChannelId(userId1: string, userId2: string): string {
  return [userId1, userId2].sort().join(':');
}

const MESSAGE_COLUMNS = `id, sender_id AS senderId, sender_nickname AS senderNickname, text, timestamp, channel,
  encrypted, file_key AS fileKey, sealed, quoted_message_id AS quotedMessageId,
  quoted_message_text AS quotedMessageText, quoted_message_sender AS quotedMessageSender,
  edited_at AS editedAt, expires_at AS expiresAt`;

function rowToMessage(row: any, includeText: boolean = true): any {
  return {
    id: row.id,
    senderId: row.senderId,
    senderNickname: row.senderNickname,
    text: includeText ? row.text : (row.text ?? ''),
    timestamp: row.timestamp,
    channel: row.channel,
    encrypted: parseJson(row.encrypted, null),
    fileKey: parseJson(row.fileKey, null),
    sealed: row.sealed || undefined,
    quotedMessageId: row.quotedMessageId || undefined,
    quotedMessageText: row.quotedMessageText || undefined,
    quotedMessageSender: row.quotedMessageSender || undefined,
    editedAt: row.editedAt || undefined,
    expiresAt: row.expiresAt || undefined,
  };
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
  const d = getDb();
  d.prepare(`INSERT INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, sealed, quoted_message_id, quoted_message_text, quoted_message_sender, edited_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, senderId, senderNickname, text, timestamp, channel, json(encrypted), json(fileKey), sealed ?? null, quotedMessageId ?? null, quotedMessageText ?? null, quotedMessageSender ?? null, editedAt ?? null, expiresAt ?? null);
}

export async function updateMessageText(messageId: string, senderId: string, newText: string): Promise<boolean> {
  const res = getDb().prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ? AND sender_id = ?')
    .run(newText, Date.now(), messageId, senderId);
  return (res as any).changes > 0;
}

export async function getRecentMessages(limit: number = 100, channel: string = 'general'): Promise<any[]> {
  const rows = getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`).all(channel, limit) as any[];
  return rows.map((row) => rowToMessage(row)).reverse();
}

export async function getMessageById(messageId: string): Promise<any | null> {
  const row = getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(messageId) as any;
  return row ? rowToMessage(row) : null;
}

export async function getDmHistory(userId1: string, userId2: string, limit: number = 100): Promise<any[]> {
  const channelId = getDmChannelId(userId1, userId2);
  const rows = getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`).all(channelId, limit) as any[];
  return rows.map((row) => rowToMessage(row)).reverse();
}

export async function getDmContacts(userId: string): Promise<{ id: string; nickname: string; lastMessage: number }[]> {
  const rows = getDb().prepare(`SELECT channel, MAX(timestamp) AS ts FROM messages WHERE channel != 'general' GROUP BY channel`).all() as any[];
  const contactMap = new Map<string, number>();
  for (const r of rows) {
    const parts = (r.channel as string).split(':');
    if (parts.length !== 2) continue;
    const otherId = parts[0] === userId ? parts[1] : parts[1] === userId ? parts[0] : null;
    if (!otherId) continue;
    const existing = contactMap.get(otherId) || 0;
    if (r.ts > existing) contactMap.set(otherId, r.ts);
  }
  const users = getDb().prepare('SELECT id, nickname FROM users').all() as { id: string; nickname: string }[];
  const userMap = new Map(users.map(u => [u.id, u.nickname]));
  const result: { id: string; nickname: string; lastMessage: number }[] = [];
  for (const [otherId, lastMessage] of contactMap) {
    const nickname = userMap.get(otherId);
    if (nickname) result.push({ id: otherId, nickname, lastMessage });
  }
  return result.sort((a, b) => b.lastMessage - a.lastMessage);
}

export async function searchMessages(query: string, channel?: string, limit: number = 50, userId?: string): Promise<any[]> {
  const d = getDb();
  const q = query.toLowerCase();
  const rows = d.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE text != '' AND instr(lower(text), ?) > 0`).all(q) as any[];
  const filtered = rows.filter((m) => {
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
    return true;
  });
  return filtered.slice(-limit).map((row) => rowToMessage(row));
}

export async function deleteMessage(messageId: string, userId: string, allowAny: boolean = false): Promise<boolean> {
  const res = allowAny
    ? getDb().prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    : getDb().prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(messageId, userId);
  return (res as any).changes > 0;
}

export async function deleteGeneralMessages(): Promise<number> {
  const res = getDb().prepare("DELETE FROM messages WHERE channel IN ('general')").run();
  return (res as any).changes;
}

let lastMondayCleanupMskDay = '';

export function startGeneralChatMondayCleanup(): void {
  setInterval(() => {
    try {
      const msk = new Date(Date.now() + 3 * 3600 * 1000);
      const isMondayMidnight = msk.getUTCDay() === 1 && msk.getUTCHours() === 0 && msk.getUTCMinutes() < 10;
      if (isMondayMidnight) {
        const dayKey = msk.toISOString().slice(0, 10);
        if (dayKey !== lastMondayCleanupMskDay) {
          lastMondayCleanupMskDay = dayKey;
          void deleteGeneralMessages().then((n) => {
            if (n > 0) console.log(`Monday cleanup (00:00 MSK): deleted ${n} general chat messages`);
          });
        }
      } else {
        lastMondayCleanupMskDay = '';
      }
    } catch (e) {
      console.error('Monday cleanup error:', e);
    }
  }, 60 * 1000);
}

export async function cleanupExpiredMessages(): Promise<number> {
  const res = getDb().prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now());
  return (res as any).changes;
}

export async function cleanupExpiredPreKeys(): Promise<number> {
  const cutoff = Date.now() - PREKEY_BUNDLE_TTL_MS;
  const res = getDb().prepare('DELETE FROM prekeys WHERE created_at < ?').run(cutoff);
  return (res as any).changes;
}

export async function startCleanupJobs(): Promise<void> {
  setInterval(() => cleanupExpiredPreKeys().then(n => n && console.log(`Cleaned ${n} expired prekeys`)), PREKEY_CLEANUP_INTERVAL_MS);
  setInterval(() => cleanupExpiredMessages().then(n => n && console.log(`Cleaned ${n} expired messages`)), MESSAGE_CLEANUP_INTERVAL_MS);
}

export function initializeDatabase(): void {
  const p = path.join(DATA_DIR, DB_FILE);
  const dbExisted = existsSync(p);
  ensureSchema();
  if (!dbExisted || !migrationsDone) {
    if (!dbExisted && anyLegacyDataExists()) migrateLegacy();
    migrationsDone = true;
  }
  const d = getDb();
  const adminCount = d.prepare('SELECT COUNT(*) AS c FROM admins').get() as any;
  if (!adminCount || adminCount.c === 0) {
    d.prepare('INSERT OR IGNORE INTO admins (nickname) VALUES (?)').run('admin');
  }
  console.log(`SQLite storage ready (${p})`);
}

// --- Reactions ---

export async function addReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  const d = getDb();
  const count = d.prepare('SELECT COUNT(*) AS c FROM reactions WHERE message_id = ?').get(messageId) as any;
  if (count.c >= 50) return;
  d.prepare('INSERT INTO reactions (message_id, user_id, emoji, timestamp) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, timestamp = excluded.timestamp')
    .run(messageId, userId, emoji, Date.now());
}

export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  getDb().prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, userId, emoji);
}

export async function getReactionsForMessage(messageId: string): Promise<{ messageId: string; userId: string; emoji: string; timestamp: number }[]> {
  return getDb().prepare('SELECT message_id as messageId, user_id as userId, emoji, timestamp FROM reactions WHERE message_id = ? ORDER BY timestamp ASC').all(messageId) as any[];
}

// --- Moderation & blocking ---

export async function setUserBannedByIdent(userId: string | null, nickname: string | null, banned: boolean): Promise<boolean> {
  const res = userId
    ? getDb().prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned ? 1 : 0, userId)
    : (nickname ? getDb().prepare('UPDATE users SET is_banned = ? WHERE nickname = ?').run(banned ? 1 : 0, nickname) : null);
  return !!res && (res as any).changes > 0;
}

export async function getUserBanned(userId: string): Promise<boolean> {
  const row = getDb().prepare('SELECT is_banned as isBanned FROM users WHERE id = ?').get(userId) as any;
  return !!(row && row.isBanned);
}

export async function getBannedUsers(): Promise<{ userId: string; nickname: string; bannedAt: number }[]> {
  return getDb().prepare('SELECT id as userId, nickname, created_at as bannedAt FROM users WHERE is_banned = 1 ORDER BY created_at DESC').all() as any[];
}

export async function getBlockedUserIds(userId: string): Promise<string[]> {
  const row = getDb().prepare('SELECT blocked FROM users WHERE id = ?').get(userId) as any;
  return row ? parseJson<string[]>(row.blocked, []) : [];
}

export async function setUserBlocked(userId: string, blockedId: string, blocked: boolean): Promise<void> {
  const d = getDb();
  const row = d.prepare('SELECT blocked FROM users WHERE id = ?').get(userId) as any;
  if (!row) return;
  const list = parseJson<string[]>(row.blocked, []);
  const next = blocked ? Array.from(new Set([...list, blockedId])) : list.filter(x => x !== blockedId);
  d.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(json(next), userId);
}

// --- Reports ---

let REPORT_CAP = 1000;

export async function addReport(report: { id: string; reporterId: string; reporterNick?: string; targetId: string; targetNick?: string; channel: string; messageId?: string; messageText?: string; reason: string; timestamp: number }): Promise<void> {
  const d = getDb();
  d.prepare('INSERT INTO reports (id, reporter_id, reporter_nick, target_id, target_nick, channel, message_id, message_text, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(report.id, report.reporterId, report.reporterNick ?? null, report.targetId, report.targetNick ?? null, report.channel, report.messageId ?? null, report.messageText ?? null, report.reason, report.timestamp);
  const count = d.prepare('SELECT COUNT(*) AS c FROM reports').get() as any;
  if (count.c > REPORT_CAP) {
    d.prepare(`DELETE FROM reports WHERE id IN (SELECT id FROM reports ORDER BY timestamp ASC LIMIT ?)`).run(count.c - REPORT_CAP);
  }
}

export async function getReports(): Promise<any[]> {
  return getDb().prepare('SELECT id, reporter_id as reporterId, reporter_nick as "reporterNick", target_id as targetId, target_nick as "targetNick", channel, message_id as messageId, message_text as messageText, reason, timestamp FROM reports ORDER BY timestamp DESC').all() as any[];
}

export async function removeReportsForTarget(targetId: string): Promise<number> {
  const res = getDb().prepare('DELETE FROM reports WHERE target_id = ?').run(targetId);
  return (res as any).changes;
}

// --- Persisted session registry ---

export interface StoredSession {
  userId: string;
  deviceId: string;
  nickname: string;
  deviceInfo: string;
  firstSeen: number;
  lastActive: number;
  revoked: boolean;
}

export async function getAllSessions(): Promise<StoredSession[]> {
  const rows = getDb().prepare('SELECT user_id as userId, device_id as deviceId, nickname, device_info as deviceInfo, first_seen as firstSeen, last_active as lastActive, revoked FROM sessions ORDER BY last_active DESC').all() as any[];
  return rows.map(r => ({ ...r, revoked: !!r.revoked }));
}

export async function upsertSession(record: StoredSession): Promise<void> {
  getDb().prepare('INSERT INTO sessions (user_id, device_id, nickname, device_info, first_seen, last_active, revoked) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO UPDATE SET nickname = excluded.nickname, device_info = excluded.device_info, last_active = excluded.last_active, revoked = excluded.revoked')
    .run(record.userId, record.deviceId, record.nickname, record.deviceInfo, record.firstSeen, record.lastActive, record.revoked ? 1 : 0);
}

export async function markSessionRevoked(userId: string, deviceId: string): Promise<void> {
  getDb().prepare('UPDATE sessions SET revoked = 1, last_active = ? WHERE user_id = ? AND device_id = ?').run(Date.now(), userId, deviceId);
}

export async function touchSession(userId: string, deviceId: string): Promise<void> {
  getDb().prepare('UPDATE sessions SET last_active = ? WHERE user_id = ? AND device_id = ?').run(Date.now(), userId, deviceId);
}

// --- Admins ---

export async function getAdminNicknames(): Promise<string[]> {
  const rows = getDb().prepare('SELECT nickname FROM admins').all() as { nickname: string }[];
  return rows.map(r => r.nickname.toLowerCase());
}

export async function isAdminNickname(nickname: string): Promise<boolean> {
  if (!nickname) return false;
  const row = getDb().prepare('SELECT nickname FROM admins WHERE nickname = ?').get(nickname.toLowerCase()) as any;
  return !!row;
}

export async function addAdminNickname(nickname: string): Promise<void> {
  getDb().prepare('INSERT OR IGNORE INTO admins (nickname) VALUES (?)').run(nickname.toLowerCase());
}

export async function removeAdminNickname(nickname: string): Promise<boolean> {
  const res = getDb().prepare('DELETE FROM admins WHERE nickname = ?').run(nickname.toLowerCase());
  return (res as any).changes > 0;
}