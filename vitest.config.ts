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
  },
});
