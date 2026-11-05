/** Public (audience) API. Only public projections: mystery identities never pass through here. */
const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware');
const snapshots = require('../services/snapshotService');
const reports = require('../services/reportService');
const P = require('../services/projections');
const crypto = require('crypto');
const env = require('../config/env');
const players = require('../services/playerService');
const { AppError } = require('../utils/errors');

const r = Router();
const ok = (res, data) => res.json({ success: true, data });
const paging = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(100) });

r.get('/auction', async (_req, res) => ok(res, await snapshots.auctionSnapshot('public')));
r.get('/auction/current', async (_req, res) => {
  const s = await snapshots.auctionSnapshot('public');
  ok(res, { version: s.version, status: s.status, player: s.player, currentBid: s.currentBid, leadingTeam: s.leadingTeam, nextValidBid: s.nextValidBid });
});
r.get('/auction/history', validate(paging.extend({ player: z.string().regex(/^[a-f0-9]{24}$/i).optional() }), 'query'),
  async (req, res) => ok(res, await reports.bidHistory(req.q, P.publicPlayer)));
r.get('/teams', async (_req, res) => ok(res, await reports.results('public')));
r.get('/results', async (_req, res) => ok(res, await reports.results('public')));
r.get('/players', validate(paging.extend({ status: z.string().max(200).optional(), category: z.string().max(30).optional(), playerType: z.enum(['NORMAL', 'MYSTERY']).optional() }), 'query'),
  async (req, res) => ok(res, await reports.publicPlayers(req.q)));

// The one exception to "masked only": the /super board, unlocked by the SUPER_VIEW_KEY secret.
const keyHash = (k) => crypto.createHash('sha256').update(String(k ?? '')).digest();
r.get('/super/players', async (req, res) => {
  if (!env.SUPER_VIEW_KEY || !crypto.timingSafeEqual(keyHash(req.query.key), keyHash(env.SUPER_VIEW_KEY))) {
    throw new AppError(403, 'INVALID_KEY', 'This link is not valid.');
  }
  ok(res, await players.listPlayers({ playerType: 'MYSTERY', limit: 200 }));
});

module.exports = r;
