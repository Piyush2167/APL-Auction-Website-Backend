const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const A = require('../src/services/auctionService');
const S = require('../src/services/snapshotService');
const ledger = require('../src/services/ledgerService');
const outbox = require('../src/services/outbox');
const { M } = H;

before(H.startDB);
after(H.stopDB);
beforeEach(H.resetDB);

const bid = async (cap, player, amount, extra = {}) => A.placeBid(await H.reload(cap.user), { playerId: player._id, amount, ...extra });

describe('auction lifecycle', () => {
  test('start requires confirmed configuration; start issues purse ledger + one token per team', async () => {
    const f = await H.fixture({ start: false });
    assert.equal(await H.code(A.startAuction(f.admin)), 'INVALID_STATE');
    await require('../src/services/seasonService').confirmConfig(f.admin);
    await A.startAuction(f.admin);
    assert.equal((await M.Auction.findOne()).status, 'LIVE');
    assert.equal(await M.MysteryToken.countDocuments(), 3);
    assert.equal(await M.FinancialTransaction.countDocuments({ type: 'INITIAL_ALLOCATION' }), 3);
    assert.equal(await H.code(A.startAuction(f.admin)), 'INVALID_STATE');
  });

  test('pause blocks bids; resume re-allows', async () => {
    const f = await H.fixture();
    await H.open(f.admin, f.players[0]);
    await A.pauseAuction(f.admin);
    assert.equal(await H.code(bid(f.captains[0], f.players[0], 20)), 'AUCTION_PAUSED');
    await A.resumeAuction(f.admin);
    assert.equal(await H.code(bid(f.captains[0], f.players[0], 20)), 'OK');
  });

  test('a player cannot be active twice; bids need open bidding', async () => {
    const f = await H.fixture();
    await A.selectPlayer(f.admin, f.players[0]._id);
    assert.equal(await H.code(A.selectPlayer(f.admin, f.players[1]._id)), 'PLAYER_ACTIVE');
    assert.equal(await H.code(bid(f.captains[0], f.players[0], 20)), 'BIDDING_NOT_OPEN');
    await A.startBidding(f.admin);
    assert.equal(await H.code(bid(f.captains[0], f.players[1], 20)), 'STALE_PLAYER');
  });
});

describe('bidding rules', () => {
  test('first bid at base price, then a raise of exactly 3 or 5', async () => {
    const f = await H.fixture({ config: { bidIncrements: [3, 5] } });
    const [a, b] = f.captains;
    await H.open(f.admin, f.players[0]);
    assert.equal(await H.code(bid(a, f.players[0], 10)), 'INVALID_AMOUNT');
    assert.equal(await H.code(bid(a, f.players[0], 23)), 'INVALID_AMOUNT'); // the first bid is the base price
    await bid(a, f.players[0], 20);
    assert.equal(await H.code(bid(a, f.players[0], 23)), 'ALREADY_LEADING');
    await bid(b, f.players[0], 25); // +5
    assert.equal(await H.code(bid(a, f.players[0], 27)), 'INVALID_AMOUNT'); // +2
    assert.equal(await H.code(bid(a, f.players[0], 35)), 'INVALID_AMOUNT'); // +10: no jump bids
    assert.equal(await H.code(bid(a, f.players[0], 25)), 'STALE_BID');
    await bid(a, f.players[0], 28); // +3
    const snap = await S.auctionSnapshot('public');
    assert.deepEqual(snap.validBids, [31, 33]);
    assert.equal(snap.nextValidBid, 31);
    const au = await M.Auction.findOne();
    assert.equal(au.currentBid, 28);
    assert.equal(String(au.leadingTeam), String(a.team._id));
    assert.equal(await M.Bid.countDocuments(), 3);
  });

  test('insufficient purse and full squad are rejected', async () => {
    const f = await H.fixture({ config: { teamPurse: 100, maxSquadSize: 1 }, playerSpecs: [{ basePrice: 110 }, {}, {}] });
    const [a, b] = f.captains;
    await H.open(f.admin, f.players[0]);
    assert.equal(await H.code(bid(a, f.players[0], 110)), 'INSUFFICIENT_PURSE');
    await A.markUnsold(f.admin);
    await H.sell(f.admin, a, f.players[1], 20);
    await H.open(f.admin, f.players[2]);
    assert.equal(await H.code(bid(a, f.players[2], 20)), 'SQUAD_FULL');
    assert.equal(await H.code(bid(b, f.players[2], 20)), 'OK');
  });

  test('idempotency key returns the same bid instead of a second one', async () => {
    const f = await H.fixture();
    await H.open(f.admin, f.players[0]);
    const r1 = await bid(f.captains[0], f.players[0], 20, { idempotencyKey: 'key-12345678' });
    const r2 = await bid(f.captains[0], f.players[0], 20, { idempotencyKey: 'key-12345678' });
    assert.equal(r2.duplicate, true);
    assert.equal(String(r1.bid._id), String(r2.bid._id));
    assert.equal(await M.Bid.countDocuments(), 1);
  });

  test('concurrent equal bids: exactly one accepted, the other rejected with latest state', async () => {
    const f = await H.fixture({ teams: 4 });
    await H.open(f.admin, f.players[0]);
    await bid(f.captains[3], f.players[0], 20);
    const results = await Promise.allSettled(f.captains.slice(0, 3).map((c) => bid(c, f.players[0], 30)));
    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 2);
    for (const r of rejected) {
      assert.ok(['STALE_BID', 'STALE_STATE', 'ALREADY_LEADING'].includes(r.reason.code), r.reason.code);
      assert.equal(r.reason.details.state.currentBid, 30);
    }
    const au = await M.Auction.findOne();
    assert.equal(au.currentBid, 30);
    assert.equal(await M.Bid.countDocuments({ amount: 30 }), 1);
  });

  test('a burst of concurrent increasing bids never produces two bids with one sequence or a lower winner', async () => {
    const f = await H.fixture({ teams: 6, config: { teamPurse: 10000 } });
    await H.open(f.admin, f.players[0]);
    await Promise.allSettled(f.captains.flatMap((c, i) => [bid(c, f.players[0], 20 + i * 10), bid(c, f.players[0], 80 + i * 10)]));
    const bids = await M.Bid.find().sort({ seq: 1 });
    const au = await M.Auction.findOne();
    for (let i = 1; i < bids.length; i++) assert.ok(bids[i].amount > bids[i - 1].amount, 'strictly increasing');
    assert.equal(au.currentBid, bids.at(-1).amount);
    assert.equal(String(au.leadingTeam), String(bids.at(-1).team));
  });
});

describe('SOLD finalization', () => {
  test('SOLD locks immediately; bids during FINALIZING rejected; completes once with correct debit', async () => {
    const f = await H.fixture();
    const [a, b] = f.captains;
    await H.open(f.admin, f.players[0]);
    await bid(a, f.players[0], 20);
    await bid(b, f.players[0], 30);
    await A.markSold(f.admin);
    const au = await M.Auction.findOne();
    assert.equal(au.status, 'FINALIZING');
    assert.equal(au.biddingOpen, false);
    assert.equal(au.finalization.amount, 30);
    assert.equal(String(au.finalization.team), String(b.team._id));
    assert.equal(await H.code(bid(a, f.players[0], 40)), 'BIDDING_LOCKED');
    assert.equal(await H.code(A.markSold(f.admin)), 'ALREADY_FINALIZING');
    assert.equal(await H.code(A.markUnsold(f.admin)), 'BIDDING_LOCKED');
    // Before deadline nothing completes.
    assert.equal(await A.completeDueFinalization(), null);
    await H.expireFinalization();
    await Promise.all([A.completeDueFinalization(), A.completeDueFinalization(), A.completeDueFinalization()]);
    const p = await M.Player.findById(f.players[0]._id);
    const team = await M.Team.findById(b.team._id);
    assert.equal(p.status, 'SOLD');
    assert.equal(p.purchasePrice, 30);
    assert.equal(String(p.currentTeam), String(b.team._id));
    assert.equal(team.finance.spent, 30);
    assert.equal(team.squad.length, 1);
    assert.equal(await M.FinancialTransaction.countDocuments({ type: 'PURCHASE_DEBIT' }), 1);
    assert.equal(await M.AuctionTransaction.countDocuments({ type: 'SALE' }), 1);
    const after = await M.Auction.findOne();
    assert.equal(after.status, 'LIVE');
    assert.equal(after.activePlayer, null);
    assert.equal(after.lastResult.outcome, 'SOLD');
    assert.ok((await ledger.reconcile()).every((r) => r.ok));
  });

  test('SOLD without a bid is refused', async () => {
    const f = await H.fixture();
    await H.open(f.admin, f.players[0]);
    assert.equal(await H.code(A.markSold(f.admin)), 'NO_VALID_BID');
  });

  test('concurrent SOLD and bid: winner is whoever the lock captured, never both', async () => {
    const f = await H.fixture();
    const [a, b] = f.captains;
    await H.open(f.admin, f.players[0]);
    await bid(a, f.players[0], 20);
    const [sold, late] = await Promise.allSettled([A.markSold(f.admin), bid(b, f.players[0], 30)]);
    assert.equal(sold.status, 'fulfilled');
    const au = await M.Auction.findOne();
    if (late.status === 'fulfilled') assert.equal(au.finalization.amount, 30);
    else assert.equal(au.finalization.amount, 20);
    await H.expireFinalization();
    await A.completeDueFinalization();
    const p = await M.Player.findById(f.players[0]._id);
    assert.equal(p.purchasePrice, au.finalization.amount);
  });

  test('recovery after restart: a persisted finalization completes exactly once', async () => {
    const f = await H.fixture();
    await H.open(f.admin, f.players[0]);
    await bid(f.captains[0], f.players[0], 20);
    await A.markSold(f.admin);
    // "Restart": the in-memory timer is gone; only DB state remains. The recovery worker drives completion.
    await H.expireFinalization();
    const recovery = require('../src/workers/recovery');
    await recovery.tick();
    await recovery.tick();
    assert.equal((await M.Player.findById(f.players[0]._id)).status, 'SOLD');
    assert.equal(await M.FinancialTransaction.countDocuments({ type: 'PURCHASE_DEBIT' }), 1);
    assert.equal((await M.Team.findById(f.captains[0].team._id)).finance.spent, 20);
  });

  test('the timer completes the sale after the configured delay', async () => {
    const f = await H.fixture();
    await H.open(f.admin, f.players[0]);
    await bid(f.captains[0], f.players[0], 20);
    await A.markSold(f.admin);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await M.Player.findById(f.players[0]._id)).status, 'SOLD');
  });
});

describe('UNSOLD, SKIPPED and re-auction', () => {
  test('UNSOLD and SKIP never move money; SKIP refused once bids exist', async () => {
    const f = await H.fixture();
    await H.open(f.admin, f.players[0]);
    await bid(f.captains[0], f.players[0], 20);
    assert.equal(await H.code(A.markSkipped(f.admin)), 'BIDS_EXIST');
    await A.markUnsold(f.admin);
    await A.selectPlayer(f.admin, f.players[1]._id);
    await A.markSkipped(f.admin);
    assert.equal((await M.Player.findById(f.players[0]._id)).status, 'UNSOLD');
    assert.equal((await M.Player.findById(f.players[1]._id)).status, 'SKIPPED');
    assert.equal(await M.FinancialTransaction.countDocuments({ type: { $ne: 'INITIAL_ALLOCATION' } }), 0);
    assert.equal((await M.Team.findById(f.captains[0].team._id)).finance.spent, 0);
  });

  test('pending players return only after the registered list is done; can be sold on re-auction', async () => {
    const f = await H.fixture({ players: 3 });
    await A.selectPlayer(f.admin, f.players[0]._id);
    await A.markUnsold(f.admin);
    await A.selectPlayer(f.admin, f.players[1]._id);
    await A.markSkipped(f.admin);
    assert.equal(await H.code(A.selectPlayer(f.admin, f.players[0]._id)), 'POOL_NOT_EXHAUSTED');
    await A.selectNextPlayer(f.admin); // players[2]
    await A.markUnsold(f.admin);
    assert.equal(await H.code(A.selectNextPlayer(f.admin)), 'POOL_EMPTY');
    const pending = await A.pendingPlayers();
    assert.equal(pending.unsold.length, 2);
    assert.equal(pending.skipped.length, 1);
    assert.equal(pending.pendingSelectable, true);
    await H.sell(f.admin, f.captains[0], f.players[1], 20);
    assert.equal((await M.Player.findById(f.players[1]._id)).status, 'SOLD');
    assert.equal(await H.code(A.selectPlayer(f.admin, f.players[1]._id)), 'PLAYER_NOT_SELECTABLE');
    // Unsold again keeps history.
    await A.selectPlayer(f.admin, f.players[0]._id);
    await A.markUnsold(f.admin);
    assert.equal((await M.Player.findById(f.players[0]._id)).unsoldCount, 2);
  });

  test('complete auction requires no active player', async () => {
    const f = await H.fixture();
    await A.selectPlayer(f.admin, f.players[0]._id);
    assert.equal(await H.code(A.completeAuction(f.admin)), 'PLAYER_ACTIVE');
    await A.markSkipped(f.admin);
    await A.completeAuction(f.admin);
    assert.equal((await M.Auction.findOne()).status, 'COMPLETED');
  });
});

describe('outbox', () => {
  test('events committed but not broadcast are published on recovery', async () => {
    const f = await H.fixture();
    await A.selectPlayer(f.admin, f.players[0]._id); // no io attached: events remain PENDING (simulated crash)
    assert.ok(await M.OutboxEvent.countDocuments({ status: 'PENDING' }) > 0);
    const emitted = [];
    const room = { emit: (type, payload) => emitted.push({ type, payload }), except: () => room };
    outbox.setIO({ to: () => room });
    await outbox.flush();
    outbox.setIO(null);
    assert.equal(await M.OutboxEvent.countDocuments({ status: 'PENDING' }), 0);
    assert.ok(emitted.some((e) => e.type === 'player:current'));
    const state = emitted.find((e) => e.type === 'auction:state');
    assert.equal(state.payload.player.id, String(f.players[0]._id));
  });
});

describe('SOLD with zero delay', () => {
  test('finalizationSeconds 0: SOLD completes in the same call, exactly once', async () => {
    const f = await H.fixture({ config: { finalizationSeconds: 0 } });
    await H.open(f.admin, f.players[0]);
    await bid(f.captains[0], f.players[0], 20);
    const after = await A.markSold(f.admin);
    assert.equal(after.status, 'LIVE');
    assert.equal(after.lastResult.outcome, 'SOLD');
    assert.equal((await M.Player.findById(f.players[0]._id)).status, 'SOLD');
    assert.equal(await M.FinancialTransaction.countDocuments({ type: 'PURCHASE_DEBIT' }), 1);
    assert.equal(await H.code(A.markSold(f.admin)), 'NO_ACTIVE_PLAYER');
    await A.completeDueFinalization();
    assert.equal(await M.FinancialTransaction.countDocuments({ type: 'PURCHASE_DEBIT' }), 1);
  });
});

describe('reset auction', () => {
  test('wipes progress, keeps teams/players/captains, and the auction can be confirmed and started again', async () => {
    const f = await H.fixture();
    await H.sell(f.admin, f.captains[0], f.players[0], 60);
    await A.selectPlayer(f.admin, f.players[1]._id);
    await A.markUnsold(f.admin);
    assert.equal(await H.code(A.resetAuction(f.admin, { confirmName: 'wrong' })), 'CONFIRMATION_MISMATCH');
    const r = await A.resetAuction(f.admin, { confirmName: 'APL Season 8' });
    assert.equal(r.removed.bids, 1);
    assert.ok(r.removed.ledgerEntries >= 4);
    const au = await M.Auction.findOne();
    assert.equal(au.status, 'CREATED');
    assert.equal(au.activePlayer, null);
    assert.equal(await M.Bid.countDocuments(), 0);
    assert.equal(await M.FinancialTransaction.countDocuments(), 0);
    assert.equal(await M.MysteryToken.countDocuments(), 0);
    assert.equal(await M.Player.countDocuments({ status: { $ne: 'AVAILABLE' } }), 0);
    const team = await M.Team.findById(f.captains[0].team._id);
    assert.deepEqual([team.squad.length, team.finance.spent], [0, 0]);
    assert.equal(await M.Team.countDocuments(), 3);
    assert.equal(await M.User.countDocuments({ role: 'CAPTAIN', active: true }), 3);
    assert.equal(await M.AuctionLog.countDocuments({ type: 'AUCTION_RESET' }), 1);
    await require('../src/services/seasonService').confirmConfig(f.admin);
    await A.startAuction(f.admin);
    await H.sell(f.admin, f.captains[1], f.players[0], 20);
    assert.equal((await M.Player.findById(f.players[0]._id)).status, 'SOLD');
  });
});
