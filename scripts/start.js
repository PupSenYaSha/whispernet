import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
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
};

// The tag the download buttons fall back to. Checked, because it goes straight into a `Location` header:
// an unvalidated value containing a newline makes `writeHead` throw, and a throw inside a `request`
// listener is not caught by Node's HTTP server — it takes the process down. A one-character typo in an
// environment variable is not supposed to be able to stop the site.
const RELEASE_TAG = /^v[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(process.env.RELEASE_TAG || '')
  ? process.env.RELEASE_TAG
  : 'v1.0.0';
const RELEASE_BASE = `https://github.com/PupSenYaSha/whispernet/releases/download/${RELEASE_TAG}`;

/**
 * The headers, sent on every response and not only the 200.
 *
 * They used to sit inside the `try` that wrote the file, so a 403, a 302 or a 404 left with no headers at
 * all - no `Content-Type`, no `nosniff`, no `Cache-Control`. Those are exactly the responses worth sniffing
 * the content type of, and they were the only ones without the protection. The real server sets all of this
 * in an `onRequest` hook for the same reason.
 *
 * `frame-ancestors 'none'` is the whole of the framing policy here. It used to be doubled up with
 * `X-Frame-Options: sameorigin`, which does not add a defence - it states a weaker rule than the CSP, and
 * the two contradicted each other about the same origin.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // `X-Frame-Options: sameorigin` was here as well as `frame-ancestors 'none'`, and the two disagreed: the
  // header permits framing by this origin, the policy forbids it by anyone including itself. The CSP is the
  // stronger and the one every current browser reads, and the comment above this block says as much - so the
  // header only served to reintroduce the weaker rule it was meant to back up.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  // the page ships its own Inter files, so nothing it loads comes from anywhere else - which is the whole
  // point, and a policy that quietly permitted a third party would undo it
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'; object-src 'none'",
};

function send(res, status, headers, body) {
  try {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  } catch {
    try { res.end(); } catch { /* the client is already gone */ }
  }
}

/**
 * Is this path inside the site directory?
 *
 * `startsWith(SITE_DIR)` was one character short of correct. It matches any sibling whose name begins with
 * the same characters, so `/../site.old/index.html` resolved to a directory next to the site and passed -
 * and `site/downloads/` is gitignored, which means a deploy that left `site.old` or `site_backup` beside it
 * published a whole previous deployment, binaries included, to anyone who asked. The separator is the
 * whole difference: a path inside the directory is always followed by one, and a sibling never is.
 */
function isInsideSite(filePath) {
  const rel = path.relative(SITE_DIR, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function serveStatic(req, res) {
  let url = (req.url || '/').split('?')[0];
  if (url === '/') url = '/index.html';

  const filePath = path.join(SITE_DIR, url);

  if (!isInsideSite(filePath)) {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // a download that was never copied into site/downloads must not be a dead link: send the
    // visitor to the release asset instead, so the button keeps working on a fresh clone
    const download = /^\/downloads\/([A-Za-z0-9._-]+)$/.exec(url);
    if (download) {
      send(res, 302, { Location: `${RELEASE_BASE}/${download[1]}` });
      return;
    }
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  // Fonts only, and the reason is the filename rather than the type.
  //
  // This was `/\.(mjs|css|woff2?)$/`, which put `site/style.css` - a fixed name with a hand-maintained
  // `?v=2` buster in `index.html` - behind a year of `immutable`. Edit the CSS without remembering to bump
  // that number and no returning visitor sees the change until the cache expires, which does not happen for
  // a year. The comment two lines above the old version diagnosed exactly this for `.js` and `sw.js`, and
  // then applied it to `.css`, which is the one file that needs the query string precisely because it is
  // not content-hashed.
  //
  // A font filename is content-addressed by whatever produced it and is never edited in place, so a year
  // on that is right. `.css` and `.mjs` stay `no-cache`: revalidated on every load, which is a conditional
  // request rather than a download.
  const immutable = /\.woff2?$/.test(ext);

  try {
    send(res, 200, {
      'Content-Type': mime,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    }, readFileSync(filePath));
  } catch {
    send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
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
    // 127.0.0.1, matching `server/app.ts`. This was 0.0.0.0, which put `site/` - including
    // `downloads/*.exe|*.apk|.deb` when they have been copied in - on a second listening socket with none of
    // the app server's posture, on the same host, for no reason: the reverse proxy connects over loopback
    // like everything else, and binding a wider interface only adds routes to the internet that nothing
    // asked for.
    server.listen(SITE_PORT, '127.0.0.1', () => {
      console.log(`  Marketing site:  http://localhost:${SITE_PORT}  (from ${SITE_DIR})`);
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

  // Publish this process's own pid, because `deploy.sh` cannot obtain it.
  //
  // The deploy script starts the server with `nohup npm start &`, so `$!` there is the **npm** pid: npm →
  // `sh -c` → `node scripts/start.js` → the server it spawns. npm does not forward SIGTERM down that tree,
  // so the `shutdown` handler below - the one that actually kills the server - was never reached by a deploy.
  // The old server kept the port, the new one died with EADDRINUSE, and the deploy's own health check
  // succeeded against the process it had just failed to replace. It printed "OK: server up" while serving
  // the previous build, which is the worst possible outcome: a deploy that reports success and changes
  // nothing.
  //
  // Writing the pid of the process that can actually be signalled is what makes a deploy replace the server.
  // The wrapper reads this back and signals *this* pid, so the handler below runs and the child dies.
  const pidFile = process.env.WHISPERNET_PIDFILE;
  if (pidFile) {
    try {
      writeFileSync(pidFile, String(process.pid));
    } catch (err) {
      // not fatal: a deploy without a pidfile can still stop the server by port, just less precisely
      console.error('  Could not write pid file:', err.message);
    }
  }

  const shutdown = () => {
    console.log('\n  Shutting down...\n');
    if (pidFile) { try { unlinkSync(pidFile); } catch { /* already gone */ } }
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