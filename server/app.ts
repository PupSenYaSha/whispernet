import fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import { existsSync } from 'fs';
import { handleConnection, startHeartbeatCheck, getTotalConnections } from './handlers.js';
import { initializeDatabase, getMediaDir } from './database.js';
import https from 'https';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const uploadRateMap = new Map<string, { count: number; resetAt: number }>();
const UPLOAD_RATE_LIMIT = 10;
const UPLOAD_RATE_WINDOW = 60_000;
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_CONNECTIONS = 500;
const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
];

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of uploadRateMap) {
    if (now > entry.resetAt) uploadRateMap.delete(ip);
  }
}, 60_000);

function checkUploadRate(ip: string): boolean {
  const now = Date.now();
  const entry = uploadRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    uploadRateMap.set(ip, { count: 1, resetAt: now + UPLOAD_RATE_WINDOW });
    return true;
  }
  if (entry.count >= UPLOAD_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f\/\\"]/g, '').slice(0, 128) || 'upload';
}

function getMediaBase(): URL {
  return new URL(process.env.MEDIA_BASE_URL || 'https://img.n1ko.dev');
}

// Load TLS material when provided via env so the server can terminate HTTPS/WSS directly.
// Production deployments should always set these (or sit behind a TLS-terminating reverse proxy).
function loadHttpsOptions(): { key: Buffer; cert: Buffer } | null {
  const keyPath = process.env.TLS_KEY || process.env.HTTPS_KEY;
  const certPath = process.env.TLS_CERT || process.env.HTTPS_CERT;
  if (!keyPath || !certPath) return null;
  try {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (e) {
    console.error('Failed to load TLS certificates:', (e as Error).message);
    return null;
  }
}

export function createApp(clientDir?: string) {
  const app = fastify({ logger: false });
  let mediaHost = 'img.n1ko.dev';
  try { mediaHost = getMediaBase().host; } catch {}

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const host = req.headers.host || 'localhost';
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://${mediaHost} http://${mediaHost}; media-src 'self' blob: https://${mediaHost} http://${mediaHost}; connect-src 'self' wss://${host} ws://${host}; font-src 'self' https://fonts.gstatic.com`);
    const origin = req.headers.origin;
    if (origin) {
      const allowedHost = new URL(origin).host;
      if (allowedHost === host) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
      }
    }
    reply.header('Vary', 'Origin');
  });

  app.register(fastifyWebsocket);
  app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_SIZE } });

  const resolvedClientDir = clientDir || path.join(__dirname, '../dist/client');
  app.register(fastifyStatic, {
    root: resolvedClientDir,
    prefix: '/',
    wildcard: true,
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/media', async (req, reply) => {
    const url = (req.query as any).url;
    if (!url || typeof url !== 'string') return reply.code(400).send({ error: 'Missing url' });

    if (url.startsWith('/media/')) {
      const id = path.basename(url);
      if (!/^[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: 'Invalid media id' });
      const fp = path.join(getMediaDir(), id);
      if (!existsSync(fp)) return reply.code(404).send({ error: 'Not found' });
      const buf = await fs.promises.readFile(fp);
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Cache-Control', 'public, max-age=86400')
        .send(buf);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'Invalid URL' });
    }

    const allowed = getMediaBase();
    if (parsed.protocol !== allowed.protocol || parsed.hostname !== allowed.hostname || parsed.port !== allowed.port) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const hijacked = reply.hijack();
    const raw = hijacked.raw;

    const lib = parsed.protocol === 'https:' ? https : http;
    const proxyReq = lib.get(url, {
      headers: { 'User-Agent': 'WhisperNet' },
      timeout: 15000,
    }, (proxyRes) => {
      let proxyResCt = proxyRes.headers['content-type'] || 'application/octet-stream';
      if (!/^(image\/|video\/|audio\/|application\/octet-stream)/i.test(proxyResCt)) {
        proxyRes.destroy();
        try { raw.writeHead(415); raw.end('Unsupported media type'); } catch {}
        return;
      }

      const contentLength = parseInt(proxyRes.headers['content-length'] || '0', 10);
      if (contentLength > 5 * 1024 * 1024) {
        proxyRes.destroy();
        try { raw.writeHead(413); raw.end('Too large'); } catch {}
        return;
      }

      let totalBytes = 0;
      const MAX_RESPONSE = 5 * 1024 * 1024;

      raw.writeHead(proxyRes.statusCode || 502, {
        'Content-Type': proxyResCt,
        'Cache-Control': 'public, max-age=86400',
      });

      proxyRes.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE) {
          proxyRes.destroy();
          try { raw.end(); } catch {}
          return;
        }
        raw.write(chunk);
      });

      proxyRes.on('end', () => { try { raw.end(); } catch {} });
    });

    proxyReq.on('error', () => { try { raw.writeHead(502); raw.end('Proxy error'); } catch {} });
    proxyReq.setTimeout(15000, () => { proxyReq.destroy(); try { raw.writeHead(504); raw.end('Timeout'); } catch {} });
    return reply;
  });

  app.post('/api/upload', async (req, reply) => {
    const ip = req.ip || 'unknown';
    if (!checkUploadRate(ip)) {
      return reply.code(429).send({ error: 'Rate limit' });
    }

    if ((process.env.MEDIA_STORAGE || 'remote') === 'local') {
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'No file' });
      if (!(data.mimetype.startsWith('image/') || data.mimetype.startsWith('video/') || data.mimetype === 'application/octet-stream')) {
        return reply.code(400).send({ error: 'Invalid file type' });
      }
      const buf = await data.toBuffer();
      if (buf.length > MAX_UPLOAD_SIZE) return reply.code(413).send({ error: 'File too large' });
      const id = crypto.randomBytes(16).toString('hex');
      await fs.promises.writeFile(path.join(getMediaDir(), id), buf);
      return reply.send({ url: '/media/' + id });
    }

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file' });

    if (!(
      data.mimetype.startsWith('image/') ||
      data.mimetype.startsWith('video/') ||
      data.mimetype === 'application/octet-stream'
    )) {
      return reply.code(400).send({ error: 'Invalid file type' });
    }

    const fileBuffer = await data.toBuffer();
    if (fileBuffer.length > MAX_UPLOAD_SIZE) {
      return reply.code(413).send({ error: 'File too large' });
    }

    const boundary = '----FormBoundary' + crypto.randomUUID();
    const fileName = sanitizeFilename((data.filename || 'upload').replace(/\.[a-z0-9]{1,5}$/i, '')) + '.bin';
    const parts: Buffer[] = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${data.mimetype}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    return new Promise<void>((resolve) => {
      const uploadUrl = new URL('/upload', getMediaBase());
      const lib = uploadUrl.protocol === 'https:' ? https : http;
      const req2 = lib.request(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'User-Agent': 'WhisperNet',
        },
        timeout: 120000,
      }, (res) => {
        let resBody = '';
        res.on('data', (c) => { resBody += c; });
        res.on('end', () => {
          for (const line of resBody.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const d = JSON.parse(line.substring(6));
                if (d.status === 'ready' && d.url) {
                  reply.send({ url: d.url });
                  resolve();
                  return;
                }
                if (d.status === 'failed') {
                  reply.code(500).send({ error: d.error || 'Upload failed' });
                  resolve();
                  return;
                }
              } catch { /* ignore parse errors */ }
            }
          }
          reply.code(500).send({ error: 'Upload failed' });
          resolve();
        });
      });

      req2.on('error', (e) => {
        console.error('Upload proxy error:', e.message);
        try { reply.code(502).send({ error: 'Network error' }); } catch {}
        resolve();
      });

      req2.on('timeout', () => {
        req2.destroy();
        try { reply.code(504).send({ error: 'Timeout' }); } catch {}
        resolve();
      });

      req2.write(body);
      req2.end();
    });
  });

  app.register(async (fastify) => {
    // Run before the websocket upgrade so mismatched origins are rejected with a
    // plain HTTP 403 instead of being upgraded. Only websocket upgrades are checked.
    fastify.addHook('preValidation', async (request, reply) => {
      if (String(request.headers.upgrade || '').toLowerCase() !== 'websocket') return;
      const origin = request.headers.origin;
      const host = request.headers.host;
      if (!host) return reply.code(400).send({ error: 'Missing Host header' });
      if (origin) {
        try {
          if (new URL(origin).host !== host) return reply.code(403).send({ error: 'Origin mismatch' });
        } catch {
          return reply.code(400).send({ error: 'Invalid Origin' });
        }
      }
    });

    fastify.get('/ws', { websocket: true }, (ws, req) => {
      const origin = req.headers.origin;
      const host = req.headers.host;

      if (!host) {
        ws.close(1008, 'Missing host');
        return;
      }

      if (origin) {
        try {
          const originHost = new URL(origin).host;
          if (originHost !== host) {
            ws.close(1008, 'Origin mismatch');
            return;
          }
        } catch {
          ws.close(1008, 'Invalid origin');
          return;
        }
      }

      if (getTotalConnections() >= MAX_TOTAL_CONNECTIONS) {
        ws.close(1013, 'Server full');
        return;
      }

      handleConnection(ws);
    });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/ws') || req.url.startsWith('/health') || req.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.sendFile('index.html');
  });

  return app;
}

export async function startServer(clientDir?: string, dataDir?: string) {
  const PORT = process.env.PORT ? parseInt(process.env.PORT) : 50025;
  const HOST = process.env.HOST || '127.0.0.1';

  const resolvedDataDir = dataDir || process.env.DATA_DIR;
  if (resolvedDataDir) {
    const { setDataDir } = await import('./database.js');
    setDataDir(resolvedDataDir);
  }
  initializeDatabase();
  startHeartbeatCheck();

  const app = createApp(clientDir);

  // Harden against connection-level errors (client resets / aborted handshakes)
  // that would otherwise surface as unhandled socket 'error' events and crash
  // the whole process.
  app.server.on('connection', (socket) => { socket.on('error', () => {}); });
  app.server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });

  const httpsOpts = loadHttpsOptions();
  const listenOpts: any = { port: PORT, host: HOST };
  if (httpsOpts) Object.assign(listenOpts, { https: httpsOpts });

  try {
    await app.listen(listenOpts);
    console.log(`Server running on ${HOST}:${PORT}${httpsOpts ? ' (HTTPS/WSS)' : ''}`);
    return app;
  } catch (err) {
    console.error('Server failed:', err);
    process.exit(1);
  }
}
