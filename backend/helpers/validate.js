/**
 * helpers/validate.js — small input validators. Each returns the cleaned value
 * or throws HttpError(400). `undefined` / '' / null handling is explicit per
 * validator so PATCH routes can tell "not sent" from "cleared".
 */
const { badRequest, parseId } = require('./httpError');

// Money is stored as Float for now (Decimal is a later schema change); keep it
// to finite values with at most 2 decimals and a sane ceiling.
const MONEY_MAX = 10_000_000;

const JOB_STATUSES     = ['pending', 'scheduled', 'in-progress', 'completed', 'cancelled'];
const JOB_PRIORITIES   = ['low', 'normal', 'high', 'urgent'];
const QUOTE_STATUSES   = ['draft', 'sent', 'approved', 'declined'];
const INVOICE_STATUSES = ['unpaid', 'paid', 'overdue', 'void'];
const CUSTOMER_TYPES   = ['residential', 'commercial', 'industrial'];
const COMM_TYPES       = ['call', 'email', 'text', 'note'];
const COMM_DIRECTIONS  = ['inbound', 'outbound'];

const isBlank = (x) => x === undefined || x === null || (typeof x === 'string' && x.trim() === '');

/** Plain string (numbers are accepted and stringified). */
function str(value, field, { required = false, max = 1000, allowNull = true } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${field} is required`, { code: 'REQUIRED', field });
    return allowNull ? null : '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`, { code: 'INVALID_INPUT', field });
  const s = value.trim();
  if (s.length > max) throw badRequest(`${field} must be at most ${max} characters`, { code: 'INVALID_INPUT', field });
  return s;
}

function email(value, field = 'email', { required = false } = {}) {
  const s = str(value, field, { required, max: 254 });
  if (s == null) return s;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`${field} must be an email address`, { code: 'INVALID_INPUT', field });
  return s.toLowerCase();
}

function oneOf(value, list, field, { required = false } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${field} is required`, { code: 'REQUIRED', field });
    return undefined;
  }
  if (typeof value !== 'string' || !list.includes(value)) {
    throw badRequest(`${field} must be one of: ${list.join(', ')}`, { code: 'INVALID_ENUM', field, allowed: list });
  }
  return value;
}

/**
 * Money amount. Accepts a number or a numeric string. Rejects NaN, Infinity,
 * exponent/hex tricks, more than 2 decimals, > MONEY_MAX, and values below
 * `min` (or equal to it when `exclusive`).
 */
function money(value, field = 'amount', { required = true, min = 0, exclusive = false, max = MONEY_MAX } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${field} is required`, { code: 'REQUIRED', field });
    return undefined;
  }
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
  else throw badRequest(`${field} must be a number`, { code: 'INVALID_AMOUNT', field });
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a finite number`, { code: 'INVALID_AMOUNT', field });
  if (exclusive ? n <= min : n < min) {
    throw badRequest(`${field} must be ${exclusive ? 'greater than' : 'at least'} ${min}`, { code: 'INVALID_AMOUNT', field });
  }
  if (n > max) throw badRequest(`${field} must be at most ${max}`, { code: 'INVALID_AMOUNT', field });
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) {
    throw badRequest(`${field} must have at most 2 decimal places`, { code: 'INVALID_AMOUNT', field });
  }
  return Math.round(n * 100) / 100;
}

function number(value, field, { required = false, min = -Infinity, max = Infinity } = {}) {
  if (isBlank(value)) {
    if (required) throw badRequest(`${field} is required`, { code: 'REQUIRED', field });
    return undefined;
  }
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw badRequest(`${field} must be a number between ${min} and ${max}`, { code: 'INVALID_INPUT', field });
  }
  return n;
}

function bool(value, field) {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequest(`${field} must be true or false`, { code: 'INVALID_INPUT', field });
}

/** Optional FK id: undefined (not sent), null ('' / null → clear) or a positive int. */
function optionalId(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return parseId(value, field);
}

function date(value, field) {
  if (value === undefined) return undefined;
  if (isBlank(value)) return null;
  const d = new Date(value);
  if (typeof value === 'boolean' || Number.isNaN(d.getTime())) throw badRequest(`${field} must be a date`, { code: 'INVALID_INPUT', field });
  return d;
}

/** YYYY-MM-DD (the format <input type=date> sends). */
function ymd(value, field = 'scheduledDate') {
  if (value === undefined) return undefined;
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw badRequest(`${field} must be a date in YYYY-MM-DD format`, { code: 'INVALID_INPUT', field });
  }
  return value;
}

/** HH:MM (24h, what <input type=time> sends); HH:MM:SS tolerated. */
function hhmm(value, field = 'scheduledTime') {
  if (value === undefined) return undefined;
  if (isBlank(value)) return null;
  const m = typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec(value);
  if (!m) throw badRequest(`${field} must be a time in HH:MM (24h) format`, { code: 'INVALID_INPUT', field });
  return `${m[1]}:${m[2]}`;
}

/** Optimistic-locking version: required positive integer (RT-9). */
function version(value) {
  if (value === undefined || value === null || value === '') {
    throw badRequest('version is required — send the version you last read so concurrent edits are detected', { code: 'VERSION_REQUIRED' });
  }
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(n) || n < 1) throw badRequest('version must be a positive integer', { code: 'VERSION_REQUIRED' });
  return n;
}

module.exports = {
  MONEY_MAX, JOB_STATUSES, JOB_PRIORITIES, QUOTE_STATUSES, INVOICE_STATUSES, CUSTOMER_TYPES, COMM_TYPES, COMM_DIRECTIONS,
  isBlank, str, email, oneOf, money, number, bool, optionalId, date, ymd, hhmm, version,
};
