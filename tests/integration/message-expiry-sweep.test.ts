import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type StartedServer } from '../helpers';

/**
 * Disappearing messages, and what they do to everybody else while they happen.
 *
 * The sweep used to be three unbounded statements: every expired reaction, every expired message, and a
 * search-index sync that read the text of every expired message into memory at once. The problem is not the
 * delete, it is the lock. `busy_timeout` is five seconds, so a sweep holding the write lock longer than that
 * does not make writers wait — it makes them fail, and it fails for whoever happened to be sending a message
 * at the time, which is the worst moment to hand somebody an error.
 *
 * So the sweep takes a bounded slice of ids, deletes exactly that slice, and yields before the next one. The
 * lock is released between passes, and peak memory is one batch of message bodies rather than all of them.
 *
 * Rows go in directly rather than over a websocket: there is a two-per-second rate limit on sending, so
 * filling the table this way would take five minutes and would be testing the send path instead of the
 * sweep. What matters here is what the sweep finds in a database a server actually wrote to.
 */

let server: StartedServer;
let cleanup: () => Promise<number>;
let getDb: () => any;

beforeAll(async () => {
  server = await startTestServer();
  const db = await import('../../server/database');
  cleanup = db.cleanupExpiredMessages;
  getDb = db.getDb;
});

afterAll(async () => {
  await server.stop();
});

const count = (sql: string, ...args: any[]): number =>
  (getDb().prepare(sql).get(...args) as any).n as number;

/** Writes `n` rows directly, expired if `expired`, so a batch boundary falls in the middle of them. */
function seed(tag: string, n: number, expired: boolean): string[] {
  const d = getDb();
  d.prepare('DELETE FROM messages').run();
  d.prepare('DELETE FROM reactions').run();
  const insert = d.prepare(
    `INSERT INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, expires_at, client_id)
     VALUES (?, ?, ?, ?, ?, 'general', 0, '{}', ?, ?)`
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${tag}-${i}`;
    insert.run(id, 'someone', 'someone', `body ${tag} ${i}`.repeat(40), Date.now(), expired ? Date.now() - 60_000 : null, id);
    ids.push(id);
  }
  return ids;
}

describe('the disappearing-message sweep', () => {
  it('removes every expired message even when there are more than fit in one batch', async () => {
    // comfortably more than the batch size, so the loop has to run more than once and "did it finish"
    // cannot be answered by the first pass
    seed('bulk', 600, true);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'bulk-%'`)).toBe(600);

    const removed = await cleanup();

    expect(removed).toBe(600);
    expect(
      count(`SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'bulk-%'`),
      'the sweep reported it was finished while rows were still there',
    ).toBe(0);
  });

  it('takes the reactions with it', async () => {
    // a surviving reaction points at a message that no longer exists: the words are gone but the fact that
    // somebody reacted, and when, is not
    seed('react', 5, true);
    getDb().prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run('react-0', 'someone', 'x');
    getDb().prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run('react-1', 'other', 'y');

    await cleanup();

    expect(count('SELECT COUNT(*) AS n FROM reactions'), 'a reaction outlived its message').toBe(0);
  });

  it('leaves a message that has not expired alone', async () => {
    seed('live', 5, false);

    await cleanup();

    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'live-%'`)).toBe(5);
  });

  it('is a no-op on an empty table rather than an error', async () => {
    seed('none', 0, true);
    expect(await cleanup()).toBe(0);
  });
});

describe('the sweep and the lock', () => {
  it('keeps accepting writes from somebody sending a message while it runs', async () => {
    // the property batching exists to provide. A single sweep of a large table used to hold the write lock
    // for its whole duration, past the five seconds a writer waits, and the writer who lost was whoever was
    // sending a message at that moment.
    seed('drain', 3000, true);
    const d = getDb();

    let writesDuringSweep = 0;
    let failed = 0;
    const sweep = cleanup();
    // hammer the table from the outside for as long as the sweep is going, which is the contention being
    // claimed to be survivable
    while (true) {
      const settled = await Promise.race([sweep.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 0))]);
      try {
        d.prepare(
          `INSERT INTO messages (id, sender_id, sender_nickname, text, timestamp, channel, encrypted, file_key, expires_at, client_id)
           VALUES (?, 'someone', 'someone', 'sent during the sweep', ?, 'general', 0, '{}', NULL, ?)`
        ).run(`live-${writesDuringSweep}`, Date.now(), `live-${writesDuringSweep}`);
        writesDuringSweep++;
      } catch {
        failed++;
        if (failed > 3) break;
      }
      if (settled) break;
    }
    await sweep;

    expect(writesDuringSweep, 'nothing could be written while the sweep was running').toBeGreaterThan(10);
    expect(failed, 'writes were rejected with SQLITE_BUSY during the sweep').toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'drain-%'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE id LIKE 'live-%'`)).toBe(writesDuringSweep);
  });
});