import { WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { searchSolution } from '../src/registerPow';

const PASSWORD = 'pass123456';
const INFO = 'vitest';
const UNIQ = String(Date.now() % 100000) + String(process.pid % 1000);

export interface StartedServer {
  url: string;
  port: number;
  dataDir: string;
  stop: (opts?: { keepData?: boolean }) => Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}, opts: { dataDir?: string } = {}): Promise<StartedServer> {
  // A caller can hand back the directory a previous server used, which is how a restart is tested: a fresh
  // process against the same files, rather than a second database that happens to start empty.
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wn-test-'));
  process.env.DATA_DIR = dataDir;
  process.env.DISABLE_RATE_LIMITS = '1';
  process.env.ADMIN_KEY = 'test-admin-key';
  // Tests that exercise the account creation budget set this themselves. Everything else gets a
  // generous number, so a test file that happens to create a dozen accounts is not refused partway
  // through for a reason it is not testing.
  // POW_BITS defaults low for the suite: a full-difficulty search is seconds, and several hundred
  // registrations would turn the suite into a benchmark. It is not switched off - every registration still
  // does real work and the real two-phase exchange, just far less of it.
  // Every test client connects over loopback and says which address it is really from with
  // `x-forwarded-for`, because a suite cannot give every case its own source address any other way. That
  // header is only believed when TRUST_PROXY says there is a proxy in front - it used to be believed for a
  // loopback peer, which is what let a client choose its own address - so the harness declares it here
  // rather than each file having to. `tests/integration/proxy-trust.test.ts` covers the undeclared case.
  for (const [k, v] of Object.entries({ MAX_REGISTRATIONS_PER_IP: '1000', MAX_ACCOUNTS_PER_DEVICE: '1000', POW_BITS: '8', TRUST_PROXY: '1', ...env })) process.env[k] = v;
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
    stop: async (opts: { keepData?: boolean } = {}) => {
      await app.close();
      // `keepData` is for the restart test: the point is to come back to the same files, so the directory
      // must outlive the process that opened it.
      if (opts.keepData) return;
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* temp dir cleanup is best effort */ }
    },
  };
}

export class TestClient {
  logs: any[] = [];
  ws!: WebSocket;
  /** The upload token the server issued on sign-in, kept so a test can upload as this account. */
  uploadToken = '';
  /** The account id the server assigned, for tests that have to address a conversation at it. */
  userId = '';
  private authResolve: ((m: any) => void) | null = null;

  constructor(private url: string, public label = 'client') { }

  connect(headers?: Record<string, string>): Promise<this> {
    return new Promise((resolve, reject) => {
      this.ws = headers ? new WebSocket(this.url, { headers }) : new WebSocket(this.url);
      this.ws.on('open', () => resolve(this));
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        this.logs.push(m);
        if (m.type === 'auth_success' && typeof m.payload?.uploadToken === 'string') this.uploadToken = m.payload.uploadToken;
        if (m.type === 'auth_success' && typeof m.payload?.userId === 'string') this.userId = m.payload.userId;
        if ((m.type === 'auth_success' || m.type === 'auth_failure' || m.type === 'twofactor_required') && this.authResolve) {
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

  /**
   * Waits for the server to answer an authentication attempt, including a request for proof of work.
   *
   * A registration with no proof comes back as a challenge rather than a success or a refusal, and the
   * suite should not have to notice: every test that registers an account goes through the real two-phase
   * flow, which is the point of having it. Turning the proof off in tests would have been easier and would
   * have left the default path with nothing covering it.
   */
  private waitAuthOrChallenge(): Promise<any> {
    return new Promise((resolve) => {
      this.authResolve = (m: any) => {
        if (m.type !== 'auth_pow_challenge') resolve(m);
      };
      const poll = setInterval(() => {
        const challenge = this.logs.find((x) => x.type === 'auth_pow_challenge');
        if (challenge) { clearInterval(poll); resolve(challenge); }
      }, 20);
      setTimeout(() => { clearInterval(poll); resolve(null); }, 10000);
    });
  }

  private ensureOpen(): Promise<this> {
    return this.ws && this.ws.readyState === 1 ? Promise.resolve(this) : this.connect();
  }

  async register(nickname: string, extra: Record<string, any> = {}): Promise<any> {
    await this.ensureOpen();
    const payload = { nickname, password: PASSWORD, deviceId: 'd' + nickname + UNIQ, deviceInfo: INFO, ...extra };
    const p = this.waitAuthOrChallenge();
    this.send('auth_register', payload);
    const res = await Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('auth timeout ' + this.label)), 10000))]);
    if (res?.type !== 'auth_pow_challenge') return res;

    // Solve and try once more, on the same socket and with the same nickname and password, so the server
    // sees exactly the frame a real client sends second.
    const challenge = res.payload.challenge as string;
    const bits = Number(res.payload.bits);
    const nonce = searchSolution(challenge, bits);
    if (nonce === null) return res;
    this.authResolve = null;
    const retry = this.waitAuth();
    this.send('auth_register', { ...payload, powChallenge: challenge, powNonce: nonce });
    return Promise.race([retry, new Promise((_, rj) => setTimeout(() => rj(new Error('auth timeout ' + this.label)), 10000))]);
  }

  async login(nickname: string, extra: Record<string, any> = {}): Promise<any> {
    await this.ensureOpen();
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

  /**
   * Waits for the first message matching any of the given types.
   *
   * For assertions that something must *not* arrive, where `waitFor` would only confirm the one type it was
   * given. A negative assertion still needs to watch the socket: the failure mode this catches is traffic
   * landing on the wrong connection, and proving it means proving it went somewhere else.
   */
  waitForAny(types: string[], timeout = 5000): Promise<any | null> {
    const hit = () => this.logs.find((m) => types.includes(m.type));
    const found = hit();
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        const h = hit();
        if (h) { clearInterval(iv); resolve(h); }
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

/**
 * The server accepts nicknames of 3 to 16 characters, so the prefix has to make room for a unique
 * suffix. Without the truncation a nickname like "multi" + suffix came out at 17 characters,
 * registration failed, and tests passed while measuring nothing.
 */
export const uniqueNick = (prefix: string): string => {
  const suffix = (process.pid % 1000).toString(36) + crypto.randomBytes(3).toString('hex');
  return (prefix + suffix).slice(0, 16);
};

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
  uploadToken?: string,
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
  const headers: Record<string, string> = { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) };
  // the endpoint requires a token now, so a caller that has one passes it and a caller testing the
  // refusal deliberately leaves it out
  if (uploadToken) headers['X-WN-Upload-Token'] = uploadToken;
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'POST', headers },
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
