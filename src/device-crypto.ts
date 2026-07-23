const PBKDF2_ITER = 100_000;

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getDeviceFingerprint(): Promise<string> {
  const parts: string[] = [];
  parts.push(navigator.userAgent);
  parts.push(screen.colorDepth.toString());
  parts.push(`${screen.width}x${screen.height}`);
  parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  parts.push(navigator.language);
  parts.push(navigator.hardwareConcurrency?.toString() || '0');
  parts.push((navigator as any).deviceMemory?.toString() || '0');
  parts.push(navigator.platform);
  parts.push(navigator.maxTouchPoints?.toString() || '0');
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillText('wn', 2, 2);
      parts.push(canvas.toDataURL().slice(0, 100));
    }
  } catch {}
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) parts.push(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    }
  } catch {}
  try {
    parts.push(window.outerWidth.toString());
    parts.push(window.outerHeight.toString());
    parts.push(screen.pixelDepth.toString());
  } catch {}
  const raw = parts.join('|||');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return bufToBase64(hash);
}

async function deriveDeviceKey(fingerprint: string, salt: Uint8Array): Promise<CryptoKey> {
  const passKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(fingerprint), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    passKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptPassword(password: string): Promise<string> {
  const fingerprint = await getDeviceFingerprint();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveDeviceKey(fingerprint, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(password)
  );
  return JSON.stringify({
    v: 1,
    salt: bufToBase64(salt.buffer),
    iv: bufToBase64(iv.buffer),
    data: bufToBase64(ciphertext),
  });
}

export async function decryptPassword(encrypted: string): Promise<string | null> {
  try {
    const { v, salt, iv, data } = JSON.parse(encrypted);
    if (v !== 1) return null;
    const fingerprint = await getDeviceFingerprint();
    const key = await deriveDeviceKey(fingerprint, new Uint8Array(base64ToBuf(salt)));
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(iv)) }, key, base64ToBuf(data)
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
