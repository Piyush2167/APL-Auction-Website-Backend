#!/usr/bin/env node
/**
 * End-to-end smoke test against RUNNING servers (frontend proxy + backend sockets).
 * It MUTATES the auction (confirms config, starts it, sells players). Use on a freshly seeded dev/staging DB only.
 *   node scripts/e2e-smoke.js --yes-mutate --web http://localhost:3000 --socket http://localhost:4000 \
 *     --admin admin@apl.local:<password> --captain-password <SEED_CAPTAIN_PASSWORD>
 */
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
if (!process.argv.includes('--yes-mutate')) { console.error('Refusing to run without --yes-mutate (this changes auction data).'); process.exit(1); }
const WEB = arg('web', 'http://localhost:3000');
const SOCK = arg('socket', 'http://localhost:4000');
const [adminEmail, adminPw] = arg('admin', '').split(':');
const capPw = arg('captain-password');

async function call(method, path, token, body) {
  const r = await fetch(`${WEB}/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  return { status: r.status, ...json, cookie: r.headers.get('set-cookie') };
}
const ok = async (p) => { const r = await p; assert.equal(r.success, true, JSON.stringify(r.error)); return r.data; };
const login = (email, password) => call('POST', '/auth/login', null, { email, password });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token) {
  const s = io(SOCK, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
  s.seen = [];
  s.onAny((t, p) => s.seen.push({ t, p }));
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
const step = (m) => console.log(`✔ ${m}`);

(async () => {
  const a = await login(adminEmail, adminPw);
  assert.equal(a.status, 200, 'admin login');
  const admin = a.data.accessToken;
  assert.match(a.cookie || '', /apl_rt=.*HttpOnly/i);
  const refreshed = await fetch(`${WEB}/api/auth/refresh`, { method: 'POST', headers: { cookie: a.cookie.split(';')[0] } });
  assert.equal(refreshed.status, 200, 'refresh through proxy');
  step('admin login + refresh-cookie rotation through the frontend proxy');

  const c1 = (await login('captain1@apl.local', capPw)).data.accessToken;
  const c2 = (await login('captain2@apl.local', capPw)).data.accessToken;
  assert.equal((await call('GET', '/admin/dashboard', c1)).status, 403);
  step('captains logged in; captain blocked from admin API');

  await ok(call('POST', '/admin/config/confirm', admin));
  await ok(call('POST', '/admin/auction/start', admin));
  step('configuration confirmed, auction LIVE');

  const [aud, s1, s2] = await Promise.all([connect(), connect(c1), connect(c2)]);
  await ok(call('POST', '/admin/auction/next-player', admin));
  await ok(call('POST', '/admin/auction/start-bidding', admin));
  await sleep(300);
  const st = await ok(call('GET', '/public/auction'));
  const ack = await new Promise((r) => s1.emit('bid:place', { playerId: st.player.id, amount: st.nextValidBid, idempotencyKey: 'smoke-bid-0001' }, r));
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const b2 = await call('POST', '/captain/auction/bid', c2, { playerId: st.player.id, amount: st.nextValidBid + 5 });
  assert.equal(b2.status, 201);
  const stale = await call('POST', '/captain/auction/bid', c1, { playerId: st.player.id, amount: st.nextValidBid + 5 });
  assert.equal(stale.error.code, 'STALE_BID');
  step('socket bid + REST bid accepted; stale bid rejected with latest state');

  await ok(call('POST', '/admin/auction/sold', admin));
  const lockedBid = await call('POST', '/captain/auction/bid', c1, { playerId: st.player.id, amount: st.nextValidBid + 10 });
  assert.equal(lockedBid.error.code, 'BIDDING_LOCKED');
  step('SOLD locks bidding immediately (bid during finalization rejected)');
  await sleep(st.finalizationSeconds * 1000 + 800);
  assert.ok(aud.seen.some((e) => e.t === 'player:finalizing'), 'audience saw finalizing');
  assert.ok(aud.seen.some((e) => e.t === 'player:sold'), 'audience saw sold');
  assert.ok(s1.seen.some((e) => e.t === 'leaderboard:updated'), 'captain got leaderboard');
  assert.ok(!aud.seen.some((e) => e.t === 'leaderboard:updated'), 'audience must not get leaderboard');
  const lb = await ok(call('GET', '/captain/leaderboard', c1));
  const t2 = lb.find((r) => r.totalSpent === st.nextValidBid + 5);
  assert.ok(t2, 'winning team debited');
  step(`sale completed after ${st.finalizationSeconds}s; leaderboard shows ${t2.name} remaining ${t2.remainingPurse}`);

  const pool = await ok(call('GET', '/admin/auction/pending-players', admin));
  const mystery = pool.pool.find((p) => p.playerType === 'MYSTERY');
  await ok(call('POST', '/admin/auction/select-player', admin, { playerId: mystery.id }));
  await sleep(300);
  const pub = JSON.stringify(await ok(call('GET', '/public/auction')));
  assert.ok(!pub.includes(mystery.name), 'public snapshot leaks mystery name');
  const rev = await ok(call('POST', '/captain/mystery-token/reveal', c1));
  assert.equal(rev.player.name, mystery.name);
  await sleep(300);
  assert.ok(s1.seen.some((e) => e.t === 'mystery:reveal'));
  assert.ok(!JSON.stringify(aud.seen).includes(mystery.name), 'audience socket leak');
  assert.ok(!JSON.stringify(s2.seen).includes(mystery.name), 'other captain socket leak');
  step('mystery identity hidden publicly; revealed only to the token holder');

  await ok(call('POST', '/admin/auction/skip', admin));
  const rec = await ok(call('GET', '/admin/ledger/reconcile', admin));
  assert.ok(rec.every((r) => r.ok), 'ledger reconciliation');
  step('ledger reconciles for all teams');
  [aud, s1, s2].forEach((s) => s.close());
  console.log('\nE2E smoke test passed.');
})().catch((e) => { console.error('✖', e.message); process.exit(1); });
