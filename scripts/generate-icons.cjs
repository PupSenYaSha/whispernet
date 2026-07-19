const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const sizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

function drawLogo(ctx, size) {
  const s = size;
  const pad = s * 0.15;
  const inner = s - pad * 2;

  // Purple background with rounded rect
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

  // W shape
  const cx = s / 2;
  const cy = s / 2;
  const wWidth = inner * 0.55;
  const wHeight = inner * 0.45;
  const strokeW = s * 0.045;

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const x1 = cx - wWidth / 2;
  const x2 = cx - wWidth / 6;
  const x3 = cx + wWidth / 6;
  const x4 = cx + wWidth / 2;
  const yTop = cy - wHeight / 2;
  const yMid = cy + wHeight / 6;
  const yBot = cy + wHeight / 2.5;

  ctx.beginPath();
  ctx.moveTo(x1, yBot);
  ctx.lineTo(x2, yTop);
  ctx.lineTo(cx, yMid);
  ctx.lineTo(x3, yTop);
  ctx.lineTo(x4, yBot);
  ctx.stroke();

  // Dot
  ctx.beginPath();
  ctx.arc(cx, yBot + s * 0.09, s * 0.035, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

const resDir = path.join(__dirname, 'android/app/src/main/res');

for (const [folder, size] of Object.entries(sizes)) {
  const dir = path.join(resDir, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Regular icon
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  drawLogo(ctx, size);
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), buf);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), buf);

  // Foreground
  const fgCanvas = createCanvas(size, size);
  const fgCtx = fgCanvas.getContext('2d');
  // Draw W on transparent background
  const strokeW = size * 0.045;
  const wWidth = size * 0.42;
  const wHeight = size * 0.35;
  fgCtx.strokeStyle = '#ffffff';
  fgCtx.lineWidth = strokeW;
  fgCtx.lineCap = 'round';
  fgCtx.lineJoin = 'round';
  const cx = size / 2, cy = size / 2;
  const x1 = cx - wWidth / 2, x2 = cx - wWidth / 6;
  const x3 = cx + wWidth / 6, x4 = cx + wWidth / 2;
  const yTop = cy - wHeight / 2, yMid = cy + wHeight / 6, yBot = cy + wHeight / 2.5;
  fgCtx.beginPath();
  fgCtx.moveTo(x1, yBot);
  fgCtx.lineTo(x2, yTop);
  fgCtx.lineTo(cx, yMid);
  fgCtx.lineTo(x3, yTop);
  fgCtx.lineTo(x4, yBot);
  fgCtx.stroke();
  fgCtx.beginPath();
  fgCtx.arc(cx, yBot + size * 0.09, size * 0.035, 0, Math.PI * 2);
  fgCtx.fillStyle = '#ffffff';
  fgCtx.fill();
  const fgBuf = fgCanvas.toBuffer('image/png');
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fgBuf);

  console.log(`Generated ${folder}: ${size}x${size}`);
}

console.log('All icons generated!');
