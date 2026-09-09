const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');
const { drawLogo } = require('./logo.cjs');

function createICO() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = [];

  for (const size of sizes) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    drawLogo(ctx, size);
    images.push(canvas.toBuffer('image/png'));
  }

  // ICO format
  const dirCount = images.length;
  const dirSize = 16;
  const headerSize = 6;
  const dirTotalSize = dirCount * dirSize;

  let offset = headerSize + dirTotalSize;
  const entries = [];
  const imageBuffers = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const size = sizes[i];
    entries.push({
      width: size >= 256 ? 0 : size,
      height: size >= 256 ? 0 : size,
      colors: 0,
      reserved: 0,
      planes: 1,
      bitCount: 32,
      size: img.length,
      offset: offset,
    });
    imageBuffers.push(img);
    offset += img.length;
  }

  const ico = Buffer.alloc(offset);
  // ICO header
  ico.writeUInt16LE(0, 0); // reserved
  ico.writeUInt16LE(1, 2); // type (1 = ICO)
  ico.writeUInt16LE(dirCount, 4);

  // Directory entries
  let dirOffset = 6;
  for (const entry of entries) {
    ico.writeUInt8(entry.width, dirOffset);
    ico.writeUInt8(entry.height, dirOffset + 1);
    ico.writeUInt8(entry.colors, dirOffset + 2);
    ico.writeUInt8(entry.reserved, dirOffset + 3);
    ico.writeUInt16LE(entry.planes, dirOffset + 4);
    ico.writeUInt16LE(entry.bitCount, dirOffset + 6);
    ico.writeUInt32LE(entry.size, dirOffset + 8);
    ico.writeUInt32LE(entry.offset, dirOffset + 12);
    dirOffset += 16;
  }

  // Image data
  let dataOffset = 6 + dirTotalSize;
  for (const buf of imageBuffers) {
    buf.copy(ico, dataOffset);
    dataOffset += buf.length;
  }

  return ico;
}

const ico = createICO();
fs.writeFileSync(path.join(__dirname, '../build/icon.ico'), ico);
console.log('Generated build/icon.ico');

// Also generate a 512x512 PNG for Mac / window icons
const canvas = createCanvas(512, 512);
const ctx = canvas.getContext('2d');
drawLogo(ctx, 512);
const pngBuf = canvas.toBuffer('image/png');
fs.writeFileSync(path.join(__dirname, '../build/icon.png'), pngBuf);
console.log('Generated build/icon.png (512x512)');