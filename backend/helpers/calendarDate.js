/**
 * helpers/calendarDate.js — date-only values (B3; Frontend-reported #13 / #14).
 *
 * Canonical form: a calendar date (invoice dueDate) is stored as UTC MIDNIGHT of
 * that date (2026-12-05T00:00:00.000Z) and always read back with
 * ymdOf(value) = the UTC Y-M-D. Never convert it through a time zone — a Dec 5
 * due date stays Dec 5 in America/Chicago and Europe/Dublin alike.
 * (helpers/xero.js and helpers/qbo.js already read due dates this way.)
 *
 *   calendarDate(value, field, tz)  request value → Date at UTC midnight, null, or undefined
 *       'YYYY-MM-DD'                → that date
 *       ISO timestamp / Date        → its calendar date IN THE BRAND TIME ZONE
 *   ymdOf(date)                     → 'YYYY-MM-DD' (UTC), '' for null
 *   ymdIn(date, tz)                 → the calendar date of an instant in a time zone
 *   zonedNoon(ymd, tz)              → the instant of 12:00 on that date in tz
 *                                     (used for issuedAt given as a bare date)
 *   normaliseDueDatesSql(tz)        → SQL that rewrites non-canonical due dates (boot)
 */
'use strict';

const { badRequest } = require('./httpError');

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function ymdIn(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

function validYmd(s) {
  const m = YMD.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const atUtcMidnight = (ymd) => new Date(`${ymd}T00:00:00.000Z`);

function calendarDate(value, field, timeZone) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value === 'string' && YMD.test(value.trim())) {
    if (!validYmd(value.trim())) throw badRequest(`${field} is not a real calendar date`, { code: 'INVALID_INPUT', field });
    return atUtcMidnight(value.trim());
  }
  const d = value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number' ? new Date(value) : new Date(NaN));
  if (typeof value === 'boolean' || Number.isNaN(d.getTime())) throw badRequest(`${field} must be a date (YYYY-MM-DD)`, { code: 'INVALID_INPUT', field });
  return atUtcMidnight(ymdIn(d, timeZone));
}

const ymdOf = (date) => (date ? (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10) : '');

function tzOffsetMs(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function zonedNoon(ymd, timeZone) {
  const guess = new Date(`${ymd}T12:00:00.000Z`);
  return new Date(guess.getTime() - tzOffsetMs(guess, timeZone || 'UTC'));
}

/** Rewrite due dates that are not at UTC midnight to their brand-local calendar date. */
function normaliseDueDatesSql() {
  return 'UPDATE "Invoice" SET "dueDate" = (((("dueDate" AT TIME ZONE \'UTC\') AT TIME ZONE $1)::date)::timestamp) ' +
    'WHERE "dueDate" IS NOT NULL AND "dueDate"::time <> \'00:00:00\'';
}

module.exports = { calendarDate, ymdOf, ymdIn, zonedNoon, validYmd, normaliseDueDatesSql, YMD };
