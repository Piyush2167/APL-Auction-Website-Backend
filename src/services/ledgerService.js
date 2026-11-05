const { FinancialTransaction, Team } = require('../models');
const { getContext } = require('./seasonService');

/** Recompute each team's balance from the ledger and compare with the cached summary on Team. */
async function reconcile() {
  const { season } = await getContext();
  const [teams, sums] = await Promise.all([
    Team.find({ season: season._id }).lean(),
    FinancialTransaction.aggregate([
      { $match: { season: season._id } },
      { $group: {
        _id: '$team',
        credit: { $sum: '$credit' }, debit: { $sum: '$debit' },
        resale: { $sum: { $cond: [{ $eq: ['$type', 'RESALE_CREDIT'] }, '$credit', 0] } },
        initial: { $sum: { $cond: [{ $eq: ['$type', 'INITIAL_ALLOCATION'] }, '$credit', 0] } },
      } },
    ]),
  ]);
  const byTeam = new Map(sums.map((x) => [String(x._id), x]));
  return teams.map((t) => {
    const l = byTeam.get(String(t._id)) || { credit: 0, debit: 0, resale: 0, initial: 0 };
    const cached = t.initialPurse + t.finance.resaleCredits - t.finance.spent;
    const ledgerStarted = l.initial > 0;
    const ledgerBalance = ledgerStarted ? l.credit - l.debit : t.initialPurse;
    return {
      teamId: String(t._id), name: t.name, cachedRemaining: cached, ledgerRemaining: ledgerBalance,
      ledgerSpent: l.debit, ledgerResaleCredits: l.resale,
      ok: cached === ledgerBalance && l.debit === t.finance.spent && l.resale === t.finance.resaleCredits && cached >= 0,
    };
  });
}

async function list({ team, page = 1, limit = 50 } = {}) {
  const { season } = await getContext();
  const q = { season: season._id };
  if (team) q.team = team;
  const [rows, total] = await Promise.all([
    FinancialTransaction.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('team', 'name abbreviation').populate('player', 'name playerType').lean(),
    FinancialTransaction.countDocuments(q),
  ]);
  return { rows, total, page, limit };
}

module.exports = { reconcile, list };
