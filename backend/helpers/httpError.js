/**
 * helpers/httpError.js — an Error that carries an HTTP status (and optional
 * machine-readable `code` / extra JSON fields) for the central error handler
 * (helpers/errorHandler.js). Throw it from a route; `next(err)` does the rest.
 *
 *   throw new HttpError(400, 'amount must be a number', { code: 'INVALID_AMOUNT' });
 */
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true;
    this.extra = extra;
  }
}

const badRequest = (msg, extra) => new HttpError(400, msg, extra);
const forbidden  = (msg = 'Forbidden — insufficient role', extra) => new HttpError(403, msg, extra);
const notFound   = (msg = 'Not found', extra) => new HttpError(404, msg, extra);
const conflict   = (msg, extra) => new HttpError(409, msg, extra);

/** Parse a route/body id: positive safe integer, else 400. */
function parseId(value, field = 'id') {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !/^\d{1,15}$/.test(s.trim())) {
    throw badRequest(`${field} must be a positive integer`, { code: 'INVALID_ID' });
  }
  const n = Number(s.trim());
  if (!Number.isSafeInteger(n) || n < 1) throw badRequest(`${field} must be a positive integer`, { code: 'INVALID_ID' });
  return n;
}

module.exports = { HttpError, badRequest, forbidden, notFound, conflict, parseId };
