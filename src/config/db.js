const mongoose = require('mongoose');
const logger = require('./logger');

mongoose.set('strictQuery', true);

/**
 * mongodb+srv needs a DNS SRV lookup. On some Windows setups Node's resolver points at 127.0.0.1 and refuses it
 * even though the OS resolves fine; fall back to public resolvers in that case.
 */
async function ensureSrvResolvable(uri) {
  const m = /^mongodb\+srv:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri);
  if (!m) return;
  const dns = require('dns');
  try {
    await dns.promises.resolveSrv(`_mongodb._tcp.${m[1]}`);
  } catch (err) {
    logger.warn({ code: err.code, servers: dns.getServers() }, 'SRV lookup failed with system DNS; retrying with public resolvers');
    dns.setServers(['1.1.1.1', '8.8.8.8']);
  }
}

async function connectDB(uri) {
  await ensureSrvResolvable(uri);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

/** Run fn(session) in a transaction. fn may be retried on transient errors: keep it free of side effects outside the DB. */
async function withTxn(fn) {
  let result;
  await mongoose.connection.transaction(async (session) => {
    result = await fn(session);
  });
  return result;
}

module.exports = { connectDB, withTxn };
