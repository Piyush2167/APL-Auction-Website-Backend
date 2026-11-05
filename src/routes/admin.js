const { Router } = require('express');
const { z } = require('zod');
const env = require('../config/env');
const { authenticate, requireRole, requirePasswordChanged, validate, importUpload, imageUpload } = require('../middleware');
const { bad, AppError } = require('../utils/errors');
const season = require('../services/seasonService');
const teams = require('../services/teamService');
const players = require('../services/playerService');
const auction = require('../services/auctionService');
const resale = require('../services/resaleService');
const mystery = require('../services/mysteryService');
const ledger = require('../services/ledgerService');
const reports = require('../services/reportService');
const snapshots = require('../services/snapshotService');

const r = Router();
r.use(authenticate, requireRole('ADMIN'), requirePasswordChanged);

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const paging = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) });

/* ---------- dashboard / season / config ---------- */
r.get('/dashboard', async (_req, res) => ok(res, await reports.adminDashboard()));
r.get('/auctions', async (_req, res) => ok(res, await reports.listAuctions()));

r.get('/season', async (_req, res) => {
  try {
    const { season: s, config, auction: a } = await season.getContext();
    ok(res, { season: s, config, auctionStatus: a.status });
  } catch (e) {
    if (e.code === 'NO_SEASON') return ok(res, null);
    throw e;
  }
});

const configShape = {
  teamCount: z.number().int().min(2).max(32),
  teamPurse: z.number().int().min(1).max(1e7),
  maxSquadSize: z.number().int().min(1).max(50),
  defaultBasePrice: z.number().int().min(0).max(1e6),
  bidIncrements: z.array(z.number().int().min(1).max(1e6)).min(1).max(4).transform((a) => [...new Set(a)].sort((x, y) => x - y)),
  finalizationSeconds: z.number().int().min(0).max(30),
  publicBudgetVisible: z.boolean(),
  resaleEnabled: z.boolean(),
  mysteryEnabled: z.boolean(),
  categories: z.array(z.string().trim().min(2).max(30)).min(1).max(20),
};
r.post('/season', validate(z.object({
  name: z.string().trim().min(2).max(60), year: z.number().int().min(2000).max(2100), sport: z.enum(['CRICKET', 'FOOTBALL']).default('CRICKET'),
  config: z.object(configShape).partial().optional(),
})), async (req, res) => ok(res, await season.createSeason(req.user, req.body), 201));
r.post('/season/archive', async (req, res) => ok(res, await season.archiveSeason(req.user)));

r.get('/config', async (_req, res) => ok(res, (await season.getContext()).config));
r.patch('/config', validate(z.object({ ...configShape, override: z.boolean(), reason: z.string().max(300) }).partial()), async (req, res) => {
  const { override, reason, ...patch } = req.body;
  if (!Object.keys(patch).length) throw bad('EMPTY_PATCH', 'Nothing to update');
  ok(res, await season.updateConfig(req.user, patch, { override, reason }));
});
r.post('/config/confirm', async (req, res) => ok(res, await season.confirmConfig(req.user)));

/* ---------- teams & captains ---------- */
const teamShape = {
  name: z.string().trim().min(2).max(60),
  abbreviation: z.string().trim().min(2).max(6).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only'),
  logo: z.url({ protocol: /^https?$/ }).max(500).nullable().optional(),
  initialPurse: z.number().int().min(1).max(1e7).optional(),
  maxSquadSize: z.number().int().min(1).max(50).optional(),
};
r.get('/teams', async (_req, res) => ok(res, await teams.list()));
r.post('/teams', validate(z.object(teamShape)), async (req, res) => ok(res, await teams.create(req.user, req.body), 201));
r.get('/teams/:id', async (req, res) => ok(res, await teams.get(objectId.parse(req.params.id))));
r.patch('/teams/:id', validate(z.object(teamShape).partial()), async (req, res) => ok(res, await teams.update(req.user, objectId.parse(req.params.id), req.body)));
r.delete('/teams/:id', async (req, res) => ok(res, await teams.remove(req.user, objectId.parse(req.params.id))));
r.post('/teams/:id/captain', validate(z.object({ name: z.string().trim().min(2).max(100).optional(), email: z.email().max(200), playerId: objectId.optional() })),
  async (req, res) => ok(res, await teams.assignCaptain(req.user, objectId.parse(req.params.id), req.body), 201));

r.get('/captains', async (_req, res) => ok(res, await teams.listCaptains()));
r.patch('/captains/:id', validate(z.object({ name: z.string().trim().min(2).max(100), active: z.boolean() }).partial()),
  async (req, res) => ok(res, await teams.updateCaptain(req.user, objectId.parse(req.params.id), req.body)));
r.post('/captains/:id/reset-password', async (req, res) => ok(res, await teams.resetCaptainPassword(req.user, objectId.parse(req.params.id))));

/* ---------- players ---------- */
r.get('/players', validate(paging.extend({
  q: z.string().max(100).optional(), status: z.string().max(200).optional(), category: z.string().max(30).optional(),
  playerType: z.enum(['NORMAL', 'MYSTERY']).optional(), sort: z.enum(['auctionOrder', 'name', 'price']).optional(),
}), 'query'), async (req, res) => ok(res, await players.listPlayers(req.q)));
r.post('/players', async (req, res) => ok(res, await players.createPlayer(req.user, req.body), 201));

const fileFormat = (req) => {
  if (!req.file) throw bad('NO_FILE', 'Attach a file in the "file" field');
  const fmt = (req.query.format || req.file.originalname.split('.').pop() || '').toLowerCase();
  if (!['csv', 'json'].includes(fmt)) throw bad('INVALID_FORMAT', 'Format must be csv or json');
  return fmt;
};
r.post('/players/import/preview', importUpload, async (req, res) => ok(res, await players.previewImport(req.file?.buffer, fileFormat(req))));
r.post('/players/import/:format', importUpload, async (req, res) => {
  const fmt = fileFormat(req);
  if (fmt !== req.params.format) throw bad('FORMAT_MISMATCH', `Expected a .${req.params.format} file`);
  ok(res, await players.commitImport(req.user, req.file.buffer, fmt), 201);
});
r.get('/players/:id', async (req, res) => ok(res, await players.getPlayer(objectId.parse(req.params.id))));
r.patch('/players/:id', async (req, res) => ok(res, await players.updatePlayer(req.user, objectId.parse(req.params.id), req.body)));
r.delete('/players/:id', async (req, res) => ok(res, await players.deletePlayer(req.user, objectId.parse(req.params.id))));

/* ---------- image upload (Cloudinary) ---------- */
r.post('/uploads/image', imageUpload, async (req, res) => {
  if (!env.CLOUDINARY_CLOUD_NAME) throw new AppError(503, 'UPLOADS_DISABLED', 'Image storage is not configured. Paste an image URL instead.');
  if (!req.file) throw bad('NO_FILE', 'Attach an image in the "image" field');
  const { v2: cloudinary } = require('cloudinary');
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder: 'apl-auction', resource_type: 'image' }, (err, out) => (err ? reject(err) : resolve(out))).end(req.file.buffer);
  });
  ok(res, { url: result.secure_url }, 201);
});

/* ---------- auction control ---------- */
r.get('/auction', async (_req, res) => ok(res, await snapshots.auctionSnapshot('admin')));
r.post('/auction/start', async (req, res) => ok(res, { version: (await auction.startAuction(req.user)).version }));
r.post('/auction/pause', async (req, res) => ok(res, { version: (await auction.pauseAuction(req.user)).version }));
r.post('/auction/resume', async (req, res) => ok(res, { version: (await auction.resumeAuction(req.user)).version }));
r.post('/auction/complete', async (req, res) => ok(res, { version: (await auction.completeAuction(req.user)).version }));
r.post('/auction/select-player', validate(z.object({ playerId: objectId })), async (req, res) => ok(res, { version: (await auction.selectPlayer(req.user, req.body.playerId)).version }));
r.post('/auction/next-player', async (req, res) => ok(res, { version: (await auction.selectNextPlayer(req.user)).version }));
r.post('/auction/start-bidding', async (req, res) => ok(res, { version: (await auction.startBidding(req.user)).version }));
r.post('/auction/sold', async (req, res) => {
  const a = await auction.markSold(req.user);
  ok(res, { version: a.version, deadline: a.finalization.deadline, amount: a.finalization.amount });
});
r.post('/auction/unsold', async (req, res) => ok(res, { version: (await auction.markUnsold(req.user)).version }));
r.post('/auction/skip', async (req, res) => ok(res, { version: (await auction.markSkipped(req.user)).version }));
r.get('/auction/pending-players', async (_req, res) => ok(res, await auction.pendingPlayers()));
r.get('/auction/bids', validate(paging.extend({ player: objectId.optional(), team: objectId.optional() }), 'query'), async (req, res) => ok(res, await reports.bidHistory(req.q)));

/* ---------- resale ---------- */
r.get('/resale', validate(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), 'query'), async (req, res) => ok(res, await resale.listRequests(req.q)));
r.post('/resale/:id/approve', async (req, res) => ok(res, await resale.approveResale(req.user, objectId.parse(req.params.id))));
r.post('/resale/:id/reject', validate(z.object({ reason: z.string().trim().min(3).max(300) })), async (req, res) => ok(res, await resale.rejectResale(req.user, objectId.parse(req.params.id), req.body.reason)));

/* ---------- reports ---------- */
r.get('/leaderboard', async (_req, res) => ok(res, await snapshots.leaderboard()));
r.get('/mystery-tokens', async (_req, res) => ok(res, await mystery.tokenUsage()));
r.get('/transactions', validate(paging, 'query'), async (req, res) => ok(res, await reports.auctionTransactions(req.q)));
r.get('/ledger', validate(paging.extend({ team: objectId.optional() }), 'query'), async (req, res) => ok(res, await ledger.list(req.q)));
r.get('/ledger/reconcile', async (_req, res) => ok(res, await ledger.reconcile()));
r.get('/logs', validate(paging.extend({ type: z.string().max(50).optional() }), 'query'), async (req, res) => ok(res, await reports.logs(req.q)));
r.get('/results', async (_req, res) => ok(res, await reports.results('admin')));
r.get('/results.csv', async (_req, res) => {
  res.type('text/csv').attachment('apl-season-8-results.csv').send(reports.resultsCsv(await reports.results('admin')));
});

module.exports = r;
