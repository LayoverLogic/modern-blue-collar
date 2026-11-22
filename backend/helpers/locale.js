/**
 * helpers/locale.js — country / currency / tax / address conventions (Phase 2b).
 *
 * One deployment = one company = one locale, configured with env vars only:
 *
 *   BRAND_COUNTRY          US (default) | IE
 *   BRAND_CURRENCY         ISO 4217 code; default from the country (US → USD, IE → EUR)
 *   BRAND_TAX_RATES        key:percent list, e.g. "standard:23,reduced:13.5,zero:0".
 *                          Default: none for US (no tax — today's behaviour);
 *                          "standard:23,reduced:13.5,zero:0" for IE.
 *   BRAND_TAX_DEFAULT      key used when a line names none (default: first key, or none)
 *   BRAND_TAX_LABEL        "Sales tax" (US) / "VAT" (IE) by default
 *   BRAND_TAX_NUMBER       the company's own tax / VAT registration number (printed)
 *   BRAND_QUOTE_PREFIX     document number prefix, default "Q-"   (Q-0001)
 *   BRAND_INVOICE_PREFIX   document number prefix, default "INV-" (INV-0001)
 *   BRAND_REVERSE_CHARGE   true | false — offer the reverse-charge option on quotes /
 *                          invoices (GAP-16). Default: on for VAT countries (IE) when
 *                          tax rates are configured, or when BRAND_RCT_NOTE is set;
 *                          off for US sales tax. true without tax rates is an error.
 *                          When off, reverseCharge=true is refused (400
 *                          REVERSE_CHARGE_UNAVAILABLE) and /api/brand says
 *                          locale.reverseChargeAvailable=false (the UI hides the box).
 *   BRAND_RCT_NOTE         wording printed on reverse-charge documents. The default
 *                          is a PLACEHOLDER that must be confirmed by an accountant
 *                          — MBC does not claim it is compliant wording.
 *
 * Tax rates are configuration, not advice: whoever deploys a client confirms
 * the rates and the reverse-charge wording with the client's accountant.
 *
 * Exported:
 *   COUNTRIES                      the built-in country definitions
 *   buildLocale(env, brand?)       full locale object (throws BrandConfigError)
 *   publicLocale(locale)           the block GET /api/brand exposes as `locale`
 *   getLocale()                    cached buildLocale(process.env) (US fallback if invalid)
 *   formatMoney(n, currency?, loc?)  "$1,234.50" / "€1,234.50"
 *   formatDate(value, loc?, tz?)   date in the brand time zone; a YYYY-MM-DD string is a
 *                                  calendar date (never shifted by a time zone)
 *   formatTime(hhmm, loc?)         "2:30 PM" (US) / "14:30" (IE)
 *   validateAddress(fields, loc?)  normalises + checks address fields for the locale
 */
'use strict';

const { BrandConfigError } = require('./brandValidate');

const COUNTRIES = {
  US: {
    country: 'US',
    countryName: 'United States',
    currency: 'USD',
    numberLocale: 'en-US',
    dateFormat: 'MM/DD/YYYY',
    phonePrefix: '+1',
    weekStart: 'sunday',
    taxLabel: 'Sales tax',
    defaultTaxRates: '',
    // US sales tax has no reverse charge (GAP-16)
    reverseCharge: false,
    addressLabels: {
      address: 'Street address', addressLine2: 'Apt, suite, unit', city: 'City', state: 'State', zip: 'ZIP code', country: 'Country',
    },
    // Today's behaviour: no address field is mandatory for US customers.
    requiredAddressFields: [],
    postcodeLabel: 'ZIP code',
    postcodePattern: '^\\d{5}(-?\\d{4})?$',
    postcodeExample: '67501',
  },
  IE: {
    country: 'IE',
    countryName: 'Ireland',
    currency: 'EUR',
    numberLocale: 'en-IE',
    dateFormat: 'DD/MM/YYYY',
    phonePrefix: '+353',
    weekStart: 'monday',
    taxLabel: 'VAT',
    defaultTaxRates: 'standard:23,reduced:13.5,zero:0',
    // VAT reverse charge / RCT (construction services)
    reverseCharge: true,
    addressLabels: {
      address: 'Address line 1', addressLine2: 'Address line 2', city: 'Town / City', state: 'County', zip: 'Eircode', country: 'Country',
    },
    requiredAddressFields: ['address', 'city', 'state'],
    postcodeLabel: 'Eircode',
    // Routing key (A65, D6W, ...) + 4-character unique identifier
    postcodePattern: '^(?:[AC-FHKNPRTV-Y]\\d{2}|D6W)\\s?[0-9AC-FHKNPRTV-Y]{4}$',
    postcodeExample: 'W91 X2Y4',
  },
};

const RCT_PLACEHOLDER =
  'Reverse charge: VAT on this supply is to be accounted for by the principal contractor. ' +
  '[Placeholder wording — to be confirmed by an accountant.]';

function clean(v) {
  if (v == null) return '';
  return String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function parseTaxRates(raw, envName = 'BRAND_TAX_RATES') {
  const s = clean(raw);
  if (!s) return [];
  const seen = new Set();
  return s.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^([a-z][a-z0-9_-]{0,29})\s*:\s*(\d{1,2}(?:\.\d{1,3})?|100)$/i.exec(part);
    if (!m) {
      throw new BrandConfigError(`${envName}: "${part}" is not key:percent (e.g. standard:23,reduced:13.5,zero:0).`);
    }
    const key = m[1].toLowerCase();
    if (seen.has(key)) throw new BrandConfigError(`${envName}: tax rate key "${key}" is listed twice.`);
    seen.add(key);
    return { key, rate: Number(m[2]) };
  });
}

function validCurrency(code) {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try { new Intl.NumberFormat('en', { style: 'currency', currency: code }); return true; } catch { return false; }
}

function prefix(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const v = clean(raw);
  if (!/^[A-Za-z0-9._/-]{0,12}$/.test(v)) {
    throw new BrandConfigError(`${name}="${v}" — use up to 12 letters, digits or . _ / - (e.g. INV-).`);
  }
  return v;
}

/**
 * Build the locale from an env-like map. Pure (no process.env access).
 * `brand` (optional) supplies defaultState / timezone.
 */
function buildLocale(env = {}, brand = {}) {
  const cc = (clean(env.BRAND_COUNTRY) || 'US').toUpperCase();
  const def = COUNTRIES[cc];
  if (!def) throw new BrandConfigError(`BRAND_COUNTRY="${cc}" is not supported. Use one of: ${Object.keys(COUNTRIES).join(' | ')}.`);

  const currency = (clean(env.BRAND_CURRENCY) || def.currency).toUpperCase();
  if (!validCurrency(currency)) throw new BrandConfigError(`BRAND_CURRENCY="${currency}" is not an ISO 4217 currency code (e.g. USD, EUR).`);

  const ratesRaw = env.BRAND_TAX_RATES !== undefined ? env.BRAND_TAX_RATES : def.defaultTaxRates;
  const taxRates = parseTaxRates(ratesRaw);
  const defKey = clean(env.BRAND_TAX_DEFAULT).toLowerCase();
  if (defKey && !taxRates.some((r) => r.key === defKey)) {
    throw new BrandConfigError(`BRAND_TAX_DEFAULT="${defKey}" is not one of the BRAND_TAX_RATES keys (${taxRates.map((r) => r.key).join(', ') || 'none configured'}).`);
  }
  const taxDefault = defKey || (taxRates[0] ? taxRates[0].key : null);

  const rctNote = clean(env.BRAND_RCT_NOTE);
  const explicitState = clean(env.BRAND_DEFAULT_STATE);

  // Reverse charge (GAP-16): only where it exists (VAT) or was asked for.
  const rcRaw = clean(env.BRAND_REVERSE_CHARGE).toLowerCase();
  if (rcRaw && !['true', 'false', '1', '0', 'yes', 'no'].includes(rcRaw)) {
    throw new BrandConfigError(`BRAND_REVERSE_CHARGE="${rcRaw}" — use true or false.`);
  }
  const rcExplicit = rcRaw ? ['true', '1', 'yes'].includes(rcRaw) : null;
  if (rcExplicit && !taxRates.length) {
    throw new BrandConfigError('BRAND_REVERSE_CHARGE=true needs tax rates (BRAND_TAX_RATES) — there is no tax to reverse-charge.');
  }
  const reverseChargeAvailable = taxRates.length > 0 && (rcExplicit !== null ? rcExplicit : (!!def.reverseCharge || !!rctNote));

  return {
    country: def.country,
    countryName: def.countryName,
    currency,
    numberLocale: def.numberLocale,
    dateFormat: def.dateFormat,
    phonePrefix: def.phonePrefix,
    // First day of the calendar week: US / CA → sunday, everywhere else monday.
    weekStart: def.weekStart || (['US', 'CA'].includes(def.country) ? 'sunday' : 'monday'),
    addressLabels: { ...def.addressLabels },
    requiredAddressFields: def.requiredAddressFields.slice(),
    postcodeLabel: def.postcodeLabel,
    postcodePattern: def.postcodePattern,
    postcodeExample: def.postcodeExample,
    // US keeps the brand default (BRAND_DEFAULT_STATE, 'KS' when unset); other
    // countries only use an explicitly configured default.
    defaultState: def.country === 'US' ? (brand.defaultState || explicitState || 'KS') : (explicitState || null),
    timezone: brand.timezone || null,
    taxEnabled: taxRates.length > 0,
    taxLabel: clean(env.BRAND_TAX_LABEL) || def.taxLabel,
    taxNumber: clean(env.BRAND_TAX_NUMBER) || null,
    taxRates,
    taxDefault,
    quotePrefix: prefix(env, 'BRAND_QUOTE_PREFIX', 'Q-'),
    invoicePrefix: prefix(env, 'BRAND_INVOICE_PREFIX', 'INV-'),
    reverseChargeAvailable,
    reverseChargeNote: rctNote || RCT_PLACEHOLDER,
    reverseChargeNoteIsPlaceholder: !rctNote,
  };
}

/** What GET /api/brand exposes (`locale` block). */
function publicLocale(l) {
  return {
    country: l.country,
    currency: l.currency,
    numberLocale: l.numberLocale,
    dateFormat: l.dateFormat,
    phonePrefix: l.phonePrefix,
    weekStart: l.weekStart,
    addressLabels: l.addressLabels,
    requiredAddressFields: l.requiredAddressFields,
    postcodePattern: l.postcodePattern,
    postcodeExample: l.postcodeExample,
    defaultState: l.defaultState,
    taxEnabled: l.taxEnabled,
    taxLabel: l.taxLabel,
    taxNumber: l.taxNumber,
    taxRates: l.taxRates,
    taxDefault: l.taxDefault,
    reverseChargeAvailable: l.reverseChargeAvailable,
    reverseChargeNote: l.reverseChargeNote,
    reverseChargeNoteIsPlaceholder: l.reverseChargeNoteIsPlaceholder,
  };
}

let cached = null;
/** Locale for this process (brand.config.js validates at boot; here invalid env falls back to US). */
function getLocale() {
  if (cached) return cached;
  let brand = {};
  try { brand = require('./brandValidate').buildBrand(process.env); } catch { /* brand.config.js reports it */ }
  try { cached = buildLocale(process.env, brand); } catch { cached = buildLocale({}, brand); }
  return cached;
}

// ── Formatting ──────────────────────────────────────────────────────────────
function formatMoney(n, currency, loc = getLocale()) {
  const value = Number(n);
  const cur = currency || loc.currency;
  try {
    return new Intl.NumberFormat(loc.numberLocale, { style: 'currency', currency: cur }).format(Number.isFinite(value) ? value : 0);
  } catch {
    return `${cur} ${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
  }
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Human date. A 'YYYY-MM-DD' string is a calendar date and is printed as such;
 * a Date / ISO timestamp is converted to the brand time zone first.
 * style: 'long' → "Tuesday, November 25, 2026" (US) / "Tuesday 25 November 2026" (IE)
 *        'short' → "11/25/2026" / "25/11/2026"
 */
function formatDate(value, loc = getLocale(), tz = loc.timezone, { style = 'long', year = true } = {}) {
  if (value == null || value === '') return '';
  let d; let timeZone = tz || 'UTC';
  if (typeof value === 'string' && YMD.test(value)) {
    const [, y, m, dd] = YMD.exec(value);
    d = new Date(Date.UTC(Number(y), Number(m) - 1, Number(dd), 12));
    timeZone = 'UTC';
  } else {
    d = value instanceof Date ? value : new Date(value);
  }
  if (Number.isNaN(d.getTime())) return String(value);
  const opts = style === 'short'
    ? { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }
    : { weekday: 'long', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}), timeZone };
  try { return new Intl.DateTimeFormat(loc.numberLocale, opts).format(d); } catch { return d.toISOString().slice(0, 10); }
}

/** 'HH:MM' (24h) → locale time ("2:30 PM" / "14:30"). Anything else is returned as-is. */
function formatTime(hhmm, loc = getLocale()) {
  const m = typeof hhmm === 'string' && /^([01]\d|2[0-3]):([0-5]\d)/.exec(hhmm);
  if (!m) return hhmm || '';
  const d = new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2])));
  return new Intl.DateTimeFormat(loc.numberLocale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', hour12: loc.country === 'US' }).format(d);
}

/**
 * Check the address fields present in `d` (already trimmed strings or null)
 * for the locale. `create` → required fields must be present.
 * Returns the normalised fields; throws HttpError(400, REQUIRED / INVALID_INPUT).
 */
function validateAddress(d, { create = false, current = null } = {}, loc = getLocale()) {
  const { badRequest } = require('./httpError');
  const out = { ...d };
  const country = (out.country || (current && current.country) || loc.country || 'US').toUpperCase();
  const def = COUNTRIES[country];
  if (def) {
    const required = country === loc.country ? loc.requiredAddressFields : def.requiredAddressFields;
    // create: every required field; update: a required field may not be cleared
    for (const k of required) {
      if (!create && !(k in out)) continue;
      const value = out[k];
      if (value == null || String(value).trim() === '') {
        throw badRequest(`${def.addressLabels[k] || k} is required`, { code: 'REQUIRED', field: k });
      }
    }
    if (out.zip) {
      let z = String(out.zip).toUpperCase().replace(/\s+/g, ' ').trim();
      if (!new RegExp(def.postcodePattern, 'i').test(z)) {
        throw badRequest(`${def.postcodeLabel} "${out.zip}" is not valid (e.g. ${def.postcodeExample})`, { code: 'INVALID_INPUT', field: 'zip' });
      }
      if (country === 'IE') z = z.replace(/\s/g, '').replace(/^(.{3})(.{4})$/, '$1 $2');
      out.zip = z;
    }
  }
  return out;
}

module.exports = {
  COUNTRIES, RCT_PLACEHOLDER, parseTaxRates, buildLocale, publicLocale, getLocale,
  formatMoney, formatDate, formatTime, validateAddress,
  _resetForTests: () => { cached = null; },
};
