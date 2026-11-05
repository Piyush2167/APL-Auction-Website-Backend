/** HTTP-level tests: auth, authorization, players/import, mystery projection, financial rules. */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const H = require('./helpers');
const { createApp } = require('../src/app');
const email = require('../src/services/emailService');
const A = require('../src/services/auctionService');
const { M } = H;

let app;
before(async () => { await H.startDB(); app = createApp(); });
after(H.stopDB);
beforeEach(async () => { await H.resetDB(); email.sent.length = 0; });

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const tempPasswordFrom = (msg) => msg.html.match(/<code[^>]*>([^<]+)<\/code>/)[1];

describe('authentication', () => {
  test('admin login, /me, bad password', async () => {
    await H.fixture({ start: false });
    const ok = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: H.PASSWORD }).expect(200);
    assert.ok(ok.body.data.accessToken);
    assert.match(ok.headers['set-cookie'][0], /apl_rt=.*HttpOnly/);
    const me = await request(app).get('/api/auth/me').set(bearer(ok.body.data.accessToken)).expect(200);
    assert.equal(me.body.data.user.role, 'ADMIN');
    const bad = await request(app).post('/api/auth/login').send({ email: 'admin@test.local', password: 'nope1234' }).expect(401);
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');
  });

  test('captain invite -> temp login -> forced password change -> dashboard', async () => {
    const f = await H.fixture({ start: false, teams: 2 });
    // Remove fixture captain so the team can get a new one through the real flow.
    await M.User.updateOne({ _id: f.captains[0].user._id }, { $set: { active: false } });
    const res = await request(app).post(`/api/admin/teams/${f.captains[0].team._id}/captain`).set(bearer(f.adminToken))
      .send({ name: 'New Captain', email: 'new.captain@test.local' }).expect(201);
    assert.equal(res.body.data.emailSent, true);
    assert.ok(!JSON.stringify(res.body).match(/password/i), 'no password in API response');
    assert.equal(email.sent.length, 1);
    const msg = email.sent[0];
    assert.match(msg.html, /Team 1/);
    assert.match(msg.html, /New Captain/);
    assert.match(msg.html, /\/login/);
    const temp = tempPasswordFrom(msg);
    const login = await request(app).post('/api/auth/login').send({ email: 'new.captain@test.local', password: temp }).expect(200);
    assert.equal(login.body.data.user.mustChangePassword, true);
    const token = login.body.data.accessToken;
    const blocked = await request(app).get('/api/captain/dashboard').set(bearer(token)).expect(403);
    assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
    await request(app).post('/api/auth/change-password').set(bearer(token)).send({ currentPassword: temp, newPassword: 'short' }).expect(400);
    const changed = await request(app).post('/api/auth/change-password').set(bearer(token)).send({ currentPassword: temp, newPassword: 'MyNewPass123' }).expect(200);
    // The old token is revoked; the temp credential no longer works.
    await request(app).get('/api/auth/me').set(bearer(token)).expect(401);
    await request(app).post('/api/auth/login').send({ email: 'new.captain@test.local', password: temp }).expect(401);
    await request(app).get('/api/captain/team').set(bearer(changed.body.data.accessToken)).expect(200);
  });

  test('duplicate captain email and second active captain are rejected', async () => {
    const f = await H.fixture({ start: false });
    const r1 = await request(app).post(`/api/admin/teams/${f.captains[0].team._id}/captain`).set(bearer(f.adminToken)).send({ name: 'X Y', email: 'z@test.local' }).expect(409);
    assert.equal(r1.body.error.code, 'CAPTAIN_EXISTS');
    await M.User.updateOne({ _id: f.captains[0].user._id }, { $set: { active: false } });
    const r2 = await request(app).post(`/api/admin/teams/${f.captains[0].team._id}/captain`).set(bearer(f.adminToken)).send({ name: 'X Y', email: 'c2@test.local' }).expect(409);
    assert.equal(r2.body.error.code, 'EMAIL_IN_USE');
  });

  test('expired temporary credential is rejected', async () => {
    const f = await H.fixture({ start: false });
    await request(app).post(`/api/admin/captains/${f.captains[0].user._id}/reset-password`).set(bearer(f.adminToken)).expect(200);
    const temp = tempPasswordFrom(email.sent[0]);
    await M.User.updateOne({ _id: f.captains[0].user._id }, { $set: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } });
    const r = await request(app).post('/api/auth/login').send({ email: 'c1@test.local', password: temp }).expect(401);
    assert.equal(r.body.error.code, 'TEMP_PASSWORD_EXPIRED');
  });

  test('forgot/reset password', async () => {
    await H.fixture({ start: false });
    await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@test.local' }).expect(200);
    assert.equal(email.sent.length, 0);
    await request(app).post('/api/auth/forgot-password').send({ email: 'c1@test.local' }).expect(200);
    const token = decodeURIComponent(email.sent[0].html.match(/token=([^"&<]+)/)[1]);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'Reset12345' }).expect(200);
    await request(app).post('/api/auth/reset-password').send({ token, password: 'Reset12345' }).expect(400);
    await request(app).post('/api/auth/login').send({ email: 'c1@test.local', password: 'Reset12345' }).expect(200);
  });

  test('refresh rotation; reusing an old refresh token revokes the family', async () => {
    await H.fixture({ start: false });
    const login = await request(app).post('/api/auth/login').send({ email: 'c1@test.local', password: H.PASSWORD });
    const cookie1 = login.headers['set-cookie'][0].split(';')[0];
    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', cookie1).expect(200);
    const cookie2 = r1.headers['set-cookie'][0].split(';')[0];
    assert.notEqual(cookie1, cookie2);
    await request(app).post('/api/auth/refresh').set('Cookie', cookie1).expect(401); // reuse detected
    await request(app).post('/api/auth/refresh').set('Cookie', cookie2).expect(401); // family revoked
  });

  test('deactivation revokes sessions immediately', async () => {
    const f = await H.fixture({ start: false });
    const t = f.captains[0].token;
    await request(app).patch(`/api/admin/captains/${f.captains[0].user._id}`).set(bearer(f.adminToken)).send({ active: false }).expect(200);
    const r = await request(app).get('/api/auth/me').set(bearer(t)).expect(401);
    assert.equal(r.body.error.code, 'SESSION_REVOKED');
    await request(app).post('/api/auth/login').send({ email: 'c1@test.local', password: H.PASSWORD }).expect(403);
  });

  test('role isolation: captains cannot reach admin APIs; anonymous cannot reach captain APIs', async () => {
    const f = await H.fixture();
    await request(app).get('/api/admin/dashboard').set(bearer(f.captains[0].token)).expect(403);
    await request(app).post('/api/admin/auction/sold').set(bearer(f.captains[0].token)).expect(403);
    await request(app).patch(`/api/admin/teams/${f.captains[0].team._id}`).set(bearer(f.captains[0].token)).send({ initialPurse: 9999 }).expect(403);
    await request(app).get('/api/captain/dashboard').expect(401);
    await request(app).get('/api/admin/dashboard').set(bearer(f.adminToken)).expect(200);
  });
});

describe('players & import', () => {
  test('create, duplicate, edit, delete; mystery creation', async () => {
    const f = await H.fixture({ start: false, players: 0, playerSpecs: [] });
    const auth = bearer(f.adminToken);
    const c = await request(app).post('/api/admin/players').set(auth).send({ name: 'Rahul Sharma', gender: 'male', category: 'batsman', basePrice: 30, skills: ['Opener'] }).expect(201);
    assert.equal(c.body.data.category, 'Batsman');
    assert.equal(c.body.data.originalBasePrice, 30);
    const dup = await request(app).post('/api/admin/players').set(auth).send({ name: '  rahul   SHARMA ', gender: 'Male', category: 'Bowler' }).expect(409);
    assert.equal(dup.body.error.code, 'DUPLICATE_PLAYER');
    await request(app).post('/api/admin/players').set(auth).send({ name: 'Bad', gender: 'Male', category: 'Goalkeeper' }).expect(400);
    const m = await request(app).post('/api/admin/players').set(auth).send({ name: 'Secret Star', gender: 'Male', category: 'Bowler', playerType: 'MYSTERY', publicSkills: ['Swing'] }).expect(201);
    assert.equal(m.body.data.playerType, 'MYSTERY');
    assert.equal(m.body.data.basePrice, 20); // config default
    const e = await request(app).patch(`/api/admin/players/${c.body.data.id}`).set(auth).send({ basePrice: 40 }).expect(200);
    assert.equal(e.body.data.originalBasePrice, 40);
    await request(app).delete(`/api/admin/players/${c.body.data.id}`).set(auth).expect(200);
  });

  test('sold players cannot be deleted or have price changed', async () => {
    const f = await H.fixture();
    await H.sell(f.admin, f.captains[0], f.players[0], 20);
    const auth = bearer(f.adminToken);
    assert.equal((await request(app).delete(`/api/admin/players/${f.players[0]._id}`).set(auth).expect(409)).body.error.code, 'PLAYER_HAS_HISTORY');
    assert.equal((await request(app).patch(`/api/admin/players/${f.players[0]._id}`).set(auth).send({ basePrice: 99 }).expect(409)).body.error.code, 'PLAYER_LOCKED');
  });

  test('CSV preview reports valid/invalid/duplicate rows; commit imports only valid', async () => {
    const f = await H.fixture({ start: false, players: 1 }); // "Player 1" exists
    const csv = 'name,gender,category,basePrice,playerType,skills\n'
      + 'Rahul Sharma,Male,Batsman,20,NORMAL,Opener;Anchor\n'
      + 'Amit Kumar,Male,Bowler,30,MYSTERY,\n'
      + 'Bad Row,Male,Goalie,-5,ALIEN,\n'
      + 'rahul sharma,Male,Bowler,20,NORMAL,\n'
      + 'Player 1,Male,Batsman,20,NORMAL,\n'
      + 'Rohit Patil,Male,All-rounder,20.5,NORMAL,\n';
    const auth = bearer(f.adminToken);
    const p = await request(app).post('/api/admin/players/import/preview').set(auth).attach('file', Buffer.from(csv), 'p.csv').expect(200);
    assert.equal(p.body.data.validCount, 2);
    assert.equal(p.body.data.invalidCount, 2);
    assert.equal(p.body.data.duplicateCount, 2);
    const bad = p.body.data.invalid.find((r) => r.row === 3);
    assert.ok(bad.errors.some((e) => e.startsWith('category')));
    assert.ok(bad.errors.some((e) => e.startsWith('basePrice')));
    assert.ok(bad.errors.some((e) => e.startsWith('playerType')));
    const c = await request(app).post('/api/admin/players/import/csv').set(auth).attach('file', Buffer.from(csv), 'p.csv').expect(201);
    assert.equal(c.body.data.imported, 2);
    assert.equal(c.body.data.failed, 4);
    const amit = await M.Player.findOne({ name: 'Amit Kumar' });
    assert.equal(amit.playerType, 'MYSTERY');
    assert.deepEqual((await M.Player.findOne({ name: 'Rahul Sharma' })).skills, ['Opener', 'Anchor']);
    // Re-import: everything is now a duplicate; nothing overwritten.
    const again = await request(app).post('/api/admin/players/import/csv').set(auth).attach('file', Buffer.from(csv), 'p.csv').expect(201);
    assert.equal(again.body.data.imported, 0);
  });

  test('JSON import and malformed JSON', async () => {
    const f = await H.fixture({ start: false, players: 0, playerSpecs: [] });
    const auth = bearer(f.adminToken);
    const json = JSON.stringify([{ name: 'Rahul Sharma', gender: 'Male', category: 'Batsman', basePrice: 20, playerType: 'NORMAL' }, { name: 'Amit Kumar', gender: 'Male', category: 'Bowler', basePrice: 30, playerType: 'MYSTERY' }]);
    const r = await request(app).post('/api/admin/players/import/json').set(auth).attach('file', Buffer.from(json), 'p.json').expect(201);
    assert.equal(r.body.data.imported, 2);
    const bad = await request(app).post('/api/admin/players/import/preview').set(auth).attach('file', Buffer.from('{"not":"array"}'), 'p.json').expect(400);
    assert.equal(bad.body.error.code, 'INVALID_FILE');
    await request(app).post('/api/admin/players/import/preview').set(auth).attach('file', Buffer.from('x'), 'p.txt').expect(400);
  });
});

describe('mystery players', () => {
  const spec = { playerSpecs: [{ name: 'Hidden Legend', playerType: 'MYSTERY', image: 'https://img.test/secret.png', registrationId: 'REG-SECRET', skills: ['Covert googly'] }, { name: 'Normal Guy' }] };

  test('public APIs and other captains never see the identity; revealing team does, persistently', async () => {
    const f = await H.fixture(spec);
    const [a, b] = f.captains;
    await H.open(f.admin, f.players[0]);
    const leaks = (body) => /Hidden Legend|secret\.png|REG-SECRET|Covert googly/.test(JSON.stringify(body));
    for (const url of ['/api/public/auction', '/api/public/auction/current', '/api/public/players', '/api/public/teams']) {
      const r = await request(app).get(url).expect(200);
      assert.ok(!leaks(r.body), `${url} leaks identity`);
    }
    const pub = await request(app).get('/api/public/auction');
    assert.equal(pub.body.data.player.identityHidden, true);
    assert.deepEqual(pub.body.data.player.skills, ['Hard hitter']);
    assert.equal(pub.body.data.player.category, 'Batsman');

    const rev = await request(app).post('/api/captain/mystery-token/reveal').set(bearer(a.token)).expect(200);
    assert.equal(rev.body.data.player.name, 'Hidden Legend');
    assert.equal(rev.body.data.player.image, 'https://img.test/secret.png');
    // Second click does not consume anything new.
    const again = await request(app).post('/api/captain/mystery-token/reveal').set(bearer(a.token)).expect(200);
    assert.equal(again.body.data.alreadyRevealed, true);
    // "Reconnect": fresh fetch keeps the reveal.
    const tok = await request(app).get('/api/captain/mystery-token').set(bearer(a.token)).expect(200);
    assert.equal(tok.body.data.status, 'USED');
    assert.equal(tok.body.data.revealedPlayer.name, 'Hidden Legend');
    // Other captain and the public still see masked data.
    const other = await request(app).get('/api/captain/dashboard').set(bearer(b.token)).expect(200);
    assert.ok(!leaks(other.body));
    assert.ok(!leaks((await request(app).get('/api/public/auction')).body));
    // Admin sees everything.
    const adm = await request(app).get('/api/admin/auction').set(bearer(f.adminToken)).expect(200);
    assert.equal(adm.body.data.player.name, 'Hidden Legend');
  });

  test('token is single-use per season and concurrent reveals consume one token', async () => {
    const f = await H.fixture({ playerSpecs: [{ playerType: 'MYSTERY' }, { playerType: 'MYSTERY' }, {}] });
    const a = f.captains[0];
    await H.open(f.admin, f.players[0]);
    const rs = await Promise.all([1, 2, 3].map(() => request(app).post('/api/captain/mystery-token/reveal').set(bearer(a.token))));
    assert.ok(rs.every((r) => r.status === 200 || r.status === 409));
    assert.equal(await M.MysteryToken.countDocuments({ team: a.team._id, status: 'USED' }), 1);
    await A.markSkipped(f.admin);
    await H.open(f.admin, f.players[1]);
    const r = await request(app).post('/api/captain/mystery-token/reveal').set(bearer(a.token)).expect(409);
    assert.equal(r.body.error.code, 'TOKEN_USED');
    // One token per team per season is a DB constraint.
    await assert.rejects(M.MysteryToken.create({ season: f.season._id, team: a.team._id }), /E11000/);
  });

  test('reveal refused for a normal player', async () => {
    const f = await H.fixture(spec);
    await H.open(f.admin, f.players[1]);
    const r = await request(app).post('/api/captain/mystery-token/reveal').set(bearer(f.captains[0].token)).expect(409);
    assert.equal(r.body.error.code, 'NOT_MYSTERY');
  });
});

describe('finance via API', () => {
  test('bid endpoint, leaderboard values, reconciliation, no negative purse', async () => {
    const f = await H.fixture({ config: { teamPurse: 100 }, playerSpecs: [{ basePrice: 110 }, { basePrice: 100 }, {}] });
    const a = f.captains[0];
    await H.open(f.admin, f.players[0]);
    const over = await request(app).post('/api/captain/auction/bid').set(bearer(a.token)).send({ playerId: String(f.players[0]._id), amount: 110 }).expect(409);
    assert.equal(over.body.error.code, 'INSUFFICIENT_PURSE');
    assert.equal(over.body.error.details.state.status, 'LIVE');
    await request(app).post('/api/admin/auction/unsold').set(bearer(f.adminToken)).expect(200);
    await H.open(f.admin, f.players[1]);
    await request(app).post('/api/captain/auction/bid').set(bearer(a.token)).send({ playerId: String(f.players[1]._id), amount: 100 }).expect(201);
    await request(app).post('/api/admin/auction/sold').set(bearer(f.adminToken)).expect(200);
    await H.expireFinalization();
    await A.completeDueFinalization();
    const lb = await request(app).get('/api/captain/leaderboard').set(bearer(a.token)).expect(200);
    const row = lb.body.data.find((r) => r.id === String(a.team._id));
    assert.deepEqual([row.initialPurse, row.totalSpent, row.remainingPurse, row.playersPurchased], [100, 100, 0, 1]);
    const rec = await request(app).get('/api/admin/ledger/reconcile').set(bearer(f.adminToken)).expect(200);
    assert.ok(rec.body.data.every((r) => r.ok));
    await H.open(f.admin, f.players[2]);
    const zero = await request(app).post('/api/captain/auction/bid').set(bearer(a.token)).send({ playerId: String(f.players[2]._id), amount: 20 }).expect(409);
    assert.equal(zero.body.error.code, 'INSUFFICIENT_PURSE');
  });

  test('config: financial fields locked after start, overrides need a reason and are audited', async () => {
    const f = await H.fixture();
    const auth = bearer(f.adminToken);
    assert.equal((await request(app).patch('/api/admin/config').set(auth).send({ teamPurse: 900 }).expect(409)).body.error.code, 'CONFIG_LOCKED');
    assert.equal((await request(app).patch('/api/admin/config').set(auth).send({ bidIncrements: [3, 5] }).expect(409)).body.error.code, 'OVERRIDE_REQUIRED');
    await request(app).patch('/api/admin/config').set(auth).send({ bidIncrements: [5, 3], override: true, reason: 'Committee decision' }).expect(200);
    assert.equal(await M.AuctionLog.countDocuments({ type: 'CONFIG_OVERRIDE' }), 1);
  });

  test('health endpoint', async () => {
    const r = await request(app).get('/api/health').expect(200);
    assert.equal(r.body.data.db, 'up');
  });
});
