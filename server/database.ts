import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import {
  MESSAGE_CLEANUP_INTERVAL_MS,
  SESSION_CLEANUP_INTERVAL_MS,
  INACTIVE_SESSION_TTL_MS,
  REPORT_CAP,
  FTS_TABLE,
} from './constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
export const DB_FILE = 'whispernet.db';
let MEDIA_DIR = path.join(DATA_DIR, 'media');
let AVATAR_DIR = path.join(DATA_DIR, 'avatars');

let db: DatabaseSync | null = null;
let DB_PATH: string | null = null;
let migrationsDone = false;
let ftsAvailable = true;

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const json = (v: any): string | null => (v == null ? null : JSON.stringify(v));

/**
 * node:sqlite binds null, numbers, bigints, strings and bytes. It rejects undefined, booleans and
 * objects outright, with ERR_INVALID_ARG_TYPE naming the parameter position — which is useless on
 * its own, because a message row has eighteen of them and the number in the log does not say which
 * field was at fault. So nothing optional is handed to the driver unchecked; every value is coerced
 * to the type its column can actually hold, and one bad field costs that field instead of the whole
 * message.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function getDb(): DatabaseSync {
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
      sealed_key TEXT,
      created_at INTEGER NOT NULL,
      is_banned INTEGER NOT NULL DEFAULT 0,
      banned_at INTEGER,
      blocked TEXT NOT NULL DEFAULT '[]',
      avatar_ext TEXT,
      avatar_updated_at INTEGER
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
    CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id)
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
      source TEXT NOT NULL DEFAULT 'message',
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
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active);
    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id);
    CREATE INDEX IF NOT EXISTS idx_reports_timestamp ON reports(timestamp);
    -- Sealed messages are ordinary rows here, addressed by a sealed:<recipientId> channel, so history
    -- and paging work without a separate table. This index is what makes that lookup cheap.
    CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel, timestamp);
`);

  
  for (const col of ['avatar_ext TEXT', 'avatar_updated_at INTEGER', 'banned_at INTEGER', 'sealed_key TEXT']) {
    try {
      d.exec(`ALTER TABLE users ADD COLUMN ${col}`);
    } catch {}
  }

  try {
    d.exec(`ALTER TABLE reports ADD COLUMN source TEXT NOT NULL DEFAULT 'message'`);
  } catch {}

  try {
    d.exec(`ALTER TABLE messages ADD COLUMN client_id TEXT`);
  } catch {}

  // X3DH and the ratchet are gone. A database created before that still carries the three columns
  // they used, so they are dropped rather than left behind: an operator reading the schema should not
  // find key material columns for a protocol the server no longer speaks.
  for (const table of ['prekeys', 'prekeys_issued']) {
    try { d.exec(`DROP TABLE IF EXISTS ${table}`); } catch {}
  }
  for (const col of ['signal_encrypted', 'x3dh_message', 'ratchet_public_key']) {
    try { d.exec(`ALTER TABLE messages DROP COLUMN ${col}`); } catch {}
  }

  
  
  
  try {
    d.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(text, content='');`);
    ftsAvailable = true;
  } catch {
    console.warn('[db] FTS5 unavailable, using instr() fallback for search');
    ftsAvailable = false;
  }
}

function backfillFts(): void {
  if (!ftsAvailable) return;
  if (!metaGet('fts_index_v2')) {
    try {
      getDb().exec(`DROP TABLE IF EXISTS ${FTS_TABLE};`);
      getDb().exec(`CREATE VIRTUAL TABLE ${FTS_TABLE} USING fts5(text, content='');`);
      metaSet('fts_index_v2', '1');
      metaSet('fts_backfilled', '');
    } catch (e) {
      console.warn('[db] FTS rebuild failed:', (e as Error).message);
      ftsAvailable = false;
      return;
    }
  }
  if (metaGet('fts_backfilled')) return;
  try {
    const rows = getDb().prepare('SELECT rowid, text FROM messages WHERE text IS NOT NULL AND text != ?').all('') as { rowid: number; text: string }[];
    const ins = getDb().prepare(`INSERT INTO ${FTS_TABLE} (rowid, text) VALUES (?, ?)`);
    for (const r of rows) {
      try { ins.run(r.rowid, r.text); } catch {}
    }
    metaSet('fts_backfilled', '1');
  } catch (e) {
    console.warn('[db] FTS backfill skipped:', (e as Error).message);
    ftsAvailable = false;
  }
}

function syncFtsInsert(rowid: number, text: string): void {
  if (!ftsAvailable || !text) return;
  try {
    getDb().prepare(`INSERT INTO ${FTS_TABLE} (rowid, text) VALUES (?, ?)`).run(rowid, text);
  } catch (e) {
    console.warn('[db] FTS insert failed, disabling FTS:', (e as Error).message);
    ftsAvailable = false;
  }
}

function ftsDropRowids(rowids: number[], texts: string[]): void {
  if (!ftsAvailable || rowids.length === 0) return;
  const del = getDb().prepare(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, rowid, text) VALUES ('delete', ?, ?)`);
  for (let i = 0; i < rowids.length; i++) {
    try {
      del.run(rowids[i], texts[i] ?? '');
    } catch (e) {
      console.warn('[db] FTS delete row failed:', (e as Error).message);
    }
  }
}

function syncFtsDelete(messageId: string): void {
  if (!ftsAvailable) return;
  try {
    const rows = getDb().prepare('SELECT rowid AS rid, text FROM messages WHERE id = ?').all(messageId) as { rid: number; text: string }[];
    ftsDropRowids(rows.map(r => r.rid), rows.map(r => r.text));
  } catch (e) {
    console.warn('[db] FTS delete failed:', (e as Error).message);
  }
}

function syncFtsUpdate(messageId: string, oldText: string, newText: string): void {
  if (!ftsAvailable) return;
  try {
    const row = getDb().prepare('SELECT rowid AS rid FROM messages WHERE id = ?').get(messageId) as { rid: number } | undefined;
    if (!row) return;
    if (oldText) ftsDropRowids([row.rid], [oldText]);
    if (newText) {
      getDb().prepare(`INSERT INTO ${FTS_TABLE} (rowid, text) VALUES (?, ?)`).run(row.rid, newText);
    }
  } catch (e) {
    console.warn('[db] FTS update failed:', (e as Error).message);
  }
}

function syncFtsDeleteByChannel(channel: string): void {
  if (!ftsAvailable) return;
  try {
    const rows = getDb().prepare('SELECT rowid AS rid, text FROM messages WHERE channel = ?').all(channel) as { rid: number; text: string }[];
    ftsDropRowids(rows.map(r => r.rid), rows.map(r => r.text));
  } catch (e) {
    console.warn('[db] FTS channel delete failed:', (e as Error).message);
  }
}

function syncFtsDeleteExpired(cutoff: number): void {
  if (!ftsAvailable) return;
  try {
    const rows = getDb().prepare('SELECT rowid AS rid, text FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(cutoff) as { rid: number; text: string }[];
    ftsDropRowids(rows.map(r => r.rid), rows.map(r => r.text));
  } catch (e) {
    console.warn('[db] FTS expired delete failed:', (e as Error).message);
  }
}


function legacyJsonFileNames(): string[] {
  return ['users.json', 'messages.json', 'reactions.json', 'keybackups.json', 'reports.json', 'sessions.json', 'admins.json', 'channel.json'];
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
          optStr(m.quotedMessageId),
          optStr(m.quotedMessageText),
          optStr(m.quotedMessageSender),
          optNum(m.editedAt),
          optNum(m.expiresAt),
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
        ins.run(r.id, optStr(r.reporterId) ?? '', optStr(r.reporterNick), optStr(r.targetId) ?? '', optStr(r.targetNick), optStr(r.channel) ?? 'general', optStr(r.messageId), optStr(r.messageText), optStr(r.reason) ?? '', optNum(r.timestamp) ?? Date.now());
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
    AVATAR_DIR = path.join(dir, 'avatars');
    try { mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
    try { mkdirSync(AVATAR_DIR, { recursive: true }); } catch {}
    return;
  }
  DATA_DIR = dir;
  MEDIA_DIR = path.join(dir, 'media');
  AVATAR_DIR = path.join(dir, 'avatars');
  if (db) {
    try { db.close(); } catch {}
    db = null;
    DB_PATH = null;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
  mkdirSync(AVATAR_DIR, { recursive: true });
}


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

export function getDataDir(): string {
  return DATA_DIR;
}

export function getAvatarDir(): string {
  return AVATAR_DIR;
}

export async function getUserProfile(userId: string): Promise<{ id: string; nickname: string; avatarExt: string | null; avatarUpdatedAt: number | null; createdAt: number } | null> {
  const row = getDb().prepare('SELECT id, nickname, avatar_ext as avatarExt, avatar_updated_at as avatarUpdatedAt, created_at as createdAt FROM users WHERE id = ?').get(userId) as any;
  if (!row) return null;
  return { id: row.id, nickname: row.nickname, avatarExt: row.avatarExt || null, avatarUpdatedAt: row.avatarUpdatedAt || null, createdAt: row.createdAt };
}

export async function setUserAvatar(userId: string, ext: string): Promise<number | null> {
  const updatedAt = Date.now();
  const res = getDb().prepare('UPDATE users SET avatar_ext = ?, avatar_updated_at = ? WHERE id = ?').run(ext, updatedAt, userId);
  return (res as any).changes > 0 ? updatedAt : null;
}

export async function removeUserAvatar(userId: string): Promise<void> {
  getDb().prepare('UPDATE users SET avatar_ext = NULL, avatar_updated_at = NULL WHERE id = ?').run(userId);
}


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

export async function getUserById(id: string): Promise<{ id: string; nickname: string; publicKey: any; avatarExt: string | null; avatarUpdatedAt: number | null; createdAt: number } | null> {
  const row = getDb().prepare('SELECT id, nickname, public_key as publicKey, avatar_ext as avatarExt, avatar_updated_at as avatarUpdatedAt, created_at as createdAt FROM users WHERE id = ?').get(id) as any;
  if (!row) return null;
  return { id: row.id, nickname: row.nickname, publicKey: parseJson(row.publicKey, null), avatarExt: row.avatarExt || null, avatarUpdatedAt: row.avatarUpdatedAt || null, createdAt: row.createdAt };
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

/**
 * The sealed sender's long-lived X25519 public key, base64.
 *
 * This replaces the X3DH identity key, which used to arrive inside the pre-key bundle and is gone with
 * the rest of that protocol. It is stored apart from the RSA key rather than beside it inside the same
 * JSON document, because that document is a JWK: the media and message paths hand it straight to
 * crypto.subtle.importKey('jwk', …), and wrapping it would break every one of them for the sake of
 * one extra field. 32 bytes, nothing more — the server never sees the private half.
 */
export async function setSealedKey(userId: string, sealedKeyB64: string): Promise<boolean> {
  if (!/^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{1,2}$|^[A-Za-z0-9+/]{43}=$/.test(sealedKeyB64)) return false;
  getDb().prepare('UPDATE users SET sealed_key = ? WHERE id = ?').run(sealedKeyB64, userId);
  return true;
}

export async function getAllSealedKeys(): Promise<Record<string, string>> {
  const rows = getDb().prepare('SELECT id, sealed_key as sealedKey FROM users WHERE sealed_key IS NOT NULL').all() as any[];
  const keys: Record<string, string> = {};
  for (const r of rows) if (typeof r.sealedKey === 'string' && r.sealedKey.length > 0) keys[r.id] = r.sealedKey;
  return keys;
}

export async function getSealedKeysByIds(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id, sealed_key as sealedKey FROM users WHERE sealed_key IS NOT NULL AND id IN (${placeholders})`).all(...ids) as any[];
  const keys: Record<string, string> = {};
  for (const r of rows) if (typeof r.sealedKey === 'string' && r.sealedKey.length > 0) keys[r.id] = r.sealedKey;
  return keys;
}

export async function getAllUsers(): Promise<{ id: string; nickname: string; avatarExt: string | null; avatarUpdatedAt: number | null }[]> {
  return getDb().prepare('SELECT id, nickname, avatar_ext as avatarExt, avatar_updated_at as avatarUpdatedAt FROM users').all() as { id: string; nickname: string; avatarExt: string | null; avatarUpdatedAt: number | null }[];
}

export async function saveKeyBackup(userId: string, blob: string): Promise<void> {
  getDb().prepare('INSERT INTO keybackups (user_id, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at')
    .run(userId, blob, Date.now());
}

export async function getKeyBackup(userId: string): Promise<string | null> {
  const row = getDb().prepare('SELECT blob FROM keybackups WHERE user_id = ?').get(userId) as any;
  return row?.blob ?? null;
}


export function getDmChannelId(userId1: string, userId2: string): string {
  return [userId1, userId2].sort().join(':');
}

const MESSAGE_COLUMNS = `id, sender_id AS senderId, sender_nickname AS senderNickname, text, timestamp, channel,
   encrypted, file_key AS fileKey, sealed, quoted_message_id AS quotedMessageId,
   quoted_message_text AS quotedMessageText, quoted_message_sender AS quotedMessageSender,
      client_id AS clientId,
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
      clientId: row.clientId || undefined,
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
   quotedMessageSender?: string,
   clientId?: string
   ): Promise<void> {
     const d = getDb();
     const body = str(text);
     const res = d.prepare(`INSERT INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, sealed, quoted_message_id, quoted_message_text, quoted_message_sender, edited_at, expires_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
       .run(str(id), str(senderId), str(senderNickname), body, optNum(timestamp) ?? Date.now(), optStr(channel) ?? 'general', json(encrypted), json(fileKey), optStr(sealed), optStr(quotedMessageId), optStr(quotedMessageText), optStr(quotedMessageSender), optNum(editedAt), optNum(expiresAt), optStr(clientId));
     syncFtsInsert(Number((res as any).lastInsertRowid), body);
   }

export async function updateMessageText(messageId: string, senderId: string, newText: string): Promise<boolean> {
  const d = getDb();
  const before = d.prepare('SELECT text FROM messages WHERE id = ? AND sender_id = ?').get(messageId, senderId) as { text: string } | undefined;
  const res = d.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ? AND sender_id = ?')
    .run(newText, Date.now(), messageId, senderId);
  if ((res as any).changes > 0) syncFtsUpdate(messageId, before?.text ?? '', newText);
  return (res as any).changes > 0;
}

export async function getRecentMessages(limit: number = 100, channel: string = 'general', before?: number): Promise<any[]> {
  // `before` walks backwards through history so the client can page in older messages instead of
  // being stuck with the newest hundred
  const rows = (before
    ? getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`).all(channel, before, limit)
    : getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`).all(channel, limit)) as any[];
  return rows.map((row) => rowToMessage(row)).reverse();
}

export async function getMessageById(messageId: string): Promise<any | null> {
  const row = getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(messageId) as any;
  return row ? rowToMessage(row) : null;
}

export async function getDmHistory(userId1: string, userId2: string, limit: number = 100, before?: number): Promise<any[]> {
  const channelId = getDmChannelId(userId1, userId2);
  const rows = (before
    ? getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`).all(channelId, before, limit)
    : getDb().prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`).all(channelId, limit)) as any[];
  return rows.map((row) => rowToMessage(row)).reverse();
}

export async function getDmContacts(userId: string): Promise<{ id: string; nickname: string; lastMessage: number }[]> {
  const d = getDb();
  
  
  const rows = d.prepare(
    "SELECT channel, MAX(timestamp) AS ts FROM messages WHERE channel != 'general' AND (channel LIKE ? OR channel LIKE ?) GROUP BY channel"
  ).all(userId + ':%', '%:' + userId) as { channel: string; ts: number }[];
  const contactMap = new Map<string, number>();
  for (const r of rows) {
    const parts = (r.channel as string).split(':');
    if (parts.length !== 2) continue;
    const otherId = parts[0] === userId ? parts[1] : parts[1] === userId ? parts[0] : null;
    if (!otherId) continue;
    const existing = contactMap.get(otherId) || 0;
    if (r.ts > existing) contactMap.set(otherId, r.ts);
  }
  const otherIds = [...contactMap.keys()];
  const userMap = new Map<string, string>();
  if (otherIds.length > 0) {
    const placeholders = otherIds.map(() => '?').join(',');
    const users = d.prepare(`SELECT id, nickname FROM users WHERE id IN (${placeholders})`).all(...otherIds) as { id: string; nickname: string }[];
    for (const u of users) userMap.set(u.id, u.nickname);
  }
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
  let rows: any[] = [];

  const keywords = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (ftsAvailable && keywords.length > 0) {
    try {
      const match = '"' + keywords.map((w) => w.replace(/"/g, '""')).join('" AND "') + '"';
      const ids = d.prepare(`SELECT ${FTS_TABLE}.rowid AS rid FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? LIMIT 1000`).all(match) as { rid: number }[];
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        rows = d.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE messages.rowid IN (${placeholders}) ORDER BY timestamp`)
          .all(...ids.map((i) => i.rid)) as any[];
      }
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0) {
    // no limit on this one: instr() cannot use an index, so the ceiling has to come from the query
    const all = d.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE text != '' AND instr(lower(text), ?) > 0 LIMIT 5000`).all(q) as any[];
    rows = all.sort((a, b) => a.timestamp - b.timestamp);
  }

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

export async function deleteMessage(messageId: string, userId: string): Promise<boolean> {
  const d = getDb();
  d.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
  const res = d.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(messageId, userId);
  if ((res as any).changes > 0) syncFtsDelete(messageId);
  return (res as any).changes > 0;
}

/**
 * Deletes a message the account was merely the recipient of, which is the one deletion a sealed
 * message allows. The sender of an anonymous message cannot delete it, for the same reason it cannot
 * edit it: proving authorship is what sealed sender withholds. This is separate from deleteMessage on
 * purpose rather than folded into it, so the sender check stays where it was audited.
 */
export async function deleteReceivedMessage(messageId: string, recipientId: string): Promise<boolean> {
  const d = getDb();
  const row = d.prepare('SELECT channel FROM messages WHERE id = ?').get(messageId) as { channel?: string } | undefined;
  if (!row || row.channel !== `sealed:${recipientId}`) return false;
  d.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
  return (d.prepare('DELETE FROM messages WHERE id = ?').run(messageId) as any).changes > 0;
}

export async function deleteGeneralMessages(): Promise<number> {
  const d = getDb();
  syncFtsDeleteByChannel('general');
  d.prepare("DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel IN ('general'))").run();
  const res = d.prepare("DELETE FROM messages WHERE channel IN ('general')").run();
  return (res as any).changes;
}

export async function cleanupExpiredMessages(): Promise<number> {
  const cutoff = Date.now();
  const d = getDb();
  d.prepare(`DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?)`).run(cutoff);
  const res = d.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?').run(cutoff);
  syncFtsDeleteExpired(cutoff);
  return (res as any).changes;
}

export async function startCleanupJobs(): Promise<void> {
  const tick = (label: string, job: () => Promise<number>) => {
    job().then(n => { if (n) console.log(`Cleaned ${n} expired ${label}`); })
      .catch(e => console.warn(`[db] ${label} cleanup failed:`, (e as Error).message));
  };
  setInterval(() => tick('messages', cleanupExpiredMessages), MESSAGE_CLEANUP_INTERVAL_MS).unref?.();
  setInterval(() => tick('inactive sessions', () => pruneInactiveSessions(INACTIVE_SESSION_TTL_MS)), SESSION_CLEANUP_INTERVAL_MS).unref?.();
}

export function initializeDatabase(): void {
  try { mkdirSync(MEDIA_DIR, { recursive: true }); } catch {}
  try { mkdirSync(AVATAR_DIR, { recursive: true }); } catch {}
  const p = path.join(DATA_DIR, DB_FILE);
  const dbExisted = existsSync(p);
  ensureSchema();
  if (!dbExisted || !migrationsDone) {
    if (!dbExisted && anyLegacyDataExists()) migrateLegacy();
    migrationsDone = true;
  }
  backfillFts();
  const d = getDb();
  const adminCount = d.prepare('SELECT COUNT(*) AS c FROM admins').get() as any;
  if (!adminCount || adminCount.c === 0) {
    d.prepare('INSERT OR IGNORE INTO admins (nickname) VALUES (?)').run('admin');
  }
  console.log(`SQLite storage ready (${p})`);
}


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


export async function getReactionsForMessages(messageIds: string[]): Promise<Map<string, { messageId: string; userId: string; emoji: string; timestamp: number }[]>> {
  const result = new Map<string, { messageId: string; userId: string; emoji: string; timestamp: number }[]>();
  const ids = [...new Set(messageIds.filter((m) => typeof m === 'string' && m.length > 0))];
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT message_id as messageId, user_id as userId, emoji, timestamp FROM reactions WHERE message_id IN (${placeholders}) ORDER BY timestamp ASC`).all(...ids) as any[];
  for (const r of rows) {
    const list = result.get(r.messageId);
    if (list) list.push(r);
    else result.set(r.messageId, [r]);
  }
  return result;
}


export async function setUserBannedByIdent(userId: string | null, nickname: string | null, banned: boolean): Promise<boolean> {
   const res = userId
   ? getDb().prepare('UPDATE users SET is_banned = ?, banned_at = ? WHERE id = ?').run(banned ? 1 : 0, banned ? Date.now() : null, userId)
   : (nickname ? getDb().prepare('UPDATE users SET is_banned = ?, banned_at = ? WHERE nickname = ?').run(banned ? 1 : 0, banned ? Date.now() : null, nickname) : null);
   return !!res && (res as any).changes > 0;
   }

export async function getUserBanned(userId: string): Promise<boolean> {
  const row = getDb().prepare('SELECT is_banned as isBanned FROM users WHERE id = ?').get(userId) as any;
  return !!(row && row.isBanned);
}

export async function getBannedUsers(): Promise<{ userId: string; nickname: string; bannedAt: number }[]> {
  return getDb().prepare('SELECT id as userId, nickname, COALESCE(banned_at, created_at) as bannedAt FROM users WHERE is_banned = 1 ORDER BY bannedAt DESC').all() as any[];
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


export async function addReport(report: { id: string; reporterId: string; reporterNick?: string; targetId: string; targetNick?: string; channel: string; messageId?: string; messageText?: string; reason: string; source?: 'profile' | 'message'; timestamp: number }): Promise<void> {
  const d = getDb();
  d.prepare('INSERT INTO reports (id, reporter_id, reporter_nick, target_id, target_nick, channel, message_id, message_text, reason, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(report.id, report.reporterId, report.reporterNick ?? null, report.targetId, report.targetNick ?? null, report.channel, report.messageId ?? null, report.messageText ?? null, report.reason, report.source === 'profile' ? 'profile' : 'message', report.timestamp);
  const count = d.prepare('SELECT COUNT(*) AS c FROM reports').get() as any;
  if (count.c > REPORT_CAP) {
    d.prepare(`DELETE FROM reports WHERE id IN (SELECT id FROM reports ORDER BY timestamp ASC LIMIT ?)`).run(count.c - REPORT_CAP);
  }
}

export async function getReports(): Promise<any[]> {
  return getDb().prepare('SELECT id, reporter_id as reporterId, reporter_nick as "reporterNick", target_id as targetId, target_nick as "targetNick", channel, message_id as messageId, message_text as messageText, reason, source, timestamp FROM reports ORDER BY timestamp DESC').all() as any[];
}

export async function removeReportsForTarget(targetId: string): Promise<number> {
  const res = getDb().prepare('DELETE FROM reports WHERE target_id = ?').run(targetId);
  return (res as any).changes;
}


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

/**
 * Sessions that have not been seen for a long time no longer occupy a slot. Without this the cap of
 * three was spent forever by devices the user had long since thrown away.
 */
export async function pruneInactiveSessions(maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  const res = getDb().prepare('DELETE FROM sessions WHERE last_active < ?').run(cutoff);
  return (res as any).changes;
}


export async function isAdminNickname(nickname: string): Promise<boolean> {
  if (!nickname) return false;
  const row = getDb().prepare('SELECT nickname FROM admins WHERE nickname = ?').get(nickname.toLowerCase()) as any;
  return !!row;
}
