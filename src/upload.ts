export type MediaErrorCode = 'offline' | 'keys' | 'upload' | 'encrypt';

/** Carries the reason to the UI, so a failed send is not reported as a failed upload. */
export class MediaError extends Error {
  constructor(readonly code: MediaErrorCode, message?: string) {
    super(message || code);
    this.name = 'MediaError';
  }
}

export const MAX_UPLOAD_BYTES = 1000 * 1024 * 1024;
/**
 * An attachment in a private chat is encrypted a chunk at a time and posted as a stream, so only one
 * chunk is ever held in memory. The ceiling is therefore the same as the global chat's, and the lower
 * number that used to sit here was a memory limit rather than a rule about private messages.
 */
export const MAX_ENCRYPTED_UPLOAD_BYTES = MAX_UPLOAD_BYTES;

/** Token from the auth payload, so the server counts uploads per account instead of per address. */
let uploadToken = '';
export function setUploadToken(token: string): void {
  uploadToken = typeof token === 'string' ? token : '';
}

export function getUploadToken(): string {
  return uploadToken;
}

/**
 * The proxied address of an attachment.
 *
 * Media is fetched by <img> and <video>, which cannot send a request header, so the account token
 * travels in the query string instead. Without it the server had no way to tell whose media request
 * this was and charged it to the address, which is shared by an entire family or office behind one
 * router.
 */
export function mediaProxyUrl(remoteUrl: string): string {
  const base = `/api/media?url=${encodeURIComponent(remoteUrl)}`;
  return uploadToken ? `${base}&t=${encodeURIComponent(uploadToken)}` : base;
}

export async function uploadFile(
  blob: Blob,
  filename: string = 'encrypted.bin',
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const form = new FormData();

  const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : 'image/png';
  form.append('file', type === blob.type ? blob : new Blob([blob], { type }), filename);

  if (onProgress) onProgress(10);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: form,
    // omitted when there is nothing to abort on, so nothing else about the request changes
    ...(signal ? { signal } : {}),
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

/**
 * Whether a throw is the caller having cancelled, rather than something going wrong.
 *
 * `fetch` reports a cancellation as an `AbortError`, which is indistinguishable from a network failure if
 * all the caller sees is the error. It matters because the two want opposite treatment: a failed upload
 * should tell the user to try again, and a cancelled one should say nothing at all - the user is the one
 * who cancelled it, and being told "upload failed" after they closed the dialog is noise at best.
 *
 * The signal is checked as well as the error name, because a stream that failed mid-body and a request
 * aborted between the two are not guaranteed to agree on which error they produce.
 */
export function isAbortError(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Uploads a body as it is produced, rather than as one finished buffer.
 *
 * A multipart form has to be handed over as a Blob, so a large encrypted attachment had to exist
 * whole before the request could start. Posting the stream directly means the request begins with the
 * first chunk and the file is never resident. `duplex: 'half'` is what tells fetch a request body is a
 * stream rather than a buffer; without it the browser refuses the call.
 *
 * `signal` is what makes a gigabyte stoppable. Without it an upload could only be abandoned by closing
 * the tab: switching conversation, signing out, or a component unmounting left the request running, and it
 * kept pushing bytes at a server nobody was waiting for. `fetch` rejects with an `AbortError` when the
 * signal fires, which callers can tell from a network failure by the signal's own state.
 */
export async function uploadStream(
  stream: ReadableStream<Uint8Array>,
  filename: string = 'media.png',
  mimeType: string = 'image/png',
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<string> {
  const q = new URLSearchParams({ name: filename, type: mimeType });
  if (onProgress) onProgress(5);

  const res = await fetch(`/api/upload-raw?${q.toString()}`, {
    method: 'POST',
    body: stream,
    duplex: 'half',
    // omitted entirely when there is nothing to abort on, so nothing else about the request changes
    ...(signal ? { signal } : {}),
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(uploadToken ? { 'X-WN-Upload-Token': uploadToken } : {}),
    },
  } as RequestInit);

  if (onProgress) onProgress(90);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || 'Upload failed');
  }

  if (onProgress) onProgress(100);
  const data = await res.json();
  return data.url;
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
