const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User, RefreshToken } = require('../models');
const { unauthorized, bad, forbidden } = require('../utils/errors');
const { audit } = require('./audit');
const email = require('./emailService');

const ROUNDS = env.isTest ? 4 : 12;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPassword = (p) => bcrypt.hash(p, ROUNDS);
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-password', ROUNDS);

function checkPasswordPolicy(p) {
  if (typeof p !== 'string' || p.length < 8 || p.length > 128 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) {
    throw bad('WEAK_PASSWORD', 'Password must be 8–128 characters with at least one letter and one number');
  }
}

/* ---------- tokens ---------- */
function signAccess(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, team: user.team ? String(user.team) : null, tv: user.tokenVersion },
    env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL, issuer: 'apl-auction' },
  );
}

function verifyAccess(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'apl-auction' });
}

async function issueRefresh(userId, family = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    user: userId, tokenHash: sha256(token), family,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400e3),
  });
  return token;
}

async function sessionFor(user, family) {
  return { accessToken: signAccess(user), refreshToken: await issueRefresh(user._id, family), user: publicUser(user) };
}

function publicUser(u) {
  return { id: String(u._id), name: u.name, email: u.email, role: u.role, team: u.team ? String(u.team._id || u.team) : null, mustChangePassword: u.mustChangePassword };
}

/** Rotate refresh token. Reuse of an already-rotated token revokes the whole family (theft detection). */
async function refresh(token) {
  if (!token) throw unauthorized('NO_REFRESH', 'No session');
  const rec = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (!rec || rec.expiresAt < new Date()) throw unauthorized('SESSION_EXPIRED', 'Session expired');
  if (rec.revokedAt) {
    await RefreshToken.updateMany({ family: rec.family, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw unauthorized('SESSION_REVOKED', 'Session revoked');
  }
  const user = await User.findById(rec.user);
  if (!user || !user.active) throw unauthorized('SESSION_REVOKED', 'Account inactive');
  // Atomic claim so two parallel refreshes cannot both succeed.
  const claimed = await RefreshToken.findOneAndUpdate({ _id: rec._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!claimed) throw unauthorized('SESSION_REVOKED', 'Session revoked');
  return sessionFor(user, rec.family);
}

async function revokeAllSessions(userId) {
  await Promise.all([
    User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }),
    RefreshToken.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } }),
  ]);
}

/* ---------- flows ---------- */
async function login(emailAddr, password) {
  const user = await User.findOne({ email: String(emailAddr).toLowerCase().trim() }).select('+passwordHash');
  // Compare against a dummy hash when the user is missing to keep timing uniform.
  const ok = await bcrypt.compare(String(password), user?.passwordHash || DUMMY_HASH);
  if (!user || !ok) throw unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
  if (!user.active) throw forbidden('This account has been deactivated');
  if (user.mustChangePassword && user.tempPasswordExpiresAt && user.tempPasswordExpiresAt < new Date()) {
    throw unauthorized('TEMP_PASSWORD_EXPIRED', 'Your temporary password has expired. Ask the administrator for a new one.');
  }
  user.lastLoginAt = new Date();
  await user.save();
  await audit(null, { type: 'LOGIN', actor: user });
  return sessionFor(user);
}

async function logout(token) {
  if (token) await RefreshToken.updateOne({ tokenHash: sha256(token) }, { $set: { revokedAt: new Date() } });
}

async function changePassword(userId, currentPassword, newPassword) {
  checkPasswordPolicy(newPassword);
  const user = await User.findById(userId).select('+passwordHash');
  if (!(await bcrypt.compare(String(currentPassword), user.passwordHash))) throw bad('INVALID_CREDENTIALS', 'Current password is incorrect');
  if (await bcrypt.compare(newPassword, user.passwordHash)) throw bad('SAME_PASSWORD', 'Choose a different password');
  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  user.tempPasswordExpiresAt = null; // temp credential invalidated
  user.tokenVersion += 1; // all other sessions revoked
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(null, { type: 'PASSWORD_CHANGED', actor: user });
  return sessionFor(user);
}

/** Generates and stores a temporary password. Returns the plaintext ONLY for emailing; never log or return it. */
async function setTemporaryPassword(user) {
  const temp = crypto.randomBytes(9).toString('base64url') + '7a';
  user.passwordHash = await hashPassword(temp);
  user.mustChangePassword = true;
  user.tempPasswordExpiresAt = new Date(Date.now() + env.TEMP_PASSWORD_HOURS * 3600e3);
  user.tokenVersion += 1;
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  return temp;
}

async function forgotPassword(emailAddr) {
  const user = await User.findOne({ email: String(emailAddr).toLowerCase().trim(), active: true });
  if (!user) return; // no account enumeration
  const token = crypto.randomBytes(32).toString('base64url');
  await User.updateOne({ _id: user._id }, { $set: { resetTokenHash: sha256(token), resetTokenExpiresAt: new Date(Date.now() + 30 * 60e3) } });
  await email.passwordReset({ to: user.email, name: user.name, token });
}

async function resetPassword(token, newPassword) {
  checkPasswordPolicy(newPassword);
  const user = await User.findOne({ resetTokenHash: sha256(String(token)), resetTokenExpiresAt: { $gt: new Date() }, active: true });
  if (!user) throw bad('INVALID_TOKEN', 'Reset link is invalid or expired');
  await User.updateOne({ _id: user._id }, {
    $set: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, tempPasswordExpiresAt: null, resetTokenHash: null, resetTokenExpiresAt: null },
    $inc: { tokenVersion: 1 },
  });
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(null, { type: 'PASSWORD_RESET', actor: user });
}

module.exports = {
  login, logout, refresh, changePassword, forgotPassword, resetPassword, setTemporaryPassword,
  revokeAllSessions, verifyAccess, signAccess, hashPassword, checkPasswordPolicy, publicUser,
};
