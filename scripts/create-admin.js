#!/usr/bin/env node
/**
 * One-time administrator initialization. Refuses to run if any admin already exists.
 *   npm run create-admin -- --name "Jane Admin" --email jane@example.com
 * Password: read from ADMIN_PASSWORD env var, otherwise prompted (input hidden). Never printed.
 */
const readline = require('readline');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const { User } = require('../src/models');
const { hashPassword, checkPasswordPolicy } = require('../src/services/authService');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };

function promptHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

(async () => {
  const name = arg('name'); const email = arg('email');
  if (!name || !email) throw new Error('Usage: npm run create-admin -- --name "Full Name" --email you@example.com');
  await require('../src/config/db').connectDB(env.MONGODB_URI);
  if (await User.exists({ role: 'ADMIN' })) throw new Error('An administrator already exists. This script only initializes the first admin.');
  const password = process.env.ADMIN_PASSWORD || await promptHidden('Admin password (8+ chars, letter + number): ');
  checkPasswordPolicy(password);
  await User.create({ name, email: email.toLowerCase(), role: 'ADMIN', passwordHash: await hashPassword(password) });
  console.log(`Administrator created for ${email}.`);
})().catch((e) => { console.error(`Error: ${e.message}`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
