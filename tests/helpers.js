process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-0123456789';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const M = require('../src/models');
const { createSeason, confirmConfig } = require('../src/services/seasonService');
const teamService = require('../src/services/teamService');
const auctionService = require('../src/services/auctionService');
const { hashPassword, signAccess } = require('../src/services/authService');
const { nameKey } = require('../src/services/playerService');

let rs;
async function startDB() {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(rs.getUri());
  await Promise.all(Object.values(M).map((m) => m.init()));
}
async function stopDB() {
  await mongoose.disconnect();
  await rs?.stop();
}
async function resetDB() {
  const cols = await mongoose.connection.db.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
}

const PASSWORD = 'Passw0rd!';

async function makeUser(data) {
  return M.User.create({ passwordHash: await hashPassword(PASSWORD), ...data });
}

/**
 * Builds a season with `teams` teams (each with an active captain) and players.
 * players: array of partial player specs (defaults: NORMAL, Batsman, basePrice 20).
 * start: confirm config and go LIVE.
 */
async function fixture({ teams = 3, players = 6, config = {}, start = true, playerSpecs } = {}) {
  const admin = await makeUser({ name: 'Admin', email: 'admin@test.local', role: 'ADMIN' });
  await createSeason(admin, { name: 'APL Season 8', year: 2026, config: { teamCount: teams, finalizationSeconds: 1, bidIncrements: [10], ...config } });
  const captains = [];
  for (let i = 0; i < teams; i++) {
    const team = await teamService.create(admin, { name: `Team ${i + 1}`, abbreviation: `T${i + 1}` });
    const user = await makeUser({ name: `Captain ${i + 1}`, email: `c${i + 1}@test.local`, role: 'CAPTAIN', team: team._id });
    await M.Team.updateOne({ _id: team._id }, { $set: { captain: user._id } });
    captains.push({ user, team, token: signAccess(user) });
  }
  const season = await M.Season.findOne({ active: true });
  const specs = playerSpecs || Array.from({ length: players }, () => ({}));
  const docs = await M.Player.insertMany(specs.map((s, i) => {
    const name = s.name || `Player ${i + 1}`;
    const base = s.basePrice ?? 20;
    return {
      season: season._id, name, nameKey: nameKey(name), gender: 'Male', category: 'Batsman', skills: ['Secret skill'],
      publicSkills: ['Hard hitter'], registrationId: `REG-${i + 1}`, image: `https://img.test/${i + 1}.png`,
      basePrice: base, originalBasePrice: base, playerType: 'NORMAL', auctionOrder: i + 1, ...s,
    };
  }));
  if (start) {
    await confirmConfig(admin);
    await auctionService.startAuction(admin);
  }
  return { admin, adminToken: signAccess(admin), captains, players: docs, season };
}

const fresh = (doc) => doc.constructor.findById(doc._id);
const reload = async (user) => M.User.findById(user._id);

/** Select a player and open bidding. */
async function open(admin, player) {
  await auctionService.selectPlayer(admin, player._id);
  await auctionService.startBidding(admin);
}

/** Force the persisted finalization deadline into the past (simulates time passing / a restart). */
async function expireFinalization() {
  await M.Auction.updateOne({ status: 'FINALIZING' }, { $set: { 'finalization.deadline': new Date(Date.now() - 1000) } });
}

/** Run a full sale of `player` to `captain` at `amount`. */
async function sell(admin, captain, player, amount) {
  // An opening bid is always the base price, so a sale at `amount` opens the player at that price.
  await M.Player.updateOne({ _id: player._id }, { $set: { basePrice: amount } });
  await open(admin, player);
  await auctionService.placeBid(await reload(captain.user), { playerId: player._id, amount });
  await auctionService.markSold(admin);
  await expireFinalization();
  await auctionService.completeDueFinalization();
}

const code = async (promise) => {
  try { await promise; return 'OK'; } catch (e) { return e.code || e.message; }
};

module.exports = { startDB, stopDB, resetDB, fixture, makeUser, PASSWORD, fresh, reload, open, sell, expireFinalization, code, M };
