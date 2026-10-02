import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const SITE_PORT = parseInt(process.env.SITE_PORT || '3000', 10);
const MESSENGER_PORT = parseInt(process.env.PORT || '50025', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

const RELEASE_TAG = process.env.RELEASE_TAG || 'v1.0.0';
const RELEASE_BASE = `https://github.com/PupSenYaSha/whispernet/releases/download/${RELEASE_TAG}`;

function serveStatic(req, res) {
  let url = (req.url || '/').split('?')[0];
  if (url === '/') url = '/index.html';

  const filePath = path.join(SITE_DIR, url);

  if (!filePath.startsWith(SITE_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // a download that was never copied into site/downloads must not be a dead link: send the
    // visitor to the release asset instead, so the button keeps working on a fresh clone
    const download = /^\/downloads\/([A-Za-z0-9._-]+)$/.exec(url);
    if (download) {
      res.writeHead(302, { Location: `${RELEASE_BASE}/${download[1]}` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  // release artifacts sit under fixed names, so caching them for a year handed every returning
  // visitor the same build forever
  const immutable = /\.(js|mjs|css|woff2?)$/.test(ext);
  const cacheControl = immutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  try {
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'sameorigin',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'",
    });
    res.end(readFileSync(filePath));
  } catch {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}


function startSiteServerIfPresent() {
  return new Promise((resolve) => {
    if (!existsSync(SITE_DIR)) return resolve(null);

    const server = createServer(serveStatic);
    server.on('error', (e) => {
      console.log(`  (site skipped: port :${SITE_PORT} unavailable - ${e.message})`);
      resolve(null);
    });
    server.listen(SITE_PORT, '0.0.0.0', () => {
      console.log(`  Marketing site:  http://localhost:${SITE_PORT}  (from ${SITE_DIR}, gitignored)`);
      resolve(server);
    });
  });
}

// held at module scope: startMessenger reports a crash from its own exit handler, which runs
// outside main()
let siteServer = null;

function releaseSite() {
  if (siteServer) siteServer.close();
  siteServer = null;
}

function startMessenger(port) {
  return new Promise((resolve, reject) => {
    const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const serverEntry = path.join(ROOT, 'server', 'index.ts');

    const child = spawn(process.execPath, [tsx, serverEntry], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port) },
    });

    let exited = false;
    let sawBanner = false;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);
      if (!sawBanner && text.includes('Server running')) {
        sawBanner = true;
        resolve(child);
      }
    });

    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('error', reject);
    // the exit has to be reported at any time, not only during startup: a server that dies after
    // the banner used to leave the wrapper printing "Ready!" and hanging on a dead port forever
    child.on('exit', (code, signal) => {
      exited = true;
      const how = signal ? `signal ${signal}` : `code ${code}`;
      console.error(`  (messenger process exited with ${how})`);
      if (!sawBanner) reject(new Error(`Messenger exited with ${how}`));
      else {
        releaseSite();
        process.exit(typeof code === 'number' && code !== 0 ? code : 1);
      }
    });

    // if the banner never arrives the child is stuck or the port is taken; give up rather than hang
    setTimeout(() => {
      if (!sawBanner && !exited) {
        console.error('  (messenger did not report that it started within 10s)');
        reject(new Error('Messenger did not start within 10s'));
      }
    }, 10000);
  });
}


async function main() {
  console.log('\n  Starting WhisperNet...\n');

  let messengerProcess;
  try {
    messengerProcess = await startMessenger(MESSENGER_PORT);
    console.log(`  Messenger app:   http://localhost:${MESSENGER_PORT}`);
  } catch (err) {
    console.error('  Messenger failed to start:', err.message);
    process.exit(1);
  }

  siteServer = await startSiteServerIfPresent();

  console.log('\n  Ready! Press Ctrl+C to stop.\n');

  const shutdown = () => {
    console.log('\n  Shutting down...\n');
    releaseSite();
    if (messengerProcess && !messengerProcess.killed) {
      messengerProcess.kill('SIGTERM');
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});