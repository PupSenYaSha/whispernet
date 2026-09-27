export type MediaErrorCode = 'offline' | 'keys' | 'upload' | 'encrypt';

/** Carries the reason to the UI, so a failed send is not reported as a failed upload. */
export class MediaError extends Error {
  constructor(readonly code: MediaErrorCode, message?: string) {
    super(message || code);
    this.name = 'MediaError';
  }
}

export const MAX_UPLOAD_BYTES = 1000 * 1024 * 1024;
/** Dm media is ciphered in memory, so it needs a ceiling a phone can survive. */
export const MAX_ENCRYPTED_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Token from the auth payload, so the server counts uploads per account instead of per address. */
let uploadToken = '';
export function setUploadToken(token: string): void {
  uploadToken = typeof token === 'string' ? token : '';
}

export async function uploadFile(
  blob: Blob,
  filename: string = 'encrypted.bin',
  onProgress?: (percent: number) => void
): Promise<string> {
  const form = new FormData();
  
  
  
  const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : 'image/png';
  form.append('file', type === blob.type ? blob : new Blob([blob], { type }), filename);

  if (onProgress) onProgress(10);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: form,
    headers: uploadToken ? { 'X-WN-Upload-Token': uploadToken } : undefined,
  });

  if (onProgress) onProgress(90);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || 'Upload failed');
  }

  if (onProgress) onProgress(100);
  const data = await res.json();
  return data.url;
}

export async function uploadImage(
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  return uploadFile(file, file.name || 'image', onProgress);
}

const MEDIA_ERROR_KEYS: Record<MediaErrorCode, string> = {
  offline: 'upload_offline',
  keys: 'upload_keys_missing',
  upload: 'upload_failed',
  encrypt: 'upload_encrypt_failed',
};

/** Turns whatever a send threw into the translation key that describes it. */
export function mediaErrorKey(error: unknown): string {
  if (error instanceof MediaError) return MEDIA_ERROR_KEYS[error.code] || MEDIA_ERROR_KEYS.upload;
  return MEDIA_ERROR_KEYS.upload;
}
