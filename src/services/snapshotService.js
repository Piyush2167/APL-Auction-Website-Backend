/** Builds authoritative read models from committed DB state. Used by REST reads and socket broadcasts. */
const { Auction, Bid, Team, Player, MysteryToken, ResaleRequest, Season, AuctionConfiguration } = require('../models');
const P = require('./projections');
const C = require('../constants');

async function loadActive() {
  const season = await Season.findOne({ active: true }).lean();
  if (!season) return null;
  const [config, auction] = await Promise.all([
    AuctionConfiguration.findOne({ season: season._id }).lean(),
    Auction.findOne({ season: season._id })
      .populate('activePlayer').populate('leadingTeam', 'name abbreviation logo')
      .populate({ path: 'lastResult.player' }).populate('lastResult.team', 'name abbreviation logo')
      .populate('finalization.team', 'name abbreviation logo')
      .lean(),
  ]);
  return { season, config, auction };
}

const increments = (cfg) => (cfg.bidIncrements?.length ? [...cfg.bidIncrements].sort((x, y) => x - y) : [3, 5]);
/** Bids a captain may place now: the base price first, then the current bid plus one of the allowed increments. */
const validBids = (a, cfg) => (!a.activePlayer ? [] : a.currentBid == null ? [a.basePrice] : increments(cfg).map((i) => a.currentBid + i));
const nextValidBid = (a, cfg) => validBids(a, cfg)[0] ?? null;

/**
 * mode: 'public' | 'admin'. Captains receive the public snapshot plus their private data separately.
 */
async function auctionSnapshot(mode = 'public') {
  const ctx = await loadActive();
  if (!ctx) return { status: 'NO_SEASON', version: 0, serverTime: new Date() };
  const { season, config, auction: a } = ctx;
  const project = mode === 'admin' ? P.fullPlayer : P.publicPlayer;
  const bids = a.activePlayer
    ? await Bid.find({ auction: a._id, player: a.activePlayer._id }).sort({ seq: -1 }).limit(100)
      .populate('team', 'name abbreviation logo').lean()
    : [];
  const snap = {
    version: a.version,
    serverTime: new Date(),
    season: { id: String(season._id), name: season.name, year: season.year, sport: season.sport || 'CRICKET' },
    status: a.status,
    biddingOpen: a.biddingOpen,
    increments: increments(config),
    finalizationSeconds: config.finalizationSeconds,
    publicBudgetVisible: config.publicBudgetVisible,
    mysteryEnabled: config.mysteryEnabled,
    resaleEnabled: config.resaleEnabled,
    player: project(a.activePlayer),
    basePrice: a.basePrice,
    currentBid: a.currentBid,
    nextValidBid: nextValidBid(a, config),
    validBids: validBids(a, config),
    leadingTeam: P.teamRef(a.leadingTeam),
    bidCount: a.bidCount,
    bids: bids.map((b) => ({ id: String(b._id), seq: b.seq, amount: b.amount, team: P.teamRef(b.team), at: b.createdAt })),
    finalization: a.status === 'FINALIZING'
      ? { team: P.teamRef(a.finalization.team), amount: a.finalization.amount, startedAt: a.finalization.startedAt, deadline: a.finalization.deadline }
      : null,
    lastResult: a.lastResult?.outcome
      ? { outcome: a.lastResult.outcome, player: project(a.lastResult.player), team: P.teamRef(a.lastResult.team), amount: a.lastResult.amount, at: a.lastResult.at }
      : null,
  };
  if (mode === 'admin') {
    snap.config = config;
    const counts = await Player.aggregate([{ $match: { season: season._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    snap.playerCounts = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    snap.startedAt = a.startedAt;
    snap.completedAt = a.completedAt;
  }
  return snap;
}

async function leaderboard() {
  const season = await Season.findOne({ active: true }).lean();
  if (!season) return [];
  const teams = await Team.find({ season: season._id }).populate('captain', 'name').lean();
  return teams.map(P.leaderboardRow).sort((x, y) => y.remainingPurse - x.remainingPurse || x.name.localeCompare(y.name));
}

/** Highest purchase price among owned players; ties all eligible; only SOLD (never-resold) players qualify. */
function resaleEligibility(squad) {
  if (!squad.length) return [];
  const max = Math.max(...squad.map((p) => p.purchasePrice || 0));
  return squad.filter((p) => p.purchasePrice === max && p.status === 'SOLD').map((p) => String(p._id));
}

/** Private data for one team (captain dashboard). */
async function teamSummary(teamId) {
  const team = await Team.findById(teamId).populate('captain', 'name email').lean();
  if (!team) return null;
  const [squad, token, resales] = await Promise.all([
    Player.find({ _id: { $in: team.squad } }).sort({ purchasePrice: -1 }).lean(),
    MysteryToken.findOne({ team: team._id, season: team.season }).populate('revealedPlayer').lean(),
    ResaleRequest.find({ team: team._id }).sort({ createdAt: -1 }).populate('player').lean(),
  ]);
  const revealedId = token?.revealedPlayer?._id;
  const eligible = resaleEligibility(squad);
  return {
    team: { ...P.teamRef(team), captain: team.captain ? { id: String(team.captain._id), name: team.captain.name } : null },
    finance: P.financeOf(team),
    squad: squad.map((p) => ({ ...P.captainPlayer(p, revealedId), resaleEligible: eligible.includes(String(p._id)) })),
    mysteryToken: token ? {
      status: token.status, usedAt: token.usedAt,
      revealedPlayer: token.revealedPlayer ? P.captainPlayer(token.revealedPlayer, revealedId) : null,
    } : { status: 'NOT_ISSUED' },
    resaleRequests: resales.map((r) => ({
      id: String(r._id), status: r.status, reason: r.reason, originalPurchaseAmount: r.originalPurchaseAmount,
      createdAt: r.createdAt, processedAt: r.processedAt, player: P.captainPlayer(r.player, revealedId),
    })),
  };
}

module.exports = { auctionSnapshot, leaderboard, teamSummary, resaleEligibility, nextValidBid, validBids, increments, C };
