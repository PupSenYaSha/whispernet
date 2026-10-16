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
  PREKEY_BUNDLE_TTL_MS,
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

/**
 * How long a recorded creation is kept before being pruned.
 *
 * Comfortably longer than the longest window any limit uses, so pruning can never delete a row that is
 * still counting against somebody, and short enough that the table cannot become the thing that fills the
 * disk. If a limit is ever given a window longer than this, raise it here - otherwise a cap would start
 * letting people through early.
 */
const REGISTRATION_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many conversations `getDmContacts` will report, and how many ids it looks up per statement.
 *
 * Both exist because the contact list is built from a scan of every DM channel this account has ever used,
 * and the ids were then fed to one `IN (...)` placeholder each. See the use site for what that cost.
 */
const MAX_DM_CONTACTS = 500;
/** Comfortably under `SQLITE_MAX_VARIABLE_NUMBER`, which is 999 on older builds and higher on newer ones. */
const MAX_DM_CONTACT_LOOKUP_BATCH = 200;
/** How far ahead of this server's clock a message's own timestamp may claim to be. */
const MAX_CLOCK_SKEW_MS = 60_000;
/** How many channels the in-memory timestamp floor tracks; a rare channel re-seeds itself from the table. */
const MAX_TRACKED_CHANNELS = 500;

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

/**
 * Closes the handle, which checkpoints the write-ahead log.
 *
 * Only called on the way out. `getDb()` reopens on the next call, so this is safe to call in a test or
 * between runs: the module's cached handle is dropped rather than left pointing at a closed database, which
 * is the failure a bare `db.close()` here would produce.
 */
export function closeDatabase(): void {
  if (!db) return;
  try { db.close(); } catch {}
  db = null;
  DB_PATH = null;
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
      banned_at INTEGER,
      blocked TEXT NOT NULL DEFAULT '[]',
      avatar_ext TEXT,
      avatar_updated_at INTEGER,
      /** The account-level identity key a safety number is computed from. See setIdentityKeyB64. */
      identity_key TEXT
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
    /**
     * One row per account created, so creation limits can be counted after the fact.
     *
     * These used to be a Map in memory, which meant a restart handed everybody a fresh allowance - and a
     * restart is not something an abuser needs to arrange deliberately, it just happens on a deploy, and
     * it left the limit silently ineffective between restarts. Counting rows also makes the number
     * survivable: it can be inspected, audited and reasoned about after the fact, which a running total
     * never could.
     *
     * The scope column is 'ip' or 'device', and subject holds the pseudonym of the thing being limited -
     * never the raw value, so this table holds no address and no device id that is not already tied to an
     * account elsewhere. 'id' is an autoincrementing key rather than part of the primary key: with
     * PRIMARY KEY (scope, subject, created_at), two accounts created in the same millisecond collided and
     * INSERT OR IGNORE silently dropped one of them, so a burst of registrations counted as one while the
     * users table grew by all of them - the ceiling was checked against a number that undercounted. One row
     * per event is what the count means.
     */
    CREATE TABLE IF NOT EXISTS registration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS registration_events_subject_time ON registration_events(scope, subject, created_at);
    /**
     * The published key material a sender needs to open a ratchet with somebody it has never spoken to.
     *
     * One row per **device**, not per account. That distinction is the whole multi-device story: every
     * device has its own identity key and its own signed prekey, so a sender builds a separate session
     * with each and seals a separate body for each. Keyed on the account alone, the second device to
     * sign in would overwrite the first one's bundle and every message would reach only whichever
     * device happened to upload last.
     *
     * Within a row the identity key lasts as long as the device and the signed prekey is rotated on a
     * schedule. The one-time prekeys inside it are consumed on the server, not merely on the client: see
     * the prekey_issued table below.
     */
    CREATE TABLE IF NOT EXISTS prekeys (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      bundle TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );
    /**
     * Which one-time prekeys have already been handed out.
     *
     * This is the table the old implementation had and lost. Without it the server served the same bundle
     * to every sender until the device happened to republish, so the same one-time prekey built session
     * after session. That is exactly what "one-time" is there to prevent: the responder's private half
     * goes into every one of those shared secrets, so a device compromised later opens all of them rather
     * than only the ones after.
     *
     * Keyed on the prekey id alone within a device's bundle, because that is what the sender received and
     * the only thing that identifies which key was spent.
     */
    CREATE TABLE IF NOT EXISTS prekey_issued (
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      opk_id INTEGER NOT NULL,
      issued_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_id, opk_id)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_prekeys_created ON prekeys(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active);
    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id);
    CREATE INDEX IF NOT EXISTS idx_reports_timestamp ON reports(timestamp);
`);

  // Case-insensitive nickname uniqueness, enforced by the database rather than by the caller.
  //
  // `users.nickname` is declared UNIQUE and SQLite's UNIQUE compares bytes, so on its own it is perfectly
  // happy to hold `Ana` and `ana` at once. `handleRegister` has always scanned for that case before
  // inserting, but the scan and the INSERT are separated by several awaits - the registration lock
  // acquisition among them - and the lock is keyed on the device and the address, not on the nickname. Two
  // registrations from different addresses for the two spellings can both pass the scan and both insert.
  // That is exactly the collision the scan exists to prevent, and it breaks nickname addressing everywhere
  // else: `getUserByNickname` is an exact match and is what DMs, blocking and the admin check all use.
  //
  // The index is the actual guarantee. It is created outside the schema block and its failure is tolerated,
  // because on a database that already holds two such accounts the CREATE throws - and a migration that
  // stops the server from starting is worse than the race it is closing. Those accounts keep the
  // application-level check; nothing new collides after this runs.
  try {
    d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_lower ON users (lower(nickname))');
  } catch {}

  for (const col of ['avatar_ext TEXT', 'avatar_updated_at INTEGER', 'banned_at INTEGER', 'identity_key TEXT']) {
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
  //
  // The ratchet is back, so the prekey table is created rather than dropped. Only the staging table the
  // old implementation used - which recorded which one-time prekeys had already been handed out, so
  // that the same bundle could not be served twice - is gone, and so are the three columns the ratchet
  // used to need on a message row. It no longer needs them: a ratchet body travels in the same
  // encrypted column as everything else, so history, quoting, editing and search all keep working
  // without knowing which kind of body they are carrying.
  try { d.exec('DROP TABLE IF EXISTS prekeys_issued'); } catch {}
  for (const col of ['signal_encrypted', 'x3dh_message', 'ratchet_public_key', 'sealed']) {
    try { d.exec(`ALTER TABLE messages DROP COLUMN ${col}`); } catch {}
  }

  // Sealed sender is gone for the same reason: a row filed under sealed:<recipientId> hid its own
  // author, so it could never be edited, deleted or searched by the person who wrote it. Anything
  // left from before the removal is deleted rather than relabelled, which would invent a sender.
  try {
    d.exec(`DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE channel LIKE 'sealed:%')`);
    d.exec(`DELETE FROM messages WHERE channel LIKE 'sealed:%'`);
  } catch {}

  try { d.exec('ALTER TABLE users DROP COLUMN sealed_key'); } catch {}

  // Registration events are rebuilt on one autoincrementing key.
  //
  // The old table was `PRIMARY KEY (scope, subject, created_at)` and rows were written with `INSERT OR
  // IGNORE`, so two accounts created in the same millisecond collided and one of them was silently dropped
  // from the count while both existed in the users table. `countRegistrations` then reported fewer accounts
  // than there were, which is the one direction a creation limit cannot fail in.
  //
  // `CREATE TABLE IF NOT EXISTS` cannot change an existing table, so it is rebuilt: renamed, recreated,
  // copied across, dropped - the same shape as the prekey migration below. The rows are copied rather than
  // discarded, because the budget a subject has already spent must survive the upgrade or the rebuild hands
  // every address a fresh allowance.
  const regCols = (d.prepare('PRAGMA table_info(registration_events)').all() as any[]);
  if (regCols.length > 0 && !regCols.some((c) => c.name === 'id')) {
    try {
      d.exec('ALTER TABLE registration_events RENAME TO registration_events_legacy');
      d.exec(`CREATE TABLE registration_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      d.exec('INSERT INTO registration_events (scope, subject, created_at) SELECT scope, subject, created_at FROM registration_events_legacy');
      d.exec('DROP TABLE registration_events_legacy');
      // Recreated here, not left to the statement above: `CREATE INDEX IF NOT EXISTS` at the top of this
      // function ran against the *old* table and followed it into the rename, so dropping the legacy table
      // took the index with it and the count queries would have run unindexed from here on.
      d.exec('CREATE INDEX IF NOT EXISTS registration_events_subject_time ON registration_events(scope, subject, created_at)');
    } catch (e) {
      console.warn('[db] could not rebuild registration_events on a per-event key:', e);
    }
  }
  // The old index led on (scope, created_at), which cannot serve the query the count actually runs - scope
  // and subject together - so it is replaced rather than kept alongside.
  try { d.exec('DROP INDEX IF EXISTS registration_events_scope_time'); } catch {}

  // Prekeys move from one row per account to one row per device.
  //
  // The old key cannot simply be left in place: keyed on the account alone, a second device signing in
  // overwrites the first device's bundle, and every sender then builds its session against material
  // that device no longer holds. So the rows are rebuilt under the new key, and the one device that was
  // using the old row keeps its identity key - which means it keeps every conversation already pinned
  // to it, the only outcome that does not sign people out of their own history. It republishes under its
  // own device id on the next sign-in, which replaces the placeholder row cleanly.
  const prekeyCols = (d.prepare('PRAGMA table_info(prekeys)').all() as any[]).map((c) => c.name);
  if (!prekeyCols.includes('device_id')) {
    try {
      const legacy = d.prepare('SELECT user_id, bundle, created_at FROM prekeys').all() as any[];
      d.exec('ALTER TABLE prekeys RENAME TO prekeys_legacy');
      d.exec(`CREATE TABLE prekeys (
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        bundle TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, device_id)
      )`);
      const insert = d.prepare('INSERT OR REPLACE INTO prekeys (user_id, device_id, bundle, created_at) VALUES (?, ?, ?, ?)');
      for (const row of legacy) {
        const device = (parseJson(row.bundle, null) as any)?.deviceId;
        insert.run(row.user_id, typeof device === 'string' && device ? device : 'legacy', row.bundle, row.created_at);
      }
      d.exec('DROP TABLE prekeys_legacy');
    } catch (e) {
      console.warn('[db] could not move prekeys to per-device rows:', e);
    }
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
    // In batches, for the same reason cleanupExpiredMessages is: one pass read every message body in the
    // database into memory and held the write lock for all of them, on a table that can hold anything.
    const take = getDb().prepare('SELECT rowid, text FROM messages WHERE text IS NOT NULL AND text != ? LIMIT ? OFFSET ?');
    const ins = getDb().prepare(`INSERT INTO ${FTS_TABLE} (rowid, text) VALUES (?, ?)`);
    let offset = 0;
    for (;;) {
      const rows = take.all('', CLEANUP_BATCH, offset) as { rowid: number; text: string }[];
      if (rows.length === 0) break;
      for (const r of rows) {
        try { ins.run(r.rowid, r.text); } catch {}
      }
      offset += rows.length;
      if (rows.length < CLEANUP_BATCH) break;
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

/**
 * How many rows one pass of a bulk delete removes.
 *
 * Sized against the write lock rather than against speed. `busy_timeout` is five seconds, so anything that
 * holds the write lock for longer than that does not queue — it fails, and it fails for whoever happened to
 * be sending a message at the time, which is the worst possible moment to hand somebody an error.
 *
 * Shared by every bulk delete in this file — the expiry sweep, the weekly clear of the general channel and
 * the one-off search-index backfill — because they all fail in the same way and all want the same bound.
 */
const CLEANUP_BATCH = 250;

/**
 * Removes rows from a **contentless** FTS5 index.
 *
 * A contentless table (`content=''`) stores no copy of the indexed text, so a row cannot be deleted by
 * its rowid alone: the exact text that was indexed has to be handed back in the 'delete' command, and
 * FTS5 removes the terms it finds. Two things follow, and both were live bugs:
 *
 *  - Deleting a rowid that was never indexed raises SQLITE_CORRUPT — "database disk image is malformed" —
 *    rather than doing nothing. That is an alarming message for what is really a bookkeeping mismatch, and
 *    the sweep hit it once per message whose body was written directly into `messages` without going
 *    through saveMessage, which is why a passing test run printed thousands of them. So the rowids are
 *    checked against the index first and only the ones actually present are asked to delete.
 *  - Handing back text that is not the indexed text also raises SQLITE_CORRUPT, and — worse — leaves the
 *    entry in place. So the text is only trusted when it really is what was indexed.
 *
 * Search correctness does not depend on any of this: `searchMessages` falls back to an `instr()` scan when
 * the index yields nothing. What depends on it is that a stale entry can send a search down the index path,
 * find a rowid, and then join to a message that is gone — and that a real database reports itself corrupt
 * for ordinary housekeeping.
 */
function ftsDropRowids(rowids: number[], texts: string[]): void {
  if (!ftsAvailable || rowids.length === 0) return;
  const d = getDb();
  try {
    // Chunked because a sweep hands this thousands of rowids at a time and the IN list has to stay under
    // SQLite's parameter limit.
    const present = new Set<number>();
    const CHUNK = 500;
    const probe = d.prepare(`SELECT rowid FROM ${FTS_TABLE} WHERE rowid IN (${new Array(Math.min(CHUNK, rowids.length)).fill('?').join(',')})`);
    for (let i = 0; i < rowids.length; i += CHUNK) {
      const slice = rowids.slice(i, i + CHUNK);
      for (const row of probe.all(...slice) as { rowid: number }[]) present.add(Number(row.rowid));
    }
    const del = d.prepare(`INSERT INTO ${FTS_TABLE} (${FTS_TABLE}, rowid, text) VALUES ('delete', ?, ?)`);
    for (let i = 0; i < rowids.length; i++) {
      if (!present.has(rowids[i])) continue;
      try {
        del.run(rowids[i], texts[i] ?? '');
      } catch (e) {
        // The indexed text did not match what was handed back, so the entry stays. That is a stale index
        // entry, not a lost message: the row is gone from `messages` either way and search falls back to
        // instr(). Worth one line, not one per row.
        console.warn('[db] FTS delete row failed:', (e as Error).message);
      }
    }
  } catch (e) {
    console.warn('[db] FTS delete failed:', (e as Error).message);
  }
}

/**
 * Drops one message's index entry, in bounded slices.
 *
 * Takes the rowid and the body from the caller, because by the time this runs the row is usually already
 * gone: `deleteMessage` reads them out here and *then* deletes. Reading them back with a query of its own,
 * as this used to, finds nothing once the DELETE has run, so the index kept the text of every deleted
 * message for the lifetime of the database.
 */
function syncFtsDeleteRows(rows: { rid: number; text: string }[]): void {
  if (!ftsAvailable || rows.length === 0) return;
  ftsDropRowids(rows.map((r) => r.rid), rows.map((r) => r.text));
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
      const ins = d.prepare('INSERT OR IGNORE INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, quoted_message_id, quoted_message_text, quoted_message_sender, edited_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const m of messages) {
        if (!m || typeof m.id !== 'string') continue;
        // A sealed message hid its own author, so it cannot become an ordinary direct message and is
        // not carried over; see the same note where old rows are dropped from an existing database.
        const channel = typeof m.channel === 'string' ? m.channel : 'general';
        if (channel.startsWith('sealed:')) continue;
        ins.run(
          m.id,
          typeof m.senderId === 'string' ? m.senderId : '',
          typeof m.senderNickname === 'string' ? m.senderNickname : '',
          typeof m.text === 'string' ? m.text : '',
          typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
          channel,
          json(m.encrypted),
          json(m.fileKey),
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
 * Stores one device's bundle: its identity key, signed prekey and a handful of one-time prekeys.
 *
 * Public material by design - it is what lets a stranger open a conversation - and replaced wholesale
 * whenever that device rotates. Keyed on the device as well as the account, so a second device signing
 * in does not overwrite the first one's material: a sender builds a session with each and seals a
 * separate body for each, which is what makes a message readable on a phone and a laptop at once
 * without any of them sharing key material.
 */
export async function setPreKeyBundle(userId: string, deviceId: string, bundle: any): Promise<void> {
  getDb().prepare('INSERT INTO prekeys (user_id, device_id, bundle, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, device_id) DO UPDATE SET bundle = excluded.bundle, created_at = excluded.created_at')
    .run(userId, deviceId, json(bundle), Date.now());
}

/**
 * Every bundle one account has published, one per device.
 *
 * The freshest row per device is what a sender wants, and since a device overwrites its own row on
 * every upload there is only ever one row per device to begin with.
 */
export async function getPreKeyBundlesByIds(ids: string[]): Promise<Record<string, { deviceId: string; bundle: any }[]>> {
  const out: Record<string, { deviceId: string; bundle: any }[]> = {};
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT user_id as userId, device_id as deviceId, bundle, created_at FROM prekeys WHERE user_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...ids) as any[];
  for (const r of rows) {
    const bundle = parseJson(r.bundle, null);
    if (!bundle) continue;
    (out[r.userId] ||= []).push({ deviceId: r.deviceId, bundle });
  }
  return out;
}

/**
 * The bundles to hand a sender, with spent one-time prekeys taken out.
 *
 * A bundle is a snapshot of several one-time prekeys, and the server has to remember which of them it has
 * already given away — otherwise every sender takes the same one, and the responder's private half ends
 * up in the shared secret of every session built against it. That is the property "one-time" exists for,
 * and losing it costs forward secrecy for all of them at once.
 *
 * A bundle with nothing left is still returned, without a one-time prekey. X3DH is defined over the
 * identity and signed prekeys alone, so the conversation still starts — the responder simply gets less
 * protection against later compromise of the device, which is the correct trade against handing out a key
 * twice. Devices replenish and republish on their own schedule, so this is a window, not a state.
 */
export async function takePreKeyBundlesForSender(ids: string[], requestedBy?: string | null): Promise<Record<string, { deviceId: string; bundle: any }[]>> {
  const db = getDb();
  const remaining = await getPreKeyBundlesByIds(ids);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO prekey_issued (user_id, device_id, opk_id, issued_at) VALUES (?, ?, ?, ?)',
  );
  const alreadyIssued = db.prepare(
    'SELECT opk_id FROM prekey_issued WHERE user_id = ? AND device_id = ?',
  );

  for (const [userId, entries] of Object.entries(remaining)) {
    // A device fetching its own bundles is not opening a session with itself, so nothing is spent. This
    // is not a rare case to be careful about: sign-in hands a client the list of its own devices so it
    // can seal a copy to its other screens, and a client that then asks for them over the wire would burn
    // a one-time prekey per device for nothing, draining the supply of an account that never had many.
    const selfFetch = !!requestedBy && requestedBy === userId;
    for (const entry of entries) {
      const opk = entry.bundle?.oneTimePreKey;
      if (!opk || typeof opk.keyId !== 'number') continue;

      const spent = alreadyIssued.all(userId, entry.deviceId) as any[];
      if (spent.some((r) => r.opk_id === opk.keyId)) {
        // taken already: leave it out rather than hand the same key to a second sender
        delete entry.bundle.oneTimePreKey;
        continue;
      }
      if (selfFetch) continue;
      insert.run(userId, entry.deviceId, opk.keyId, Date.now());
    }
  }
  return remaining;
}

/**
 * Forgets the record of spent keys for one device.
 *
 * Called when the device publishes a fresh bundle: those are new key ids, so the old bookkeeping does not
 * apply to them and keeping it would only grow.
 */
export async function resetIssuedPreKeys(userId: string, deviceId: string): Promise<void> {
  getDb().prepare('DELETE FROM prekey_issued WHERE user_id = ? AND device_id = ?').run(userId, deviceId);
}

/** The freshest bundle for an account, which is what a caller with a single device in mind wants. */
export async function getPreKeyBundle(userId: string): Promise<any | null> {
  const row = getDb().prepare('SELECT bundle FROM prekeys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as any;
  return row ? parseJson(row.bundle, null) : null;
}

/**
 * The account's own long-lived identity key, which is what a safety number is computed from.
 *
 * Deliberately separate from the per-device bundles above. A safety number has to be the same on every
 * device the account owns, or comparing it would mean comparing a different number per device and
 * proving nothing; so the number comes from one account-level key while the ratchet keys stay per
 * device. This is also the key a server would have to substitute to make two people read the same
 * wrong number, which is exactly why it is worth reading aloud.
 */
export async function getIdentityKeyB64(userId: string): Promise<string | null> {
  const row = getDb().prepare('SELECT identity_key FROM users WHERE id = ?').get(userId) as any;
  const key = row?.identity_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

export async function setIdentityKeyB64(userId: string, identityKey: string): Promise<void> {
  getDb().prepare('UPDATE users SET identity_key = ? WHERE id = ?').run(identityKey, userId);
}

/** Account-level identity keys for a set of accounts, for safety numbers. */
export async function getIdentityKeysByIds(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = getDb().prepare(`SELECT id, identity_key FROM users WHERE id IN (${placeholders})`).all(...ids) as any[];
  for (const r of rows) {
    if (typeof r.identity_key === 'string' && r.identity_key.length > 0) out[r.id] = r.identity_key;
  }
  return out;
}

/**
 * Forgets bundles nobody has refreshed. A stale signed prekey is worse than none: a sender would build
 * a session against material the owner has already replaced.
 */
export async function cleanupExpiredPreKeys(maxAgeMs: number): Promise<number> {
  const d = getDb();
  const res = d.prepare('DELETE FROM prekeys WHERE created_at < ?').run(Date.now() - maxAgeMs);
  // the record of what was spent from a bundle that no longer exists refers to keys nobody will be handed,
  // so it is not a protection against anything — it is only a table that grows
  try {
    d.prepare('DELETE FROM prekey_issued WHERE NOT EXISTS (SELECT 1 FROM prekeys WHERE prekeys.user_id = prekey_issued.user_id AND prekeys.device_id = prekey_issued.device_id)').run();
  } catch { /* a missing table is a fresh database, which has nothing to clean */ }
  return (res as any).changes;
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
   encrypted, file_key AS fileKey, quoted_message_id AS quotedMessageId,
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
    quotedMessageId: row.quotedMessageId || undefined,
    quotedMessageText: row.quotedMessageText || undefined,
    quotedMessageSender: row.quotedMessageSender || undefined,
      clientId: row.clientId || undefined,
    editedAt: row.editedAt || undefined,
    expiresAt: row.expiresAt || undefined,
  };
}

/**
 * The bodies a sender sealed for one conversation, one per device.
 *
 * Each is a complete ratchet body for a specific device, so the server is holding N copies of one message
 * and can open none of them - it does not know which device is which beyond the label the sender chose,
 * and the label is not what opens a body. A sender whose recipient has one device sends one body, which
 * is the ordinary case and exactly what it sent before.
 */
export interface DeviceBody {
  /** The device this body is for, as the recipient's own bundle was labelled. */
  deviceId: string;
  body: any;
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
  quotedMessageId?: string,
  editedAt?: number,
  expiresAt?: number,
   quotedMessageText?: string,
   quotedMessageSender?: string,
   clientId?: string
   ): Promise<void> {
     const d = getDb();
     const body = str(text);
     const ch = optStr(channel) ?? 'general';
     const res = d.prepare(`INSERT INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, quoted_message_id, quoted_message_text, quoted_message_sender, edited_at, expires_at, client_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
       .run(str(id), str(senderId), str(senderNickname), body, monotonicTimestamp(d, ch, optNum(timestamp)), ch, json(encrypted), json(fileKey), optStr(quotedMessageId), optStr(quotedMessageText), optStr(quotedMessageSender), optNum(editedAt), optNum(expiresAt), optStr(clientId));
     syncFtsInsert(Number((res as any).lastInsertRowid), body);
   }

/**
 * The newest timestamp already stored in a channel, so the next message can be given one strictly later.
 *
 * This exists because of how history is paged. `getRecentMessages` and `getDmHistory` walk backwards with
 * `WHERE timestamp < ?`, and the client sends back the oldest timestamp it is holding. Two messages that
 * share a millisecond therefore mean the second one is skipped forever: paging stops at the shared value
 * and never reaches it. `hasMore` is worked out from the row count, so it still reports the end of history
 * correctly - which is what makes the gap silent. In the public channel, where many senders share one
 * millisecond, this is not an edge case.
 *
 * The floor is held in memory and re-seeded from `MAX(timestamp)` the first time a channel is seen after
 * a restart, so the guarantee outlives the process. One extra indexed read per channel per process, and
 * nothing at all on the read path.
 *
 * The value handed back can be a millisecond or so ahead of the wall clock under a burst, which is the
 * price of an ordering the pagination can rely on. It does not drift: each write is measured against the
 * last one, so the skew is bounded by how fast messages actually arrive.
 */
const lastTimestampByChannel = new Map<string, number>();

function monotonicTimestamp(d: any, channel: string, requested?: number | null): number {
  const wanted = requested ?? Date.now();
  // Clamped. `wanted` is the timestamp the *sender* chose, and it becomes the floor for every message after
  // it in this channel - so one frame claiming next year would push the whole conversation's clock a year
  // into the future, permanently, and the real ordering it exists to preserve would be gone. A small skew
  // covers a genuine clock difference between two devices; anything larger is not a clock, it is a claim.
  const claim = Math.min(wanted, Date.now() + MAX_CLOCK_SKEW_MS);
  let floor = lastTimestampByChannel.get(channel);
  if (floor === undefined) {
    const row = d.prepare('SELECT MAX(timestamp) AS m FROM messages WHERE channel = ?').get(channel) as { m: number | null } | undefined;
    floor = row?.m ?? 0;
  }
  const chosen = claim > floor ? claim : floor + 1;
  // Re-seeding the cached floor only when the entry is new would leave the map holding one entry per channel
  // the process has ever seen, for the life of the process. Re-inserting instead moves the entry to the end,
  // and an LRU trim drops the ones nobody has written to in hours - which is every channel that is over.
  lastTimestampByChannel.delete(channel);
  lastTimestampByChannel.set(channel, chosen);
  if (lastTimestampByChannel.size > MAX_TRACKED_CHANNELS) {
    const oldest = lastTimestampByChannel.keys().next();
    if (!oldest.done) lastTimestampByChannel.delete(oldest.value);
  }
  return chosen;
}

export async function updateMessageText(messageId: string, senderId: string, newText: string): Promise<boolean> {
  const d = getDb();
  const before = d.prepare('SELECT text FROM messages WHERE id = ? AND sender_id = ?').get(messageId, senderId) as { text: string } | undefined;
  const res = d.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ? AND sender_id = ?')
    .run(newText, Date.now(), messageId, senderId);
  if ((res as any).changes > 0) syncFtsUpdate(messageId, before?.text ?? '', newText);
  return (res as any).changes > 0;
}

/**
 * Replaces the ciphertext of a message its author wrote.
 *
 * This is what makes a private message correctable at all. The server cannot rewrite the words, but it
 * does record who wrote a message, so it can swap one encrypted body for another and refuse anybody
 * else's. The text stays empty: a direct message is stored as ciphertext, and the client shows what it
 * decrypts.
 */
export async function updateEncryptedMessage(messageId: string, senderId: string, encrypted: any, expiresAt?: number): Promise<boolean> {
  const d = getDb();
  const res = d.prepare('UPDATE messages SET encrypted = ?, expires_at = COALESCE(?, expires_at), edited_at = ? WHERE id = ? AND sender_id = ?')
    .run(json(encrypted), optNum(expiresAt), Date.now(), messageId, senderId);
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
  const otherIds = [...contactMap.keys()]
    // Newest first, then capped. The list used to be every conversation this account has ever had, with no
    // limit, and every one of those ids became a placeholder in the `IN (...)` below. An account with a few
    // thousand old conversations therefore built a statement past `SQLITE_MAX_VARIABLE_NUMBER` on older
    // SQLite builds, which throws - and the throw reaches the client as a bare internal error for that
    // account alone. Chunking the lookup is what actually removes the ceiling; the cap is what stops the
    // frame from carrying every conversation anybody ever had.
    .sort((a, b) => (contactMap.get(b) ?? 0) - (contactMap.get(a) ?? 0))
    .slice(0, MAX_DM_CONTACTS);
  const userMap = new Map<string, string>();
  // Chunked rather than one wide statement, so the placeholder count stays under SQLite's variable limit.
  for (let i = 0; i < otherIds.length; i += MAX_DM_CONTACT_LOOKUP_BATCH) {
    const batch = otherIds.slice(i, i + MAX_DM_CONTACT_LOOKUP_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const users = d.prepare(`SELECT id, nickname FROM users WHERE id IN (${placeholders})`).all(...batch) as { id: string; nickname: string }[];
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
  // The index entry is removed first, while the row and its body can still be read.
  //
  // Order matters because the table is contentless: dropping the entry needs the exact text that was
  // indexed, and after the DELETE there is nothing left to read it from. syncFtsDelete used to be called
  // afterwards, found no row, and quietly kept the index entry — so every deleted message stayed in the
  // search index for good. The existing test passed anyway, because search falls back to an instr() scan
  // when the index yields a rowid whose message is gone; that fallback is what hid it.
  const row = d.prepare('SELECT rowid AS rid, text FROM messages WHERE id = ? AND sender_id = ?')
    .get(messageId, userId) as { rid: number; text: string } | undefined;
  // The scoped delete goes first, because everything after it is keyed on the row having been this
  // caller's to delete. The reactions purge used to run before it and was not scoped by `sender_id` at
  // all, so any user who was allowed to *attempt* a delete could wipe the reactions off someone else's
  // message: a general-channel message is deletable by every signed-in account, and a DM recipient can
  // ask to delete the sender's message. Both attempts returned NOT_FOUND - the caller was told it had
  // failed - while the reactions were already gone. Gate the purge on the delete having matched.
  const res = d.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ?').run(messageId, userId);
  if ((res as any).changes === 0) return false;
  d.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
  syncFtsDeleteRows(row ? [row] : []);
  return true;
}

/**
 * Empties the general channel, in bounded slices.
 *
 * This ran on Monday at midnight and was three unbounded statements: it read the text of *every* general
 * message into memory at once so the contentless search index could be told to drop it, deleted every
 * reaction in the channel in one statement, and then deleted every message in one statement. On a server
 * that had been up a while that is the whole channel held in memory and the write lock held for all of it -
 * past the five seconds `busy_timeout` waits, which means it does not queue, it fails, and it fails for
 * whoever happened to be sending a message at that moment.
 *
 * Same shape as `cleanupExpiredMessages`: take `CLEANUP_BATCH` ids, delete exactly that batch - reactions,
 * index entries and rows - and hand the event loop back before the next one. A clear that takes a minute now
 * holds the lock for milliseconds at a time, and the peak memory is one batch of message bodies.
 */
export async function deleteGeneralMessages(): Promise<number> {
  const d = getDb();
  const take = d.prepare(
    `SELECT id, rowid AS rid, text FROM messages WHERE channel IN ('general') LIMIT ?`
  );
  let removed = 0;
  for (;;) {
    // Read before the DELETE, for the same reason as deleteMessage: the contentless index needs the exact
    // text that was indexed, and after the row is gone there is nothing left to read it from.
    const rows = take.all(CLEANUP_BATCH) as { id: string; rid: number; text: string }[];
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const holes = ids.map(() => '?').join(',');
    d.prepare(`DELETE FROM reactions WHERE message_id IN (${holes})`).run(...ids);
    ftsDropRowids(rows.map((r) => r.rid), rows.map((r) => r.text));
    const res = d.prepare(`DELETE FROM messages WHERE id IN (${holes})`).run(...ids);
    removed += (res as any).changes;
    if (rows.length < CLEANUP_BATCH) break;
    await new Promise((r) => setImmediate(r));
  }
  return removed;
}

/**
 * Removes expired messages in bounded slices.
 *
 * This used to be three unbounded statements: a delete of every expired reaction, a delete of every expired
 * message, and a search-index sync that read the text of every expired message into memory at once. On a
 * server that had been running long enough for that to be a lot of rows, the middle statement held the write
 * lock for the whole delete — long past the five seconds a waiting writer is prepared to wait — so the
 * people who got errors were the ones sending messages, and they got them at cleanup time rather than at
 * any fault of their own.
 *
 * So each pass takes a bounded slice of ids, deletes exactly that slice, and hands the event loop back
 * before the next one. The lock is released between passes, the peak memory is one batch of message bodies
 * rather than all of them, and a cleanup that takes a minute holds the lock for a few milliseconds at a
 * time. It is still the same delete, just not all at once.
 */
export async function cleanupExpiredMessages(): Promise<number> {
  const d = getDb();
  const cutoff = Date.now();
  const take = d.prepare(
    `SELECT id, rowid AS rid, text FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`
  );
  let removed = 0;

  for (;;) {
    const rows = take.all(cutoff, CLEANUP_BATCH) as { id: string; rid: number; text: string }[];
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const holes = ids.map(() => '?').join(',');
    d.prepare(`DELETE FROM reactions WHERE message_id IN (${holes})`).run(...ids);
    ftsDropRowids(rows.map((r) => r.rid), rows.map((r) => r.text));
    const res = d.prepare(`DELETE FROM messages WHERE id IN (${holes})`).run(...ids);
    removed += (res as any).changes;
    if (rows.length < CLEANUP_BATCH) break;
    // give the socket handlers and the next writer a turn rather than holding the loop for the whole sweep
    await new Promise((r) => setImmediate(r));
  }
  return removed;
}

export async function startCleanupJobs(): Promise<void> {
  const tick = (label: string, job: () => Promise<number>) => {
    job().then(n => { if (n) console.log(`Cleaned ${n} expired ${label}`); })
      .catch(e => console.warn(`[db] ${label} cleanup failed:`, (e as Error).message));
  };
  setInterval(() => tick('messages', cleanupExpiredMessages), MESSAGE_CLEANUP_INTERVAL_MS).unref?.();
  // A bundle that has not been refreshed in this long is not the material its owner is using any more.
  setInterval(() => tick('prekeys', () => cleanupExpiredPreKeys(PREKEY_BUNDLE_TTL_MS)), SESSION_CLEANUP_INTERVAL_MS).unref?.();
  setInterval(() => tick('inactive sessions', () => pruneInactiveSessions(INACTIVE_SESSION_TTL_MS)), SESSION_CLEANUP_INTERVAL_MS).unref?.();
}

/**
 * Drops indexes that are exact duplicates of another on the same table.
 *
 * `messages(channel, timestamp)` was created twice - once as `idx_messages_channel_ts` and again as
 * `idx_messages_channel_time`, identical column for column. Removing the second `CREATE INDEX` only stops
 * *new* databases growing it: `CREATE INDEX IF NOT EXISTS` never touches an index that is already there, so
 * every install that ran the older build keeps paying for a second structure on every insert, and keeps paying
 * for it for as long as the file is written at all.
 *
 * Safe to run on every start, which is what makes it worth doing this way rather than in a versioned
 * migration: dropping an index SQLite already knows it does not need cannot lose data, and the cost is
 * proportional to what it removes rather than to the table.
 */
function dropRedundantIndexes(): void {
  const d = getDb();
  const existing = d.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'").all() as
    { name: string; tbl_name: string }[];
  // Grouped by table and the columns it covers, so anything duplicated by accident is found rather than only
  // the one this was found by.
  const byShape = new Map<string, Set<string>>();
  for (const row of existing) {
    let columns: { name: string }[] | null = null;
    try {
      columns = d.prepare(`PRAGMA index_info('${row.name.replace(/'/g, "''")}')`).all() as { name: string }[];
    } catch {
      continue;
    }
    const signature = `${row.tbl_name}(${(columns || []).map((c) => c.name).join(',')})`;
    if (!byShape.has(signature)) byShape.set(signature, new Set());
    byShape.get(signature)!.add(row.name);
  }
  for (const [signature, names] of byShape) {
    if (names.size < 2) continue;
    // Keep one - preferring the shorter name, so the survivor is the one that reads like the original.
    const keep = [...names].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    for (const name of names) {
      if (name === keep) continue;
      try {
        d.exec(`DROP INDEX IF EXISTS "${name.replace(/"/g, '""')}"`);
        console.log(`[db] dropped duplicate index ${name} on ${signature}`);
      } catch (e) {
        // Said out loud on purpose. The catch used to be empty, which is indistinguishable from "there were
        // no duplicates to drop": SQLite refuses to drop an index that backs a UNIQUE constraint or a
        // PRIMARY KEY, and those names do reach here, so the operator saw silence on every start of every
        // database and could not tell a clean sweep from a refused one. The attempt is a harmless no-op and
        // this is only worth a line when it actually happens.
        console.warn(`[db] could not drop duplicate index ${name} on ${signature}:`, (e as Error).message);
      }
    }
  }
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
  dropRedundantIndexes();
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

/**
 * Counts the accounts one subject has created inside a window.
 *
 * Backed by rows rather than a running total, so the answer survives a restart and can be checked against
 * the accounts that actually exist. `withinMs` is a sliding window, matching what the limit promises to
 * the person being refused: "N in the last day" rather than "N on the calendar day".
 */
export async function countRegistrations(scope: string, subject: string, withinMs: number): Promise<number> {
  const since = Date.now() - withinMs;
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM registration_events WHERE scope = ? AND subject = ? AND created_at > ?')
    .get(scope, subject, since) as any;
  return row?.c ?? 0;
}

/**
 * When the oldest event in the window happened, for telling someone how long until a slot frees up.
 *
 * Returns null when there is nothing to wait for, which the caller should not treat as zero: it means the
 * subject has no events at all, not that one expires this instant.
 */
export async function oldestRegistration(scope: string, subject: string, withinMs: number): Promise<number | null> {
  const since = Date.now() - withinMs;
  const row = getDb()
    .prepare('SELECT MIN(created_at) AS t FROM registration_events WHERE scope = ? AND subject = ? AND created_at > ?')
    .get(scope, subject, since) as any;
  return typeof row?.t === 'number' ? row.t : null;
}

/**
 * Records that one subject created one account.
 *
 * Rows are pruned on write rather than by a sweeper, because registration is rare enough that a periodic
 * job would be more machinery than the cleanup is worth - and a limit whose storage grows without bound is
 * a slow-motion version of the problem this replaced.
 */
export async function recordRegistrationEvent(scope: string, subject: string, createdAt = Date.now()): Promise<void> {
  const d = getDb();
  // Plain INSERT, and one row per event. `INSERT OR IGNORE` against the old `(scope, subject, created_at)`
  // primary key collapsed a burst that landed in the same millisecond into a single counted row, so a spammer
  // got N accounts for the price of one against the ceiling.
  d.prepare('INSERT INTO registration_events (scope, subject, created_at) VALUES (?, ?, ?)')
    .run(scope, subject, createdAt);
  // Only the scopes still being limited need keeping; anything else is dead weight from a window that has
  // since closed or a ceiling that has since been lifted.
  d.prepare('DELETE FROM registration_events WHERE created_at <= ?').run(createdAt - REGISTRATION_EVENT_RETENTION_MS);
}

/** Drops every recorded creation. For "forget everything" and for tests that want a clean slate. */
export async function clearRegistrationEvents(): Promise<void> {
  getDb().prepare('DELETE FROM registration_events').run();
}

export async function getReports(): Promise<any[]> {  return getDb().prepare('SELECT id, reporter_id as reporterId, reporter_nick as "reporterNick", target_id as targetId, target_nick as "targetNick", channel, message_id as messageId, message_text as messageText, reason, source, timestamp FROM reports ORDER BY timestamp DESC').all() as any[];
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
