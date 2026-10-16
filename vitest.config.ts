import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Generous, and deliberately so. The integration tests do real cryptography against a real server —
    // hundreds of bcrypt comparisons, PBKDF2 at six hundred thousand iterations, sockets — and the
    // heaviest ones take ten to fifteen seconds on an idle machine. At sixty they failed intermittently
    // on a busy one, in whichever file happened to be running, which reads as a real defect and is not
    // one. A flaky suite is worse than a slow suite: it teaches the eye to re-run instead of read.
    testTimeout: 180000,
    hookTimeout: 60000,
    pool: 'forks',
    fileParallelism: false,

    /**
     * The registration proof is cheap here, and it has to be set here rather than in the test helper.
     *
     * `server/constants` reads the environment when it is first imported, and a test file that imports a
     * constant *statically* — `connection-caps` needs `MAX_SESSIONS_PER_USER` — loads it before `beforeAll`
     * ever runs. The helper sets its defaults too late for those files, which left them searching at the
     * production difficulty: twelve registrations at twenty bits is over half a minute, and the test
     * timed out looking like a defect. Setting it here is before any test module is imported, so every
     * file starts from the same cheap value.
     *
     * It is deliberately not zero. Registrations still do real work and still make the real two-phase
     * exchange, several hundred times over; there is just far less of it, and a file that needs a specific
     * difficulty says so by setting `POW_BITS` in its own `startTestServer` call - which does work, because
     * that file will not have imported the server modules by then.
     */
    env: {
      POW_BITS: '8',
    },
  },
});
