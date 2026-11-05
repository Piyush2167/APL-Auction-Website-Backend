const { Player, Team, ResaleRequest, FinancialTransaction, AuctionTransaction } = require('../models');
const { getContext } = require('./seasonService');
const { conflict, notFound, forbidden, bad } = require('../utils/errors');
const { audit } = require('./audit');
const { mutate } = require('./auctionService');
const outbox = require('./outbox');
const { resaleEligibility } = require('./snapshotService');
const P = require('./projections');

const LEADERBOARD = { type: 'leaderboard:updated', rooms: ['admin', 'captains'] };

/** Captain requests resale of their highest-priced player (ties: any of them). No money moves until approval. */
async function requestResale(user, playerId) {
  return mutate(async (s) => {
    const { season, config } = await getContext(s);
    if (!config.resaleEnabled) throw conflict('RESALE_DISABLED', 'Resale is disabled for this season');
    const team = await Team.findOne({ _id: user.team, season: season._id }).session(s);
    if (!team) throw forbidden('No team assigned');
    const squad = await Player.find({ _id: { $in: team.squad }, currentTeam: team._id }).session(s);
    const player = squad.find((p) => String(p._id) === String(playerId));
    if (!player) throw forbidden('This player is not in your squad');
    if (player.status === 'RESALE_PENDING' || await ResaleRequest.exists({ team: team._id, status: 'PENDING' }).session(s)) {
      throw conflict('RESALE_ALREADY_PENDING', 'Your team already has a pending resale request');
    }
    if (player.status === 'RESOLD' || player.resaleCount > 0) throw conflict('ALREADY_RESOLD', 'This player has already been through resale');
    if (!resaleEligibility(squad).includes(String(player._id))) {
      throw conflict('NOT_HIGHEST_PRICED', 'Only your highest-priced purchased player can be put up for resale');
    }
    const moved = await Player.findOneAndUpdate({ _id: player._id, status: 'SOLD', currentTeam: team._id }, { $set: { status: 'RESALE_PENDING' } }, { session: s });
    if (!moved) throw conflict('STALE_STATE', 'Player status changed');
    const [req] = await ResaleRequest.create([{
      season: season._id, player: player._id, team: team._id, captain: user._id,
      originalPurchaseAmount: player.purchasePrice, originalPurchaseTxn: player.purchaseTxn, previousPlayerStatus: 'SOLD',
    }], { session: s });
    await audit(s, { season: season._id, type: 'RESALE_REQUESTED', actor: user, player: player._id, team: team._id, details: { amount: player.purchasePrice, request: req._id } });
    await outbox.enqueue(s, [
      { type: 'resale:requested', rooms: ['admin'], payload: { requestId: String(req._id), team: P.teamRef(team), playerId: String(player._id) } },
      { type: 'team:updated', rooms: [`team:${team._id}`] },
    ]);
    return req;
  });
}

async function approveResale(admin, requestId) {
  return mutate(async (s) => {
    const { season } = await getContext(s);
    const req = await ResaleRequest.findOneAndUpdate(
      { _id: requestId, season: season._id, status: 'PENDING' },
      { $set: { status: 'APPROVED', admin: admin._id, processedAt: new Date() } }, { returnDocument: 'after', session: s },
    );
    if (!req) throw conflict('NOT_PENDING', 'Request not found or already processed');
    const purchase = await FinancialTransaction.findOne({ _id: req.originalPurchaseTxn, team: req.team, type: 'PURCHASE_DEBIT' }).session(s);
    if (!purchase || purchase.debit !== req.originalPurchaseAmount) throw conflict('PURCHASE_MISMATCH', 'Original purchase record does not match');
    const player = await Player.findOne({ _id: req.player, status: 'RESALE_PENDING', currentTeam: req.team }).session(s);
    if (!player) throw conflict('OWNERSHIP_CHANGED', 'Player no longer belongs to this team');
    const team = await Team.findOneAndUpdate(
      { _id: req.team, squad: player._id },
      { $pull: { squad: player._id }, $inc: { 'finance.resaleCredits': purchase.debit } }, { returnDocument: 'after', session: s },
    );
    if (!team) throw conflict('OWNERSHIP_CHANGED', 'Player is not in the team squad');
    const [credit] = await FinancialTransaction.create([{
      season: season._id, team: team._id, player: player._id, type: 'RESALE_CREDIT', credit: purchase.debit,
      originalPurchase: purchase._id, resaleRequest: req._id, admin: admin._id,
      idempotencyKey: `RESALE:${req._id}`, description: `Resale refund for player ${player._id}`,
    }], { session: s });
    await Player.updateOne({ _id: player._id }, {
      $set: { status: 'RESALE_APPROVED', currentTeam: null, purchasePrice: null, purchaseTxn: null, basePrice: player.originalBasePrice },
      $inc: { resaleCount: 1 },
    }, { session: s });
    await AuctionTransaction.create([{
      season: season._id, type: 'RESALE', player: player._id, team: team._id, amount: credit.credit,
      originalPurchaseAmount: purchase.debit, resaleRequest: req._id, admin: admin._id, idempotencyKey: `RESALE:${req._id}`,
    }], { session: s });
    await audit(s, { season: season._id, type: 'RESALE_APPROVED', actor: admin, player: player._id, team: team._id, previousState: 'RESALE_PENDING', newState: 'RESALE_APPROVED', details: { refund: purchase.debit } });
    await outbox.enqueue(s, [
      { type: 'resale:approved', rooms: ['admin', `team:${team._id}`], payload: { requestId: String(req._id), team: P.teamRef(team), refund: purchase.debit } },
      { type: 'team:updated', rooms: [`team:${team._id}`] }, LEADERBOARD, { type: 'auction:state', rooms: ['public'] },
    ]);
    return req;
  });
}

async function rejectResale(admin, requestId, reason) {
  if (!reason || reason.trim().length < 3) throw bad('REASON_REQUIRED', 'A rejection reason is required');
  return mutate(async (s) => {
    const { season } = await getContext(s);
    const req = await ResaleRequest.findOneAndUpdate(
      { _id: requestId, season: season._id, status: 'PENDING' },
      { $set: { status: 'REJECTED', admin: admin._id, reason: reason.trim(), processedAt: new Date() } }, { returnDocument: 'after', session: s },
    );
    if (!req) throw conflict('NOT_PENDING', 'Request not found or already processed');
    await Player.updateOne({ _id: req.player, status: 'RESALE_PENDING' }, { $set: { status: req.previousPlayerStatus } }, { session: s });
    await audit(s, { season: season._id, type: 'RESALE_REJECTED', actor: admin, player: req.player, team: req.team, details: { reason } });
    await outbox.enqueue(s, [
      { type: 'resale:rejected', rooms: ['admin', `team:${req.team}`], payload: { requestId: String(req._id), reason: req.reason } },
      { type: 'team:updated', rooms: [`team:${req.team}`] },
    ]);
    return req;
  });
}

async function listRequests({ status } = {}) {
  const { season } = await getContext();
  const q = { season: season._id };
  if (status) q.status = status;
  const rows = await ResaleRequest.find(q).sort({ createdAt: -1 })
    .populate('player').populate('team', 'name abbreviation logo').populate('captain', 'name').populate('admin', 'name').lean();
  return rows.map((r) => ({
    id: String(r._id), status: r.status, reason: r.reason, originalPurchaseAmount: r.originalPurchaseAmount,
    createdAt: r.createdAt, processedAt: r.processedAt, player: P.fullPlayer(r.player), team: P.teamRef(r.team),
    captain: r.captain?.name, processedBy: r.admin?.name || null,
  }));
}

async function getRequestForCaptain(user, id) {
  const r = await ResaleRequest.findOne({ _id: id, team: user.team }).lean();
  if (!r) throw notFound('Resale request');
  return { id: String(r._id), status: r.status, reason: r.reason, originalPurchaseAmount: r.originalPurchaseAmount, createdAt: r.createdAt, processedAt: r.processedAt, playerId: String(r.player) };
}

module.exports = { requestResale, approveResale, rejectResale, listRequests, getRequestForCaptain };
