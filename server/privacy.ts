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
 * Addresses are not stored raw. A daily-rotating salt means an entry can still be correlated with
 * the connection it came from, but the same person cannot be tracked across days by grepping the
 * file, and nothing here survives long enough to be a durable identifier.
 */
function dailySalt(): Buffer {
  const day = new Date().toISOString().slice(0, 10);
  if (cachedSalt && cachedDay === day) return cachedSalt;
  const file = path.join(getDataDir(), SALT_FILE);
  try {
    cachedSalt = fs.readFileSync(file);
    cachedDay = day;
    return cachedSalt;
  } catch {}
  const salt = crypto.randomBytes(32);
  cachedSalt = salt;
  cachedDay = day;
  try { fs.writeFileSync(file, salt, { mode: 0o600 }); } catch {}
  return salt;
}

export function pseudonymizeAddress(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  return crypto.createHmac('sha256', dailySalt()).update(ip).digest('base64url').slice(0, 16);
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
  try { fs.renameSync(file, file + '.1'); } catch {}
  activeBytes = 0;
}
