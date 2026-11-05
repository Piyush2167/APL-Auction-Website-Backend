const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const A = require('../src/services/auctionService');
const R = require('../src/services/resaleService');
const ledger = require('../src/services/ledgerService');
const { teamSummary } = require('../src/services/snapshotService');
const { M } = H;

before(H.startDB);
after(H.stopDB);
beforeEach(H.resetDB);

const remaining = async (team) => {
  const t = await M.Team.findById(team._id);
  return t.initialPurse + t.finance.resaleCredits - t.finance.spent;
};

async function teamWithTwo() {
  const f = await H.fixture({ playerSpecs: [{ basePrice: 20 }, { basePrice: 30 }, {}, {}] });
  const a = f.captains[0];
  await H.sell(f.admin, a, f.players[0], 150); // Player A
  await H.sell(f.admin, a, f.players[1], 100); // Player B
  return { f, a };
}

test('spec example: 500 - 150 - 100 = 250, resale of A refunds 150 -> 400', async () => {
  const { f, a } = await teamWithTwo();
  assert.equal(await remaining(a.team), 250);
  const req = await R.requestResale(await H.reload(a.user), f.players[0]._id);
  // Pending: no credit, still owned.
  assert.equal(await remaining(a.team), 250);
  const pending = await M.Player.findById(f.players[0]._id);
  assert.equal(pending.status, 'RESALE_PENDING');
  assert.equal(String(pending.currentTeam), String(a.team._id));
  await R.approveResale(f.admin, req._id);
  assert.equal(await remaining(a.team), 400);
  const p = await M.Player.findById(f.players[0]._id);
  assert.equal(p.status, 'RESALE_APPROVED');
  assert.equal(p.currentTeam, null);
  assert.equal(p.basePrice, 20); // original base price restored
  const t = await M.Team.findById(a.team._id);
  assert.equal(t.squad.length, 1);
  const credit = await M.FinancialTransaction.findOne({ type: 'RESALE_CREDIT' });
  const purchase = await M.FinancialTransaction.findOne({ type: 'PURCHASE_DEBIT', player: f.players[0]._id });
  assert.equal(credit.credit, 150);
  assert.equal(String(credit.originalPurchase), String(purchase._id));
  assert.ok((await ledger.reconcile()).every((r) => r.ok));
  // Original purchase record is still there.
  assert.equal(await M.FinancialTransaction.countDocuments({ type: 'PURCHASE_DEBIT' }), 2);
});

test('only the highest-priced player is eligible', async () => {
  const { f, a } = await teamWithTwo();
  assert.equal(await H.code(R.requestResale(await H.reload(a.user), f.players[1]._id)), 'NOT_HIGHEST_PRICED');
  const s = await teamSummary(a.team._id);
  assert.deepEqual(s.squad.filter((p) => p.resaleEligible).map((p) => p.id), [String(f.players[0]._id)]);
});

test('tied highest-priced players are all selectable', async () => {
  const f = await H.fixture();
  const a = f.captains[0];
  await H.sell(f.admin, a, f.players[0], 80);
  await H.sell(f.admin, a, f.players[1], 80);
  const s = await teamSummary(a.team._id);
  assert.equal(s.squad.filter((p) => p.resaleEligible).length, 2);
  assert.equal(await H.code(R.requestResale(await H.reload(a.user), f.players[1]._id)), 'OK');
});

test('cannot resell another team\'s or an unowned player; one pending request at a time', async () => {
  const { f, a } = await teamWithTwo();
  const b = f.captains[1];
  assert.equal(await H.code(R.requestResale(await H.reload(b.user), f.players[0]._id)), 'FORBIDDEN');
  assert.equal(await H.code(R.requestResale(await H.reload(a.user), f.players[2]._id)), 'FORBIDDEN');
  await R.requestResale(await H.reload(a.user), f.players[0]._id);
  assert.equal(await H.code(R.requestResale(await H.reload(a.user), f.players[0]._id)), 'RESALE_ALREADY_PENDING');
});

test('pending player is not biddable or selectable', async () => {
  const { f, a } = await teamWithTwo();
  await R.requestResale(await H.reload(a.user), f.players[0]._id);
  assert.equal(await H.code(A.selectPlayer(f.admin, f.players[0]._id)), 'PLAYER_NOT_SELECTABLE');
});

test('reject keeps squad and purse; reason recorded', async () => {
  const { f, a } = await teamWithTwo();
  const req = await R.requestResale(await H.reload(a.user), f.players[0]._id);
  assert.equal(await H.code(R.rejectResale(f.admin, req._id, '')), 'REASON_REQUIRED');
  await R.rejectResale(f.admin, req._id, 'Not allowed this late');
  assert.equal(await remaining(a.team), 250);
  assert.equal((await M.Player.findById(f.players[0]._id)).status, 'SOLD');
  assert.equal((await M.ResaleRequest.findById(req._id)).reason, 'Not allowed this late');
});

test('duplicate approval cannot refund twice (sequential and concurrent)', async () => {
  const { f, a } = await teamWithTwo();
  const req = await R.requestResale(await H.reload(a.user), f.players[0]._id);
  const results = await Promise.allSettled([R.approveResale(f.admin, req._id), R.approveResale(f.admin, req._id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await H.code(R.approveResale(f.admin, req._id)), 'NOT_PENDING');
  assert.equal(await M.FinancialTransaction.countDocuments({ type: 'RESALE_CREDIT' }), 1);
  assert.equal(await remaining(a.team), 400);
});

test('resold player returns to the pool, the original team cannot rebuy it, and it cannot be resold again', async () => {
  const { f, a } = await teamWithTwo();
  const b = f.captains[1];
  const req = await R.requestResale(await H.reload(a.user), f.players[0]._id);
  await R.approveResale(f.admin, req._id);
  await H.open(f.admin, f.players[0]);
  assert.equal(await H.code(A.placeBid(await H.reload(a.user), { playerId: f.players[0]._id, amount: 20 })), 'ALREADY_PURCHASED');
  await A.placeBid(await H.reload(b.user), { playerId: f.players[0]._id, amount: 20 });
  await A.markSold(f.admin);
  await H.expireFinalization();
  await A.completeDueFinalization();
  const p = await M.Player.findById(f.players[0]._id);
  assert.equal(p.status, 'RESOLD');
  assert.equal(await H.code(R.requestResale(await H.reload(b.user), p._id)), 'ALREADY_RESOLD');
  assert.ok((await ledger.reconcile()).every((r) => r.ok));
});

test('ledger is append-only', async () => {
  const { a } = await teamWithTwo();
  await assert.rejects(M.FinancialTransaction.updateOne({ team: a.team._id }, { $set: { debit: 0 } }), /append-only/);
  await assert.rejects(M.FinancialTransaction.deleteMany({}), /append-only/);
});

test('resale disabled by config', async () => {
  const { f, a } = await teamWithTwo();
  await M.AuctionConfiguration.updateOne({}, { $set: { resaleEnabled: false } });
  assert.equal(await H.code(R.requestResale(await H.reload(a.user), f.players[0]._id)), 'RESALE_DISABLED');
});
