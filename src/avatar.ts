const AVATAR_SIZE = 256;

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed'));
    img.src = src;
  });
}

export async function fileToAvatarDataUrl(file: File): Promise<string | null> {
  if (!file || !/^image\//.test(file.type)) return null;
  const raw = await file.arrayBuffer();
  const blob = new Blob([raw], { type: file.type });
  let objectUrl: string | null = null;
  let img: HTMLImageElement;
  try {
    objectUrl = URL.createObjectURL(blob);
    img = await loadImage(objectUrl);
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }

  const size = Math.max(img.naturalWidth, img.naturalHeight);
  if (size === 0) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }
  const scale = size > AVATAR_SIZE ? AVATAR_SIZE / size : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
  } catch {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);

  const webpData = canvas.toDataURL('image/webp', 0.85);
  if (webpData.startsWith('data:image/webp')) return webpData;
  return canvas.toDataURL('image/jpeg', 0.85);
}