/**
 * Strips a UTF-8 byte order mark from tracked text files.
 *
 * A BOM is invisible in an editor and harmless in almost every tool, which is exactly why it survives.
 * Gradle is not one of those tools: it reads the first line of a build script and finds a `?` where
 * `apply` should be, then refuses to compile with a parse error pointing at line 1 column 1 - a message
 * that gives no hint that a single invisible byte three positions in is the cause.
 *
 * That is not hypothetical here. Eight tracked files had one, `android/app/build.gradle` among them, and
 * that file is what stops the Android build before it even reaches signing. The others would surface the
 * same way, in whatever tool happens to be stricter than the editor.
 *
 * Run from the repository root:  node scripts/strip-bom.js
 */
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const BOM = [0xef, 0xbb, 0xbf];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const fixed = [];

for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.length < 3 || !BOM.every((b, i) => bytes[i] === b)) continue;

  // only text: a binary file that happens to start with these three bytes is not ours to rewrite, and a
  // NUL byte within the first few hundred is the giveaway that we are looking at one
  const head = bytes.subarray(3, 3 + 512);
  if (head.includes(0)) continue;

  writeFileSync(file, bytes.subarray(3));
  fixed.push(file);
}

console.log('stripped a BOM from', fixed.length, 'files');
for (const f of fixed) console.log(' ', f);