const mongoose = require('mongoose');
const C = require('../constants');

const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const ts = { timestamps: true };

/* ---------- User ---------- */
const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: Object.values(C.ROLES), required: true },
  team: { type: ObjectId, ref: 'Team', default: null },
  mustChangePassword: { type: Boolean, default: false },
  tempPasswordExpiresAt: { type: Date, default: null },
  resetTokenHash: { type: String, default: null, select: false },
  resetTokenExpiresAt: { type: Date, default: null, select: false },
  tokenVersion: { type: Number, default: 0 }, // bump to revoke all sessions
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
}, ts);
userSchema.index({ role: 1, team: 1 });

const refreshTokenSchema = new Schema({
  user: { type: ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  family: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  replacedBy: { type: String, default: null },
}, ts);
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* ---------- Season & configuration ---------- */
const seasonSchema = new Schema({
  name: { type: String, required: true, trim: true },
  year: { type: Number, required: true },
  sport: { type: String, enum: C.SPORTS, default: 'CRICKET' },
  active: { type: Boolean, default: true },
  config: { type: ObjectId, ref: 'AuctionConfiguration' },
}, ts);
// Only one active season at a time.
seasonSchema.index({ active: 1 }, { unique: true, partialFilterExpression: { active: true } });

const configSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true, unique: true },
  teamCount: { type: Number, required: true, min: 2, max: 32 },
  teamPurse: { type: Number, required: true, min: 1 },
  maxSquadSize: { type: Number, required: true, min: 1, max: 50 },
  defaultBasePrice: { type: Number, required: true, min: 0 },
  // Allowed raises over the current bid (a captain picks one per bid). Old configs without it get [3, 5].
  bidIncrements: { type: [Number], default: () => [3, 5], validate: { validator: (a) => a.length > 0 && a.every((n) => Number.isInteger(n) && n >= 1), message: 'Bid increments must be whole numbers of 1 or more' } },
  finalizationSeconds: { type: Number, required: true, min: 0, max: 30, default: 0 }, // 0 = SOLD completes immediately
  biddingPolicy: { type: String, enum: ['STANDARD_OPEN'], default: 'STANDARD_OPEN' },
  publicBudgetVisible: { type: Boolean, default: true },
  resaleEnabled: { type: Boolean, default: true },
  mysteryEnabled: { type: Boolean, default: true },
  mysteryTokensPerTeam: { type: Number, default: 1, min: 1, max: 1 },
  categories: { type: [String], default: () => [...C.DEFAULT_CATEGORIES] },
  version: { type: Number, default: 1 },
}, ts);

/* ---------- Team ---------- */
const teamSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  abbreviation: { type: String, required: true, trim: true, uppercase: true, maxlength: 6 },
  logo: { type: String, default: null },
  captain: { type: ObjectId, ref: 'User', default: null },
  captainPlayer: { type: ObjectId, ref: 'Player', default: null }, // registered player chosen as captain
  initialPurse: { type: Number, required: true, min: 0 },
  maxSquadSize: { type: Number, required: true, min: 1 },
  squad: [{ type: ObjectId, ref: 'Player' }],
  // Cached summary; reconcilable against FinancialTransaction ledger.
  finance: {
    spent: { type: Number, default: 0, min: 0 },
    resaleCredits: { type: Number, default: 0, min: 0 },
  },
}, ts);
teamSchema.index({ season: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
teamSchema.index({ season: 1, abbreviation: 1 }, { unique: true });
teamSchema.virtual('remainingPurse').get(function () {
  return this.initialPurse + this.finance.resaleCredits - this.finance.spent;
});

/* ---------- Player ---------- */
const playerSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  nameKey: { type: String, required: true }, // normalized name for duplicate detection
  image: { type: String, default: null },
  gender: { type: String, enum: C.GENDERS, required: true },
  category: { type: String, required: true },
  battingStyle: { type: String, default: '' },
  bowlingStyle: { type: String, default: '' },
  skills: { type: [String], default: [] },
  publicSkills: { type: [String], default: [] }, // approved non-identifying skills shown for MYSTERY players
  experience: { type: String, default: '' },
  registrationId: { type: String, default: null, trim: true },
  basePrice: { type: Number, required: true, min: 0 },
  originalBasePrice: { type: Number, required: true, min: 0 },
  playerType: { type: String, enum: Object.values(C.PLAYER_TYPES), default: 'NORMAL' },
  status: { type: String, enum: Object.values(C.PLAYER_STATUS), default: 'AVAILABLE' },
  auctionOrder: { type: Number, default: 0 },
  currentTeam: { type: ObjectId, ref: 'Team', default: null },
  purchasePrice: { type: Number, default: null },
  purchaseTxn: { type: ObjectId, ref: 'FinancialTransaction', default: null },
  previousOwners: [{ type: ObjectId, ref: 'Team' }],
  resaleCount: { type: Number, default: 0 },
  unsoldCount: { type: Number, default: 0 },
  skipCount: { type: Number, default: 0 },
}, ts);
playerSchema.index({ season: 1, status: 1, auctionOrder: 1 });
playerSchema.index({ season: 1, nameKey: 1 });
playerSchema.index({ season: 1, registrationId: 1 }, { unique: true, partialFilterExpression: { registrationId: { $type: 'string' } } });
playerSchema.index({ currentTeam: 1 });

/* ---------- Auction (one per season; no rounds) ---------- */
const auctionSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true, unique: true },
  status: { type: String, enum: Object.values(C.AUCTION_STATUS), default: 'CREATED' },
  activePlayer: { type: ObjectId, ref: 'Player', default: null },
  biddingOpen: { type: Boolean, default: false },
  basePrice: { type: Number, default: null }, // base price of active player at selection time
  currentBid: { type: Number, default: null },
  leadingTeam: { type: ObjectId, ref: 'Team', default: null },
  leadingCaptain: { type: ObjectId, ref: 'User', default: null },
  bidCount: { type: Number, default: 0 }, // bids on the active player
  bidSeq: { type: Number, default: 0 }, // global accepted-bid sequence
  statusBeforePause: { type: String, default: null },
  finalization: {
    key: { type: String, default: null },
    player: { type: ObjectId, ref: 'Player', default: null },
    team: { type: ObjectId, ref: 'Team', default: null },
    captain: { type: ObjectId, ref: 'User', default: null },
    amount: { type: Number, default: null },
    startedAt: { type: Date, default: null },
    deadline: { type: Date, default: null },
  },
  lastResult: {
    outcome: { type: String, enum: ['SOLD', 'UNSOLD', 'SKIPPED', null], default: null },
    player: { type: ObjectId, ref: 'Player', default: null },
    team: { type: ObjectId, ref: 'Team', default: null },
    amount: { type: Number, default: null },
    at: { type: Date, default: null },
  },
  configSnapshot: { type: Schema.Types.Mixed, default: null },
  version: { type: Number, default: 0 }, // optimistic-concurrency state version
  startedAt: Date,
  completedAt: Date,
}, ts);
auctionSchema.index({ status: 1, 'finalization.deadline': 1 });

/* ---------- Bid ---------- */
const bidSchema = new Schema({
  auction: { type: ObjectId, ref: 'Auction', required: true },
  season: { type: ObjectId, ref: 'Season', required: true },
  player: { type: ObjectId, ref: 'Player', required: true },
  team: { type: ObjectId, ref: 'Team', required: true },
  captain: { type: ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 0 },
  seq: { type: Number, required: true },
  idempotencyKey: { type: String, required: true },
  status: { type: String, enum: ['ACCEPTED'], default: 'ACCEPTED' },
}, ts);
bidSchema.index({ auction: 1, seq: 1 }, { unique: true });
bidSchema.index({ captain: 1, idempotencyKey: 1 }, { unique: true });
bidSchema.index({ player: 1, createdAt: -1 });

/* ---------- Auction transactions (sale/unsold/skip/resale history) ---------- */
const auctionTxnSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true },
  type: { type: String, enum: ['SALE', 'UNSOLD', 'SKIPPED', 'RESALE'], required: true },
  player: { type: ObjectId, ref: 'Player', required: true },
  team: { type: ObjectId, ref: 'Team', default: null },
  amount: { type: Number, default: 0 },
  originalPurchaseAmount: { type: Number, default: null },
  bid: { type: ObjectId, ref: 'Bid', default: null },
  resaleRequest: { type: ObjectId, ref: 'ResaleRequest', default: null },
  admin: { type: ObjectId, ref: 'User', default: null },
  idempotencyKey: { type: String, required: true, unique: true },
}, ts);
auctionTxnSchema.index({ season: 1, createdAt: -1 });

/* ---------- Financial ledger (append-only) ---------- */
const finTxnSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true },
  team: { type: ObjectId, ref: 'Team', required: true },
  player: { type: ObjectId, ref: 'Player', default: null },
  type: { type: String, enum: Object.values(C.LEDGER_TYPES), required: true },
  debit: { type: Number, default: 0, min: 0 },
  credit: { type: Number, default: 0, min: 0 },
  originalPurchase: { type: ObjectId, ref: 'FinancialTransaction', default: null },
  resaleRequest: { type: ObjectId, ref: 'ResaleRequest', default: null },
  admin: { type: ObjectId, ref: 'User', default: null },
  idempotencyKey: { type: String, required: true, unique: true },
  description: { type: String, default: '' },
}, ts);
finTxnSchema.index({ team: 1, createdAt: 1 });
const immutable = function () { throw new Error('Financial transactions are append-only'); };
['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'].forEach((op) => finTxnSchema.pre(op, immutable));

/* ---------- Resale ---------- */
const resaleSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true },
  player: { type: ObjectId, ref: 'Player', required: true },
  team: { type: ObjectId, ref: 'Team', required: true },
  captain: { type: ObjectId, ref: 'User', required: true },
  originalPurchaseAmount: { type: Number, required: true },
  originalPurchaseTxn: { type: ObjectId, ref: 'FinancialTransaction', required: true },
  previousPlayerStatus: { type: String, required: true },
  status: { type: String, enum: Object.values(C.RESALE_STATUS), default: 'PENDING' },
  admin: { type: ObjectId, ref: 'User', default: null },
  reason: { type: String, default: '' },
  processedAt: { type: Date, default: null },
}, ts);
// One pending request per team, and per player.
resaleSchema.index({ team: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });
resaleSchema.index({ player: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' } });

/* ---------- Mystery token ---------- */
const mysteryTokenSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', required: true },
  team: { type: ObjectId, ref: 'Team', required: true },
  status: { type: String, enum: ['AVAILABLE', 'USED'], default: 'AVAILABLE' },
  usedAt: { type: Date, default: null },
  revealedPlayer: { type: ObjectId, ref: 'Player', default: null },
  usedBy: { type: ObjectId, ref: 'User', default: null },
  meta: { type: Schema.Types.Mixed, default: null },
}, ts);
mysteryTokenSchema.index({ season: 1, team: 1 }, { unique: true });

/* ---------- Audit log ---------- */
const logSchema = new Schema({
  season: { type: ObjectId, ref: 'Season', default: null },
  type: { type: String, required: true },
  actor: { type: ObjectId, ref: 'User', default: null },
  actorRole: { type: String, default: 'SYSTEM' },
  player: { type: ObjectId, ref: 'Player', default: null },
  team: { type: ObjectId, ref: 'Team', default: null },
  previousState: { type: Schema.Types.Mixed, default: null },
  newState: { type: Schema.Types.Mixed, default: null },
  details: { type: Schema.Types.Mixed, default: null },
}, ts);
logSchema.index({ season: 1, createdAt: -1 });
logSchema.index({ type: 1 });

/* ---------- Transactional outbox ---------- */
const outboxSchema = new Schema({
  type: { type: String, required: true },
  rooms: { type: [String], required: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  aggregate: { type: String, default: 'auction' },
  version: { type: Number, default: null },
  status: { type: String, enum: ['PENDING', 'PUBLISHED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 },
  publishedAt: { type: Date, default: null },
}, ts);
outboxSchema.index({ status: 1, _id: 1 });
outboxSchema.index({ publishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

module.exports = {
  User: model('User', userSchema),
  RefreshToken: model('RefreshToken', refreshTokenSchema),
  Season: model('Season', seasonSchema),
  AuctionConfiguration: model('AuctionConfiguration', configSchema),
  Team: model('Team', teamSchema),
  Player: model('Player', playerSchema),
  Auction: model('Auction', auctionSchema),
  Bid: model('Bid', bidSchema),
  AuctionTransaction: model('AuctionTransaction', auctionTxnSchema),
  FinancialTransaction: model('FinancialTransaction', finTxnSchema),
  ResaleRequest: model('ResaleRequest', resaleSchema),
  MysteryToken: model('MysteryToken', mysteryTokenSchema),
  AuctionLog: model('AuctionLog', logSchema),
  OutboxEvent: model('OutboxEvent', outboxSchema),
};
