const http = require('http');
const env = require('./config/env');
const logger = require('./config/logger');
const { connectDB } = require('./config/db');
const { createApp } = require('./app');
const { initSockets } = require('./sockets');
const recovery = require('./workers/recovery');

async function main() {
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await connectDB(env.MONGODB_URI);
  const app = createApp();
  const server = http.createServer(app);
  initSockets(server);
  recovery.start();
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'APL Auction API listening'));

  const shutdown = (sig) => {
    logger.info({ sig }, 'shutting down');
    recovery.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  if (err.name === 'MongooseServerSelectionError') {
    logger.fatal(`Cannot reach MongoDB at MONGODB_URI (${err.message}). For local development start the database first in another terminal: npm run dev-db`);
    process.exit(1);
  }
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
