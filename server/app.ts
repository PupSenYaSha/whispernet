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
import { initializeDatabase, getMediaDir, getAvatarDir, getUserProfile } from './database.js';
import {
  UPLOAD_RATE_LIMIT,
  UPLOAD_RATE_WINDOW,
  MAX_UPLOAD_SIZE,
  MAX_TOTAL_CONNECTIONS,
  MEDIA_RATE_LIMIT,
  MEDIA_RATE_WINDOW,
  MAX_MEDIA_STREAM,
  MAX_WS_PAYLOAD_SIZE,
} from './constants.js';
import https from 'https';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));



const MIME_RE = /^(image|video)\/[a-z0-9.+-]+$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AVATAR_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const uploadRateMap = new Map<string, { count: number; resetAt: number }>();
const mediaRateMap = new Map<string, { count: number; resetAt: number }>();



setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of uploadRateMap) {
    if (now > entry.resetAt) uploadRateMap.delete(ip);
  }
  for (const [ip, entry] of mediaRateMap) {
    if (now > entry.resetAt) mediaRateMap.delete(ip);
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

function checkMediaRate(ip: string): boolean {
  const now = Date.now();
  const entry = mediaRateMap.get(ip);
  if (!entry || now > entry.resetAt) {
    mediaRateMap.set(ip, { count: 1, resetAt: now + MEDIA_RATE_WINDOW });
    return true;
  }
  if (entry.count >= MEDIA_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f\/\\"]/g, '').slice(0, 128) || 'upload';
}

function getMediaBase(): URL {
  return new URL(process.env.MEDIA_BASE_URL || 'https://img.n1ko.dev');
}



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
  const trustProxy = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
  const app = fastify({ logger: false, trustProxy });
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
      let allowedHost = '';
      try {
        allowedHost = new URL(origin).host;
      } catch {
        allowedHost = '';
      }
      if (allowedHost && allowedHost === host) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
      }
    }
    reply.header('Vary', 'Origin');
  });

  app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_SIZE } });
  app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_SIZE, files: 1, fields: 0, parts: 1 } });

  const resolvedClientDir = clientDir || path.join(__dirname, '../dist/client');
  app.register(fastifyStatic, {
    root: resolvedClientDir,
    prefix: '/',
    wildcard: true,
    
    
    setHeaders(res, filePath) {
      if (/\.(js|mjs|css|woff2?|png|jpg|jpeg|gif|webp|svg|ico)$/i.test(filePath)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.header('Cache-Control', 'no-cache');
      }
    },
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/avatar/:id', async (req, reply) => {
    const id = (req.params as any).id || '';
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'Invalid user id' });
    const prof = await getUserProfile(id);
    if (!prof || !prof.avatarExt) return reply.code(404).send({ error: 'Not found' });
    const mime = AVATAR_MIME[prof.avatarExt];
    if (!mime) return reply.code(404).send({ error: 'Not found' });
    const fp = path.join(getAvatarDir(), id);
    if (!existsSync(fp)) return reply.code(404).send({ error: 'Not found' });
    const buf = await fs.promises.readFile(fp);
    return reply
      .header('Content-Type', mime)
      .header('Cache-Control', 'public, max-age=86400')
      .send(buf);
  });

  app.get('/api/media', async (req, reply) => {
    const ip = req.ip || 'unknown';
    if (!checkMediaRate(ip)) {
      return reply.code(429).send({ error: 'Rate limit' });
    }
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
      const MEDIA_CT_ALLOW_RE = /^(image\/(png|jpeg|jpg|webp|gif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/octet-stream)\b/i;
      if (!MEDIA_CT_ALLOW_RE.test(proxyResCt)) {
        proxyRes.destroy();
        try { raw.writeHead(415); raw.end('Unsupported media type'); } catch {}
        return;
      }

      const contentLength = parseInt(proxyRes.headers['content-length'] || '0', 10);
      if (contentLength > MAX_MEDIA_STREAM) {
        proxyRes.destroy();
        try { raw.writeHead(413); raw.end('Too large'); } catch {}
        return;
      }

      let totalBytes = 0;
      const MAX_RESPONSE = MAX_MEDIA_STREAM;

      raw.writeHead(proxyRes.statusCode || 502, {
        'Content-Type': proxyResCt,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
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

    // a request that carries no file part trips a multipart limit, which Fastify would report as
    // "413 File too large" and confuse the sender; it is a malformed upload, so say so
    const readUpload = async () => {
      try {
        return await req.file();
      } catch (e: any) {
        const code = String(e?.code || '');
        if (code.startsWith('FST_FIELDS_LIMIT') || code.startsWith('FST_FILES_LIMIT') || code.startsWith('FST_PARTS_LIMIT')) {
          await reply.code(400).send({ error: 'No file' });
          return null;
        }
        throw e;
      }
    };

    if ((process.env.MEDIA_STORAGE || 'remote') === 'local') {
      const data = await readUpload();
      if (!data) return;
      if (!MIME_RE.test(data.mimetype)) {
        return reply.code(400).send({ error: 'Invalid file type' });
      }
      const buf = await data.toBuffer();
      if (buf.length > MAX_UPLOAD_SIZE) return reply.code(413).send({ error: 'File too large' });
      const id = crypto.randomBytes(16).toString('hex');
      await fs.promises.writeFile(path.join(getMediaDir(), id), buf);
      return reply.send({ url: '/media/' + id });
    }

    const data = await readUpload();
    if (!data) return;

    if (!MIME_RE.test(data.mimetype)) {
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
      // the file is already fully buffered at this point, so the upload must not be tied to the
      // lifetime of the incoming request: reading the multipart body to the end makes req.raw emit
      // "close", and destroying the upstream request there aborted every single upload
      const respond = (code: number, body: Record<string, unknown>) => {
        try { reply.code(code).send(body); } catch { /* the client is already gone */ }
        resolve();
      };
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
        let resBytes = 0;
        const MAX_UPLOAD_RESPONSE = 64 * 1024;
        res.on('data', (c: Buffer) => {
          resBytes += c.length;
          if (resBytes > MAX_UPLOAD_RESPONSE) {
            req2.destroy();
            respond(502, { error: 'Upstream response too large' });
            return;
          }
          resBody += c;
        });
        res.on('end', () => {
          for (const line of resBody.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const d = JSON.parse(line.substring(6));
                if (d.status === 'ready' && d.url) {
                  respond(200, { url: d.url });
                  return;
                }
                if (d.status === 'failed') {
                  respond(500, { error: d.error || 'Upload failed' });
                  return;
                }
              } catch {  }
            }
          }
          respond(500, { error: 'Upload failed' });
        });
      });

      req2.on('error', (e) => {
        console.error('Upload proxy error:', e.message);
        respond(502, { error: 'Network error' });
      });

      req2.on('timeout', () => {
        req2.destroy();
        respond(504, { error: 'Timeout' });
      });

      req2.write(body);
      req2.end();
    });
  });

  app.register(async (fastify) => {
    
    
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
    reply
      .header('Cache-Control', 'no-cache')
      .sendFile('index.html');
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
