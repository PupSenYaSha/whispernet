import { startServer } from './app.js';
import { startAutoCleanup } from './database.js';

startServer().then(() => {
  startAutoCleanup();
}).catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
