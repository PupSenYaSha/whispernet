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
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
    });
    res.end(content);
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

function startMessenger(port) {
  return new Promise((resolve, reject) => {
    const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const serverEntry = path.join(ROOT, 'server', 'index.ts');

    const child = spawn(process.execPath, [tsx, serverEntry], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port) },
    });

    let started = false;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);
      if (!started && text.includes('Server running')) {
        started = true;
        resolve(child);
      }
    });

    child.stderr.on('data', (data) => process.stderr.write(data));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!started) reject(new Error(`Messenger exited with code ${code}`));
    });

    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(child);
      }
    }, 5000);
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

  const siteServer = await startSiteServerIfPresent();

  console.log('\n  Ready! Press Ctrl+C to stop.\n');

  const shutdown = () => {
    console.log('\n  Shutting down...\n');
    if (siteServer) siteServer.close();
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