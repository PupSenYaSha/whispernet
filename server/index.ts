import { startServer } from './app.js';
import { startCleanupJobs } from './database.js';

/**
 * `startServer` installs the SIGTERM/SIGINT handler and exits from it, having closed the listener, the
 * sockets, the pending session writes and the database. Resolving here rather than calling `app.close()` a
 * second time is deliberate: the shutdown path has to run in one order, and running a second, different
 * close would race the first.
 */
startServer().then(() => {
  void startCleanupJobs();
}).catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});