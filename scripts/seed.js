#!/usr/bin/env node
/**
 * DEVELOPMENT ONLY sample data: season with provisional config, 8 teams + captains, 48 players (6 mystery).
 *   SEED_CAPTAIN_PASSWORD=<pw> npm run seed            (refuses in production, refuses if a season exists)
 *   SEED_CAPTAIN_PASSWORD=<pw> npm run seed -- --reset  (drops ALL auction data first; dev DB only)
 * Captains log in as captain1@apl.local … captain8@apl.local with SEED_CAPTAIN_PASSWORD (no forced change).
 */
const mongoose = require('mongoose');
const env = require('../src/config/env');
const M = require('../src/models');
const { createSeason } = require('../src/services/seasonService');
const { hashPassword, checkPasswordPolicy } = require('../src/services/authService');
const { nameKey } = require('../src/services/playerService');

const TEAMS = [
  ['Mumbai Tigers', 'MT'], ['Royal Strikers', 'RS'], ['Super Kings', 'SK'], ['Warriors', 'WAR'],
  ['Thunder Bolts', 'TB'], ['Desert Hawks', 'DH'], ['Coastal Riders', 'CR'], ['Mountain Lions', 'ML'],
];
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Kabir', 'Dhruv', 'Ananya', 'Diya', 'Meera', 'Riya'];
const LAST = ['Sharma', 'Patil', 'Kumar', 'Iyer', 'Reddy', 'Nair', 'Singh', 'Joshi', 'Desai', 'Mehta', 'Kulkarni', 'Rao'];
const CATS = ['Batsman', 'Bowler', 'All-rounder', 'Wicketkeeper', 'Fielder'];
const SKILLS = { Batsman: ['Power hitter', 'Anchor'], Bowler: ['Swing', 'Yorkers'], 'All-rounder': ['Finisher', 'Medium pace'], Wicketkeeper: ['Quick stumpings', 'Top order'], Fielder: ['Safe hands', 'Strong arm'] };

(async () => {
  if (env.isProd) throw new Error('Refusing to seed in production.');
  const pw = process.env.SEED_CAPTAIN_PASSWORD;
  if (!pw) throw new Error('Set SEED_CAPTAIN_PASSWORD (8+ chars, letter + number).');
  checkPasswordPolicy(pw);
  await require('../src/config/db').connectDB(env.MONGODB_URI);
  if (process.argv.includes('--reset')) {
    for (const m of ['Season', 'AuctionConfiguration', 'Team', 'Player', 'Auction', 'Bid', 'AuctionTransaction', 'ResaleRequest', 'MysteryToken', 'AuctionLog', 'OutboxEvent']) await M[m].deleteMany({});
    await mongoose.connection.collection('financialtransactions').deleteMany({}); // bypass append-only hooks for dev reset
    await M.User.deleteMany({ role: 'CAPTAIN' });
    console.log('Dev data reset (admins kept).');
  }
  if (await M.Season.exists({ active: true })) throw new Error('An active season exists. Use --reset on a dev database.');
  await Promise.all(Object.values(M).map((m) => m.syncIndexes()));

  const { season, config } = await createSeason(null, { name: 'APL Season 8', year: new Date().getFullYear() });
  const hash = await hashPassword(pw);
  for (const [i, [name, abbreviation]] of TEAMS.entries()) {
    const team = await M.Team.create({ season: season._id, name, abbreviation, initialPurse: config.teamPurse, maxSquadSize: config.maxSquadSize });
    const cap = await M.User.create({ name: `Captain ${name}`, email: `captain${i + 1}@apl.local`, role: 'CAPTAIN', team: team._id, passwordHash: hash });
    team.captain = cap._id;
    await team.save();
  }
  const players = Array.from({ length: 48 }, (_, i) => {
    const category = CATS[i % CATS.length];
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]} ${i + 1}`;
    const mystery = i % 8 === 5;
    const base = [20, 20, 30, 40][i % 4];
    return {
      season: season._id, name, nameKey: nameKey(name), gender: i % 6 === 0 ? 'Female' : 'Male', category,
      battingStyle: i % 3 ? 'Right-hand bat' : 'Left-hand bat', bowlingStyle: i % 2 ? 'Right-arm medium' : 'Left-arm spin',
      skills: SKILLS[category], publicSkills: mystery ? [SKILLS[category][0]] : [], experience: `${(i % 9) + 1} seasons`,
      basePrice: base, originalBasePrice: base, playerType: mystery ? 'MYSTERY' : 'NORMAL', auctionOrder: i + 1,
    };
  });
  await M.Player.insertMany(players);
  console.log(`Seeded: ${TEAMS.length} teams/captains (captain1..8@apl.local), ${players.length} players. Config is provisional: confirm it in Admin > Settings.`);
})().catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
