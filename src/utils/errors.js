class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const bad = (code, msg, d) => new AppError(400, code, msg, d);
const conflict = (code, msg, d) => new AppError(409, code, msg, d);
const notFound = (what) => new AppError(404, 'NOT_FOUND', `${what} not found`);
const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
const unauthorized = (code = 'UNAUTHORIZED', msg = 'Authentication required') => new AppError(401, code, msg);

module.exports = { AppError, bad, conflict, notFound, forbidden, unauthorized };
