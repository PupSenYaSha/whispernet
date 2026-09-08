import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REQUIRED = ['vite', 'tsx', 'typescript', 'react', 'react-dom', 'fastify', '@fastify/websocket', 'ws', '@noble/ciphers'];

if (process.env.WN_SKIP_PREPARE === '1') {
  console.log('[prepare] skipped (WN_SKIP_PREPARE=1)');
  process.exit(0);
}

const missing = REQUIRED.filter((p) => !existsSync(path.join(ROOT, 'node_modules', p)));

if (missing.length === 0) {
  console.log('[prepare] dependencies OK');
  process.exit(0);
}

console.log(`[prepare] installing missing dependencies: ${missing.join(', ')} ...`);
const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (res.status !== 0) {
  console.error('[prepare] npm install failed');
  process.exit(res.status || 1);
}
console.log('[prepare] dependencies installed');