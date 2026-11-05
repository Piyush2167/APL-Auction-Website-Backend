#!/usr/bin/env node
/**
 * Local MongoDB replica set for development without Atlas (transactions need a replica set).
 * Data persists in backend/.devdb. Prints the URI to put in MONGODB_URI. Ctrl+C to stop.
 *   npm run dev-db
 */
const path = require('path');
const fs = require('fs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

(async () => {
  const dbPath = path.join(__dirname, '../.devdb');
  fs.mkdirSync(dbPath, { recursive: true });
  const port = Number(process.env.DEV_DB_PORT || 27027);
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ port, dbPath }],
  });
  console.log(`Dev MongoDB replica set ready:\n  MONGODB_URI=${rs.getUri('apl_auction')}`);
  const stop = async () => { await rs.stop({ doCleanup: false }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
