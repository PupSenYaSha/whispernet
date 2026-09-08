import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MESSENGER_PORT = parseInt(process.env.PORT || '50025', 10);

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

  console.log('\n  Ready! Press Ctrl+C to stop.\n');

  const shutdown = () => {
    console.log('\n  Shutting down...\n');
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
