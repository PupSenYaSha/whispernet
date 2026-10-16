#!/usr/bin/env node
/**
 * Makes the key pair that update releases are signed with.
 *
 * ## What this protects against
 *
 * The updater already refuses any build it cannot match against a published digest, and a digest fetched from
 * the same place as the payload catches a corrupted or stale download. It does **not** prove who published
 * the build: whoever can alter the release also alters the digest beside it. Only a signature over the digest,
 * verified against a key compiled into the binary, proves the build came from the person who holds the
 * private half.
 *
 * ## Why the private half is written and not printed
 *
 * The point of a signing key is that exactly one place can read it, and that place is not a transcript, a log,
 * a chat message or a copy of one. So this script writes the private key to a file and prints only the public
 * half - which is not a secret and is supposed to be embedded in the source.
 *
 * Run it once. Then put the printed public key into `src-tauri/src/lib.rs` (see `UPDATE_PUBLIC_KEY`), commit
 * that, and keep the private file out of git - it is written under `android/app/` which is already ignored, so
 * it cannot be committed by accident, and nowhere near this file so a `git add .` cannot pick it up either.
 *
 * The private key belongs in a password manager and in the repository secrets as
 * `UPDATE_SIGNING_KEY_BASE64`. **Publishing it would let anyone ship code to every user's desktop.**
 *
 * ## Losing it means losing updates
 *
 * There is no recovery path and no second key: a key that can no longer sign is a key that can no longer be
 * used, and shipping a new public key is a release in its own right. So back it up before deleting anything.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// Deliberately next to the Android keystore rather than in the repo root: `.gitignore` covers `*.key`, so this
// file cannot be added to git even by accident, and it cannot be confused for something that was meant to be
// public. `git check-ignore -v android/app/update-signing.key` confirms which rule covers it.
const PRIVATE_DIR = path.join(root, 'android', 'app');
const PRIVATE_PATH = path.join(PRIVATE_DIR, 'update-signing.key');

if (fs.existsSync(PRIVATE_PATH)) {
  console.error(`A signing key already exists at ${path.relative(root, PRIVATE_PATH)}.`);
  console.error('Deleting it means no further release can be signed, because the public key is compiled in.');
  console.error('Remove the file yourself if you are certain you mean to.');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

// Raw 32-byte halves as hex. Node's JWK export speaks base64url, and the digest of one is easy to mistake
// for the other - so it is converted here rather than at each of the four places that read it: the verifier
// in lib.rs, the signer in sign-update.mjs, and whatever an operator types into the repository secret.
const b64urlToHex = (s) => Buffer.from(s, 'base64url').toString('hex');
const privateHex = b64urlToHex(privateKey.export({ format: 'jwk' }).d);
const publicHex = b64urlToHex(publicKey.export({ format: 'jwk' }).x);

if (privateHex.length !== 64 || publicHex.length !== 64) {
  throw new Error('unexpected key size; an Ed25519 half is 32 bytes and must be 64 hex characters');
}

fs.writeFileSync(PRIVATE_PATH, `${privateHex}\n`, { mode: 0o600 });

console.log('Update signing key written.');
console.log('');
console.log(`  private key: ${path.relative(root, PRIVATE_PATH)}  (never printed, never committed)`);
console.log('');
console.log('Paste this public key into src-tauri/src/lib.rs as UPDATE_PUBLIC_KEY:');
console.log('');
console.log(`    "${publicHex}"`);
console.log('');
console.log('Then add the private half to the repository secrets as UPDATE_SIGNING_KEY_BASE64.');
console.log('It is on disk as hex, so convert it to base64 *without printing it* - and take the base64 of the');
console.log('decoded bytes, not of the hex text, which is the easy mistake and is rejected rather than misread:');
console.log('');
console.log('  # PowerShell');
console.log(`  $h = (Get-Content '${path.relative(root, PRIVATE_PATH)}' -Raw).Trim()`);
console.log('  [Convert]::ToBase64String([byte[]](0..31 | ForEach-Object { [Convert]::ToByte($h.Substring($_*2,2),16) }))');
console.log('');
console.log('Back both halves up somewhere that is not this machine.');
