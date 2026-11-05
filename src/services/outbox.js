/**
 * Transactional outbox. Services insert events inside their DB transaction; this publisher emits them
 * over Socket.IO only after commit. A crash between commit and emit is healed by the recovery worker's flush.
 *
 * Marker events are rebuilt from fresh DB state at publish time (so they can never leak or go stale):
 *   auction:state       -> public snapshot to 'public', admin snapshot to 'admin'
 *   leaderboard:updated -> leaderboard to 'admin' + 'captains'
 *   team:updated        -> private team summary to each 'team:<id>' room listed
 */
const { OutboxEvent } = require('../models');
const snapshots = require('./snapshotService');
const logger = require('../config/logger');

let io = null;
let flushing = null;
let again = false;

const setIO = (server) => { io = server; };
const getIO = () => io;

async function enqueue(session, events) {
  if (events.length) await OutboxEvent.insertMany(events, { session });
}

async function publishOne(ev) {
  const { type, rooms, payload } = ev;
  if (type === 'auction:state') {
    const [pub, adm] = await Promise.all([snapshots.auctionSnapshot('public'), snapshots.auctionSnapshot('admin')]);
    io.to('public').except('admin').emit('auction:state', pub);
    io.to('admin').emit('auction:state', adm);
  } else if (type === 'leaderboard:updated') {
    io.to(['admin', 'captains']).emit('leaderboard:updated', { rows: await snapshots.leaderboard() });
  } else if (type === 'team:updated') {
    for (const room of rooms) {
      const summary = await snapshots.teamSummary(room.replace('team:', ''));
      if (summary) io.to(room).emit('team:updated', summary);
    }
  } else {
    io.to(rooms).emit(type, { ...payload, version: ev.version });
  }
}

async function drain() {
  for (;;) {
    const batch = await OutboxEvent.find({ status: 'PENDING' }).sort({ _id: 1 }).limit(100).lean();
    if (!batch.length) return;
    // Coalesce duplicate state markers within a batch: one fresh snapshot covers them all.
    const seen = new Set();
    for (const ev of batch) {
      const coalesceKey = ['auction:state', 'leaderboard:updated'].includes(ev.type) ? ev.type : null;
      try {
        if (!coalesceKey || !seen.has(coalesceKey)) await publishOne(ev);
        if (coalesceKey) seen.add(coalesceKey);
        await OutboxEvent.updateOne({ _id: ev._id }, { $set: { status: 'PUBLISHED', publishedAt: new Date() }, $inc: { attempts: 1 } });
      } catch (err) {
        logger.error({ err, ev: ev._id }, 'outbox publish failed');
        await OutboxEvent.updateOne({ _id: ev._id }, { $inc: { attempts: 1 } });
        return; // keep ordering; retry on next flush
      }
    }
  }
}

/** Publish all pending events. Safe to call any time; concurrent calls coalesce. */
// ponytail: single-instance publisher. For multiple instances, claim events atomically and add the Redis adapter.
function flush() {
  if (!io) return Promise.resolve();
  if (flushing) { again = true; return flushing; }
  flushing = (async () => {
    do { again = false; await drain(); } while (again);
  })().catch((err) => logger.error({ err }, 'outbox flush error')).finally(() => { flushing = null; });
  return flushing;
}

module.exports = { enqueue, flush, setIO, getIO };
