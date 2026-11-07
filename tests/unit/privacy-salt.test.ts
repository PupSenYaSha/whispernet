import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * The pseudonym in the security log is only worth something if it stops being worth something.
 *
 * The claim is that addresses are written under a daily-rotating HMAC, so an operator cannot read one
 * person's movement off a month of the file. For a long time the code said "daily-rotating" and did not
 * rotate: a single random salt was written once and read back for every day after. That is the exact
 * outcome the rotation exists to prevent, and the README claimed it happened.
 *
 * These check the property rather than the mechanism — that a day's entries cannot be reproduced once
 * the day is over — because the mechanism is free to change and the property is what matters.
 */

let dataDir = '';
let restoreDate: () => void = () => {};

/**
 * Pins the clock for the duration of a test, because the salt is chosen by the date.
 *
 * The constructor has to be replaced, not just `Date.now`: `new Date()` with no arguments reads the
 * clock internally and does not go through the static method, so patching `Date.now` alone leaves the
 * real day in place and every rotation assertion passes against the wrong date.
 */
function freezeAt(iso: string): void {
  const when = new Date(iso).getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    // the overload set of Date is narrower than its runtime behaviour, so this has to widen it back
    constructor(...args: [] | [number] | [string] | [number, number, number] | [number, number, number, number] | [number, number, number, number, number, number]) {
      if (args.length === 0) super(when);
      else super(...(args as [number]));
    }
    static override now(): number { return when; }
  }
  (globalThis as any).Date = FrozenDate;
  restoreDate = () => { (globalThis as any).Date = RealDate; };
}

/**
 * A fresh copy of the module pointed at a fresh directory.
 *
 * Fresh is the point: the salt is cached in module state on purpose, so reusing the module would reuse
 * yesterday's key and every rotation assertion here would pass for the wrong reason.
 */
async function loadPrivacy(iso: string): Promise<{ pseudonymizeAddress: (ip: string) => string; saltFile: () => string }> {
  freezeAt(iso);
  vi.resetModules();
  const db = await import('../../server/database');
  db.setDataDir(dataDir);
  const { pseudonymizeAddress } = await import('../../server/privacy');
  return {
    pseudonymizeAddress,
    saltFile: () => fs.readFileSync(path.join(dataDir, 'log-salt'), 'utf8'),
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-privacy-'));
});

afterEach(() => {
  restoreDate();
  restoreDate = () => {};
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the address in the security log', () => {
  it('reads the same within a day, so one person can still be correlated with themselves', async () => {
    const { pseudonymizeAddress } = await loadPrivacy('2026-03-04T10:00:00Z');
    expect(pseudonymizeAddress('203.0.113.7')).toBe(pseudonymizeAddress('203.0.113.7'));
    expect(pseudonymizeAddress('203.0.113.7')).not.toBe(pseudonymizeAddress('203.0.113.8'));
  });

  it('does not read the same on the next day, which is the whole point', async () => {
    const today = await loadPrivacy('2026-03-04T23:59:00Z');
    const todayValue = today.pseudonymizeAddress('203.0.113.7');

    const tomorrow = await loadPrivacy('2026-03-05T00:01:00Z');
    const tomorrowValue = tomorrow.pseudonymizeAddress('203.0.113.7');

    expect(tomorrowValue).not.toBe(todayValue);
  });

  it('replaces the salt on disk rather than keeping the old one beside it', async () => {
    const first = await loadPrivacy('2026-03-04T10:00:00Z');
    first.pseudonymizeAddress('203.0.113.7');
    const firstSalt = first.saltFile();

    const second = await loadPrivacy('2026-03-05T10:00:00Z');
    second.pseudonymizeAddress('203.0.113.7');
    const secondSalt = second.saltFile();

    // if yesterday's salt were still in the file, an operator holding it could reproduce yesterday's
    // entries exactly, which is the whole thing the rotation is for
    expect(secondSalt).not.toBe(firstSalt);
    expect(JSON.parse(secondSalt).day).toBe('2026-03-05');
  });

  it('discards a salt written by the version that never rotated', async () => {
    // a bare 32-byte file, which is what the old code left behind
    fs.writeFileSync(path.join(dataDir, 'log-salt'), Buffer.alloc(32, 7));
    const { pseudonymizeAddress, saltFile } = await loadPrivacy('2026-03-04T10:00:00Z');
    const value = pseudonymizeAddress('203.0.113.7');

    // it did not keep serving the old salt, and it did not crash on the shape it did not expect
    expect(value).toBeTruthy();
    expect(JSON.parse(saltFile()).day).toBe('2026-03-04');
  });

  it('keeps the same salt across a restart inside one day', async () => {
    const before = await loadPrivacy('2026-03-04T10:00:00Z');
    const value = before.pseudonymizeAddress('203.0.113.7');

    // a fresh module is what a restarted process has, and a mid-day restart must not orphan the entries
    // already written under the old one
    const after = await loadPrivacy('2026-03-04T18:00:00Z');
    expect(after.pseudonymizeAddress('203.0.113.7')).toBe(value);
  });
});