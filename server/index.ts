import { startServer } from './app.js';
import { startCleanupJobs } from './database.js';

startServer().then(() => {
  void startCleanupJobs();
}).catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
