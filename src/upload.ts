export async function uploadImage(
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  const form = new FormData();
  form.append('file', file);

  if (onProgress) onProgress(10);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: form,
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
