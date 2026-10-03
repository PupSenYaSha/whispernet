import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { startTestServer, startMediaHost, postMultipart, TestClient, uniqueNick, type StartedServer, type StartedMediaHost } from '../helpers';

const clients: TestClient[] = [];

let server: StartedServer;
let media: StartedMediaHost;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// The upload routes require the token the handshake issues, so these tests need a signed-in
// account to upload as rather than an anonymous socket.
let uploader: TestClient;

beforeAll(async () => {
  media = await startMediaHost();
  server = await startTestServer({ MEDIA_BASE_URL: media.url, MEDIA_STORAGE: 'remote' });
  uploader = new TestClient(server.url, 'uploader');
  clients.push(uploader);
  await uploader.register(uniqueNick('upl'));
  expect(uploader.uploadToken).toBeTruthy();
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  await server.stop();
  await media.stop();
});

describe('media upload', () => {

  // This is the hole the token requirement closes. The routes used to read the token only to
  // decide whose rate limit to charge, and served anybody who asked: no account, no password, and
  // a body of up to a gigabyte. The handshake is the only thing that issues a token, so requiring
  // one is what turns an open endpoint into a signed-in one.
  it('refuses an upload with no token at all', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'photo.png', contentType: 'image/png', body: PNG },
    ]);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Upload token required');
    // and nothing reached the media host
    expect(media.requests).toHaveLength(0);
  });

  it('refuses a token that was never issued', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'photo.png', contentType: 'image/png', body: PNG },
    ], 'f'.repeat(48));
    expect(res.status).toBe(401);
    expect(media.requests).toHaveLength(0);
  });

  it('refuses the streamed route the same way', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload-raw?name=a.png&type=image%2Fpng`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(401);
  });

  it('stores a picture through the media host and returns its url', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'photo.png', contentType: 'image/png', body: PNG },
    ], uploader.uploadToken);

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/img\.test\/[0-9a-f]+\.bin$/);
    expect(media.requests).toHaveLength(1);
    expect(media.requests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(media.requests[0].length).toBeGreaterThan(PNG.length);
  });

  it('accepts a video as well', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', body: Buffer.from('not a real video') },
    ], uploader.uploadToken);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/img\.test\//);
  });

  it('rejects a file that is neither an image nor a video', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'file', filename: 'payload.exe', contentType: 'application/octet-stream', body: Buffer.from('MZ') },
    ], uploader.uploadToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid file type');
    expect(media.requests).toHaveLength(2);
  });

  it('rejects a request without a file part', async () => {
    const res = await postMultipart(server.port, '/api/upload', [
      { name: 'notafile', body: 'hello' },
    ], uploader.uploadToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No file');
  });

  it('reports an upstream failure instead of hanging', async () => {
    const failing = await startFailingMediaHost();
    const scoped = await startTestServer({ MEDIA_BASE_URL: failing.url, MEDIA_STORAGE: 'remote' });
    try {
      const res = await postMultipart(scoped.port, '/api/upload', [
        { name: 'file', filename: 'photo.png', contentType: 'image/png', body: PNG },
      ], uploader.uploadToken);
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
