const { Season, AuctionConfiguration, Auction, Team, Player, User } = require('../models');
const { withTxn } = require('../config/db');
const { conflict, bad, AppError } = require('../utils/errors');
const C = require('../constants');
const { audit } = require('./audit');

async function getContext(session = null) {
  const season = await Season.findOne({ active: true }).session(session);
  if (!season) throw new AppError(409, 'NO_SEASON', 'No active auction. An administrator must create one in Settings.');
  const [config, auction] = await Promise.all([
    AuctionConfiguration.findOne({ season: season._id }).session(session),
    Auction.findOne({ season: season._id }).session(session),
  ]);
  return { season, config, auction };
}

// Provisional development values (spec §4). The admin confirms real values before going LIVE.
const DEV_DEFAULTS = { teamCount: 8, teamPurse: 500, maxSquadSize: 7, defaultBasePrice: 20, bidIncrements: [3, 5], finalizationSeconds: 0 };

async function createSeason(admin, { name, year, sport = 'CRICKET', config = {} }) {
  return withTxn(async (s) => {
    if (await Season.exists({ active: true }).session(s)) throw conflict('SEASON_EXISTS', 'An active auction already exists. Archive it first.');
    const [season] = await Season.create([{ name, year, sport }], { session: s });
    const categories = config.categories?.length ? config.categories : C.SPORT_CATEGORIES[sport];
    const [cfg] = await AuctionConfiguration.create([{ ...DEV_DEFAULTS, ...config, categories, season: season._id }], { session: s });
    season.config = cfg._id;
    await season.save({ session: s });
    await Auction.create([{ season: season._id }], { session: s });
    await audit(s, { season: season._id, type: 'SEASON_CREATED', actor: admin, details: { name, year, sport, config: cfg.toObject() } });
    return { season, config: cfg };
  });
}

// Fields that can never change once the auction has started (they would invalidate completed transactions).
const LOCKED_AFTER_START = ['teamCount', 'teamPurse', 'maxSquadSize', 'defaultBasePrice', 'categories', 'mysteryTokensPerTeam'];

async function updateConfig(admin, patch, { override = false, reason = '' } = {}) {
  return withTxn(async (s) => {
    const { season, config, auction } = await getContext(s);
    const before = config.toObject();
    const started = !['CREATED', 'READY'].includes(auction.status);
    if (started) {
      const locked = Object.keys(patch).filter((k) => LOCKED_AFTER_START.includes(k));
      if (locked.length) throw conflict('CONFIG_LOCKED', `Cannot change ${locked.join(', ')} after the auction has started`);
      if (!override || reason.trim().length < 5) {
        throw conflict('OVERRIDE_REQUIRED', 'The auction has started: an explicit override with a reason (5+ chars) is required');
      }
      if (auction.status === 'FINALIZING') throw conflict('BIDDING_LOCKED', 'Wait for the current sale to finalize');
    }
    if (patch.categories) {
      const inUse = await Player.distinct('category', { season: season._id }).session(s);
      const missing = inUse.filter((c) => !patch.categories.includes(c));
      if (missing.length) throw bad('CATEGORY_IN_USE', `Categories in use by players: ${missing.join(', ')}`);
    }
    Object.assign(config, patch);
    config.version += 1;
    await config.save({ session: s });
    if (auction.status === 'READY') auction.status = 'CREATED'; // config changed: must be re-confirmed
    if (started) auction.configSnapshot = { ...config.toObject(), snapshotAt: new Date() };
    auction.version += 1;
    await auction.save({ session: s });
    await audit(s, {
      season: season._id, type: started ? 'CONFIG_OVERRIDE' : 'CONFIG_UPDATED', actor: admin,
      previousState: before, newState: config.toObject(), details: { reason },
    });
    return config;
  });
}

async function confirmConfig(admin) {
  return withTxn(async (s) => {
    const { season, config, auction } = await getContext(s);
    if (auction.status !== 'CREATED') throw conflict('INVALID_STATE', `Auction is ${auction.status}`);
    const teams = await Team.find({ season: season._id }).populate('captain', 'active').session(s);
    if (teams.length !== config.teamCount) throw conflict('TEAM_COUNT_MISMATCH', `Configured for ${config.teamCount} teams but ${teams.length} exist`);
    const noCaptain = teams.filter((t) => !t.captain || !t.captain.active).map((t) => t.name);
    if (noCaptain.length) throw conflict('CAPTAIN_MISSING', `Teams without an active captain: ${noCaptain.join(', ')}`);
    if (!(await Player.exists({ season: season._id }).session(s))) throw conflict('NO_PLAYERS', 'Register players first');
    auction.status = 'READY';
    auction.version += 1;
    await auction.save({ session: s });
    await audit(s, { season: season._id, type: 'CONFIG_CONFIRMED', actor: admin, newState: config.toObject() });
    return auction;
  });
}

/**
 * Archive the active auction so a new one (e.g. another sport) can be created. All history stays in the DB.
 * Not allowed mid-auction. Its captains are deactivated (sessions revoked) and can be re-assigned to the next auction.
 */
async function archiveSeason(admin) {
  return withTxn(async (s) => {
    const { season, auction } = await getContext(s);
    if (!['CREATED', 'READY', 'COMPLETED'].includes(auction.status)) {
      throw conflict('AUCTION_IN_PROGRESS', 'Complete the auction before archiving it');
    }
    if (auction.status !== 'COMPLETED') { auction.status = 'CANCELLED'; auction.version += 1; await auction.save({ session: s }); }
    season.active = false;
    await season.save({ session: s });
    const teams = await Team.find({ season: season._id }).select('captain').session(s);
    const captainIds = teams.map((t) => t.captain).filter(Boolean);
    await User.updateMany({ _id: { $in: captainIds } }, { $set: { active: false }, $inc: { tokenVersion: 1 } }, { session: s });
    await audit(s, { season: season._id, type: 'AUCTION_ARCHIVED', actor: admin, previousState: auction.status });
    return { archived: String(season._id), captainsDeactivated: captainIds.length };
  });
}

module.exports = { getContext, createSeason, updateConfig, confirmConfig, archiveSeason, DEV_DEFAULTS };
