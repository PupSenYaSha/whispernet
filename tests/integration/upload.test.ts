import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { startTestServer, startMediaHost, postMultipart, type StartedServer, type StartedMediaHost } from '../helpers';

let server: StartedServer;
let media: StartedMediaHost;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  media = await startMediaHost();
  server = await startTestServer({ MEDIA_BASE_URL: media.url, MEDIA_STORAGE: 'remote' });
});

afterAll(async () => {
  await server.stop();
  await media.stop();
});

describe('media upload', () => {
  it('stores a picture through the media host and returns its url', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'photo.png', contentType: 'image/png', body: PNG },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/img\.test\/[0-9a-f]+\.bin$/);
    expect(media.requests).toHaveLength(1);
    expect(media.requests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(media.requests[0].length).toBeGreaterThan(PNG.length);
  });

  it('accepts a video as well', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', body: Buffer.from('not a real video') },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/img\.test\//);
  });

  it('rejects a file that is neither an image nor a video', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'payload.exe', contentType: 'application/octet-stream', body: Buffer.from('MZ') },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid file type');
    expect(media.requests).toHaveLength(2);
  });

  it('rejects a request without a file part', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'notafile', body: 'hello' },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No file');
  });

  it('reports an upstream failure instead of hanging', async () => {
    const failing = await startFailingMediaHost();
    const scoped = await startTestServer({ MEDIA_BASE_URL: failing.url, MEDIA_STORAGE: 'remote' });
    try {
      const res = await postMultipart(scoped.port, '/api/upload', [
        { name: 'file', filename: 'photo.png', contentType: 'image/png', body: PNG },
      ]);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('Network error');
    } finally {
      await scoped.stop();
      await failing.stop();
    }
  });
});

function startFailingMediaHost(): Promise<StartedMediaHost & { requests: any[] }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => { /* drain */ });
    req.on('end', () => { requests.push({}); res.destroy(); });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, url: `http://127.0.0.1:${port}`, requests, stop: () => new Promise<void>((r) => { server.close(() => r()); }) });
    });
  });
}
