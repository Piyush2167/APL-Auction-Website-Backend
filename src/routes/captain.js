const { Router } = require('express');
const { z } = require('zod');
const { authenticate, requireRole, requirePasswordChanged, validate, limits } = require('../middleware');
const { forbidden } = require('../utils/errors');
const auction = require('../services/auctionService');
const resale = require('../services/resaleService');
const mystery = require('../services/mysteryService');
const snapshots = require('../services/snapshotService');
const reports = require('../services/reportService');
const P = require('../services/projections');

const r = Router();
r.use(authenticate, requireRole('CAPTAIN'), requirePasswordChanged, (req, _res, next) => (req.user.team ? next() : next(forbidden('No team assigned'))));

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

r.get('/dashboard', async (req, res) => {
  const [state, summary, leaderboard] = await Promise.all([
    snapshots.auctionSnapshot('public'), snapshots.teamSummary(req.user.team), snapshots.leaderboard(),
  ]);
  ok(res, { state, ...summary, leaderboard });
});
r.get('/team', async (req, res) => {
  const s = await snapshots.teamSummary(req.user.team);
  ok(res, { team: s.team, finance: s.finance });
});
r.get('/team/squad', async (req, res) => ok(res, (await snapshots.teamSummary(req.user.team)).squad));
r.get('/leaderboard', async (_req, res) => ok(res, await snapshots.leaderboard()));

r.post('/auction/bid', limits.bid, validate(z.object({
  playerId: objectId, amount: z.number().int().min(0), idempotencyKey: z.string().min(8).max(100).optional(),
})), async (req, res) => {
  const { bid, duplicate } = await auction.placeBid(req.user, req.body);
  ok(res, { amount: bid.amount, seq: bid.seq, duplicate }, duplicate ? 200 : 201);
});
r.get('/auction/history', validate(z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(100) }), 'query'),
  async (req, res) => ok(res, await reports.bidHistory({ ...req.q, team: req.user.team }, P.publicPlayer)));

r.get('/resale', async (req, res) => ok(res, (await snapshots.teamSummary(req.user.team)).resaleRequests));
r.post('/resale', validate(z.object({ playerId: objectId })), async (req, res) => {
  const reqDoc = await resale.requestResale(req.user, req.body.playerId);
  ok(res, { id: String(reqDoc._id), status: reqDoc.status }, 201);
});
r.get('/resale/:id', async (req, res) => ok(res, await resale.getRequestForCaptain(req.user, objectId.parse(req.params.id))));

r.get('/mystery-token', async (req, res) => ok(res, (await snapshots.teamSummary(req.user.team)).mysteryToken));
r.post('/mystery-token/reveal', async (req, res) => ok(res, await mystery.reveal(req.user)));

module.exports = r;
