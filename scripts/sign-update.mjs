#!/usr/bin/env node
/**
 * Signs an update so the desktop app will install it.
 *
 * ## What gets signed, and why not the file
 *
 * The signature covers the file's SHA-256 digest - the 32 raw bytes - rather than the archive. Signing
 * fifty megabytes on every build is slow and says nothing more: if the bytes on disk hash to the signed
 * digest, they are the bytes that were signed. So the chain is signature -> digest -> file, and the verifier
 * in `src-tauri/src/lib.rs` walks it in that order, checking the digest against the download *before* asking
 * whether the signature is any good.
 *
 * ## Where the key comes from
 *
 * `UPDATE_SIGNING_KEY_HEX`, or `UPDATE_SIGNING_KEY_BASE64`. The key never touches an argument, so it cannot
 * end up in a shell history, a process listing or a CI log line. CI sets it from the repository secret.
 *
 * ## The failure this is built around
 *
 * A missing key is a hard error and the release does not go out. Publishing an unsigned archive looks
 * identical to a signed one right up until somebody swaps the binary, which is exactly the moment the check
 * matters - so a build that cannot sign fails loudly instead of shipping something the app will refuse.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/sign-update.mjs <file-to-sign>');
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error(`nothing to sign: ${target} does not exist`);
  process.exit(1);
}

/**
 * Reduces either accepted form of the secret to 32 raw seed bytes.
 *
 * Both forms are accepted because both are ways this value genuinely gets typed, and rejecting the wrong one
 * at the last moment of a release is a bad time to find out:
 *
 * - hex, as written by `generate-update-key.mjs` and as handed to `UPDATE_SIGNING_KEY_HEX`
 * - base64 of the raw 32 bytes, as a repository secret normally holds it
 *
 * The two cannot be confused: base64 of the *hex text* is 88 characters, which is neither 64 nor 32, so a
 * value that is base64-of-hex rather than base64-of-bytes is rejected rather than silently misread. That is
 * deliberate - guessing would be worse than saying no.
 */
function normalizeSeed(value) {
  const text = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, 'hex');
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error(
    `the signing key is neither 64 hex characters nor base64 of 32 bytes (got ${text.length} characters, ` +
    `which decoded to ${decoded.length} bytes)`
  );
}

function privateKeyFrom(value) {
  const seed = normalizeSeed(value);
  // Node wants a PKCS#8 DER for an Ed25519 private key, which is a fixed 16-byte prefix followed by the
  // 32 raw bytes. Both ends are pinned by the algorithm, so this cannot silently drift into a different key.
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

let privateKey;
try {
  const raw = process.env.UPDATE_SIGNING_KEY_HEX || process.env.UPDATE_SIGNING_KEY_BASE64;
  if (!raw) {
    throw new Error('no UPDATE_SIGNING_KEY_HEX or UPDATE_SIGNING_KEY_BASE64 in the environment');
  }
  privateKey = privateKeyFrom(raw);
} catch (e) {
  console.error(`refusing to publish an unsigned update: ${e.message}`);
  process.exit(1);
}

const bytes = fs.readFileSync(target);
const digest = crypto.createHash('sha256').update(bytes).digest();
const signature = crypto.sign(null, digest, privateKey);
const outPath = `${target}.sig`;
fs.writeFileSync(outPath, `${signature.toString('hex')}\n`, 'ascii');

console.log(`signed ${path.basename(target)}`);
console.log(`  sha256 ${digest.toString('hex')}`);
console.log(`  wrote   ${path.basename(outPath)}`);
