/**
 * Socket.IO. Rooms are assigned by the server from the verified token; clients cannot join rooms.
 *   public        everyone (audience, captains, admins)
 *   admin         administrators
 *   captains      all captains (leaderboard)
 *   team:<id>     one team's private channel (mystery reveal, finances)
 *   user:<id>     one user (forced disconnects)
 */
const { Server } = require('socket.io');
const env = require('../config/env');
const logger = require('../config/logger');
const { User } = require('../models');
const auth = require('../services/authService');
const auction = require('../services/auctionService');
const snapshots = require('../services/snapshotService');
const outbox = require('../services/outbox');
const presence = require('./presence');

function errPayload(err) {
  return { ok: false, error: { code: err.code || 'INTERNAL', message: err.status ? err.message : 'Internal error', details: err.details } };
}

function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigins, credentials: true },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) { socket.data.role = 'AUDIENCE'; return next(); }
    try {
      const claims = auth.verifyAccess(token);
      const user = await User.findById(claims.sub).lean();
      if (!user || !user.active || user.tokenVersion !== claims.tv) return next(new Error('UNAUTHORIZED'));
      if (user.mustChangePassword) return next(new Error('PASSWORD_CHANGE_REQUIRED'));
      socket.data.user = user;
      socket.data.role = user.role;
      next();
    } catch (e) {
      next(new Error(e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'UNAUTHORIZED'));
    }
  });

  const broadcastCounts = () => io.emit('audience:count', presence.counts());

  io.on('connection', async (socket) => {
    const { role, user } = socket.data;
    socket.join('public');
    if (role === 'ADMIN') socket.join(['admin', `user:${user._id}`]);
    if (role === 'CAPTAIN') socket.join(['captains', `team:${user.team}`, `user:${user._id}`]);
    presence.add(role, user && String(user._id));
    broadcastCounts();

    // Handlers are registered synchronously (before any await) so no early client event is lost.
    socket.on('auction:sync', async (_, ack) => {
      if (typeof ack !== 'function') return;
      try { ack({ ok: true, data: await snapshots.auctionSnapshot(role === 'ADMIN' ? 'admin' : 'public') }); } catch (e) { ack(errPayload(e)); }
    });

    // Same service as POST /api/captain/auction/bid.
    socket.on('bid:place', async (input, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (role !== 'CAPTAIN') return reply({ ok: false, error: { code: 'FORBIDDEN', message: 'Captains only' } });
      try {
        const fresh = await User.findById(user._id).lean();
        if (!fresh?.active) { socket.disconnect(true); return; }
        const { bid, duplicate } = await auction.placeBid(fresh, {
          playerId: String(input?.playerId || ''), amount: Number(input?.amount), idempotencyKey: input?.idempotencyKey ? String(input.idempotencyKey).slice(0, 100) : undefined,
        });
        reply({ ok: true, data: { amount: bid.amount, seq: bid.seq, duplicate } });
      } catch (err) {
        socket.emit('bid:rejected', errPayload(err).error);
        reply(errPayload(err));
      }
    });

    socket.on('disconnect', () => {
      presence.remove(role, user && String(user._id));
      broadcastCounts();
    });

    // Initial authoritative snapshot; clients never depend on having seen earlier events.
    try {
      socket.emit('connection:status', { role, connected: true });
      socket.emit('auction:state', await snapshots.auctionSnapshot(role === 'ADMIN' ? 'admin' : 'public'));
      if (role === 'CAPTAIN') socket.emit('team:updated', await snapshots.teamSummary(user.team));
      if (role !== 'AUDIENCE') socket.emit('leaderboard:updated', { rows: await snapshots.leaderboard() });
    } catch (err) { logger.warn({ err: err.message }, 'initial snapshot failed'); }
  });

  outbox.setIO(io);
  return io;
}

module.exports = { initSockets };
