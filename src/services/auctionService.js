/**
 * Core auction engine. Every auction mutation (REST or Socket.IO) goes through this module.
 * Concurrency model: each mutation runs in a MongoDB transaction and updates the Auction document
 * conditionally on its `version` (compare-and-swap). Concurrent writers hit a write conflict, the
 * transaction is retried with fresh state, and business validation is re-run against that state.
 */
const crypto = require('crypto');
const { Auction, Player, Team, Bid, AuctionTransaction, FinancialTransaction, MysteryToken, ResaleRequest } = require('../models');
const { withTxn } = require('../config/db');
const { getContext } = require('./seasonService');
const { conflict, bad, forbidden, notFound, AppError } = require('../utils/errors');
const { audit } = require('./audit');
const outbox = require('./outbox');
const snapshots = require('./snapshotService');
const P = require('./projections');
const C = require('../constants');
const logger = require('../config/logger');

const STATE = { type: 'auction:state', rooms: ['public'] };
const LEADERBOARD = { type: 'leaderboard:updated', rooms: ['admin', 'captains'] };

/** Run a transactional mutation, then publish its outbox events. */
async function mutate(fn) {
  const result = await withTxn(fn);
  outbox.flush();
  return result;
}

/** Conditionally update the auction on its version; bumps version. */
async function cas(session, auction, filter, update) {
  const res = await Auction.findOneAndUpdate(
    { _id: auction._id, version: auction.version, ...filter },
    { ...update, $inc: { ...(update.$inc || {}), version: 1 } },
    { returnDocument: 'after', session },
  );
  if (!res) throw conflict('STALE_STATE', 'The auction state changed. Please retry with the latest state.');
  return res;
}

const CLEAR_ACTIVE = {
  activePlayer: null, biddingOpen: false, basePrice: null, currentBid: null,
  leadingTeam: null, leadingCaptain: null, bidCount: 0,
};
const CLEAR_FINAL = { key: null, player: null, team: null, captain: null, amount: null, startedAt: null, deadline: null };

function requireStatus(auction, ...allowed) {
  if (!allowed.includes(auction.status)) {
    if (auction.status === 'FINALIZING') throw conflict('BIDDING_LOCKED', 'A sale is being finalized');
    if (auction.status === 'PAUSED') throw conflict('AUCTION_PAUSED', 'The auction is paused');
    throw conflict('INVALID_STATE', `Not allowed while the auction is ${auction.status}`);
  }
}

/* ------------------------------------------------------------------ lifecycle */

async function startAuction(admin) {
  return mutate(async (s) => {
    const { season, config, auction } = await getContext(s);
    if (auction.status !== 'READY') throw conflict('INVALID_STATE', auction.status === 'CREATED'
      ? 'Confirm the auction configuration first' : `Auction is already ${auction.status}`);
    const teams = await Team.find({ season: season._id }).session(s);
    // Initial purse allocation and the one-per-season mystery token. Unique keys make this exactly-once.
    await FinancialTransaction.insertMany(teams.map((t) => ({
      season: season._id, team: t._id, type: 'INITIAL_ALLOCATION', credit: t.initialPurse,
      idempotencyKey: `INIT:${season._id}:${t._id}`, admin: admin._id, description: 'Initial purse allocation',
    })), { session: s });
    await MysteryToken.insertMany(teams.map((t) => ({ season: season._id, team: t._id })), { session: s });
    const updated = await cas(s, auction, { status: 'READY' }, {
      $set: { status: 'LIVE', startedAt: new Date(), configSnapshot: { ...config.toObject(), snapshotAt: new Date() } },
    });
    await audit(s, { season: season._id, type: 'AUCTION_STARTED', actor: admin, previousState: 'READY', newState: 'LIVE' });
    await outbox.enqueue(s, [{ type: 'auction:started', rooms: ['public'], version: updated.version }, STATE, LEADERBOARD]);
    return updated;
  });
}

async function pauseAuction(admin) {
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    requireStatus(auction, 'LIVE');
    const updated = await cas(s, auction, { status: 'LIVE' }, { $set: { status: 'PAUSED' } });
    await audit(s, { season: season._id, type: 'AUCTION_PAUSED', actor: admin, previousState: 'LIVE', newState: 'PAUSED' });
    await outbox.enqueue(s, [{ type: 'auction:paused', rooms: ['public'], version: updated.version }, STATE]);
    return updated;
  });
}

async function resumeAuction(admin) {
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    if (auction.status !== 'PAUSED') throw conflict('INVALID_STATE', 'The auction is not paused');
    const updated = await cas(s, auction, { status: 'PAUSED' }, { $set: { status: 'LIVE' } });
    await audit(s, { season: season._id, type: 'AUCTION_RESUMED', actor: admin, previousState: 'PAUSED', newState: 'LIVE' });
    await outbox.enqueue(s, [{ type: 'auction:resumed', rooms: ['public'], version: updated.version }, STATE]);
    return updated;
  });
}

async function completeAuction(admin) {
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    requireStatus(auction, 'LIVE', 'PAUSED');
    if (auction.activePlayer) throw conflict('PLAYER_ACTIVE', 'Resolve the active player first (SOLD, UNSOLD or SKIP)');
    const updated = await cas(s, auction, { activePlayer: null }, { $set: { status: 'COMPLETED', completedAt: new Date() } });
    await audit(s, { season: season._id, type: 'AUCTION_COMPLETED', actor: admin, previousState: auction.status, newState: 'COMPLETED' });
    await outbox.enqueue(s, [{ type: 'auction:completed', rooms: ['public'], version: updated.version }, STATE]);
    return updated;
  });
}

/* ------------------------------------------------------------------ player selection */

async function selectPlayer(admin, playerId) {
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    requireStatus(auction, 'LIVE');
    if (auction.activePlayer) throw conflict('PLAYER_ACTIVE', 'Another player is already active');
    const player = await Player.findOne({ _id: playerId, season: season._id }).session(s);
    if (!player) throw notFound('Player');
    if (C.PENDING_STATUSES.includes(player.status)) {
      // Spec §10.D: pending players come back only once the original registered list is completed.
      const remaining = await Player.countDocuments({ season: season._id, status: 'AVAILABLE' }).session(s);
      if (remaining > 0) throw conflict('POOL_NOT_EXHAUSTED', `${remaining} registered player(s) have not been auctioned yet`);
    } else if (!C.POOL_STATUSES.includes(player.status)) {
      throw conflict('PLAYER_NOT_SELECTABLE', `Player is ${player.status}`);
    }
    const from = player.status;
    const moved = await Player.findOneAndUpdate({ _id: player._id, status: from }, { $set: { status: 'ACTIVE' } }, { returnDocument: 'after', session: s });
    if (!moved) throw conflict('STALE_STATE', 'Player status changed');
    const updated = await cas(s, auction, { status: 'LIVE', activePlayer: null }, {
      $set: { ...CLEAR_ACTIVE, activePlayer: player._id, basePrice: player.basePrice, lastResult: { outcome: null } },
    });
    await audit(s, { season: season._id, type: 'PLAYER_SELECTED', actor: admin, player: player._id, previousState: from, newState: 'ACTIVE' });
    await outbox.enqueue(s, [{ type: 'player:current', rooms: ['public'], payload: { player: P.publicPlayer(moved) }, version: updated.version }, STATE]);
    return updated;
  });
}

async function selectNextPlayer(admin) {
  const { season } = await getContext();
  const next = await Player.findOne({ season: season._id, status: { $in: C.POOL_STATUSES } }).sort({ auctionOrder: 1, createdAt: 1 }).select('_id');
  if (!next) throw conflict('POOL_EMPTY', 'No players remain in the main pool. Select a pending UNSOLD/SKIPPED player.');
  return selectPlayer(admin, next._id);
}

async function startBidding(admin) {
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    requireStatus(auction, 'LIVE');
    if (!auction.activePlayer) throw conflict('NO_ACTIVE_PLAYER', 'Select a player first');
    if (auction.biddingOpen) throw conflict('BIDDING_ALREADY_OPEN', 'Bidding is already open');
    const updated = await cas(s, auction, { status: 'LIVE', biddingOpen: false }, { $set: { biddingOpen: true } });
    await audit(s, { season: season._id, type: 'BIDDING_STARTED', actor: admin, player: auction.activePlayer });
    await outbox.enqueue(s, [STATE]);
    return updated;
  });
}

/* ------------------------------------------------------------------ bidding */

async function placeBidTxn(user, { playerId, amount, idempotencyKey }) {
  return mutate(async (s) => {
    if (idempotencyKey) {
      const dup = await Bid.findOne({ captain: user._id, idempotencyKey }).session(s);
      if (dup) return { bid: dup, duplicate: true };
    }
    const { season, config, auction } = await getContext(s);
    requireStatus(auction, 'LIVE');
    if (!auction.activePlayer) throw conflict('NO_ACTIVE_PLAYER', 'No player is up for auction');
    if (String(auction.activePlayer) !== String(playerId)) throw conflict('STALE_PLAYER', 'That player is no longer active');
    if (!auction.biddingOpen) throw conflict('BIDDING_NOT_OPEN', 'Bidding has not been opened for this player');
    if (!user.team) throw forbidden('Captain is not assigned to a team');
    const team = await Team.findOne({ _id: user.team, season: season._id }).session(s);
    if (!team) throw forbidden('Team not found for this season');
    if (String(auction.leadingTeam) === String(team._id)) throw conflict('ALREADY_LEADING', 'Your team already holds the highest bid');
    const player = await Player.findById(auction.activePlayer).select('previousOwners').session(s);
    if (player.previousOwners.some((t) => String(t) === String(team._id))) {
      throw conflict('ALREADY_PURCHASED', 'Your team has already purchased this player once');
    }
    if (team.squad.length >= team.maxSquadSize) throw conflict('SQUAD_FULL', 'Your squad is full');
    const next = snapshots.nextValidBid(auction, config);
    if (!Number.isInteger(amount)) throw bad('INVALID_AMOUNT', 'Bid must be a whole number', { nextValidBid: next });
    if (auction.currentBid != null && amount <= auction.currentBid) {
      throw conflict('STALE_BID', `Outbid: the current bid is already ${auction.currentBid}`, { nextValidBid: next });
    }
    const allowed = snapshots.validBids(auction, config);
    if (!allowed.includes(amount)) {
      const msg = auction.currentBid == null ? `The first bid must be the base price, ${next}` : `Raise the bid by ${snapshots.increments(config).join(' or ')}: bid ${allowed.join(' or ')}`;
      throw bad('INVALID_AMOUNT', msg, { nextValidBid: next, validBids: allowed });
    }
    if (amount > team.remainingPurse) throw conflict('INSUFFICIENT_PURSE', `Remaining purse is ${team.remainingPurse}`);

    const updated = await cas(s, auction, { status: 'LIVE', biddingOpen: true, activePlayer: auction.activePlayer }, {
      $set: { currentBid: amount, leadingTeam: team._id, leadingCaptain: user._id },
      $inc: { bidCount: 1, bidSeq: 1 },
    });
    const [bid] = await Bid.create([{
      auction: auction._id, season: season._id, player: auction.activePlayer, team: team._id, captain: user._id,
      amount, seq: updated.bidSeq, idempotencyKey: idempotencyKey || crypto.randomUUID(),
    }], { session: s });
    await outbox.enqueue(s, [{
      type: 'bid:placed', rooms: ['public'], version: updated.version,
      payload: { playerId: String(auction.activePlayer), amount, seq: updated.bidSeq, team: P.teamRef(team), at: bid.createdAt },
    }, STATE]);
    return { bid, duplicate: false };
  });
}

/** Place a bid. On rejection the error carries the latest public state and the rejection is audited. */
async function placeBid(user, input) {
  try {
    return await placeBidTxn(user, input);
  } catch (err) {
    if (err instanceof AppError) {
      err.details = { ...(err.details || {}), state: await snapshots.auctionSnapshot('public') };
      audit(null, { type: 'BID_REJECTED', actor: user, team: user.team, details: { code: err.code, amount: input.amount, playerId: String(input.playerId) } })
        .catch((e) => logger.warn({ e }, 'audit failed'));
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ SOLD / UNSOLD / SKIP */

let finalizeTimer = null;
function scheduleFinalization(deadline) {
  clearTimeout(finalizeTimer);
  const ms = Math.max(new Date(deadline).getTime() - Date.now(), 0) + 25;
  finalizeTimer = setTimeout(() => completeDueFinalization().catch((err) => logger.error({ err }, 'finalization failed')), ms);
  finalizeTimer.unref?.();
}

/** SOLD: lock bidding immediately and persist the finalization; the sale completes after the deadline. */
async function markSold(admin) {
  const result = await mutate(async (s) => {
    const { season, config, auction } = await getContext(s);
    if (auction.status === 'FINALIZING') throw conflict('ALREADY_FINALIZING', 'This sale is already being finalized');
    requireStatus(auction, 'LIVE');
    if (!auction.activePlayer) throw conflict('NO_ACTIVE_PLAYER', 'No active player');
    if (!auction.leadingTeam || auction.currentBid == null) throw conflict('NO_VALID_BID', 'No valid bid: use UNSOLD instead');
    const now = new Date();
    const finalization = {
      key: crypto.randomUUID(), player: auction.activePlayer, team: auction.leadingTeam, captain: auction.leadingCaptain,
      amount: auction.currentBid, startedAt: now, deadline: new Date(now.getTime() + config.finalizationSeconds * 1000),
    };
    // Same filter as bids use: once this commits, every bid's CAS fails.
    const updated = await cas(s, auction, { status: 'LIVE', activePlayer: auction.activePlayer }, {
      $set: { status: 'FINALIZING', biddingOpen: false, finalization },
    });
    const p = await Player.findOneAndUpdate({ _id: auction.activePlayer, status: 'ACTIVE' }, { $set: { status: 'FINALIZING' } }, { session: s });
    if (!p) throw conflict('STALE_STATE', 'Player is not active');
    await audit(s, {
      season: season._id, type: 'SOLD_INITIATED', actor: admin, player: p._id, team: finalization.team,
      details: { amount: finalization.amount, deadline: finalization.deadline, key: finalization.key },
    });
    const team = await Team.findById(finalization.team).select('name abbreviation logo').session(s);
    await outbox.enqueue(s, [{
      type: 'player:finalizing', rooms: ['public'], version: updated.version,
      payload: { playerId: String(p._id), team: P.teamRef(team), amount: finalization.amount, deadline: finalization.deadline },
    }, STATE]);
    return updated;
  });
  // Delay of 0: complete the sale now, in the same request (same exactly-once path the timer/recovery use).
  if (new Date(result.finalization.deadline).getTime() <= Date.now()) {
    return (await completeDueFinalization()) || result;
  }
  scheduleFinalization(result.finalization.deadline);
  return result;
}

/**
 * Completes a due finalization exactly once. Called by the timer and by the recovery worker (after restarts).
 * The claim is a CAS on (status FINALIZING, finalization.key); ledger/sale rows have unique idempotency keys.
 */
async function completeDueFinalization() {
  return mutate(async (s) => {
    const auction = await Auction.findOne({ status: 'FINALIZING', 'finalization.deadline': { $lte: new Date() } }).session(s);
    if (!auction) return null;
    const f = auction.finalization;
    const player = await Player.findOne({ _id: f.player, status: 'FINALIZING' }).session(s);
    const team = await Team.findOneAndUpdate(
      {
        _id: f.team,
        $expr: { $and: [
          { $gte: [{ $subtract: [{ $add: ['$initialPurse', '$finance.resaleCredits'] }, '$finance.spent'] }, f.amount] },
          { $lt: [{ $size: '$squad' }, '$maxSquadSize'] },
        ] },
      },
      { $inc: { 'finance.spent': f.amount }, $push: { squad: f.player } },
      { returnDocument: 'after', session: s },
    );
    if (!player || !team) {
      // Should be impossible (bids are validated); fail safe: reopen the player with bidding locked for admin decision.
      const reverted = await cas(s, auction, { status: 'FINALIZING', 'finalization.key': f.key }, {
        $set: { status: 'LIVE', biddingOpen: false, finalization: CLEAR_FINAL },
      });
      if (player) await Player.updateOne({ _id: player._id }, { $set: { status: 'ACTIVE' } }, { session: s });
      await audit(s, { season: auction.season, type: 'FINALIZATION_FAILED', player: f.player, team: f.team, details: { key: f.key, amount: f.amount } });
      await outbox.enqueue(s, [STATE]);
      return reverted;
    }
    const updated = await cas(s, auction, { status: 'FINALIZING', 'finalization.key': f.key }, {
      $set: {
        ...CLEAR_ACTIVE, status: 'LIVE', finalization: CLEAR_FINAL,
        lastResult: { outcome: 'SOLD', player: f.player, team: f.team, amount: f.amount, at: new Date() },
      },
    });
    const [ledger] = await FinancialTransaction.create([{
      season: auction.season, team: f.team, player: f.player, type: 'PURCHASE_DEBIT', debit: f.amount,
      idempotencyKey: `PURCHASE:${f.key}`, description: `Purchase of player ${f.player}`,
    }], { session: s });
    const winningBid = await Bid.findOne({ player: f.player, team: f.team, amount: f.amount }).sort({ seq: -1 }).session(s);
    const sold = await Player.findOneAndUpdate({ _id: f.player, status: 'FINALIZING' }, {
      $set: { status: player.resaleCount > 0 ? 'RESOLD' : 'SOLD', currentTeam: f.team, purchasePrice: f.amount, purchaseTxn: ledger._id },
      $addToSet: { previousOwners: f.team },
    }, { returnDocument: 'after', session: s });
    await AuctionTransaction.create([{
      season: auction.season, type: 'SALE', player: f.player, team: f.team, amount: f.amount,
      bid: winningBid?._id, idempotencyKey: `SALE:${f.key}`,
    }], { session: s });
    await audit(s, { season: auction.season, type: 'SOLD_COMPLETED', player: f.player, team: f.team, newState: sold.status, details: { amount: f.amount, key: f.key } });
    await outbox.enqueue(s, [
      { type: 'player:sold', rooms: ['public'], version: updated.version, payload: { player: P.publicPlayer(sold), team: P.teamRef(team), amount: f.amount } },
      STATE, LEADERBOARD, { type: 'team:updated', rooms: [`team:${f.team}`] },
    ]);
    return updated;
  });
}

async function resolveWithoutSale(admin, outcome) {
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    requireStatus(auction, 'LIVE', 'PAUSED');
    if (!auction.activePlayer) throw conflict('NO_ACTIVE_PLAYER', 'No active player');
    if (outcome === 'SKIPPED' && auction.bidCount > 0) throw conflict('BIDS_EXIST', 'Bids were placed on this player: use SOLD or UNSOLD');
    const inc = outcome === 'UNSOLD' ? { unsoldCount: 1 } : { skipCount: 1 };
    const player = await Player.findOneAndUpdate({ _id: auction.activePlayer, status: 'ACTIVE' }, { $set: { status: outcome }, $inc: inc }, { returnDocument: 'after', session: s });
    if (!player) throw conflict('STALE_STATE', 'Player is not active');
    const updated = await cas(s, auction, { activePlayer: auction.activePlayer, status: { $in: ['LIVE', 'PAUSED'] } }, {
      $set: { ...CLEAR_ACTIVE, lastResult: { outcome, player: player._id, team: null, amount: null, at: new Date() } },
    });
    await AuctionTransaction.create([{
      season: season._id, type: outcome, player: player._id, admin: admin._id,
      amount: 0, idempotencyKey: `${outcome}:${player._id}:${updated.version}`,
    }], { session: s });
    await audit(s, { season: season._id, type: `PLAYER_${outcome}`, actor: admin, player: player._id, previousState: 'ACTIVE', newState: outcome, details: { bidCount: auction.bidCount, highestBid: auction.currentBid } });
    const evt = outcome === 'UNSOLD' ? 'player:unsold' : 'player:skipped';
    await outbox.enqueue(s, [{ type: evt, rooms: ['public'], version: updated.version, payload: { player: P.publicPlayer(player) } }, STATE]);
    return updated;
  });
}

const markUnsold = (admin) => resolveWithoutSale(admin, 'UNSOLD');
const markSkipped = (admin) => resolveWithoutSale(admin, 'SKIPPED');

async function pendingPlayers() {
  const { season } = await getContext();
  const [pending, availableCount, pool] = await Promise.all([
    Player.find({ season: season._id, status: { $in: C.PENDING_STATUSES } }).sort({ auctionOrder: 1 }).lean(),
    Player.countDocuments({ season: season._id, status: 'AVAILABLE' }),
    Player.find({ season: season._id, status: { $in: C.POOL_STATUSES } }).sort({ auctionOrder: 1, createdAt: 1 }).lean(),
  ]);
  return {
    unsold: pending.filter((p) => p.status === 'UNSOLD').map(P.fullPlayer),
    skipped: pending.filter((p) => p.status === 'SKIPPED').map(P.fullPlayer),
    pool: pool.map(P.fullPlayer),
    pendingSelectable: availableCount === 0,
    availableCount,
  };
}

/**
 * Reset the current auction to its starting point (status CREATED) for a fresh run.
 * Removes all progress: bids, sale/unsold/skip/resale records, the financial ledger, mystery token use, resale requests.
 * Keeps teams, captains, players (back to AVAILABLE at their original base price), configuration and the audit log.
 * Exceptional, destructive admin operation: the caller must repeat the auction name, and the reset is audited with counts.
 */
async function resetAuction(admin, { confirmName } = {}) {
  clearTimeout(finalizeTimer);
  return mutate(async (s) => {
    const { season, auction } = await getContext(s);
    if (String(confirmName || '').trim() !== season.name) throw bad('CONFIRMATION_MISMATCH', `Type the auction name "${season.name}" exactly to confirm`);
    const sid = season._id;
    const [bids, txns, ledger, resales, tokens] = await Promise.all([
      Bid.deleteMany({ season: sid }, { session: s }),
      AuctionTransaction.deleteMany({ season: sid }, { session: s }),
      // The ledger model blocks deletes (append-only); a reset is the one sanctioned exception.
      FinancialTransaction.collection.deleteMany({ season: sid }, { session: s }),
      ResaleRequest.deleteMany({ season: sid }, { session: s }),
      MysteryToken.deleteMany({ season: sid }, { session: s }),
    ]);
    const players = await Player.updateMany({ season: sid }, [{ $set: {
      status: 'AVAILABLE', currentTeam: null, purchasePrice: null, purchaseTxn: null, previousOwners: [],
      resaleCount: 0, unsoldCount: 0, skipCount: 0, basePrice: '$originalBasePrice',
    } }], { session: s, updatePipeline: true });
    await Team.updateMany({ season: sid }, { $set: { squad: [], 'finance.spent': 0, 'finance.resaleCredits': 0 } }, { session: s });
    const updated = await cas(s, auction, {}, { $set: {
      ...CLEAR_ACTIVE, status: 'CREATED', bidSeq: 0, statusBeforePause: null, finalization: CLEAR_FINAL,
      lastResult: { outcome: null, player: null, team: null, amount: null, at: null }, configSnapshot: null, startedAt: null, completedAt: null,
    } });
    const removed = { bids: bids.deletedCount, auctionTransactions: txns.deletedCount, ledgerEntries: ledger.deletedCount, resaleRequests: resales.deletedCount, mysteryTokens: tokens.deletedCount, playersReset: players.modifiedCount };
    await audit(s, { season: sid, type: 'AUCTION_RESET', actor: admin, previousState: auction.status, newState: 'CREATED', details: removed });
    const teams = await Team.find({ season: sid }).select('_id').session(s);
    await outbox.enqueue(s, [STATE, LEADERBOARD, ...teams.map((t) => ({ type: 'team:updated', rooms: [`team:${t._id}`] }))]);
    return { version: updated.version, removed };
  });
}

module.exports = {
  resetAuction,
  startAuction, pauseAuction, resumeAuction, completeAuction, selectPlayer, selectNextPlayer, startBidding,
  placeBid, markSold, markUnsold, markSkipped, completeDueFinalization, scheduleFinalization, pendingPlayers, mutate, cas,
};
