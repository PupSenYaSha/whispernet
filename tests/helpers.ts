import { WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

const PASSWORD = 'pass123456';
const INFO = 'vitest';
const UNIQ = String(Date.now() % 100000) + String(process.pid % 1000);

export interface StartedServer {
  url: string;
  port: number;
  dataDir: string;
  stop: () => Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}): Promise<StartedServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DISABLE_RATE_LIMITS = '1';
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const distDir = path.resolve('dist/client');
  const { setDataDir, initializeDatabase } = await import('../server/database');
  setDataDir(dataDir);
  initializeDatabase();
  const { createApp } = await import('../server/app');
  const app = createApp(fs.existsSync(distDir) ? distDir : undefined);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    dataDir,
    url: `ws://127.0.0.1:${port}/ws`,
    stop: async () => {
      await app.close();
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* temp dir cleanup is best effort */ }
    },
  };
}

export class TestClient {
  logs: any[] = [];
  ws!: WebSocket;
  private authResolve: ((m: any) => void) | null = null;

  constructor(private url: string, public label = 'client') { }

  connect(): Promise<this> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        this.logs.push(m);
        if ((m.type === 'auth_success' || m.type === 'auth_failure') && this.authResolve) {
          this.authResolve(m);
          this.authResolve = null;
        }
      });
    });
  }

  send(type: string, payload: any = {}): void {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  private waitAuth(): Promise<any> {
    return new Promise((r) => { this.authResolve = r; });
  }

  async register(nickname: string): Promise<any> {
    await this.connect();
    const p = this.waitAuth();
    this.send('auth_register', { nickname, password: PASSWORD, deviceId: 'd' + nickname + UNIQ, deviceInfo: INFO });
    return Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('auth timeout ' + this.label)), 10000))]);
  }

  async login(nickname: string, extra: Record<string, any> = {}): Promise<any> {
    const p = this.waitAuth();
    this.send('auth_login', { nickname, password: PASSWORD, deviceId: 'd' + nickname + UNIQ, deviceInfo: INFO, ...extra });
    return Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('auth timeout ' + this.label)), 10000))]);
  }

  waitFor(type: string, timeout = 5000): Promise<any> {
    const found = this.logs.find((m) => m.type === type);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        const hit = this.logs.find((m) => m.type === type);
        if (hit) { clearInterval(iv); resolve(hit); }
      }, 30);
      setTimeout(() => { clearInterval(iv); resolve(null); }, timeout);
    });
  }

  clear(): void { this.logs.length = 0; }

  close(): void { try { this.ws.close(); } catch { /* already closed */ } }
}

export function httpGet(port: number, urlPath: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', (e: any) => resolve({ status: -1, headers: {}, body: Buffer.from(e.message) }));
  });
}

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const pngDataUrl = (): string => 'data:image/png;base64,' + PNG_1x1;

const crcTable = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function pngDataUrlOfSize(bytes: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const text = Buffer.concat([Buffer.from('Comment\0', 'ascii'), Buffer.alloc(Math.max(1, bytes), 0x41)]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('tEXt', text), chunk('IEND', Buffer.alloc(0)),
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

export const ADMIN_KEY = 'test-admin-key';
export const uniqueNick = (prefix: string): string => prefix + UNIQ + crypto.randomBytes(2).toString('hex');

export interface StartedMediaHost {
  url: string;
  port: number;
  requests: Array<{ contentType: string; length: number }>;
  stop: () => Promise<void>;
}

/**
 * Stands in for the external image host so the upload proxy can be tested without the internet.
 * It mimics the newline separated "data: {...}" stream the real host answers with.
 */
export function startMediaHost(): Promise<StartedMediaHost> {
  const requests: Array<{ contentType: string; length: number }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ contentType: req.headers['content-type'] || '', length: Buffer.concat(chunks).length });
      const id = crypto.randomBytes(8).toString('hex');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('data: {"status":"processing","id":"' + id + '"}\n\n');
      setTimeout(() => {
        res.write('data: {"status":"ready","url":"https://img.test/' + id + '.bin"}\n\n');
        res.end();
      }, 10);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
  });
}

export function postMultipart(
  port: number,
  urlPath: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; body: Buffer | string }>,
): Promise<{ status: number; body: any }> {
  const boundary = '----TestBoundary' + crypto.randomBytes(6).toString('hex');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    chunks.push(Buffer.from(head + '\r\n'));
    chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => {
        const out: Buffer[] = [];
        res.on('data', (c) => out.push(c));
        res.on('end', () => {
          const text = Buffer.concat(out).toString('utf8');
          let parsed: any = text;
          try { parsed = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', (e: any) => resolve({ status: -1, body: { error: e.message } }));
    req.write(body);
    req.end();
  });
}
