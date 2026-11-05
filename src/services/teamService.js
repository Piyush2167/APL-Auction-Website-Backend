const { Team, User, Player, FinancialTransaction } = require('../models');
const { withTxn } = require('../config/db');
const { getContext } = require('./seasonService');
const { conflict, notFound, bad } = require('../utils/errors');
const { audit } = require('./audit');
const auth = require('./authService');
const email = require('./emailService');
const outbox = require('./outbox');
const P = require('./projections');
const logger = require('../config/logger');

const started = (auction) => !['CREATED', 'READY'].includes(auction.status);

async function list() {
  const { season } = await getContext();
  const teams = await Team.find({ season: season._id }).populate('captain', 'name email active mustChangePassword lastLoginAt').sort({ name: 1 }).lean();
  return teams.map((t) => ({
    ...P.leaderboardRow(t),
    captain: t.captain ? { id: String(t.captain._id), name: t.captain.name, email: t.captain.email, active: t.captain.active, mustChangePassword: t.captain.mustChangePassword, lastLoginAt: t.captain.lastLoginAt } : null,
  }));
}

async function get(id) {
  const { season } = await getContext();
  const team = await Team.findOne({ _id: id, season: season._id }).populate('captain', 'name email active').lean();
  if (!team) throw notFound('Team');
  const [squad, ledger] = await Promise.all([
    Player.find({ _id: { $in: team.squad } }).sort({ purchasePrice: -1 }).lean(),
    FinancialTransaction.find({ team: team._id }).sort({ createdAt: 1 }).populate('player', 'name playerType').lean(),
  ]);
  return { ...P.leaderboardRow(team), captain: team.captain, squad: squad.map(P.fullPlayer), ledger };
}

async function create(admin, data) {
  return withTxn(async (s) => {
    const { season, config, auction } = await getContext(s);
    if (started(auction)) throw conflict('AUCTION_STARTED', 'Teams cannot be added after the auction has started');
    if ((await Team.countDocuments({ season: season._id }).session(s)) >= config.teamCount) {
      throw conflict('TEAM_LIMIT', `The configuration allows ${config.teamCount} teams`);
    }
    const [team] = await Team.create([{
      season: season._id, name: data.name, abbreviation: data.abbreviation, logo: data.logo || null,
      initialPurse: data.initialPurse ?? config.teamPurse, maxSquadSize: data.maxSquadSize ?? config.maxSquadSize,
    }], { session: s });
    if (auction.status === 'READY') { auction.status = 'CREATED'; auction.version += 1; await auction.save({ session: s }); }
    await audit(s, { season: season._id, type: 'TEAM_CREATED', actor: admin, team: team._id, newState: team.toObject() });
    return team;
  });
}

async function update(admin, id, data) {
  return withTxn(async (s) => {
    const { season, auction } = await getContext(s);
    const team = await Team.findOne({ _id: id, season: season._id }).session(s);
    if (!team) throw notFound('Team');
    const financial = ['initialPurse', 'maxSquadSize'].filter((k) => data[k] !== undefined && data[k] !== team[k]);
    if (financial.length && started(auction)) throw conflict('AUCTION_STARTED', `Cannot change ${financial.join(', ')} after the auction has started`);
    const before = team.toObject();
    for (const k of ['name', 'abbreviation', 'logo', 'initialPurse', 'maxSquadSize']) if (data[k] !== undefined) team[k] = data[k];
    await team.save({ session: s });
    await audit(s, { season: season._id, type: 'TEAM_UPDATED', actor: admin, team: team._id, previousState: before, newState: team.toObject() });
    await outbox.enqueue(s, [{ type: 'leaderboard:updated', rooms: ['admin', 'captains'] }, { type: 'team:updated', rooms: [`team:${team._id}`] }]);
    return team;
  }).finally(() => outbox.flush());
}

async function remove(admin, id) {
  return withTxn(async (s) => {
    const { season, auction } = await getContext(s);
    if (started(auction)) throw conflict('AUCTION_STARTED', 'Teams cannot be deleted after the auction has started');
    const team = await Team.findOne({ _id: id, season: season._id }).session(s);
    if (!team) throw notFound('Team');
    if (team.captain) await User.updateOne({ _id: team.captain }, { $set: { active: false, team: null }, $inc: { tokenVersion: 1 } }, { session: s });
    await team.deleteOne({ session: s });
    await audit(s, { season: season._id, type: 'TEAM_DELETED', actor: admin, team: team._id, previousState: team.toObject() });
  });
}

/** Create the captain account for a team and email a temporary credential. */
async function assignCaptain(admin, teamId, { name, email: addr }) {
  const { user, team } = await withTxn(async (s) => {
    const { season } = await getContext(s);
    const team = await Team.findOne({ _id: teamId, season: season._id }).populate('captain').session(s);
    if (!team) throw notFound('Team');
    if (team.captain?.active) throw conflict('CAPTAIN_EXISTS', 'This team already has an active captain. Deactivate them first.');
    const lower = addr.toLowerCase().trim();
    const existing = await User.findOne({ email: lower }).populate('team', 'season').session(s);
    let user;
    if (existing) {
      // A captain from an archived auction can be re-used; anyone else with this email cannot.
      const fromOldAuction = existing.role === 'CAPTAIN' && !existing.active && (!existing.team || String(existing.team.season) !== String(season._id));
      if (!fromOldAuction) throw conflict('EMAIL_IN_USE', 'An account with this email already exists');
      existing.set({ name, team: team._id, active: true });
      await existing.save({ session: s });
      user = existing;
    } else {
      [user] = await User.create([{ name, email: lower, role: 'CAPTAIN', team: team._id, passwordHash: await auth.hashPassword(require('crypto').randomBytes(24).toString('hex')), mustChangePassword: true }], { session: s });
    }
    if (team.captain) await User.updateOne({ _id: team.captain._id }, { $set: { team: null } }, { session: s });
    team.captain = user._id;
    await team.save({ session: s });
    await audit(s, { season: season._id, type: 'CAPTAIN_ASSIGNED', actor: admin, team: team._id, details: { captain: user._id, email: lower } });
    return { user, team };
  });
  const emailSent = await sendInvite(await User.findById(user._id), team.name);
  return { captain: { id: String(user._id), name: user.name, email: user.email }, emailSent };
}

async function sendInvite(user, teamName) {
  const temp = await auth.setTemporaryPassword(user);
  try {
    await email.captainInvite({ to: user.email, captainName: user.name, teamName, tempPassword: temp, expiresAt: user.tempPasswordExpiresAt });
    return true;
  } catch (err) {
    logger.error({ err: err.message, user: String(user._id) }, 'captain invite email failed');
    return false;
  }
}

async function listCaptains() {
  const users = await User.find({ role: 'CAPTAIN' }).populate('team', 'name abbreviation logo').sort({ name: 1 }).lean();
  return users.map((u) => ({
    id: String(u._id), name: u.name, email: u.email, active: u.active, mustChangePassword: u.mustChangePassword,
    tempPasswordExpiresAt: u.tempPasswordExpiresAt, lastLoginAt: u.lastLoginAt, team: P.teamRef(u.team),
  }));
}

async function updateCaptain(admin, id, { name, active }) {
  const user = await User.findOne({ _id: id, role: 'CAPTAIN' });
  if (!user) throw notFound('Captain');
  if (name !== undefined) user.name = name;
  if (active === true && !user.team) throw bad('NO_TEAM', 'Reassign this captain to a team instead of reactivating');
  if (active !== undefined && active !== user.active) {
    user.active = active;
    if (!active) await auth.revokeAllSessions(user._id);
  }
  await user.save();
  if (active === false) outbox.getIO()?.in(`user:${user._id}`).disconnectSockets(true);
  await audit(null, { type: active === false ? 'CAPTAIN_DEACTIVATED' : 'CAPTAIN_UPDATED', actor: admin, team: user.team, details: { captain: user._id, name, active } });
  return { id: String(user._id), name: user.name, email: user.email, active: user.active };
}

async function resetCaptainPassword(admin, id) {
  const user = await User.findOne({ _id: id, role: 'CAPTAIN', active: true }).populate('team', 'name');
  if (!user) throw notFound('Active captain');
  outbox.getIO()?.in(`user:${user._id}`).disconnectSockets(true);
  const emailSent = await sendInvite(user, user.team?.name || 'your team');
  await audit(null, { type: 'CAPTAIN_PASSWORD_RESET', actor: admin, team: user.team?._id, details: { captain: user._id, emailSent } });
  return { emailSent };
}

module.exports = { list, get, create, update, remove, assignCaptain, listCaptains, updateCaptain, resetCaptainPassword };
