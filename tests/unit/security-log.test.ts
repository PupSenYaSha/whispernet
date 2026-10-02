import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The security log is the largest record of behaviour the operator of a self-hosted messenger will
 * ever hold, so it is capped. This exists because it was once described as growing without bound, and
 * nothing caught it: the cap was already in place and had simply never been exercised.
 *
 * The module remembers which file it is appending to, so every test gets a directory of its own
 * rather than sharing one and having the cached size disagree with what is on disk.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

async function freshLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-log-'));
  dirs.push(dir);
  const db = await import('../../server/database');
  db.setDataDir(dir);
  const privacy = await import('../../server/privacy');
  return {
    append: privacy.appendSecurityLine,
    dir,
    size: (name: string) => (fs.existsSync(path.join(dir, name)) ? fs.statSync(path.join(dir, name)).size : 0),
  };
}

describe('the security log', () => {
  it('writes a line', async () => {
    const log = await freshLog();
    log.append('[t] LOGIN_OK {}\n');
    expect(fs.readFileSync(path.join(log.dir, 'security.log'), 'utf8')).toContain('LOGIN_OK');
  });

  it('keeps appending rather than replacing what is already there', async () => {
    const log = await freshLog();
    log.append('first\n');
    log.append('second\n');
    const text = fs.readFileSync(path.join(log.dir, 'security.log'), 'utf8');
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  it('moves the file aside instead of truncating it when it passes the cap', async () => {
    const log = await freshLog();
    // one byte past eight megabytes
    const line = 'x'.repeat(1024) + '\n';
    for (let i = 0; i < 8 * 1024 + 2; i++) log.append(line);

    expect(log.size('security.log.1')).toBeGreaterThan(0);
    // the pair stays near the cap rather than growing without bound
    expect(log.size('security.log.1') + log.size('security.log')).toBeLessThan(20 * 1024 * 1024);
    expect(log.size('security.log')).toBeLessThanOrEqual(8 * 1024 * 1024 + 2048);
  });

  it('stays a readable file through a rotation', async () => {
    const log = await freshLog();
    const line = 'y'.repeat(4096) + '\n';
    for (let i = 0; i < 2100; i++) log.append(line);
    expect(fs.statSync(path.join(log.dir, 'security.log')).isFile()).toBe(true);
  });

  it('starts a fresh cap cycle after rotating', async () => {
    const log = await freshLog();
    const line = 'z'.repeat(1024) + '\n';
    for (let i = 0; i < 8 * 1024 + 2; i++) log.append(line);
    const afterFirst = log.size('security.log');
    // well under the cap again, so the next cycle starts from a small file
    expect(afterFirst).toBeLessThan(8 * 1024 * 1024);
    for (let i = 0; i < 1000; i++) log.append(line);
    expect(log.size('security.log')).toBeLessThanOrEqual(8 * 1024 * 1024 + 2048);
  });
});