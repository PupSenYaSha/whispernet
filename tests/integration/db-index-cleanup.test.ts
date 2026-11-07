import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A duplicate index costs on every write and never earns anything.
 *
 * `messages(channel, timestamp)` was created twice, under two names, identical column for column. Deleting the
 * second `CREATE INDEX` only stops new databases growing it: `CREATE INDEX IF NOT EXISTS` leaves an index that
 * is already there alone, so every install that ran the older build would otherwise keep maintaining two
 * identical structures on the `messages` table for as long as the server runs.
 *
 * Which means the cleanup has to be a real migration, not an edit to the schema, and this test is what tells
 * the difference: it plants the duplicate on disk the way an old install would have it, then starts the
 * server over that file.
 */

let dataDir: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-index-'));
});

afterAll(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('starting over a database that already grew a duplicate index', () => {
  it('drops it', async () => {
    // A database with the duplicate already present, as an install that ran the older build would have.
    const dbPath = path.join(dataDir, 'whispernet.db');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      expires_at INTEGER
    );`);
    seed.exec('CREATE INDEX idx_messages_channel_ts ON messages(channel, timestamp);');
    seed.exec('CREATE INDEX idx_messages_channel_time ON messages(channel, timestamp);');
    seed.close();

    const beforeDb = new DatabaseSync(dbPath);
    const before = beforeDb
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND name LIKE 'idx_messages_channel%'")
      .get() as any;
    beforeDb.close();
    expect(before.c, 'the seed did not plant the duplicate').toBe(2);

    process.env.DATA_DIR = dataDir;
    const { setDataDir, initializeDatabase, getDb } = await import('../../server/database');
    setDataDir(dataDir);
    initializeDatabase();

    const d = getDb();
    const after = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages' AND name LIKE 'idx_messages_channel%'").all() as { name: string }[];
    expect(after.map((r) => r.name), 'the duplicate index survived the start').toEqual(['idx_messages_channel_ts']);

    // The surviving index must still work, or the cleanup has cost the query plan it was providing.
    d.prepare('INSERT INTO messages (id, channel, sender_id, text, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run('m1', 'general', 'u1', 'hi', Date.now());
    const rows = d.prepare('SELECT id FROM messages WHERE channel = ? ORDER BY timestamp').all('general');
    expect(rows).toHaveLength(1);
  }, 60000);
});
