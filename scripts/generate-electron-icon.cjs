const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawLogo(ctx, size) {
  const s = size;
  const pad = s * 0.15;
  const inner = s - pad * 2;

  const radius = s * 0.22;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(s - radius, 0);
  ctx.quadraticCurveTo(s, 0, s, radius);
  ctx.lineTo(s, s - radius);
  ctx.quadraticCurveTo(s, s, s - radius, s);
  ctx.lineTo(radius, s);
  ctx.quadraticCurveTo(0, s, 0, s - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  ctx.fillStyle = '#8b5cf6';
  ctx.fill();

  const cx = s / 2, cy = s / 2;
  const wWidth = inner * 0.55, wHeight = inner * 0.45;
  const strokeW = s * 0.045;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const x1 = cx - wWidth / 2, x2 = cx - wWidth / 6;
  const x3 = cx + wWidth / 6, x4 = cx + wWidth / 2;
  const yTop = cy - wHeight / 2, yMid = cy + wHeight / 6, yBot = cy + wHeight / 2.5;

  ctx.beginPath();
  ctx.moveTo(x1, yBot);
  ctx.lineTo(x2, yTop);
  ctx.lineTo(cx, yMid);
  ctx.lineTo(x3, yTop);
  ctx.lineTo(x4, yBot);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, yBot + s * 0.09, s * 0.035, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

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
fs.writeFileSync(path.join(__dirname, 'build/icon.ico'), ico);
console.log('Generated build/icon.ico');

// Also generate a 512x512 PNG for Mac
const canvas = createCanvas(512, 512);
const ctx = canvas.getContext('2d');
drawLogo(ctx, 512);
const pngBuf = canvas.toBuffer('image/png');
fs.writeFileSync(path.join(__dirname, 'build/icon.png'), pngBuf);
console.log('Generated build/icon.png (512x512)');
