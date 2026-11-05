#!/usr/bin/env node
/**
 * Attach photos from a folder to players by name.
 * Resizes each photo to a 512px WebP in frontend/public/players/ and sets player.image = /players/<file>.webp.
 *   node scripts/player-photos.js "../../season 2"            (dry run: shows matches, writes nothing)
 *   node scripts/player-photos.js "../../season 2" --apply
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const { Player } = require('../src/models');
const { nameKey } = require('../src/services/playerService');
const { getContext } = require('../src/services/seasonService');
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '../../frontend')] }));

// photo file name (without extension, lowercase) → player name exactly as in the player list.
// Covers both the "season 2" and "Images" folders. Ambiguous photos are left out on purpose
// (Ahmed, Awwab, Awab sir, Ayyan, awais, maaz, Abdul Maaz, Abdullah, Ebadat Pathan, season-2 Zaid).
const MAP = {
  'aamir': 'Aamir sable', 'abdul rehman': 'Abdul Rehman', 'abhijeet': 'Abhijeet sawant', 'affan': 'Affan khan', 'affan khan': 'Affan khan',
  'amanat': 'Amanat rasool', 'aqiub hingwala': 'Aquib hingwala', 'asif': 'Sayyed asif', 'ayaan raje': 'Ayaan raje',
  'chinmay mj': 'Chinmay gawade', 'danish khan': 'Danish', 'faraz': 'Faraz khan',
  'farhan': 'Farhan tolkar', 'farhan tolkar': 'Farhan tolkar', 'ibadat': 'ibadat khan', 'iffat': 'Iqfat shaikh', 'ikrama': 'Ghavte ikrama',
  'irfan': 'Irfan', 'irfan shaikh': 'Irfan', 'jagda': 'Mohd jagda', 'junaid': 'Junaid khan', 'karan': 'Karan',
  'kazim': 'Kazim', 'kazim salmani': 'Kazim',
  'mirza ubaid': 'Mirza ubaid', 'mohd ali': 'mohd ali', 'mudassir': 'Mudassair', 'mudassir markania': 'Mudassair', 'nafisa': 'Nafisa',
  'najeeb': 'Najeeb sayeed', 'noor': 'Noor khan', 'nouman khan': 'Nouman khan', 'obaid shaikh': 'Ubaid shaikh',
  'piyush pandey': 'Piyush pandey', 'piyush patwa': 'Piyush patwa', 'prashant': 'Prashant patil',
  'pravin': 'Pravin chettiar', 'pravin chettiar': 'Pravin chettiar', 'raj': 'Raj sharma',
  'saad': 'Saad ranasaria', 'sahil': 'Sahil Ansari', 'sahil ansari': 'Sahil Ansari', 'sajiya': 'Sajiya', 'sami': 'Sami shaikh',
  'sanad naqvi': 'Sanad naqvi', 'sanskar': 'Sanskar ashan', 'sanskar ashan': 'Sanskar ashan', 'shams sir': 'Shams ali shaikh',
  'sufiyan khan': 'Sufiyan khan', 'taha': 'Taha choudhary', 'taha chaudhary': 'Taha choudhary', 'tamanna': 'Tamanna ansari',
  'tasmiya': 'tasmiya shaikh', 'uzer': 'Uzer sayyed', 'uzer sayyed': 'Uzer sayyed', 'vinayak': 'Vinayak gupta', 'vinayak gupta': 'Vinayak gupta',
  'viraj': 'Viraj adsul', 'zaid achhwa': 'Zaid achwa', 'zaid khan': 'Zaid khan',
};

(async () => {
  const dir = path.resolve(process.argv[2] || '');
  const apply = process.argv.includes('--apply');
  const outDir = path.join(__dirname, '../../frontend/public/players');
  await require('../src/config/db').connectDB(env.MONGODB_URI);
  const { season } = await getContext();
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const unmapped = []; const notInDb = []; let done = 0;
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const name = MAP[path.parse(f).name.trim().toLowerCase()];
    if (!name) { unmapped.push(f); continue; }
    const player = await Player.findOne({ season: season._id, nameKey: nameKey(name) });
    if (!player) { notInDb.push(`${f} → ${name}`); continue; }
    const out = `${nameKey(name).replace(/[^a-z0-9]+/g, '-')}.webp`;
    console.log(`${apply ? 'SET ' : 'would set'} ${name.padEnd(28)} ← ${f}`);
    if (!apply) continue;
    await sharp(path.join(dir, f)).rotate().resize(512, 512, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toFile(path.join(outDir, out));
    await Player.updateOne({ _id: player._id }, { $set: { image: `/players/${out}` } });
    done += 1;
  }
  console.log(`\n${apply ? 'Updated' : 'Matched'}: ${apply ? done : files.length - unmapped.length - notInDb.length}`);
  if (notInDb.length) console.log(`Player not found in database:\n  ${notInDb.join('\n  ')}`);
  if (unmapped.length) console.log(`No player assigned (skipped):\n  ${unmapped.join('\n  ')}`);
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => mongoose.disconnect());
