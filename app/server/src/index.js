import { startServer } from './app.js';

startServer().catch((err) => {
  console.error('nihaixia server failed to start:', err);
  process.exit(1);
});

export default startServer;
