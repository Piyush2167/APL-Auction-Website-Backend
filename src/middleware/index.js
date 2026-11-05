const { ZodError } = require('zod');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const env = require('../config/env');
const logger = require('../config/logger');
const { User } = require('../models');
const { verifyAccess } = require('../services/authService');
const { AppError, unauthorized, forbidden, bad } = require('../utils/errors');

/* ---------- auth ---------- */
async function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return next(unauthorized());
  let claims;
  try { claims = verifyAccess(token); } catch (e) {
    return next(unauthorized(e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', 'Session expired or invalid'));
  }
  const user = await User.findById(claims.sub);
  if (!user || !user.active || user.tokenVersion !== claims.tv) return next(unauthorized('SESSION_REVOKED', 'Session revoked'));
  req.user = user;
  next();
}

const requireRole = (...roles) => (req, _res, next) => (roles.includes(req.user?.role) ? next() : next(forbidden()));

/** Captains on a temporary credential may only reach change-password/me/logout. */
function requirePasswordChanged(req, _res, next) {
  if (req.user?.mustChangePassword) return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Set a new password first'));
  next();
}

/* ---------- validation ---------- */
const validate = (schema, where = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[where] ?? {});
  if (!r.success) return next(r.error);
  if (where === 'query') req.q = r.data; else req[where] = r.data;
  next();
};

/* ---------- rate limits ---------- */
const limiter = (windowMs, limit, extra = {}) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => env.isTest,
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } }),
  ...extra,
});
const limits = {
  api: limiter(60_000, 600),
  auth: limiter(15 * 60_000, 20),
  bid: limiter(10_000, 40, { keyGenerator: (req) => String(req.user?._id || rateLimit.ipKeyGenerator(req.ip)) }),
};

/* ---------- uploads (memory only; Render's disk is not persistent) ---------- */
const importUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/\.(csv|json)$/i.test(file.originalname) ? cb(null, true) : cb(bad('INVALID_FILE', 'Only .csv or .json files are accepted'))),
}).single('file');
const imageUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (/^image\/(png|jpe?g|webp)$/.test(file.mimetype) ? cb(null, true) : cb(bad('INVALID_FILE', 'Only PNG, JPEG or WebP images are accepted'))),
}).single('image');

/* ---------- errors ---------- */
function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: { code: 'UPLOAD_ERROR', message: err.message } });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'Duplicate record or request' } });
  }
  if (['MongoServerSelectionError', 'MongoNetworkError'].includes(err?.name) || /buffering timed out/.test(err?.message || '')) {
    logger.error({ msg: err.message.split('\n')[0] }, 'database unavailable');
    return res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'The server cannot reach the database right now. Please try again shortly.' } });
  }
  if (err?.name === 'CastError') return res.status(400).json({ success: false, error: { code: 'INVALID_ID', message: 'Invalid identifier' } });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Internal server error' } });
}

module.exports = { authenticate, requireRole, requirePasswordChanged, validate, limits, importUpload, imageUpload, notFoundHandler, errorHandler };
