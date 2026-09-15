


function roundedRectPath(ctx, s, radius) {
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
}




function drawLogo(ctx, size) {
  const s = size;
  const rx = s * (28 / 120);
  const grad = ctx.createLinearGradient(0, 0, s, s);
  grad.addColorStop(0, '#8b5cf6');
  grad.addColorStop(1, '#6d28d9');
  roundedRectPath(ctx, s, rx);
  ctx.fillStyle = grad;
  ctx.fill();

  const w = s * 0.04167; 
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s * 0.25, s * 0.625);
  ctx.lineTo(s * 0.35, s * 0.3333);
  ctx.lineTo(s * 0.45, s * 0.5417);
  ctx.lineTo(s * 0.55, s * 0.2917);
  ctx.lineTo(s * 0.65, s * 0.5417);
  ctx.lineTo(s * 0.75, s * 0.3333);
  ctx.lineTo(s * 0.75, s * 0.625);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.7333, s * 0.0333, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fill();
}

module.exports = { drawLogo, roundedRectPath };