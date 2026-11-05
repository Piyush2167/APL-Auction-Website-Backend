const { Team, Player, User, ResaleRequest, AuctionTransaction, AuctionLog, Bid, Season, Auction } = require('../models');
const { getContext } = require('./seasonService');
const snapshots = require('./snapshotService');
const P = require('./projections');
const presence = require('../sockets/presence');

async function adminDashboard() {
  const { season } = await getContext();
  const [state, teams, captains, mystery, pendingResale, txnCount, recentSales, recentLogs, leaderboard] = await Promise.all([
    snapshots.auctionSnapshot('admin'),
    Team.countDocuments({ season: season._id }),
    User.countDocuments({ role: 'CAPTAIN', active: true }),
    Player.countDocuments({ season: season._id, playerType: 'MYSTERY' }),
    ResaleRequest.countDocuments({ season: season._id, status: 'PENDING' }),
    AuctionTransaction.countDocuments({ season: season._id }),
    AuctionTransaction.find({ season: season._id, type: 'SALE' }).sort({ createdAt: -1 }).limit(10).populate('player').populate('team', 'name abbreviation logo').lean(),
    AuctionLog.find({ season: season._id }).sort({ createdAt: -1 }).limit(20).populate('actor', 'name role').lean(),
    snapshots.leaderboard(),
  ]);
  const c = state.playerCounts || {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return {
    auction: { id: String(season._id), name: season.name, year: season.year, sport: season.sport || 'CRICKET' },
    stats: {
      totalPlayers: total, totalTeams: teams, totalCaptains: captains,
      available: c.AVAILABLE || 0, active: (c.ACTIVE || 0) + (c.FINALIZING || 0),
      sold: (c.SOLD || 0) + (c.RESOLD || 0) + (c.RESALE_PENDING || 0), unsold: c.UNSOLD || 0, skipped: c.SKIPPED || 0,
      pendingResale, mysteryPlayers: mystery, remainingPool: (c.AVAILABLE || 0) + (c.RESALE_APPROVED || 0) + (c.UNSOLD || 0) + (c.SKIPPED || 0),
      totalTransactions: txnCount, connectedCaptains: presence.counts().captains, audienceViewers: presence.counts().audience,
      auctionStatus: state.status,
    },
    statusDistribution: c,
    state,
    recentPurchases: recentSales.map((t) => ({ player: P.fullPlayer(t.player), team: P.teamRef(t.team), amount: t.amount, at: t.createdAt })),
    recentActivity: recentLogs.map(logRow),
    leaderboard,
  };
}

function logRow(l) {
  return { id: String(l._id), type: l.type, actor: l.actor ? { name: l.actor.name, role: l.actor.role } : { name: 'System', role: l.actorRole }, player: l.player ? String(l.player) : null, team: l.team ? String(l.team) : null, details: l.details, previousState: l.previousState, newState: l.newState, at: l.createdAt };
}

async function logs({ type, page = 1, limit = 50 }) {
  const { season } = await getContext();
  const q = { $or: [{ season: season._id }, { season: null }] };
  if (type) q.type = type;
  const [rows, total] = await Promise.all([
    AuctionLog.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('actor', 'name role').lean(),
    AuctionLog.countDocuments(q),
  ]);
  return { rows: rows.map(logRow), total, page, limit };
}

async function auctionTransactions({ page = 1, limit = 50 }) {
  const { season } = await getContext();
  const q = { season: season._id };
  const [rows, total] = await Promise.all([
    AuctionTransaction.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('player').populate('team', 'name abbreviation').populate('admin', 'name').lean(),
    AuctionTransaction.countDocuments(q),
  ]);
  return { rows: rows.map((t) => ({ id: String(t._id), type: t.type, player: P.fullPlayer(t.player), team: P.teamRef(t.team), amount: t.amount, originalPurchaseAmount: t.originalPurchaseAmount, admin: t.admin?.name || null, at: t.createdAt })), total, page, limit };
}

async function bidHistory({ player, team, page = 1, limit = 100 }, projectPlayer = P.fullPlayer) {
  const { season } = await getContext();
  const q = { season: season._id };
  if (player) q.player = player;
  if (team) q.team = team;
  const [rows, total] = await Promise.all([
    Bid.find(q).sort({ seq: -1 }).skip((page - 1) * limit).limit(limit).populate('team', 'name abbreviation logo').populate('player').lean(),
    Bid.countDocuments(q),
  ]);
  return { rows: rows.map((b) => ({ id: String(b._id), seq: b.seq, amount: b.amount, team: P.teamRef(b.team), player: projectPlayer(b.player), at: b.createdAt })), total, page, limit };
}

/**
 * Team results. mode 'admin' -> full identities and finances; 'public' -> mystery masked, budgets per config.
 */
async function results(mode = 'public') {
  const { season, config } = await getContext();
  const teams = await Team.find({ season: season._id }).populate('captain', 'name').sort({ name: 1 }).lean();
  const players = await Player.find({ _id: { $in: teams.flatMap((t) => t.squad) } }).lean();
  const byId = new Map(players.map((p) => [String(p._id), p]));
  const project = mode === 'admin' ? P.fullPlayer : P.publicPlayer;
  const showBudget = mode === 'admin' || config.publicBudgetVisible;
  return teams.map((t) => {
    const fin = P.financeOf(t);
    return {
      ...P.teamRef(t), captainName: t.captain?.name || null,
      squad: t.squad.map((id) => byId.get(String(id))).filter(Boolean).map(project),
      playersPurchased: fin.playersPurchased, playersRemaining: fin.playersRemaining, maxSquadSize: fin.maxSquadSize, squadCompletion: fin.squadCompletion,
      ...(showBudget ? { initialPurse: fin.initialPurse, totalSpent: fin.totalSpent, totalResaleCredits: fin.totalResaleCredits, remainingPurse: fin.remainingPurse } : {}),
    };
  });
}

function resultsCsv(rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Team', 'Captain', 'Player', 'Type', 'Category', 'Purchase Price', 'Team Spent', 'Resale Credits', 'Remaining Purse', 'Squad', 'Slots Left'].map(q).join(',')];
  for (const t of rows) {
    const base = [t.name, t.captainName];
    const tail = [t.totalSpent, t.totalResaleCredits, t.remainingPurse, `${t.playersPurchased}/${t.maxSquadSize}`, t.playersRemaining];
    if (!t.squad.length) lines.push([...base, '', '', '', '', ...tail].map(q).join(','));
    for (const p of t.squad) lines.push([...base, p.name, p.playerType, p.category, p.purchasePrice, ...tail].map(q).join(','));
  }
  return lines.join('\n');
}

async function publicPlayers({ status, category, playerType, page = 1, limit = 100 }) {
  const { season } = await getContext();
  const q = { season: season._id };
  if (status) q.status = { $in: String(status).split(',') };
  if (category) q.category = category;
  if (playerType) q.playerType = playerType;
  const [rows, total] = await Promise.all([
    Player.find(q).sort({ auctionOrder: 1 }).skip((page - 1) * limit).limit(limit).populate('currentTeam', 'name abbreviation logo').lean(),
    Player.countDocuments(q),
  ]);
  return { rows: rows.map(P.publicPlayer), total, page, limit };
}

/** Every auction ever created (active and archived), newest first, with headline numbers. */
async function listAuctions() {
  const seasons = await Season.find().sort({ createdAt: -1 }).lean();
  const ids = seasons.map((s) => s._id);
  const [auctions, teamCounts, playerCounts] = await Promise.all([
    Auction.find({ season: { $in: ids } }).select('season status startedAt completedAt').lean(),
    Team.aggregate([{ $match: { season: { $in: ids } } }, { $group: { _id: '$season', n: { $sum: 1 } } }]),
    Player.aggregate([{ $match: { season: { $in: ids } } }, { $group: {
      _id: '$season', total: { $sum: 1 },
      sold: { $sum: { $cond: [{ $in: ['$status', ['SOLD', 'RESOLD', 'RESALE_PENDING']] }, 1, 0] } },
      spent: { $sum: { $cond: [{ $in: ['$status', ['SOLD', 'RESOLD', 'RESALE_PENDING']] }, '$purchasePrice', 0] } },
    } }]),
  ]);
  const by = (arr, key = '_id') => new Map(arr.map((x) => [String(x[key]), x]));
  const a = by(auctions, 'season'); const t = by(teamCounts); const p = by(playerCounts);
  return seasons.map((s) => {
    const id = String(s._id);
    return {
      id, name: s.name, year: s.year, sport: s.sport || 'CRICKET', active: s.active, createdAt: s.createdAt,
      status: a.get(id)?.status || 'CREATED', startedAt: a.get(id)?.startedAt || null, completedAt: a.get(id)?.completedAt || null,
      teams: t.get(id)?.n || 0, players: p.get(id)?.total || 0, sold: p.get(id)?.sold || 0, totalSpent: p.get(id)?.spent || 0,
    };
  });
}

module.exports = { listAuctions, adminDashboard, logs, auctionTransactions, bidHistory, results, resultsCsv, publicPlayers };
