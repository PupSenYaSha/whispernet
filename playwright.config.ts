import { defineConfig } from '@playwright/test';

/**
 * Browser tests, against a real server, over a real websocket.
 *
 * Everything else in this suite tests modules. That is a real limitation and it is not a small one: the
 * wiring between a React effect and the cryptography it calls has never once been executed. A hook that
 * never fires, a state write that never re-renders, a component that reads the wrong field — all of it
 * passes 292 module tests and ships a broken app.
 *
 * The client talks to `/ws` on its own origin and the server serves the built client, so a test here is
 * the same arrangement as production: build once, boot the server, drive the page.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // two accounts have to sign in at the same time for the encrypted path, so tests cannot race each other
  // over one server
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WN_E2E_URL || 'http://127.0.0.1:8799',
    trace: 'retain-on-failure',
  },
});