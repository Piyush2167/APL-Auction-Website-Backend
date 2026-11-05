const { z } = require('zod');
const { parse: parseCsv } = require('csv-parse/sync');
const { Player, Bid } = require('../models');
const { withTxn } = require('../config/db');
const { getContext } = require('./seasonService');
const { conflict, notFound, bad } = require('../utils/errors');
const { audit } = require('./audit');
const P = require('./projections');
const C = require('../constants');

const nameKey = (n) => String(n).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const ciMatch = (list) => (v) => list.find((x) => x.toLowerCase() === String(v ?? '').trim().toLowerCase());
const list = z.array(z.string().trim().min(1).max(60)).max(20);
const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[;|]/)).map((s) => String(s).trim()).filter(Boolean);
const emptyToUndef = (v) => (v === '' || v === null ? undefined : v);

function playerSchema(config, { partial = false } = {}) {
  const cat = ciMatch(config.categories);
  const gen = ciMatch(C.GENDERS);
  const shape = {
    name: z.string().trim().min(2, 'name must be at least 2 characters').max(100),
    image: z.preprocess(emptyToUndef, z.url({ protocol: /^https?$/ }).max(500).nullable().optional()),
    gender: z.preprocess((v) => gen(v) ?? v, z.enum(C.GENDERS, { message: `gender must be one of ${C.GENDERS.join(', ')}` })),
    category: z.preprocess((v) => cat(v) ?? v, z.enum(config.categories, { message: `category must be one of ${config.categories.join(', ')}` })),
    battingStyle: z.string().trim().max(60).optional().default(''),
    bowlingStyle: z.string().trim().max(60).optional().default(''),
    skills: z.preprocess(toList, list).default([]),
    publicSkills: z.preprocess(toList, list).default([]),
    experience: z.preprocess((v) => (v == null ? '' : String(v)), z.string().trim().max(200)).default(''),
    registrationId: z.preprocess(emptyToUndef, z.string().trim().max(40).nullable().optional()),
    basePrice: z.preprocess(emptyToUndef, z.coerce.number().int('basePrice must be a whole number').min(0, 'basePrice cannot be negative').max(100000).optional()),
    playerType: z.preprocess((v) => (emptyToUndef(v) === undefined ? 'NORMAL' : String(v).trim().toUpperCase()), z.enum(['NORMAL', 'MYSTERY'], { message: 'playerType must be NORMAL or MYSTERY' })),
    auctionOrder: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).optional()),
  };
  const s = z.object(shape).strict();
  return partial ? s.partial() : s;
}

async function listPlayers({ q, status, category, playerType, page = 1, limit = 50, sort = 'auctionOrder' } = {}) {
  const { season } = await getContext();
  const filter = { season: season._id };
  if (q) filter.nameKey = { $regex: nameKey(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  if (status) filter.status = { $in: String(status).split(',') };
  if (category) filter.category = category;
  if (playerType) filter.playerType = playerType;
  const sortSpec = sort === 'name' ? { nameKey: 1 } : sort === 'price' ? { basePrice: -1 } : { auctionOrder: 1, createdAt: 1 };
  const [rows, total] = await Promise.all([
    Player.find(filter).sort(sortSpec).skip((page - 1) * limit).limit(limit).populate('currentTeam', 'name abbreviation logo').lean(),
    Player.countDocuments(filter),
  ]);
  return { rows: rows.map(P.fullPlayer), total, page, limit };
}

async function getPlayer(id) {
  const { season } = await getContext();
  const p = await Player.findOne({ _id: id, season: season._id }).populate('currentTeam', 'name abbreviation logo').lean();
  if (!p) throw notFound('Player');
  const bids = await Bid.find({ player: p._id }).sort({ seq: -1 }).limit(200).populate('team', 'name abbreviation').lean();
  return { ...P.fullPlayer(p), bids: bids.map((b) => ({ amount: b.amount, seq: b.seq, team: P.teamRef(b.team), at: b.createdAt })) };
}

async function nextOrder(season, s) {
  const last = await Player.findOne({ season }).sort({ auctionOrder: -1 }).select('auctionOrder').session(s);
  return (last?.auctionOrder || 0) + 1;
}

async function createPlayer(admin, input) {
  return withTxn(async (s) => {
    const { season, config } = await getContext(s);
    const data = playerSchema(config).parse(input);
    const key = nameKey(data.name);
    if (await Player.exists({ season: season._id, nameKey: key }).session(s)) throw conflict('DUPLICATE_PLAYER', `A player named "${data.name}" already exists`);
    const base = data.basePrice ?? config.defaultBasePrice;
    const [p] = await Player.create([{
      ...data, season: season._id, nameKey: key, basePrice: base, originalBasePrice: base,
      auctionOrder: data.auctionOrder ?? await nextOrder(season._id, s),
    }], { session: s });
    await audit(s, { season: season._id, type: 'PLAYER_CREATED', actor: admin, player: p._id });
    return P.fullPlayer(p);
  });
}

const AUCTION_FIELDS = ['basePrice', 'playerType'];
const EDITABLE_AUCTION_STATUSES = ['AVAILABLE', 'UNSOLD', 'SKIPPED', 'RESALE_APPROVED'];

async function updatePlayer(admin, id, input) {
  return withTxn(async (s) => {
    const { season, config } = await getContext(s);
    const p = await Player.findOne({ _id: id, season: season._id }).session(s);
    if (!p) throw notFound('Player');
    const data = playerSchema(config, { partial: true }).parse(input);
    const touchesAuction = AUCTION_FIELDS.filter((k) => data[k] !== undefined && data[k] !== p[k]);
    if (touchesAuction.length && !EDITABLE_AUCTION_STATUSES.includes(p.status)) {
      throw conflict('PLAYER_LOCKED', `Cannot change ${touchesAuction.join(', ')} while the player is ${p.status}`);
    }
    if (data.name) {
      const key = nameKey(data.name);
      if (key !== p.nameKey && await Player.exists({ season: season._id, nameKey: key, _id: { $ne: p._id } }).session(s)) {
        throw conflict('DUPLICATE_PLAYER', `A player named "${data.name}" already exists`);
      }
      p.nameKey = key;
    }
    const before = p.toObject();
    Object.assign(p, data);
    if (data.basePrice !== undefined) p.originalBasePrice = data.basePrice; // admin-set base price is the "original" for resale
    await p.save({ session: s });
    await audit(s, { season: season._id, type: 'PLAYER_UPDATED', actor: admin, player: p._id, previousState: before, newState: p.toObject() });
    return P.fullPlayer(p);
  });
}

async function deletePlayer(admin, id) {
  return withTxn(async (s) => {
    const { season } = await getContext(s);
    const p = await Player.findOne({ _id: id, season: season._id }).session(s);
    if (!p) throw notFound('Player');
    const hasHistory = p.status !== 'AVAILABLE' || p.unsoldCount || p.skipCount || p.resaleCount || p.previousOwners.length
      || await Bid.exists({ player: p._id }).session(s);
    if (hasHistory) throw conflict('PLAYER_HAS_HISTORY', 'Only players that have never been auctioned can be deleted');
    await p.deleteOne({ session: s });
    await audit(s, { season: season._id, type: 'PLAYER_DELETED', actor: admin, previousState: p.toObject() });
  });
}

/* ---------------------------------------------------------------- import */

const MAX_ROWS = 2000;

function parseFile(buffer, format) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  if (format === 'csv') {
    try {
      return parseCsv(text, { columns: (h) => h.map((c) => c.trim()), skip_empty_lines: true, trim: true, relax_column_count: false });
    } catch (e) { throw bad('INVALID_FILE', `CSV could not be parsed: ${e.message}`); }
  }
  if (format === 'json') {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw bad('INVALID_FILE', `JSON could not be parsed: ${e.message}`); }
    if (!Array.isArray(data)) throw bad('INVALID_FILE', 'JSON must be an array of player objects');
    if (data.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw bad('INVALID_FILE', 'Every JSON array item must be an object');
    return data;
  }
  throw bad('INVALID_FORMAT', 'Format must be csv or json');
}

/** Validate every row; never silently drop anything. Rows are 1-based (CSV: data row number, header excluded). */
async function analyzeImport(buffer, format) {
  const { season, config } = await getContext();
  const rows = parseFile(buffer, format);
  if (!rows.length) throw bad('EMPTY_FILE', 'The file contains no player records');
  if (rows.length > MAX_ROWS) throw bad('TOO_MANY_ROWS', `At most ${MAX_ROWS} rows per import`);
  const schema = playerSchema(config);
  const existing = await Player.find({ season: season._id }).select('nameKey registrationId').lean();
  const existingKeys = new Set(existing.map((p) => p.nameKey));
  const existingRegs = new Set(existing.map((p) => p.registrationId).filter(Boolean));
  const seenKeys = new Map();
  const seenRegs = new Map();
  const valid = []; const invalid = []; const duplicates = [];
  rows.forEach((raw, i) => {
    const row = i + 1;
    const r = schema.safeParse(raw);
    if (!r.success) {
      invalid.push({ row, raw, errors: r.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`) });
      return;
    }
    const key = nameKey(r.data.name);
    const reg = r.data.registrationId;
    let reason = null;
    if (existingKeys.has(key)) reason = 'A player with this name already exists';
    else if (reg && existingRegs.has(reg)) reason = 'Registration ID already exists';
    else if (seenKeys.has(key)) reason = `Duplicate of row ${seenKeys.get(key)} in this file`;
    else if (reg && seenRegs.has(reg)) reason = `Same registration ID as row ${seenRegs.get(reg)}`;
    if (reason) { duplicates.push({ row, name: r.data.name, reason }); return; }
    seenKeys.set(key, row);
    if (reg) seenRegs.set(reg, row);
    valid.push({ row, data: { ...r.data, basePrice: r.data.basePrice ?? config.defaultBasePrice } });
  });
  return { format, total: rows.length, valid, invalid, duplicates };
}

async function previewImport(buffer, format) {
  const a = await analyzeImport(buffer, format);
  return { ...a, validCount: a.valid.length, invalidCount: a.invalid.length, duplicateCount: a.duplicates.length };
}

/** Re-validates server-side (never trusts the preview) and inserts only new, valid rows. */
async function commitImport(admin, buffer, format) {
  const a = await analyzeImport(buffer, format);
  const inserted = await withTxn(async (s) => {
    const { season } = await getContext(s);
    let order = await nextOrder(season._id, s);
    const docs = a.valid.map(({ data }) => ({
      ...data, season: season._id, nameKey: nameKey(data.name), originalBasePrice: data.basePrice,
      auctionOrder: data.auctionOrder ?? order++,
    }));
    const res = docs.length ? await Player.insertMany(docs, { session: s }) : [];
    await audit(s, { season: season._id, type: 'PLAYERS_IMPORTED', actor: admin, details: { format, total: a.total, imported: res.length, invalid: a.invalid.length, duplicates: a.duplicates.length } });
    return res.length;
  });
  return {
    format, total: a.total, imported: inserted, failed: a.invalid.length + a.duplicates.length,
    invalid: a.invalid, duplicates: a.duplicates,
  };
}

module.exports = { listPlayers, getPlayer, createPlayer, updatePlayer, deletePlayer, previewImport, commitImport, nameKey, playerSchema };
