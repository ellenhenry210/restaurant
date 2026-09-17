import { createServer } from 'node:http';

import dotenv from 'dotenv';

import app from './app.js';
import { initDb } from './init-db.js';
import { initRealtime } from './realtime.js';

dotenv.config();

const PORT = process.env.PORT || 3000;

// An explicit http.Server, not app.listen()'s implicit one — Socket.io
// needs to attach to the actual HTTP server (to upgrade connections to
// WebSocket on it), and app.listen() doesn't hand that back to you.
const httpServer = createServer(app);
initRealtime(httpServer);

async function start() {
  // Fail loudly before accepting any traffic if the schema can't be
  // brought up to date, rather than serving requests against a database
  // that's silently missing tables.
  await initDb();

  httpServer.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
