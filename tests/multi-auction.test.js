const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const A = require('../src/services/auctionService');
const S = require('../src/services/seasonService');
const teams = require('../src/services/teamService');
const { M } = H;

before(H.startDB);
after(H.stopDB);
beforeEach(H.resetDB);

test('football auction gets football categories by default', async () => {
  const admin = await H.makeUser({ name: 'Admin', email: 'admin@test.local', role: 'ADMIN' });
  const { season, config } = await S.createSeason(admin, { name: 'APL Football', year: 2026, sport: 'FOOTBALL' });
  assert.equal(season.sport, 'FOOTBALL');
  assert.deepEqual(config.categories, ['Goalkeeper', 'Defender', 'Midfielder', 'Forward']);
});

test('archive: refused mid-auction; after completion a new auction can be created and captains re-used', async () => {
  const f = await H.fixture({ teams: 2 });
  assert.equal(await H.code(S.createSeason(f.admin, { name: 'Next', year: 2026 })), 'SEASON_EXISTS');
  assert.equal(await H.code(S.archiveSeason(f.admin)), 'AUCTION_IN_PROGRESS');
  await A.completeAuction(f.admin);
  const r = await S.archiveSeason(f.admin);
  assert.equal(r.captainsDeactivated, 2);
  assert.equal((await M.User.findById(f.captains[0].user._id)).active, false);

  await S.createSeason(f.admin, { name: 'APL Football', year: 2026, sport: 'FOOTBALL', config: { teamCount: 2 } });
  const team = await teams.create(f.admin, { name: 'Team 1', abbreviation: 'T1' }); // same name allowed in a new auction
  const res = await teams.assignCaptain(f.admin, team._id, { name: 'Captain 1', email: 'c1@test.local' });
  assert.equal(res.captain.email, 'c1@test.local');
  const u = await M.User.findById(f.captains[0].user._id);
  assert.equal(u.active, true);
  assert.equal(String(u.team), String(team._id));
  assert.equal(u.mustChangePassword, true);
  // Old auction data is kept.
  assert.equal(await M.Season.countDocuments(), 2);
  assert.ok(await M.Player.countDocuments({ season: f.season._id }) > 0);
});

test('an active captain of the current auction cannot be grabbed by another team', async () => {
  const f = await H.fixture({ teams: 2, start: false });
  await M.User.updateOne({ _id: f.captains[1].user._id }, { $set: { active: false } });
  assert.equal(await H.code(teams.assignCaptain(f.admin, f.captains[1].team._id, { name: 'X', email: 'c1@test.local' })), 'EMAIL_IN_USE');
});

test('captain chosen from the registered players: name filled, linked, not reusable for another team', async () => {
  const f = await H.fixture({ teams: 2, start: false });
  await M.User.updateMany({ role: 'CAPTAIN' }, { $set: { active: false } });
  const r = await teams.assignCaptain(f.admin, f.captains[0].team._id, { email: 'p1@test.local', playerId: f.players[0]._id });
  assert.equal(r.captain.name, f.players[0].name);
  assert.equal(String((await M.Team.findById(f.captains[0].team._id)).captainPlayer), String(f.players[0]._id));
  assert.equal(await H.code(teams.assignCaptain(f.admin, f.captains[1].team._id, { email: 'p2@test.local', playerId: f.players[0]._id })), 'PLAYER_ALREADY_CAPTAIN');
  assert.equal(await H.code(teams.assignCaptain(f.admin, f.captains[1].team._id, { email: 'p3@test.local' })), 'NAME_REQUIRED');
});
