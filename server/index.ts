import { startServer } from './app.js';
import { startGeneralChatMondayCleanup } from './database.js';

startServer().then(() => {
  startGeneralChatMondayCleanup();
}).catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});
