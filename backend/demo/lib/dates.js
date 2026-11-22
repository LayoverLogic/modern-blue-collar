/**
 * demo/lib/dates.js — wall-clock dates in the brand time zone (no dependencies).
 *
 * Demo data is generated relative to "today in BRAND_TIMEZONE", so a demo seeded
 * at 23:30 in Chicago does not put today's jobs on tomorrow's UTC date.
 */
'use strict';

function parts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

/** 'YYYY-MM-DD' of `date` as seen in `timeZone`. */
function localDate(date, timeZone) {
  const p = parts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Add whole days to a 'YYYY-MM-DD' string (calendar arithmetic, DST-safe). */
function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Offset (ms) of `timeZone` from UTC at instant `date`. */
function tzOffset(date, timeZone) {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant of wall time `ymd` + 'HH:MM' in `timeZone`. */
function zonedToUtc(ymd, hm, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = (hm || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffset(new Date(guess), timeZone);
  t = guess - tzOffset(new Date(t), timeZone); // second pass settles DST edges
  return new Date(t);
}

module.exports = { localDate, addDays, zonedToUtc, tzOffset };
