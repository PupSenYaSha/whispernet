import fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { resolveUploadTokenUser } from './uploadTokens.js';
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
import type { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));



const MIME_RE = /^(image|video)\/[a-z0-9.+-]+$/i;

/** A bare host, optionally with a port - nothing that could smuggle directives into a header. */
const SAFE_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

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

function checkUploadRate(key: string): boolean {
  const now = Date.now();
  const entry = uploadRateMap.get(key);
  if (!entry || now > entry.resetAt) {
    uploadRateMap.set(key, { count: 1, resetAt: now + UPLOAD_RATE_WINDOW });
    return true;
  }
  if (entry.count >= UPLOAD_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function checkMediaRate(key: string): boolean {
  const now = Date.now();
  const entry = mediaRateMap.get(key);
  if (!entry || now > entry.resetAt) {
    mediaRateMap.set(key, { count: 1, resetAt: now + MEDIA_RATE_WINDOW });
    return true;
  }
  if (entry.count >= MEDIA_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\x00-\x1f\x7f/\\"]/g, '').slice(0, 128) || 'upload';
}

function resolveUploadUser(req: any): string | null {
  return resolveUploadTokenUser(req.headers?.['x-wn-upload-token'])
    ?? resolveUploadTokenUser((req.query as any)?.t);
}

function resolveUploadRateKey(req: any): string {
  // The token arrives in a header for uploads, but media is fetched by <img> and <video>, which cannot
  // carry one. Without reading it from the query string as well, every media request fell back to the
  // address, which put a whole family or office on one shared counter.
  const userId = resolveUploadUser(req);
  if (userId) return 'user:' + userId;
  // anonymous callers fall back to the address, which is all we know about them
  return 'ip:' + (req.ip || req.socket?.remoteAddress || 'unknown');
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
    // X-XSS-Protection is deliberately absent. It has been deprecated for years, every modern browser
    // ignores it, and the filter it used to switch on has itself been a source of vulnerabilities.
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    if (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const host = req.headers.host || 'localhost';
    // the policy is built from a host the client chose, so only a plain host:port may go in -
    // anything else could carry extra directives into the header
    const configured = (process.env.PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const cspHost = SAFE_HOST_RE.test(configured) ? configured : (SAFE_HOST_RE.test(host) ? host : 'localhost');
    // The websocket scheme follows the one the page itself arrived on. Listing `ws:` unconditionally left
    // a plaintext socket permitted on an encrypted deployment, which is one misdirected request away
    // from being used.
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    const wsScheme = secure ? 'wss:' : 'ws:';
    reply.header('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://${mediaHost} http://${mediaHost}; media-src 'self' blob: https://${mediaHost} http://${mediaHost}; connect-src 'self' ${wsScheme}//${cspHost}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; font-src 'self'`);
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

  // The streamed upload route posts the encrypted attachment as the request body, which fastify
  // refuses by default because it has no idea what to do with an unparsed octet stream. Passing the
  // stream through untouched is the point: anything that read it into memory here would defeat the
  // reason the route exists.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

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

  /**
   * Streams a stored attachment out.
   *
   * It used to be read whole into a buffer and handed over with `send`. The ceiling on an attachment is
   * a gigabyte, this route needs no token - reading stays open, because an <img> cannot carry one - so a
   * single unauthenticated request was enough to make the process allocate a gigabyte. It goes out in
   * chunks now, and a Range header is honoured so seeking in a video does not restart from the
   * beginning, which is what makes a <video> element usable at all.
   */
  async function streamStoredMedia(req: any, reply: any, fp: string): Promise<any> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fp);
      if (!stat.isFile()) return reply.code(404).send({ error: 'Not found' });
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }

    const size = stat.size;
    const range = typeof req.headers?.range === 'string' ? req.headers.range : '';
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    // The range is settled before the content type is set. Once it has been, fastify no longer
    // serialises an object for this reply, and a refusal sent as `{error: ...}` comes back as a 500
    // about an invalid payload rather than the status that was meant.
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (match && (match[1] || match[2])) {
      if (match[1] === '') {
        // a suffix range: the last N bytes
        const suffix = Number(match[2]);
        if (!Number.isFinite(suffix) || suffix <= 0) {
          reply.header('Content-Range', `bytes */${size}`);
          return reply.code(416).type('text/plain').send('Range not satisfiable');
        }
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Number(match[2]);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        reply.header('Content-Range', `bytes */${size}`);
        return reply.code(416).type('text/plain').send('Range not satisfiable');
      }
      if (end >= size) end = size - 1;
      partial = true;
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.header('X-Content-Type-Options', 'nosniff');

    if (partial) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', String(end - start + 1));
      return reply.send(fs.createReadStream(fp, { start, end }));
    }

    reply.header('Content-Length', String(size));
    return reply.send(fs.createReadStream(fp));
  }

  app.get('/api/media', async (req, reply) => {
    if (!checkMediaRate(resolveUploadRateKey(req))) {
      return reply.code(429).send({ error: 'Rate limit' });
    }
    const url = (req.query as any).url;
    if (!url || typeof url !== 'string') return reply.code(400).send({ error: 'Missing url' });

    if (url.startsWith('/media/')) {
      const id = path.basename(url);
      if (!/^[a-f0-9]{32}$/.test(id)) return reply.code(400).send({ error: 'Invalid media id' });
      const fp = path.join(getMediaDir(), id);
      if (!existsSync(fp)) return reply.code(404).send({ error: 'Not found' });
      return streamStoredMedia(req, reply, fp);
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
      const proxyResCt = proxyRes.headers['content-type'] || 'application/octet-stream';
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

  /**
   * Everything that happens once the bytes are safely on disk: kept locally, or handed to the media
   * host. Shared by the multipart and the streamed route so a large encrypted attachment and a small
   * picture are stored in exactly the same way, and neither is ever held in memory to do it.
   */
  async function storeTempUpload(
    reply: any,
    tmpPath: string,
    size: number,
    rawName: string,
    mimeType: string
  ): Promise<void> {
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* already gone */ } };

    try {
      if ((process.env.MEDIA_STORAGE || 'remote') === 'local') {
        const id = crypto.randomBytes(16).toString('hex');
        await fs.promises.copyFile(tmpPath, path.join(getMediaDir(), id));
        reply.send({ url: '/media/' + id });
        return;
      }

      const boundary = '----FormBoundary' + crypto.randomUUID();
      const fileName = sanitizeFilename((rawName || 'upload').replace(/\.[a-z0-9]{1,5}$/i, '')) + '.bin';
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const contentLength = head.length + size + tail.length;

      await new Promise<void>((resolve) => {
        const uploadUrl = new URL('/upload', getMediaBase());
        const lib = uploadUrl.protocol === 'https:' ? https : http;
        let answered = false;
        const respond = (code: number, body: Record<string, unknown>) => {
          if (answered) return;
          answered = true;
          try { reply.code(code).send(body); } catch { /* the client is already gone */ }
          resolve();
        };
        const req2 = lib.request(uploadUrl, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': contentLength,
            'User-Agent': 'WhisperNet',
          },
          timeout: 15 * 60 * 1000,
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
                } catch { /* not a json line */ }
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

        const readStream = fs.createReadStream(tmpPath);
        readStream.on('error', () => {
          req2.destroy();
          respond(500, { error: 'Storage error' });
        });
        readStream.on('end', () => { req2.end(tail); });
        req2.write(head);
        readStream.pipe(req2, { end: false });
      });
    } finally {
      cleanup();
    }
  }

  /**
   * Refuses an upload from anybody who cannot name an account.
   *
   * Both upload routes used to take the token only to decide whose rate limit to charge, and never to
   * decide whether to serve the request at all. Since the ceiling is a gigabyte and the websocket
   * handshake is the only thing that issues a token, that left the endpoint open to anyone who could
   * reach the port: no account, no password, just a body of whatever size they liked. Reading is a
   * separate matter and stays open, because an <img> cannot carry a header.
   */
  function requireUploadUser(req: any, reply: any): string | null {
    const userId = resolveUploadUser(req);
    if (!userId) {
      reply.code(401).send({ error: 'Upload token required' });
      return null;
    }
    return userId;
  }

  /** Writes a request stream to disk, refusing anything past the ceiling without buffering it. */
  async function drainToTempFile(source: Readable, tmpPath: string): Promise<number> {
    return new Promise<number>((resolve) => {
      const out = fs.createWriteStream(tmpPath);
      let bytes = 0;
      let settled = false;
      const finish = (n: number) => { if (!settled) { settled = true; resolve(n); } };

      source.on('data', (c: Buffer) => {
        bytes += c.length;
        if (bytes <= MAX_UPLOAD_SIZE || settled) return;
        // Past the ceiling the answer is decided. Stopped rather than drained: letting a client keep
        // sending a gigabyte it has already been refused is the one thing this route must not do, and
        // waiting for the body to finish before replying would hang it instead.
        try { source.unpipe(out); } catch { /* already detached */ }
        out.end();
        finish(-1);
        try { source.destroy(); } catch { /* already gone */ }
      });
      source.on('error', () => finish(-1));
      out.on('error', () => finish(-1));
      out.on('finish', () => finish(bytes));
      source.pipe(out);
    });
  }

  app.post('/api/upload', async (req, reply) => {
    if (!requireUploadUser(req, reply)) return;

    const rateKey = resolveUploadRateKey(req);
    if (!checkUploadRate(rateKey)) {
      return reply.code(429).send({ error: 'Rate limit' });
    }

    const tmpPath = path.join(os.tmpdir(), 'wn-upload-' + crypto.randomBytes(8).toString('hex'));
    const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* already gone */ } };

    let part: any;
    try {
      part = await req.file();
    } catch (e: any) {
      const code = String(e?.code || '');
      if (code.startsWith('FST_FIELDS_LIMIT') || code.startsWith('FST_FILES_LIMIT') || code.startsWith('FST_PARTS_LIMIT')) {
        return reply.code(400).send({ error: 'No file' });
      }
      if (code.startsWith('FST_REQ_FILE_TOO_LARGE')) {
        return reply.code(413).send({ error: 'File too large' });
      }
      throw e;
    }
    if (!part) return reply.code(400).send({ error: 'No file' });
    if (!MIME_RE.test(part.mimetype)) {
      part.file.resume();
      return reply.code(400).send({ error: 'Invalid file type' });
    }

    // the file may be a gigabyte, so it never sits in memory: it lands in a temp file and every
    // later step streams from there
    const size = await new Promise<number>((resolve, reject) => {
      const out = fs.createWriteStream(tmpPath);
      let bytes = 0;
      part.file.on('data', (c: Buffer) => { bytes += c.length; });
      part.file.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve(bytes));
      part.file.pipe(out);
    }).catch(() => -1);

    if (size < 0) {
      cleanup();
      return reply.code(413).send({ error: 'File too large' });
    }
    if (size > MAX_UPLOAD_SIZE) {
      cleanup();
      return reply.code(413).send({ error: 'File too large' });
    }

    await storeTempUpload(reply, tmpPath, size, part.filename || 'upload', part.mimetype);
    return reply;
  });

  /**
   * The same upload, but the body is the encrypted stream itself rather than a multipart form.
   *
   * A multipart request has to arrive as one finished Blob, so a client with a large attachment had
   * to hold it whole before the request could start. Here the request begins with the first chunk and
   * the bytes are written straight to disk as they arrive, which is what lets a private chat carry
   * the same gigabyte the global chat already did.
   */
  app.post('/api/upload-raw', async (req, reply) => {
    if (!requireUploadUser(req, reply)) return;

    const rateKey = resolveUploadRateKey(req);
    if (!checkUploadRate(rateKey)) {
      return reply.code(429).send({ error: 'Rate limit' });
    }

    const mimeType = String((req.query as any)?.type || 'application/octet-stream');
    if (!MIME_RE.test(mimeType)) return reply.code(400).send({ error: 'Invalid file type' });
    const name = String((req.query as any)?.name || 'media.png').slice(0, 128);

    const declared = Number((req.headers as any)?.['content-length'] || 0);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_SIZE) {
      return reply.code(413).send({ error: 'File too large' });
    }

    const tmpPath = path.join(os.tmpdir(), 'wn-upload-' + crypto.randomBytes(8).toString('hex'));
    // the registered parser hands the stream through untouched, so nothing has read it yet
    const body = (req as any).body;
    const source = body && typeof body.pipe === 'function' ? body : req.raw;
    const size = await drainToTempFile(source, tmpPath);
    if (size < 0) {
      try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
      return reply.code(413).send({ error: 'File too large' });
    }

    await storeTempUpload(reply, tmpPath, size, name, mimeType);
    return reply;
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

      handleConnection(ws, req);
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
