const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');
const { drawLogo } = require('./logo.cjs');

const sizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192,
};

const resDir = path.join(__dirname, '../android/app/src/main/res');

for (const [folder, size] of Object.entries(sizes)) {
  const dir = path.join(resDir, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Regular icon (canonical gradient logo)
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  drawLogo(ctx, size);
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), buf);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), buf);

  // Foreground: white W on transparent background (for adaptive icon)
  const fgCanvas = createCanvas(size, size);
  const fgCtx = fgCanvas.getContext('2d');
  const w = size * 0.04167;
  fgCtx.strokeStyle = '#ffffff';
  fgCtx.lineWidth = w;
  fgCtx.lineCap = 'round';
  fgCtx.lineJoin = 'round';
  fgCtx.beginPath();
  fgCtx.moveTo(size * 0.25, size * 0.625);
  fgCtx.lineTo(size * 0.35, size * 0.3333);
  fgCtx.lineTo(size * 0.45, size * 0.5417);
  fgCtx.lineTo(size * 0.55, size * 0.2917);
  fgCtx.lineTo(size * 0.65, size * 0.5417);
  fgCtx.lineTo(size * 0.75, size * 0.3333);
  fgCtx.lineTo(size * 0.75, size * 0.625);
  fgCtx.stroke();
  fgCtx.beginPath();
  fgCtx.arc(size * 0.5, size * 0.7333, size * 0.0333, 0, Math.PI * 2);
  fgCtx.fillStyle = 'rgba(255,255,255,0.6)';
  fgCtx.fill();
  const fgBuf = fgCanvas.toBuffer('image/png');
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), fgBuf);

  console.log(`Generated ${folder}: ${size}x${size}`);
}

// PWA icons (used by manifest / favicon / apple-touch-icon)
const pwaDir = path.join(__dirname, '../public/icons');
if (!fs.existsSync(pwaDir)) fs.mkdirSync(pwaDir, { recursive: true });
for (const size of [192, 512]) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  drawLogo(ctx, size);
  fs.writeFileSync(path.join(pwaDir, `icon-${size}.png`), canvas.toBuffer('image/png'));
  console.log(`Generated public/icons/icon-${size}.png`);
}

console.log('All icons generated!');