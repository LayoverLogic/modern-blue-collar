/**
 * helpers/phone.js — phone numbers to E.164 (WL-12).
 *
 * Customers and users store phone numbers in E.164 ("+16205550142",
 * "+353209100142"); pages format them for display. National numbers are read
 * with the rules of a country — the customer's own `country` when it is a
 * supported one, else the brand locale (BRAND_COUNTRY):
 *
 *   US  (620) 555-0142 · 620.555.0142 · 1-620-555-0142   → +16205550142
 *       10 digits (or 11 starting with 1); area code and exchange start 2-9.
 *       011 is the international prefix.
 *   IE  020 910 0142 · 089 011 0101 · (01) 234 5678       → +353209100142
 *       national numbers start with the trunk 0; 7-9 digits after it.
 *       00 is the international prefix.
 *
 * International input (+…, 00…, 011… from the US) is accepted from any
 * country: +1 must have 10 digits after it, +353 7-9 (a "(0)" after the
 * country code is dropped), anything else 8-15 digits in total.
 * Separators allowed: spaces, - . / ( ). Anything else (letters, extensions,
 * "=" …) or a number that fits no rule → 400 INVALID_PHONE (field = the name
 * passed in).
 *
 * Exported:
 *   toE164(raw, country?)            E.164 string, or null if it cannot be normalised
 *   normalisePhone(raw, field, opts) for routes: '' / null → null, else E.164 or throws
 *                                    opts { required, country }
 *   matchVariants(e164)              digit strings that the same number may be
 *                                    stored as (legacy, not yet normalised rows)
 *   digitsForSearch(text)            digit fragments for a phone search
 */
'use strict';

const { badRequest } = require('./httpError');

const RULES = {
  US: { cc: '1', intlPrefixes: ['011'] },
  IE: { cc: '353', intlPrefixes: ['00'] },
};

function brandCountry() {
  try { return require('./locale').getLocale().country; } catch { return 'US'; }
}

function validNanp(ten) {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
}

/** "+<digits>" → valid E.164 or null (country-code specific length checks). */
function checkInternational(digits) {
  if (digits.startsWith('1')) return digits.length === 11 && validNanp(digits.slice(1)) ? `+${digits}` : null;
  if (digits.startsWith('353')) {
    let nsn = digits.slice(3);
    if (nsn.startsWith('0')) nsn = nsn.slice(1); // "+353 0 87…" typed with the trunk 0
    return /^[1-9]\d{6,8}$/.test(nsn) ? `+353${nsn}` : null;
  }
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/**
 * Normalise to E.164, or null. `country` = 2-letter code for national
 * numbers (default: the brand country).
 */
function toE164(raw, country) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/\(0\)/g, ' ');                  // "+353 (0)87 …"
  if (!/^\+?[\d\s\-./()]+$/.test(s)) return null; // letters, extensions, formulas …
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (plus) return checkInternational(digits);

  const cc = String(country || brandCountry() || 'US').toUpperCase();
  const rule = RULES[cc];
  if (rule) {
    for (const p of rule.intlPrefixes) {
      if (digits.startsWith(p) && digits.length > p.length + 6) return checkInternational(digits.slice(p.length));
    }
  } else if (digits.startsWith('00')) {
    return checkInternational(digits.slice(2));
  }

  if (cc === 'US') {
    if (digits.length === 10 && validNanp(digits)) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1') && validNanp(digits.slice(1))) return `+${digits}`;
    return null;
  }
  if (cc === 'IE') {
    if (/^0[1-9]\d{6,8}$/.test(digits)) return `+353${digits.slice(1)}`;
    return null;
  }
  return null; // other countries: international format only
}

/**
 * Route helper. Blank → null (or 400 REQUIRED when required); otherwise the
 * E.164 form or 400 INVALID_PHONE.
 */
function normalisePhone(raw, field = 'phone', { required = false, country } = {}) {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw badRequest(`${field} is required`, { code: 'REQUIRED', field });
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) raw = String(raw);
  if (typeof raw !== 'string') throw badRequest(`${field} must be a string`, { code: 'INVALID_INPUT', field });
  if (raw.length > 40) throw badRequest(`${field} must be at most 40 characters`, { code: 'INVALID_INPUT', field });
  const cc = String(country || brandCountry() || 'US').toUpperCase();
  const e164 = toE164(raw, cc);
  if (!e164) {
    const hint = cc === 'IE' ? 'e.g. 087 123 4567 or +353 87 123 4567'
      : cc === 'US' ? 'e.g. (620) 555-0142 or +1 620 555 0142'
        : 'use international format, e.g. +44 20 7946 0958';
    throw badRequest(`${field} "${raw.trim()}" is not a valid phone number (${hint})`, { code: 'INVALID_PHONE', field });
  }
  return e164;
}

/**
 * Digits-only strings the same number may be stored under (rows written
 * before WL-12 keep their original formatting).
 */
function matchVariants(e164) {
  if (typeof e164 !== 'string' || !/^\+\d{8,15}$/.test(e164)) return [];
  const d = e164.slice(1);
  const set = new Set([d]);
  if (d.startsWith('1') && d.length === 11) set.add(d.slice(1));
  if (d.startsWith('353')) { set.add(`0${d.slice(3)}`); set.add(`00${d}`); }
  return [...set];
}

/** Digit fragments to look for when someone searches "620-555" or "087 12". */
function digitsForSearch(text) {
  const d = String(text || '').replace(/\D/g, '');
  if (d.length < 3) return [];
  const out = new Set([d]);
  if (d.startsWith('0') && d.length > 3) out.add(d.slice(1)); // national trunk 0 is not in E.164
  return [...out];
}

module.exports = { toE164, normalisePhone, matchVariants, digitsForSearch, RULES };
