/**
 * Recovery worker: the DB, not memory, is the source of truth.
 *  - completes SOLD finalizations whose persisted deadline has passed (exactly-once via CAS + unique keys)
 *  - re-arms the timer for a finalization still in progress after a restart
 *  - publishes outbox events committed but not yet broadcast (e.g. crash between commit and emit)
 */
const { Auction } = require('../models');
const auction = require('../services/auctionService');
const outbox = require('../services/outbox');
const logger = require('../config/logger');

let timer = null;

let dbDownLogged = false;
async function tick() {
  // Nothing to recover while the DB is unreachable; log the outage once instead of every second.
  if (require('mongoose').connection.readyState !== 1) {
    if (!dbDownLogged) logger.warn('database unavailable; recovery worker waiting for reconnection');
    dbDownLogged = true;
    return;
  }
  if (dbDownLogged) { logger.info('database reconnected; recovery worker resumed'); dbDownLogged = false; }
  try {
    while (await auction.completeDueFinalization()) { /* drain any due finalization */ }
    const pending = await Auction.findOne({ status: 'FINALIZING' }).select('finalization.deadline').lean();
    if (pending) auction.scheduleFinalization(pending.finalization.deadline);
    await outbox.flush();
  } catch (err) {
    logger.error({ err }, 'recovery tick failed');
  }
}

function start(intervalMs = 1000) {
  if (timer) return;
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, tick };
