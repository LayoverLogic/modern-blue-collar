/**
 * helpers/errorHandler.js — central error → HTTP mapping (RT-17).
 *
 * Client mistakes become 4xx with a short message; nothing internal (Prisma
 * invocation text, stack frames, SQL) is ever sent to the client. Unknown
 * errors are logged server-side and answered with a generic 500.
 *
 *   HttpError (helpers/httpError.js)     → its status, message, extra fields
 *   Prisma P2002 unique violation        → 409 { code: 'DUPLICATE' }
 *   Prisma P2003 foreign-key violation   → 409 { code: 'IN_USE_OR_MISSING_REFERENCE' }
 *   Prisma P2025 record not found        → 404 { code: 'NOT_FOUND' }
 *   PrismaClientValidationError          → 400 { code: 'INVALID_INPUT' }
 *   multer LIMIT_FILE_SIZE               → 413 { code: 'FILE_TOO_LARGE' }
 *   other multer errors                  → 400 { code: 'INVALID_UPLOAD' }
 *   malformed JSON body                  → 400 { code: 'INVALID_JSON' }
 *   body too large                       → 413 { code: 'PAYLOAD_TOO_LARGE' }
 *
 * Every error body has the shape { error: string, code?: string, ...extra }.
 */

function prismaCode(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.code === 'string' && /^P\d{4}$/.test(err.code)) return err.code;
  // Driver-adapter errors sometimes arrive wrapped.
  if (err.cause && typeof err.cause.code === 'string' && /^P\d{4}$/.test(err.cause.code)) return err.cause.code;
  return null;
}

function mapError(err) {
  if (!err) return { status: 500, body: { error: 'Internal server error' } };

  if (err.name === 'HttpError' || (err.expose && Number.isInteger(err.status) && err.status < 500)) {
    return { status: err.status, body: { error: err.message, ...(err.extra || {}) } };
  }

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return { status: 413, body: { error: 'File is too large', code: 'FILE_TOO_LARGE' } };
    return { status: 400, body: { error: `Invalid upload (${err.code})`, code: 'INVALID_UPLOAD' } };
  }

  // body-parser
  if (err.type === 'entity.parse.failed') return { status: 400, body: { error: 'Malformed JSON body', code: 'INVALID_JSON' } };
  if (err.type === 'entity.too.large')    return { status: 413, body: { error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' } };

  const code = prismaCode(err);
  if (code === 'P2002') return { status: 409, body: { error: 'A record with these values already exists', code: 'DUPLICATE' } };
  if (code === 'P2003') return { status: 409, body: { error: 'This record is referenced by (or references) another record — remove the dependent records first', code: 'IN_USE_OR_MISSING_REFERENCE' } };
  if (code === 'P2025' || code === 'P2001' || code === 'P2018') return { status: 404, body: { error: 'Record not found', code: 'NOT_FOUND' } };
  if (code === 'P2000') return { status: 400, body: { error: 'A value is too long', code: 'INVALID_INPUT' } };
  if (code === 'P2006' || code === 'P2007' || code === 'P2009' || code === 'P2012' || code === 'P2019' || code === 'P2020') {
    return { status: 400, body: { error: 'Invalid input', code: 'INVALID_INPUT' } };
  }
  if (err.name === 'PrismaClientValidationError') return { status: 400, body: { error: 'Invalid input', code: 'INVALID_INPUT' } };

  // Explicit 4xx set by older code paths (e.g. storage 404s) — message is ours.
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return { status: err.status, body: { error: err.message } };
  }
  if (Number.isInteger(err.status) && err.status === 503) {
    return { status: 503, body: { error: err.message } };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const { status, body } = mapError(err);
  if (status >= 500) console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err && (err.stack || err.message));
  if (res.headersSent) return res.destroy();
  res.status(status).json(body);
}

module.exports = { errorHandler, mapError };
