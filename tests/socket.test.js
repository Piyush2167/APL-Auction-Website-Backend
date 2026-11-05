const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { io: connect } = require('socket.io-client');
const H = require('./helpers');
const { createApp } = require('../src/app');
const { initSockets } = require('../src/sockets');
const A = require('../src/services/auctionService');
const M = H.M;

let server; let url; let ioServer; const clients = [];
before(async () => {
  await H.startDB();
  server = http.createServer(createApp());
  ioServer = initSockets(server);
  await new Promise((r) => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { ioServer.close(); await H.stopDB(); });
beforeEach(H.resetDB);
afterEach(() => { while (clients.length) clients.pop().close(); });

function client(token) {
  const s = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
  s.events = [];
  s.onAny((type, payload) => s.events.push({ type, payload }));
  clients.push(s);
  return s;
}
const connected = (s) => new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
function waitFor(s, type, pred = () => true, ms = 4000) {
  const hit = s.events.find((e) => e.type === type && pred(e.payload));
  if (hit) return Promise.resolve(hit.payload);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
    const h = (payload) => { if (pred(payload)) { clearTimeout(t); s.off(type, h); res(payload); } };
    s.on(type, h);
  });
}
const emit = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

test('invalid token is refused; audience gets an initial snapshot', async () => {
  await H.fixture();
  const bad = client('not-a-token');
  await assert.rejects(connected(bad), /UNAUTHORIZED/);
  const aud = client();
  await connected(aud);
  const snap = await waitFor(aud, 'auction:state');
  assert.equal(snap.status, 'LIVE');
  assert.ok(!aud.events.some((e) => e.type === 'leaderboard:updated'), 'audience must not get the leaderboard');
});

test('socket bid -> broadcast; FINALIZING -> SOLD; leaderboard and private team updates', async () => {
  const f = await H.fixture();
  const [a, b] = f.captains;
  const aud = client(); const ca = client(a.token); const cb = client(b.token);
  await Promise.all([aud, ca, cb].map(connected));
  await H.open(f.admin, f.players[0]);
  await waitFor(aud, 'auction:state', (s) => s.biddingOpen);

  const ok = await emit(ca, 'bid:place', { playerId: String(f.players[0]._id), amount: 20, idempotencyKey: 'sock-bid-0001' });
  assert.equal(ok.ok, true);
  const placed = await waitFor(aud, 'bid:placed');
  assert.equal(placed.amount, 20);
  assert.equal(placed.team.id, String(a.team._id));
  const st = await waitFor(aud, 'auction:state', (s) => s.currentBid === 20);
  assert.equal(st.nextValidBid, 30);
  assert.equal(st.bids.length, 1);

  const rej = await emit(cb, 'bid:place', { playerId: String(f.players[0]._id), amount: 25 });
  assert.equal(rej.ok, false);
  assert.equal(rej.error.code, 'INVALID_AMOUNT');
  assert.equal(rej.error.details.state.currentBid, 20);
  await waitFor(cb, 'bid:rejected');

  await A.markSold(f.admin);
  const fin = await waitFor(aud, 'player:finalizing');
  assert.equal(fin.amount, 20);
  await waitFor(ca, 'auction:state', (s) => s.status === 'FINALIZING' && s.biddingOpen === false);
  const late = await emit(cb, 'bid:place', { playerId: String(f.players[0]._id), amount: 30 });
  assert.equal(late.error.code, 'BIDDING_LOCKED');

  const sold = await waitFor(aud, 'player:sold', () => true, 5000); // timer fires after finalizationSeconds=1
  assert.equal(sold.amount, 20);
  const lb = await waitFor(cb, 'leaderboard:updated', (p) => p.rows.some((r) => r.totalSpent === 20));
  assert.equal(lb.rows.find((r) => r.id === String(a.team._id)).remainingPurse, 480);
  await waitFor(ca, 'team:updated', (s) => s.finance.totalSpent === 20);
  assert.ok(!cb.events.some((e) => e.type === 'team:updated' && e.payload.team.id === String(a.team._id)), 'team B must not get team A private data');
  assert.ok(!aud.events.some((e) => e.type === 'leaderboard:updated' || e.type === 'team:updated'));
});

test('mystery reveal goes only to the revealing team', async () => {
  const f = await H.fixture({ playerSpecs: [{ name: 'Masked Marvel', playerType: 'MYSTERY', skills: ['Covert'], registrationId: 'REG-X' }] });
  const [a, b] = f.captains;
  const aud = client(); const ca = client(a.token); const cb = client(b.token); const adm = client(f.adminToken);
  await Promise.all([aud, ca, cb, adm].map(connected));
  await H.open(f.admin, f.players[0]);
  await require('../src/services/mysteryService').reveal(await H.reload(a.user));
  const rev = await waitFor(ca, 'mystery:reveal');
  assert.equal(rev.player.name, 'Masked Marvel');
  await waitFor(adm, 'mystery:token_used');
  await new Promise((r) => setTimeout(r, 200));
  const leak = (s) => JSON.stringify(s.events).match(/Masked Marvel|REG-X|Covert/);
  assert.ok(!leak(aud), 'audience leak');
  assert.ok(!leak(cb), 'other captain leak');
  // Reconnect: captain A's fresh connection restores the reveal through its private team summary.
  ca.close();
  const ca2 = client(a.token);
  await connected(ca2);
  const summary = await waitFor(ca2, 'team:updated');
  assert.equal(summary.mysteryToken.revealedPlayer.name, 'Masked Marvel');
});

test('reconnecting client receives the authoritative state without replaying events', async () => {
  const f = await H.fixture();
  await H.open(f.admin, f.players[0]);
  await A.placeBid(await H.reload(f.captains[0].user), { playerId: f.players[0]._id, amount: 20 });
  await A.placeBid(await H.reload(f.captains[1].user), { playerId: f.players[0]._id, amount: 30 });
  const late = client(f.captains[2].token);
  await connected(late);
  const snap = await waitFor(late, 'auction:state');
  assert.equal(snap.currentBid, 30);
  assert.equal(snap.leadingTeam.id, String(f.captains[1].team._id));
  assert.equal(snap.bidCount, 2);
  const synced = await emit(late, 'auction:sync', null);
  assert.equal(synced.data.version, snap.version);
});

test('deactivated captain is disconnected', async () => {
  const f = await H.fixture();
  const ca = client(f.captains[0].token);
  await connected(ca);
  const gone = new Promise((r) => ca.on('disconnect', r));
  await require('../src/services/teamService').updateCaptain(f.admin, f.captains[0].user._id, { active: false });
  await gone;
  assert.equal(await M.User.countDocuments({ active: false }), 1);
});
