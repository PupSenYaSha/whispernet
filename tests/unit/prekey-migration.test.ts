import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The prekey migration, on a database that actually has the old shape.
 *
 * Every other test runs `initializeDatabase` against a fresh file, so the whole file - including the
 * schema this app used before per-device bundles - takes the `CREATE TABLE IF NOT EXISTS` path and the
 * migration never runs. Which means the one piece of code that has to handle somebody's existing data is
 * the one piece with no coverage, and it renames a table.
 *
 * If it is wrong it is wrong destructively: the rows are copied out and the old table dropped, so a
 * mistake here loses the prekeys of every account on the server and with them the ability to open a single
 * message sent since the last rotation.
 *
 * So: build the old schema by hand, put rows in it, run the migration, and check they came out the other
 * side with the identity keys intact.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-migrate-'));
const dbPath = path.join(dir, 'whispernet.db');
process.env.DATA_DIR = dir;
process.env.DISABLE_RATE_LIMITS = '1';

const db = new DatabaseSync(dbPath);

// The schema as it was: prekeys keyed on the account alone, no identity_key on users, no per-device row.
db.exec(`
  CREATE TABLE users (
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
    sealed_key TEXT
  );
  CREATE TABLE prekeys (
    user_id TEXT PRIMARY KEY,
    bundle TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const identityKey = Buffer.from('an-identity-key-of-thirty-two-bytes!!').toString('base64');
const bundle = (deviceId?: string) => JSON.stringify({
  version: 2,
  identityKey,
  ed25519PublicKey: identityKey,
  signedPreKey: { keyId: 3, publicKey: identityKey, signature: [1, 2, 3], createdAt: 1700000000000 },
  oneTimePreKey: { keyId: 1, publicKey: identityKey },
  // a modern client already stamps this; an older one does not
  ...(deviceId ? { deviceId } : {}),
});

const insertUser = db.prepare('INSERT INTO users (id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?)');
const insertPrekey = db.prepare('INSERT INTO prekeys (user_id, bundle, created_at) VALUES (?, ?, ?)');
insertUser.run('id-with-device', 'alice', 'h', 1);
insertUser.run('id-no-device', 'bob', 'h', 2);
insertPrekey.run('id-with-device', bundle('alice-phone'), 100);
insertPrekey.run('id-no-device', bundle(), 200);
insertUser.run('id-no-prekeys', 'carol', 'h', 3);

// the columns the ratchet no longer uses on a message row, which the migration is also meant to clear
db.exec(`CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  sender_nickname TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'general',
  encrypted TEXT,
  file_key TEXT,
  signal_encrypted TEXT,
  x3dh_message TEXT,
  ratchet_public_key TEXT,
  sealed TEXT,
  quoted_message_id TEXT,
  quoted_message_text TEXT,
  quoted_message_sender TEXT,
  edited_at INTEGER,
  expires_at INTEGER
)`);
db.close();

/**
 * Run against one old-shaped database.
 *
 * A function rather than a bare block because the migration runs once per process - the database module
 * keeps its handle open and caches the schema check - so the whole arrangement has to happen inside one
 * test to be repeatable.
 */
async function migrateOldSchema(): Promise<any> {
  const { setDataDir, initializeDatabase } = await import('../../server/database');
  setDataDir(dir);
  initializeDatabase();
  const conn = new DatabaseSync(dbPath);
  return {
    conn,
    cols: (t: string) => conn.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => c.name),
  };
}

describe('bringing an existing database onto per-device prekeys', () => {
  it('keeps every published bundle, and lets a second device add to it rather than replace it', async () => {
    const { conn: after, cols } = await migrateOldSchema();

    expect(cols('prekeys')).toContain('device_id');
    expect(cols('prekeys_legacy'), 'the staging table should not survive').toHaveLength(0);
    expect(cols('users')).toContain('identity_key');
    // the column sealed sender needed, dropped when sealed sender went
    expect(cols('users')).not.toContain('sealed_key');
    // and the ones the ratchet does not use any more, left on a message row by earlier versions
    expect(cols('messages'), 'columns for a protocol the server no longer speaks are still on the schema')
      .not.toContain('sealed');

    const rows = after.prepare('SELECT user_id, device_id, bundle FROM prekeys ORDER BY user_id').all() as any[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.parse(row.bundle).identityKey, `identity key lost for ${row.user_id}`).toBe(identityKey);
    }
    // a bundle that named its own device keeps that name; one that did not gets a placeholder the client
    // overwrites on the next sign-in
    expect(rows.find((r) => r.user_id === 'id-with-device').device_id).toBe('alice-phone');
    expect(rows.find((r) => r.user_id === 'id-no-device').device_id).toBe('legacy');

    // the point of the whole exercise: the same account on a second device can now publish without
    // destroying the first one's row
    after.prepare('INSERT INTO prekeys (user_id, device_id, bundle, created_at) VALUES (?, ?, ?, ?)')
      .run('id-with-device', 'alice-laptop', bundle('alice-laptop'), 300);
    const perDevice = after.prepare('SELECT COUNT(*) as c FROM prekeys WHERE user_id = ?').get('id-with-device') as any;
    expect(perDevice.c, 'a second device replaced the first instead of adding to it').toBe(2);

    // and an account with no prekeys at all is untouched rather than invented
    const carol = after.prepare('SELECT COUNT(*) as c FROM prekeys WHERE user_id = ?').get('id-no-prekeys') as any;
    expect(carol.c).toBe(0);

    after.close();
    // The database module keeps its own handle open for the rest of the process, so the directory cannot
    // be removed here; it is under the temp directory and will go with it.
    void fs;
  }, 20000);
});