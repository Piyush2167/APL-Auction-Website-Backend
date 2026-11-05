/**
 * Email delivery. SMTP when EMAIL_HOST is set. Without SMTP:
 *  - test: messages are kept in memory (`sent`) for assertions
 *  - development: messages are written to backend/.mail/*.html (gitignored) — never to logs
 *  - production: sending fails, and the caller reports emailSent=false
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../config/logger');

const sent = [];
const transport = env.EMAIL_HOST
  ? nodemailer.createTransport({
    host: env.EMAIL_HOST, port: env.EMAIL_PORT || 587, secure: env.EMAIL_PORT === 465,
    auth: env.EMAIL_USER ? { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD } : undefined,
  })
  : null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(title, body) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
  <div style="background:#0f172a;color:#fbbf24;padding:20px 24px;font-size:20px;font-weight:bold">APL Auction · Season 8</div>
  <div style="padding:24px;color:#111827;line-height:1.5"><h2 style="margin-top:0">${esc(title)}</h2>${body}</div>
  <div style="background:#f3f4f6;padding:12px 24px;font-size:12px;color:#6b7280">This is an automated message from APL Auction. Do not share your credentials.</div></div>`;
}

async function send({ to, subject, html }) {
  const msg = { from: env.EMAIL_FROM, to, subject, html };
  if (transport) { await transport.sendMail(msg); return; }
  if (env.isTest) { sent.push(msg); return; }
  if (env.isProd) throw new Error('Email is not configured (EMAIL_HOST missing)');
  const dir = path.join(__dirname, '../../.mail');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${to.replace(/[^a-z0-9]/gi, '_')}.html`);
  fs.writeFileSync(file, `<p>To: ${esc(to)}<br>Subject: ${esc(subject)}</p>${html}`);
  logger.info({ to, file: path.basename(file) }, 'dev email written to backend/.mail');
}

function captainInvite({ to, captainName, teamName, tempPassword, expiresAt }) {
  const loginUrl = `${env.FRONTEND_URL}/login`;
  return send({
    to, subject: `APL Auction Season 8 — Captain access for ${teamName}`,
    html: layout(`Welcome, ${captainName}`, `
      <p>You have been appointed captain of <b>${esc(teamName)}</b> for the APL Auction.</p>
      <p><b>Login URL:</b> <a href="${esc(loginUrl)}">${esc(loginUrl)}</a><br>
      <b>Email:</b> ${esc(to)}<br><b>Temporary password:</b> <code style="font-size:16px">${esc(tempPassword)}</code></p>
      <p>This temporary password expires on <b>${esc(new Date(expiresAt).toUTCString())}</b>.</p>
      <ol><li>Open the login page and sign in with the temporary password.</li>
      <li>You will be asked to set your own password (at least 8 characters, with a letter and a number).</li>
      <li>After that, your captain dashboard opens.</li></ol>`),
  });
}

function passwordReset({ to, name, token }) {
  const link = `${env.FRONTEND_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to, subject: 'APL Auction — Password reset',
    html: layout(`Hi ${name}`, `<p>Use the link below to set a new password. It expires in 30 minutes.</p>
      <p><a href="${esc(link)}">${esc(link)}</a></p><p>If you did not request this, ignore this email.</p>`),
  });
}

module.exports = { captainInvite, passwordReset, sent };
