import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';

const ROOT = process.cwd();
const BUILD_DIR = path.join(ROOT, 'deb-build');
const DEST = path.join(ROOT, 'dist', 'build');
const VERSION = '1.0.0';
const PACKAGE = 'whispernet';
const ARCH = 'amd64';

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

// ---------- ar archive writer ----------
// ar header: name(16) date(12) uid(6) gid(6) mode(8) size(10) fmagic(2) = 60 bytes
function arHeader(name, size) {
  const h = Buffer.alloc(60, 0x20); // spaces
  const nameBuf = Buffer.from(name);
  nameBuf.copy(h, 0);
  // date
  h.write(String(Math.floor(Date.now() / 1000)).padEnd(12, ' '), 16, 'ascii');
  // uid/gid
  h.write('0'.repeat(6), 28, 'ascii');
  h.write('0'.repeat(6), 34, 'ascii');
  // mode
  h.write(String(0o644).padEnd(8, ' '), 42, 'ascii');
  // size
  h.write(String(size).padEnd(10, ' '), 48, 'ascii');
  // fmagic
  h.write('\x60\x0a', 58, 'ascii');
  return h;
}

function arArchive(files) {
  // ar magic
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  for (const f of files) {
    parts.push(arHeader(f.name, f.data.length));
    parts.push(f.data);
    // pad to even
    if (f.data.length % 2 !== 0) parts.push(Buffer.from('\n', 'ascii'));
  }
  return Buffer.concat(parts);
}

// ---------- tar writer (ustar) ----------
function tarHeader(name, size, mode = 0o755, type = '0') {
  const h = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(name, 'ascii');
  if (nameBuf.length > 100) throw new Error('name too long: ' + name);
  nameBuf.copy(h, 0);
  h.write(String(mode).padEnd(7, '0') + '\0', 100, 'ascii');
  h.write('0'.repeat(7) + '\0', 108, 'ascii'); // uid
  h.write('0'.repeat(7) + '\0', 116, 'ascii'); // gid
  h.write(String(size).padEnd(11, '0') + '\0', 124, 'ascii');
  h.write(Math.floor(Date.now() / 1000).toString(8).padEnd(11, '0') + '\0', 136, 'ascii');
  h.write('0'.repeat(7) + '\0', 148, 'ascii'); // checksum placeholder
  h.write(type, 156, 'ascii');
  h.write('ustar\u0000', 257, 'ascii');
  h.write('00', 263, 'ascii');
  // checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(String(sum).padEnd(7, '0') + '\0', 148, 'ascii');
  return h;
}

function tarPack(files) {
  const parts = [];
  for (const f of files) {
    const h = tarHeader(f.name, f.data.length, f.mode, f.type === 'dir' ? '5' : '0');
    parts.push(h);
    parts.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  // two zero blocks
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

async function gzip(data) {
  return new Promise((resolve, reject) => {
    zlib.gzip(data, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// ---------- build ----------
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, 'DEBIAN'), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, 'usr', 'bin'), { recursive: true });
fs.mkdirSync(path.join(BUILD_DIR, 'opt', 'whispernet'), { recursive: true });

// Copy server files
const serverSrc = path.join(ROOT, 'dist', 'server');
const serverDst = path.join(BUILD_DIR, 'opt', 'whispernet', 'server');
fs.cpSync(serverSrc, serverDst, { recursive: true });

// Copy client files
const clientSrc = path.join(ROOT, 'dist', 'client');
const clientDst = path.join(BUILD_DIR, 'opt', 'whispernet', 'client');
fs.cpSync(clientSrc, clientDst, { recursive: true });

// Launcher script
const launcher = `#!/bin/sh
exec node /opt/whispernet/server/index.js "$@"
`;
fs.writeFileSync(path.join(BUILD_DIR, 'usr', 'bin', 'whispernet'), launcher, { mode: 0o755 });

// Control file
const control = `Package: whispernet
Version: ${VERSION}
Section: net
Priority: optional
Architecture: ${ARCH}
Maintainer: PupSenYaSha <whispernet@cloudpub.ru>
Description: Minimalist messenger with end-to-end encryption
 WhisperNet is a minimalist secure messenger with end-to-end encryption
 based on Signal Protocol (X3DH + Double Ratchet) for direct messages.
 Supports groups, disappearing messages, voice/video calls via WebRTC,
 screenshots protection, multi-device (up to 3 sessions), key backup,
 and signed updates.
Homepage: https://github.com/PupSenYaSha/whispernet
`;
fs.writeFileSync(path.join(BUILD_DIR, 'DEBIAN', 'control'), control);

// Build data.tar.gz
const dataFiles = [];
function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel);
    } else {
      dataFiles.push({ name: rel, data: fs.readFileSync(full), mode: fs.statSync(full).mode });
    }
  }
}
walk(BUILD_DIR, '');

const dataTar = tarPack(dataFiles);
const dataTarGz = await gzip(dataTar);

// Build control.tar.gz
const controlFile = fs.readFileSync(path.join(BUILD_DIR, 'DEBIAN', 'control'));
const controlTar = tarPack([{ name: './control', data: controlFile }]);
const controlTarGz = await gzip(controlTar);

// debian-binary
const debianBinary = Buffer.from('2.0\n', 'ascii');

// Build ar
const ar = arArchive([
  { name: 'debian-binary', data: debianBinary },
  { name: 'control.tar.gz', data: controlTarGz },
  { name: 'data.tar.gz', data: dataTarGz },
]);

const debName = `WhisperNet_${VERSION}_amd64.deb`;
const debPath = path.join(DEST, debName);
fs.mkdirSync(DEST, { recursive: true });
fs.writeFileSync(debPath, ar);

console.log(`Built ${debPath}`);
console.log(`Size: ${ar.length} bytes`);

// SHA-256
const hash = crypto.createHash('sha256').update(ar).digest('hex');
fs.writeFileSync(`${debPath}.sha256`, hash + '\n');
console.log(`SHA-256: ${hash}`);
console.log(`Written ${debPath}.sha256`);