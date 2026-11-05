const { Router } = require('express');
const { z } = require('zod');
const env = require('../config/env');
const auth = require('../services/authService');
const { Team } = require('../models');
const { authenticate, validate, limits } = require('../middleware');

const r = Router();
const COOKIE = 'apl_rt';
// The frontend proxies /api through its own origin (next.config rewrites), so the cookie is first-party.
const cookieOpts = () => ({ httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/api/auth', maxAge: env.REFRESH_TOKEN_DAYS * 86400e3 });

function sendSession(res, { accessToken, refreshToken, user }) {
  res.cookie(COOKIE, refreshToken, cookieOpts());
  res.json({ success: true, data: { accessToken, user } });
}

r.post('/login', limits.auth, validate(z.object({ email: z.email().max(200), password: z.string().min(1).max(200) })), async (req, res) => {
  sendSession(res, await auth.login(req.body.email, req.body.password));
});

r.post('/refresh', async (req, res) => {
  try {
    sendSession(res, await auth.refresh(req.cookies?.[COOKIE]));
  } catch (e) {
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw e;
  }
});

r.post('/logout', async (req, res) => {
  await auth.logout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json({ success: true, data: null });
});

r.get('/me', authenticate, async (req, res) => {
  const team = req.user.team ? await Team.findById(req.user.team).select('name abbreviation logo').lean() : null;
  res.json({ success: true, data: { user: auth.publicUser(req.user), team: team && { id: String(team._id), name: team.name, abbreviation: team.abbreviation, logo: team.logo } } });
});

r.post('/change-password', authenticate, limits.auth,
  validate(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) })),
  async (req, res) => sendSession(res, await auth.changePassword(req.user._id, req.body.currentPassword, req.body.newPassword)));

r.post('/forgot-password', limits.auth, validate(z.object({ email: z.email().max(200) })), async (req, res) => {
  await auth.forgotPassword(req.body.email);
  res.json({ success: true, data: { message: 'If an account exists, a reset link has been sent.' } });
});

r.post('/reset-password', limits.auth, validate(z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(200) })), async (req, res) => {
  await auth.resetPassword(req.body.token, req.body.password);
  res.json({ success: true, data: { message: 'Password updated. You can now log in.' } });
});

module.exports = r;
