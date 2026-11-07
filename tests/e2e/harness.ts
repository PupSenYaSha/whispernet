import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Boots a real server on a random port against a throwaway database.
 *
 * In process, the same way the integration tests do it, so the browser is talking to the actual Fastify
 * app with the actual websocket route and the actual crypto — not a stub that agrees with whatever the
 * test hoped the server would do.
 */

const PORT = Number(process.env.WN_E2E_PORT || 8799);
const DATA_DIR = path.join(os.tmpdir(), `wn-e2e-${process.pid}`);
const CLIENT_DIST = path.join(process.cwd(), 'dist', 'client');

export interface E2EServer {
  url: string;
  stop: () => Promise<void>;
  /** Everything the page wrote to the console, so a test can look at it. */
  dataDir: string;
}

export async function startE2EServer(): Promise<E2EServer> {
  // Point the same scenarios at an instance that is already running, with WN_E2E_LIVE=1.
  //
  // Worth having as a mode rather than a separate suite: the browser tests prove the crypto path, and they
  // prove it against a server this run started. That is not the same claim as proving it against the
  // server people are connected to, and the difference is not academic — the live host was returning 502
  // for a while while every one of these passed locally.
  if (process.env.WN_E2E_LIVE === '1') {
    const url = process.env.WN_E2E_URL;
    if (!url) throw new Error('WN_E2E_LIVE=1 needs WN_E2E_URL');
    return { url, dataDir: '', stop: async () => { /* somebody else's server; leave it running */ } };
  }

  if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    throw new Error('dist/client is missing — run `npm run build:client` before the browser tests');
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  process.env.DATA_DIR = DATA_DIR;
  process.env.NODE_ENV = 'test';
  process.env.WN_PORT = String(PORT);

  const { setDataDir, initializeDatabase } = await import('../../server/database');
  setDataDir(DATA_DIR);
  initializeDatabase();

  const { createApp } = await import('../../server/app');
  // passed explicitly rather than left to the default, so the browser gets the build this run made and
  // not whatever happens to be sitting in dist from yesterday
  const app = await createApp(CLIENT_DIST);
  await app.listen({ port: PORT, host: '127.0.0.1' });

  return {
    url: `http://127.0.0.1:${PORT}`,
    dataDir: DATA_DIR,
    stop: async () => {
      await app.close();
      // Best effort, and deliberately not awaited-thrown: Windows keeps the SQLite file mapped for a
      // moment after the server closes, so a hard failure here would replace every real assertion failure
      // with a cleanup error and hide what actually went wrong.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(DATA_DIR, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
}

/** A nickname nobody else in this run can have taken. */
export function uniqueNick(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`.slice(0, 16);
}