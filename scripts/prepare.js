import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

if (process.env.WN_SKIP_PREPARE === '1') {
  console.log('[prepare] skipped (WN_SKIP_PREPARE=1)');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * What `npm start` actually needs: every production dependency, plus the tools the build is run with.
 *
 * The list used to be hand-maintained and had fallen behind - seven production dependencies were never
 * checked, so a partially installed tree passed here and `npm start` died later with `Cannot find module
 * '@fastify/multipart'`, reported as "Messenger failed to start" with nothing pointing at the real cause.
 * Every production dependency is now taken from package.json, so nothing can fall behind again.
 *
 * Only the build tools are still named. The rest of devDependencies are deliberately not checked: the
 * `@types/*` packages have no runtime entry point at all and cannot be resolved by `require.resolve`, and
 * the Android platform package is not something a server host has any reason to have installed. Asking
 * whether those are present turns a working checkout into a reinstall on every run.
 *
 * Resolution rather than an `existsSync` on the directory, because a directory can be present and still be
 * unusable - a half-extracted install, or a link pointing nowhere. `tsx` was the sharper version of that:
 * the check looked for `node_modules/tsx` while the spawn needs `node_modules/tsx/dist/cli.mjs` inside it.
 */
const BUILD_TOOLS = ['vite', 'tsx', 'typescript'];
const required = [...Object.keys(pkg.dependencies || {}), ...BUILD_TOOLS];

// The build tools are `devDependencies`, and `npm ci` legitimately omits them whenever the environment says
// it only wants what ships: `NODE_ENV=production` or `npm_config_omit=dev`. So on a host configured that
// way, every tool below is "missing", the install that follows is an `npm ci` that omits them for the same
// reason, and this exits non-zero having changed nothing.
//
// The failure then surfaces as a timeout against the server rather than as "your environment will not let me
// build", because `npm start` is backgrounded by `deploy.sh` and its exit code never reaches the operator.
// Said plainly here instead: the check is skipped, because the tools were omitted deliberately, and `vite`
// is needed at runtime to build the client.
const buildToolsOmitted = process.env.NODE_ENV === 'production'
  || /\bdev\b/.test(process.env.npm_config_omit || '')
  || process.env.NPM_CONFIG_PRODUCTION === 'true';
const requiredHere = buildToolsOmitted ? Object.keys(pkg.dependencies || {}) : required;

if (buildToolsOmitted) {
  console.log('[prepare] NODE_ENV=production or npm omit=dev is set; the build tools will not be installed,');
  console.log('[prepare] so the client cannot be built here. Run `npm ci --include=dev` first.');
}

const require_ = createRequire(path.join(ROOT, 'package.json'));
const unresolved = () => requiredHere.filter((name) => {
  try {
    require_.resolve(name);
    return false;
  } catch {
    return true;
  }
});

const missing = unresolved();
if (missing.length === 0) {
  console.log('[prepare] dependencies OK');
  process.exit(0);
}

console.log(`[prepare] installing missing dependencies: ${missing.join(', ')} ...`);

// `npm ci` where there is a lockfile, `npm install` only where there is not.
//
// This ran on every `npm start`, via `prestart`, and used `npm install` - which resolves `^` ranges afresh
// and then writes the result back. So a missing single dependency on a direct `npm start` was enough to
// mutate the dependency tree away from `package-lock.json`, silently, to whatever satisfied the ranges that
// day. The deploy path was protected because `deploy.sh` runs `npm ci` first; the developer path was not.
// `npm ci` refuses to run without a lockfile, which is what the fallback is for.
const hasLockfile = existsSync(path.join(ROOT, 'package-lock.json'));
const args = hasLockfile ? ['ci'] : ['install'];
if (!hasLockfile) {
  console.warn('[prepare] no package-lock.json; falling back to npm install, which resolves versions anew');
}
args.push('--no-audit', '--no-fund');
const res = spawnSync('npm', args, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (res.status !== 0) {
  console.error(`[prepare] npm ${args[0]} failed`);
  process.exit(res.status || 1);
}

// Checked again rather than assumed: the install may have succeeded and still not produced a usable tree,
// and reporting "ready" when it is not is the failure this whole file exists to prevent.
const stillMissing = unresolved();
if (stillMissing.length > 0) {
  console.error(`[prepare] still unresolvable after install: ${stillMissing.join(', ')}`);
  process.exit(1);
}
console.log('[prepare] dependencies installed');