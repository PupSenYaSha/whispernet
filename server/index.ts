import { startServer } from './app.js';

startServer().catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
