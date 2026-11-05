const freeze = (arr) => Object.freeze(Object.fromEntries(arr.map((k) => [k, k])));

module.exports = {
  ROLES: freeze(['ADMIN', 'CAPTAIN']),
  AUCTION_STATUS: freeze(['CREATED', 'READY', 'LIVE', 'PAUSED', 'FINALIZING', 'COMPLETED', 'CANCELLED']),
  PLAYER_STATUS: freeze(['AVAILABLE', 'ACTIVE', 'FINALIZING', 'SOLD', 'UNSOLD', 'SKIPPED', 'RESALE_PENDING', 'RESALE_APPROVED', 'RESOLD']),
  PLAYER_TYPES: freeze(['NORMAL', 'MYSTERY']),
  DEFAULT_CATEGORIES: ['Batsman', 'Bowler', 'All-rounder', 'Wicketkeeper', 'Fielder'],
  SPORTS: ['CRICKET', 'FOOTBALL'],
  SPORT_CATEGORIES: {
    CRICKET: ['Batsman', 'Bowler', 'All-rounder', 'Wicketkeeper', 'Fielder'],
    FOOTBALL: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'],
  },
  GENDERS: ['Male', 'Female', 'Other'],
  RESALE_STATUS: freeze(['PENDING', 'APPROVED', 'REJECTED']),
  LEDGER_TYPES: freeze(['INITIAL_ALLOCATION', 'PURCHASE_DEBIT', 'RESALE_CREDIT']),
  // Statuses in which a player is owned by a team.
  OWNED_STATUSES: ['SOLD', 'RESOLD', 'RESALE_PENDING'],
  // Statuses selectable from the main pool.
  POOL_STATUSES: ['AVAILABLE', 'RESALE_APPROVED'],
  PENDING_STATUSES: ['UNSOLD', 'SKIPPED'],
};
