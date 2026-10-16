import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataDir } from './database.js';

/**
 * Everything the server writes down about who connected and when. The point of a messenger is that
 * the operator cannot read the messages; the next step is to not hand them a map of who talks to
 * whom either, so this module exists to be the only place that ever writes an address or a device
 * name to disk.
 */

const SALT_FILE = 'log-salt';
let cachedSalt: Buffer | null = null;
let cachedDay: string | null = null;
let activeFile: string | null = null;
let activeBytes = 0;

/**
 * Addresses are not stored raw, and the pseudonym is worth nothing the next day.
 *
 * This said "daily-rotating" for a long time and did not rotate at all: the salt was written once to
 * `log-salt` and then read back for every day after, so one stable HMAC sat behind every entry the log
 * would ever hold. An operator could grep a month of it and read one person's movement straight off,
 * which is the exact thing the rotation was supposed to prevent — and the README claimed it happened.
 *
 * The salt is now per day and derived from nothing: a fresh `randomBytes` when the day changes, written
 * over the old file so the previous day's key is gone. That matters in both directions — a leaked salt
 * cannot be walked backwards to recover the addresses behind yesterday's entries, because the salt that
 * hashed them no longer exists.
 *
 * A restart inside the same day reuses the file, and has to: without it two connections from one person
 * on one day would not correlate, and correlating those is the log's entire remaining value.
 */
function dailySalt(): Buffer {
  const day = new Date().toISOString().slice(0, 10);
  if (cachedSalt && cachedDay === day) return cachedSalt;
  const file = path.join(getDataDir(), SALT_FILE);
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: string; salt?: string };
    if (stored?.day === day && typeof stored.salt === 'string' && stored.salt.length > 0) {
      cachedSalt = Buffer.from(stored.salt, 'base64');
      cachedDay = day;
      return cachedSalt;
    }
  } catch {}
  // a new day, or a file left by the version that never rotated: either way this is a fresh key, and
  // writing it over replaces the old one rather than keeping it beside it
  const salt = crypto.randomBytes(32);
  cachedSalt = salt;
  cachedDay = day;
  try {
    fs.writeFileSync(file, JSON.stringify({ day, salt: salt.toString('base64') }), { mode: 0o600 });
  } catch {}
  return salt;
}

export function pseudonymizeAddress(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  return crypto.createHmac('sha256', dailySalt()).update(ip).digest('base64url').slice(0, 16);
}

/**
 * The same pseudonym, under the salt that does not rotate - and only for the one scope that counts rows.
 *
 * `pseudonymizeAddress` above is keyed by the day, which is right for a log and quietly wrong for a limit.
 * The registration counters count rows in `registration_events` whose subject column holds this value, so a
 * new key every midnight means every address starts again at zero at 00:00 UTC: "40 accounts in the last
 * 24 hours" was in fact "40 per UTC day", and the promise made in MAX_REGISTRATIONS_PER_IP was not the one
 * the code kept. The device scope never had this problem - it was already on `stableSalt`, which is
 * documented above as being the salt for exactly this reason.
 *
 * The split is deliberate and narrow: the log gets the rotating pseudonym, because joining one person's
 * addresses across days is what the rotation exists to stop, and only the counted scope gets this one,
 * because a counter keyed on a value that changes every morning is a counter that never fills. Both are
 * HMACs over the same input to a server-held secret, truncated identically, so neither tells an operator
 * which address it stands for.
 */
export function stablePseudonymizeAddress(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  return crypto.createHmac('sha256', stableSalt()).update(ip).digest('base64url').slice(0, 16);
}

const LIMIT_SALT_FILE = 'limit-salt';
let cachedLimitSalt: Buffer | null = null;

/**
 * A salt that does *not* rotate, for keys that have to keep meaning the same thing tomorrow.
 *
 * The log salt above is deliberately worthless by the next day, which is right for a log and useless here:
 * the registration limits count rows keyed on this pseudonym, so rotating it would make every account look
 * brand new each morning and the limits would never reach their ceiling at all. The two needs are opposite,
 * so they get two files rather than one compromise.
 *
 * The value is only ever used to group identical inputs - nothing is recovered from it and nothing is
 * compared across servers - so it is a stable secret rather than a rotating one, and rotating it would
 * hand everyone a fresh allowance, which is the same as having no limit.
 */
function stableSalt(): Buffer {
  if (cachedLimitSalt) return cachedLimitSalt;
  const file = path.join(getDataDir(), LIMIT_SALT_FILE);
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { salt?: string };
    if (typeof stored?.salt === 'string' && stored.salt.length > 0) {
      cachedLimitSalt = Buffer.from(stored.salt, 'base64');
      return cachedLimitSalt;
    }
  } catch {}
  const salt = crypto.randomBytes(32);
  cachedLimitSalt = salt;
  try { fs.writeFileSync(file, JSON.stringify({ salt: salt.toString('base64') }), { mode: 0o600 }); } catch {}
  return salt;
}

/**
 * A device id reduced to a stable pseudonym, for counting rather than identifying.
 *
 * A device id is a client-supplied UUID, not a credential, and it is already stored against sessions - but
 * here it would be stored with no account attached to it, which is a list of machines that exist whether or
 * not their owners ever signed in. Hashing it keeps that list to one opaque value per machine.
 *
 * Truncated to 16 base64url characters, the same as the address pseudonym: 96 bits, and these are never
 * brute-forced because UUIDs are not guessable.
 */
export function pseudonymizeDevice(deviceId: string): string {
  if (!deviceId) return 'unknown';
  return crypto.createHmac('sha256', stableSalt()).update(deviceId).digest('base64url').slice(0, 16);
}

/**
 * A device string is a fingerprint, so only a coarse label survives. Version numbers and hardware
 * models are dropped: together with a nickname they would identify one person's machine, and their
 * only use on this screen is telling the account owner which session to revoke.
 *
 * Two shapes arrive here. Current clients send something like "Chrome 120 on Windows"; older ones
 * send a full user agent, which falls through to the pattern matching below.
 */
export function coarsenDeviceLabel(deviceInfo: unknown): string {
  if (typeof deviceInfo !== 'string' || !deviceInfo) return '';
  const text = deviceInfo.slice(0, 200);

  if (/Mozilla|Safari\/|Chrome\/|Firefox\/|Edg\/|OPR\//i.test(text)) {
    let platform = 'unknown';
    let browser = 'unknown';
    if (/Android/i.test(text)) platform = 'Android';
    else if (/iPhone|iPad|iPod/i.test(text)) platform = 'iOS';
    else if (/Windows/i.test(text)) platform = 'Windows';
    else if (/Mac OS X|Macintosh/i.test(text)) platform = 'macOS';
    else if (/Linux/i.test(text)) platform = 'Linux';

    if (/Edg\//i.test(text)) browser = 'Edge';
    else if (/OPR\//i.test(text)) browser = 'Opera';
    else if (/Firefox\//i.test(text)) browser = 'Firefox';
    else if (/Chrome\//i.test(text)) browser = 'Chrome';
    else if (/Safari\//i.test(text)) browser = 'Safari';
    return `${browser} on ${platform}`;
  }

  // an already-coarse label: keep the words, lose the digits
  return text.replace(/\d+(\.\d+)*/g, '').replace(/\s{2,}/g, ' ').trim().slice(0, 40);
}

const MAX_LOG_BYTES = 8 * 1024 * 1024;

function securityLogPath(): string {
  const file = path.join(getDataDir(), 'security.log');
  if (activeFile === file) return file;
  activeFile = file;
  activeBytes = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
  return file;
}

/**
 * Writes one line and keeps the file from growing without bound. A log nobody prunes is a log
 * nobody ever wanted: it is the largest store of behaviour the operator will ever hold.
 */
export function appendSecurityLine(line: string): void {
  const file = securityLogPath();
  try {
    fs.appendFileSync(file, line);
    activeBytes += Buffer.byteLength(line);
    if (activeBytes > MAX_LOG_BYTES) rotate(file);
  } catch {}
}

function rotate(file: string): void {
  // The destination has to go first. `renameSync` over an existing file is allowed on POSIX and fails with
  // EPERM/EEXIST on Windows, so after the first rotation every later rename threw - and the throw was
  // swallowed by the caller's `catch`. `activeBytes` was zeroed regardless, so the size that decides
  // whether to rotate was forgotten from then on and the log grew without bound on the one platform this
  // is developed on. Zeroing only on success keeps the accounting honest on any platform.
  try { fs.unlinkSync(file + '.1'); } catch {}
  try {
    fs.renameSync(file, file + '.1');
    activeBytes = 0;
  } catch {}
}
