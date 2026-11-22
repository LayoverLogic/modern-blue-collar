/**
 * helpers/importer.js — customer CSV import with the five migration gates built in
 * (mbc-team/gtm/implementation/data-migration-playbook.md §1, §4.3, §5, §6).
 *
 * One pipeline for the API (routes/imports.js) and the CLI (scripts/import-customers.js):
 *
 *   const plan   = await planCustomerImport({ files, source, mapping, decisions, options })
 *   const report = dryRun ? plan.report : await commitCustomerImport(plan)
 *   renderMarkdown(report) / exceptionsCsv(report) / mergeCsv(report) / spotCheckCsv(report)
 *
 * planCustomerImport() reads the database (existing customers + earlier import links)
 * but WRITES NOTHING. Every source row gets exactly one outcome:
 *   created | updated | merged | excluded | errored
 * and the report proves  sourceRows = created + updated + merged + excluded + errored
 * with `unexplained` = 0 (Gate 3).
 *
 * Rules (playbook):
 *   - Source IDs or nothing: a row without a source id is an error (unless the mapping
 *     derives one explicitly — flagged `derivedSourceIds` in the report).
 *   - Idempotent: (sourceSystem, sourceId) on Customer → update in place; earlier merges are
 *     remembered in IntegrationLink (provider "import:<sourceSystem>", entity "customer").
 *   - Cleaning §5.1, in order, every change counted: Excel wrappers (="x", =x), non-printing
 *     characters, whitespace, email lowercase, phone → E.164, postcode uppercase as text,
 *     dates parsed with an explicit format (never guessed), amounts as cents.
 *   - Fail closed: unknown type / country, bad email / phone / postcode / date → errored with
 *     a rule; nothing gets a silent default. Address rules come from the locale
 *     (helpers/locale.js validateAddress: US nothing required, IE address + town + county).
 *   - Company names are never split; company → type commercial; "Is Company?" honoured.
 *   - Dedupe §5.2 (first match wins): same source id → same record; email + (phone | postcode)
 *     → auto-merge candidate; phone + postcode → review; display name + postcode → review;
 *     name only → never. Shared emails (≥ sharedEmailThreshold identities) never drive a merge.
 *     Candidates are NOT merged unless the decisions file says so — undecided rows are held
 *     (excluded, rule pending_merge_decision) or, with options.undecided = "create", created
 *     and flagged.
 *   - Rows repeating a source id with the same name (HCP: one row per address) are merged into
 *     the first row and their address goes to its notes; with a different name → excluded.
 *
 * commitCustomerImport(): one interactive transaction per batch (default 200 rows). A failing
 * batch rolls back entirely; later batches are not attempted (errored, rule
 * not_attempted_after_batch_failure) — re-running is safe because of the source ids. The report
 * keeps `before` values of updated / merged customers so undoCustomerImport(report) can roll a
 * run back (created rows deleted while they have no jobs / communications, updates restored
 * while nobody edited the customer since).
 */
'use strict';

const crypto = require('crypto');
const { parseCsv, csvLine } = require('./csv');
const { getLocale, validateAddress, COUNTRIES } = require('./locale');
const { CUSTOMER_TYPES } = require('./validate');

// ── Presets ──────────────────────────────────────────────────────────────────
// Candidate header names per target field (matched case-insensitively, ignoring a leading
// "*" and repeated spaces). The first candidate present in the file wins. A mapping file
// overrides any field. Exports differ per account / plan: the report lists which header each
// field used and every unmapped source column, so a wrong guess is visible at Gate 2.
const PRESETS = {
  generic: {
    label: 'Generic spreadsheet (our customers template)',
    sourceSystem: 'generic',
    dateFormat: 'YYYY-MM-DD',
    fields: {
      sourceId: ['source_id'], company: ['company'], firstName: ['first_name'], lastName: ['last_name'],
      fullName: ['name', 'full_name', 'display_name'], email: ['email'], phone: ['phone'], phoneAlt: ['phone_alt'],
      address: ['line1', 'address', 'address_line1'], addressLine2: ['line2', 'address_line2'],
      city: ['city', 'town'], state: ['region', 'state', 'county'], zip: ['postcode', 'zip', 'eircode'],
      country: ['country'], type: ['type'], notes: ['notes'], taxNumber: ['tax_number', 'vat_number'],
      createdAt: ['created_at'], lifetimeValue: ['lifetime_value'], archived: ['archived'],
      extraAddress: ['service_address'],
    },
  },
  housecallpro: {
    label: 'Housecall Pro customer list export',
    sourceSystem: 'housecallpro',
    dateFormat: null,
    fields: {
      sourceId: ['Customer ID', 'Customer Id', 'ID', 'Id'],
      fullName: ['Customer', 'Customer name', 'Display name', 'Name'],
      firstName: ['First Name'], lastName: ['Last Name'], company: ['Company', 'Company name'],
      email: ['Email', 'Email address'], phone: ['Mobile Phone', 'Mobile phone', 'Phone', 'Phone number'],
      phoneAlt: ['Home Phone', 'Work Phone', 'Home phone', 'Work phone'],
      addressFull: ['Address', 'Service address', 'Address 1'],
      address: ['Street', 'Address Line 1', 'Street address'], addressLine2: ['Address Line 2', 'Street Line 2', 'Unit'],
      city: ['City'], state: ['State'], zip: ['Zip', 'Zip Code', 'Postal Code'],
      notes: ['Notes', 'Customer Notes', 'Private notes'], tags: ['Tags'],
      createdAt: ['Created At', 'Created', 'Customer since'],
      lifetimeValue: ['Job revenue', 'Lifetime value', 'Total revenue'],
      extraAddress: ['Address 2', 'Service Address 2'],
      type: ['Customer type'],
    },
  },
  jobber: {
    label: 'Jobber client export (CSV)',
    sourceSystem: 'jobber',
    dateFormat: null,
    fields: {
      sourceId: ['J-ID', 'J_ID', 'JID', 'Client ID'],
      fullName: ['Display name', 'Client name', 'Name'],
      firstName: ['First name'], lastName: ['Last name'], company: ['Company name', 'Company'],
      isCompany: ['Is Company?', 'Is company'],
      email: ['E-mails', 'Emails', 'Email', 'E-mail', 'Email address'],
      phone: ['Main phone', 'Mobile phone', 'Phone', 'Phone number', 'Phone numbers', 'Text Message Enabled Phone Number'],
      phoneAlt: ['Work phone', 'Home phone', 'Other phone'],
      address: ['Billing street 1', 'Billing street', 'Street 1'], addressLine2: ['Billing street 2', 'Street 2'],
      city: ['Billing city', 'City'], state: ['Billing state', 'Billing province', 'State', 'Province'],
      zip: ['Billing zip code', 'Billing postal code', 'Billing zip', 'Zip code', 'Postal code'],
      country: ['Billing country', 'Country'], notes: ['Notes'], tags: ['Tags'], archived: ['Archived'],
      createdAt: ['Created date', 'Created at', 'Created'], lifetimeValue: ['Lifetime value', 'Total revenue'],
      extraAddress: ['Service street 1', 'Property street 1', 'Property address'],
    },
  },
};

const TARGET_FIELDS = Object.freeze([
  'sourceId', 'company', 'firstName', 'lastName', 'fullName', 'isCompany', 'email', 'phone', 'phoneAlt',
  'addressFull', 'address', 'addressLine2', 'city', 'state', 'zip', 'country', 'type', 'notes', 'tags',
  'taxNumber', 'createdAt', 'lifetimeValue', 'archived', 'extraAddress',
]);

// Customer columns the importer writes (and compares for "updated")
const WRITE_FIELDS = ['firstName', 'lastName', 'company', 'email', 'phone', 'address', 'addressLine2', 'city', 'state', 'zip', 'country', 'type', 'taxNumber', 'notes'];
const MAX = { firstName: 100, lastName: 100, company: 200, email: 254, phone: 40, address: 200, addressLine2: 200, city: 200, state: 50, zip: 20, taxNumber: 40, notes: 5000 };

const DEFAULT_TYPE_MAP = {
  residential: 'residential', homeowner: 'residential', home: 'residential', individual: 'residential', person: 'residential', domestic: 'residential',
  commercial: 'commercial', business: 'commercial', company: 'commercial',
  industrial: 'industrial',
};

const DEFAULT_OPTIONS = {
  batchSize: 200,
  undecided: 'hold',            // hold | create
  missingPhone: 'error',        // error | blank  (blank needs client approval at Gate 2)
  excludeArchived: false,
  sharedEmailThreshold: 3,
  spotCheckSize: 25,
  maxRows: 100000,
};

class ImportError extends Error {
  constructor(message, code = 'IMPORT_INVALID', extra = {}) { super(message); this.name = 'ImportError'; this.code = code; this.extra = extra; }
}

// ── Small utilities ──────────────────────────────────────────────────────────
const normHeader = (h) => String(h || '').replace(/^﻿/, '').replace(/^\*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isBlank = (v) => v == null || String(v).trim() === '';

function seededRandom(seedHex) {
  let s = parseInt(String(seedHex).slice(0, 8), 16) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** §5.1 steps 1–2. Returns the cleaned string and bumps counters in `stats`. */
function cleanValue(raw, stats, { multiline = false } = {}) {
  if (raw == null) return '';
  let v = String(raw);
  let m;
  if ((m = /^="([\s\S]*)"$/.exec(v.trim()))) { v = m[1].replace(/""/g, '"'); stats.excel_wrapper_stripped += 1; }
  else if ((m = /^=([^()=]*)$/.exec(v.trim())) && m[1] !== '') { v = m[1]; stats.excel_wrapper_stripped += 1; }
  v = v.replace(/ /g, ' ');
  v = multiline ? v.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : v.replace(/[\t\r\n]+/g, ' ');
  const np = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‍⁠﻿]/g, '');
  if (np !== v) { stats.non_printing_removed += 1; v = np; }
  const ws = multiline ? v.replace(/[ ]{2,}/g, ' ').replace(/ +$/gm, '').trim() : v.replace(/ {2,}/g, ' ').trim();
  if (ws !== v.trim()) stats.whitespace_collapsed += 1;
  return ws;
}

/** E.164 for the given country, or null when it cannot be a valid number. */
function normalisePhone(raw, country) {
  if (isBlank(raw)) return null;
  let s = String(raw).replace(/^[A-Za-z][A-Za-z ]{0,20}:\s*/, '').replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i, '').trim();
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (plus) return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  if (d.startsWith('00')) { d = d.slice(2); return d.length >= 8 && d.length <= 15 ? `+${d}` : null; }
  if (country === 'US') {
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 && /^[2-9]\d{2}[2-9]/.test(d) ? `+1${d}` : null;
  }
  if (country === 'IE') {
    if (d.startsWith('353') && d.length >= 11 && d.length <= 12) return `+${d}`;
    if (d.startsWith('0') && d.length >= 9 && d.length <= 10) return `+353${d.slice(1)}`;
    return null;
  }
  return null;
}

const COUNTRY_NAMES = {
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  ie: 'IE', ireland: 'IE', 'republic of ireland': 'IE', eire: 'IE', 'éire': 'IE', irl: 'IE',
  gb: 'GB', uk: 'GB', 'united kingdom': 'GB', 'northern ireland': 'GB', ca: 'CA', canada: 'CA',
};
function normaliseCountry(raw) {
  if (isBlank(raw)) return null;
  const k = String(raw).trim().toLowerCase().replace(/\./g, '');
  if (COUNTRY_NAMES[k]) return COUNTRY_NAMES[k];
  return undefined; // unknown → fail closed
}

/**
 * Explicit-format date parse (§5.1 step 4). fmt: 'YYYY-MM-DD' (also ISO timestamps),
 * 'MM/DD/YYYY' or 'DD/MM/YYYY' (separators / - . accepted). Without a format only ISO is
 * accepted; anything else is an error so 03/04 is never guessed.
 * @returns {Date|null} null = blank; throws {rule, detail}
 */
function parseDate(raw, fmt) {
  if (isBlank(raw)) return null;
  const s = String(raw).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  const mk = (y, mo, d, h = 0, mi = 0, se = 0) => {
    const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw { rule: 'invalid_date', detail: `"${s}" is not a real date` };
    return dt;
  };
  if (iso) {
    if (iso[7]) { const d = new Date(s); if (Number.isNaN(d.getTime())) throw { rule: 'invalid_date', detail: `"${s}"` }; return d; }
    return mk(+iso[1], +iso[2], +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0));
  }
  const sl = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (sl && (fmt === 'MM/DD/YYYY' || fmt === 'DD/MM/YYYY')) {
    let h = +(sl[4] || 0);
    if (sl[7]) { if (h === 12) h = 0; if (/p/i.test(sl[7])) h += 12; }
    const [a, b] = [+sl[1], +sl[2]];
    return fmt === 'MM/DD/YYYY' ? mk(+sl[3], a, b, h, +(sl[5] || 0), +(sl[6] || 0)) : mk(+sl[3], b, a, h, +(sl[5] || 0), +(sl[6] || 0));
  }
  if (sl) throw { rule: 'date_format_required', detail: `"${s}" — set dateFormat (MM/DD/YYYY or DD/MM/YYYY) in the mapping; dates are never guessed` };
  throw { rule: 'invalid_date', detail: `"${s}" is not in ${fmt || 'YYYY-MM-DD'} format` };
}

/** "$1,234.50" → 123450 (integer cents) or null; throws on garbage. */
function parseCents(raw) {
  if (isBlank(raw)) return null;
  const s = String(raw).replace(/[\s$€£,]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw { rule: 'invalid_amount', detail: `"${raw}"` };
  const [i, f = ''] = s.replace('-', '').split('.');
  const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
  return s.startsWith('-') ? -cents : cents;
}

function parseBool(raw) {
  if (isBlank(raw)) return null;
  const s = String(raw).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', 't'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'f'].includes(s)) return false;
  return undefined;
}

const COMPANY_RE = /(\b(llc|l\.l\.c\.?|inc\.?|incorporated|ltd\.?|limited|plc|corp\.?|corporation|company|co\.|construction|services|properties|property management|holdings|group|partners|associates|enterprises|contractors?|builders?|church|school|council|teoranta|dac|clg|hoa|apartments|management)\b|&)/i;
const looksLikeCompany = (s) => COMPANY_RE.test(s);

const PARTICLES = new Set(['de', 'da', 'di', 'del', 'della', 'van', 'von', 'der', 'den', 'le', 'la', 'du', 'mac', 'mc', 'ni', 'ní', 'nic', 'o', 'ó', 'ua', 'st', 'st.', 'bin', 'ibn', 'al']);
/** Person full name → { firstName, lastName }. Particles (Ní, Ó, van, de…) stay with the surname. */
function splitPersonName(full) {
  const parts = full.split(' ').filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  let idx = parts.length - 1;
  for (let i = 1; i < parts.length - 1; i += 1) if (PARTICLES.has(parts[i].toLowerCase())) { idx = i; break; }
  return { firstName: parts.slice(0, idx).join(' '), lastName: parts.slice(idx).join(' ') };
}

/** "12 Main St, Apt 4, Hutchinson, KS 67501" (US) / "…, Naas, Co. Kildare, W91 X2Y4" (IE) */
function parseFullAddress(full, country) {
  const parts = String(full).split(',').map((p) => p.trim()).filter(Boolean);
  const out = { address: '', addressLine2: null, city: null, state: null, zip: null };
  if (!parts.length) return out;
  if (country === 'IE') {
    const last = parts[parts.length - 1];
    if (new RegExp(COUNTRIES.IE.postcodePattern, 'i').test(last)) { out.zip = last; parts.pop(); }
    const ci = parts.findIndex((p, i) => i > 0 && /^(co\.?|county)\s+\S/i.test(p));
    if (ci > 0) { out.state = parts[ci]; parts.splice(ci, 1); }
    if (parts.length > 1) out.city = parts.pop();
    out.address = parts.shift() || '';
    if (parts.length) out.addressLine2 = parts.join(', ');
    return out;
  }
  const tail = parts[parts.length - 1];
  const sz = /^([A-Za-z]{2})\s+(\d{5}(?:-?\d{4})?|\d{3,4})$/.exec(tail) || /^([A-Za-z]{2})$/.exec(tail);
  if (sz && parts.length >= 2) {
    out.state = sz[1].toUpperCase(); out.zip = sz[2] || null; parts.pop();
    if (parts.length > 1) out.city = parts.pop();
  }
  out.address = parts.shift() || '';
  if (parts.length) out.addressLine2 = parts.join(', ');
  return out;
}

const displayKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const postKey = (z) => (z ? String(z).toUpperCase().replace(/[\s-]/g, '') : '');
const displayName = (c) => (c.company ? c.company : `${c.firstName || ''} ${c.lastName || ''}`.trim());

// ── Mapping resolution ───────────────────────────────────────────────────────
/**
 * Resolve the field → header mapping. `mapping.fields[f]` may be a header name, a list of
 * candidates, null (unmap) or { derive: [headers…] } (sourceId only: sha256 of the values).
 */
function resolveMapping(headers, source, mapping = {}) {
  const preset = PRESETS[source];
  if (!preset) throw new ImportError(`Unknown source "${source}" — use one of: ${Object.keys(PRESETS).join(', ')}`, 'INVALID_ENUM', { field: 'source', allowed: Object.keys(PRESETS) });
  if (mapping && typeof mapping !== 'object') throw new ImportError('mapping must be a JSON object', 'INVALID_INPUT', { field: 'mapping' });
  const index = new Map();
  headers.forEach((h, i) => { const k = normHeader(h); if (!index.has(k)) index.set(k, i); });
  const userFields = (mapping && mapping.fields) || {};
  for (const k of Object.keys(userFields)) {
    if (!TARGET_FIELDS.includes(k)) throw new ImportError(`mapping.fields.${k} is not a target field (${TARGET_FIELDS.join(', ')})`, 'INVALID_INPUT', { field: `mapping.fields.${k}` });
  }
  const fields = {};
  let derive = null;
  for (const f of TARGET_FIELDS) {
    const spec = Object.prototype.hasOwnProperty.call(userFields, f) ? userFields[f] : preset.fields[f];
    if (spec == null) continue;
    if (f === 'sourceId' && typeof spec === 'object' && !Array.isArray(spec) && Array.isArray(spec.derive)) {
      const cols = spec.derive.map((h) => {
        const i = index.get(normHeader(h));
        if (i === undefined) throw new ImportError(`mapping.fields.sourceId.derive: column "${h}" is not in the file`, 'INVALID_INPUT', { field: 'mapping.fields.sourceId' });
        return i;
      });
      derive = cols;
      fields.sourceId = { derived: spec.derive.slice() };
      continue;
    }
    const candidates = Array.isArray(spec) ? spec : [spec];
    for (const c of candidates) {
      const i = index.get(normHeader(c));
      if (i !== undefined) { fields[f] = { header: headers[i], index: i }; break; }
    }
    if (Object.prototype.hasOwnProperty.call(userFields, f) && !fields[f]) {
      throw new ImportError(`mapping.fields.${f}: column ${JSON.stringify(spec)} is not in the file`, 'INVALID_INPUT', { field: `mapping.fields.${f}` });
    }
  }
  const used = new Set(Object.values(fields).filter((x) => x.index !== undefined).map((x) => x.index));
  if (derive) derive.forEach((i) => used.add(i));
  const unmapped = headers.filter((_, i) => !used.has(i));
  return { fields, derive, unmapped };
}

// ── Row preparation (pure) ───────────────────────────────────────────────────
function emptyStats() {
  return {
    excel_wrapper_stripped: 0, non_printing_removed: 0, whitespace_collapsed: 0,
    email_lowercased: 0, phone_normalised: 0, postcode_normalised: 0, name_split: 0,
    company_not_split: 0, type_from_company: 0, extra_values_to_notes: 0, address_parsed: 0,
  };
}

/**
 * One CSV row → { ok:true, data, meta } or { ok:false, rule, detail, field }.
 * data = Customer columns (+ sourceId, createdAt); meta = values used for dedupe / sampling.
 */
function prepareRow(cells, ctx) {
  const { map, stats, locale, opts, typeMap, dateFormat, sourceSystem } = ctx;
  const raw = {};
  const get = (f) => {
    const m = map.fields[f];
    if (!m || m.index === undefined) return '';
    const v = cleanValue(cells[m.index], stats, { multiline: f === 'notes' });
    raw[f] = v;
    return v;
  };
  const fail = (rule, detail, field) => ({ ok: false, rule, detail, field, raw });

  // Source id
  let sourceId;
  if (map.derive) {
    const basis = map.derive.map((i) => cleanValue(cells[i], stats).toLowerCase()).join('␟');
    if (!basis.replace(/␟/g, '')) return fail('missing_source_id', 'all derive columns are blank', 'sourceId');
    sourceId = `derived:${sha256(basis).slice(0, 20)}`;
  } else {
    sourceId = get('sourceId');
    if (!sourceId) return fail('missing_source_id', map.fields.sourceId ? `column "${map.fields.sourceId.header}" is blank` : 'no source id column mapped (map one, or derive one explicitly)', 'sourceId');
    if (sourceId.length > 191) return fail('too_long', 'source id longer than 191 characters', 'sourceId');
  }

  const notesExtra = [];
  // Archived
  const archivedRaw = get('archived');
  const archived = parseBool(archivedRaw);
  if (archived === undefined) return fail('invalid_boolean', `Archived "${archivedRaw}" is not TRUE/FALSE`, 'archived');
  if (archived && opts.excludeArchived) return { ok: false, excluded: true, rule: 'archived_out_of_scope', detail: 'archived in the source; options.excludeArchived', raw, sourceId };

  // Country (row value, else the brand's)
  const countryRaw = get('country');
  let country = normaliseCountry(countryRaw);
  if (country === undefined) {
    if (/^[A-Za-z]{2}$/.test(countryRaw)) country = countryRaw.toUpperCase();
    else return fail('unknown_country', `"${countryRaw}" — use a 2-letter ISO code`, 'country');
  }
  if (!country) country = locale.country;

  // Names / company — company names are never split into first / last name (a lesson from earlier customer imports)
  let company = get('company') || null;
  let firstName = get('firstName');
  let lastName = get('lastName');
  const fullName = get('fullName');
  const isCompanyRaw = get('isCompany');
  const isCompany = parseBool(isCompanyRaw);
  if (isCompany === undefined) return fail('invalid_boolean', `"${isCompanyRaw}" is not TRUE/FALSE`, 'isCompany');
  if (isCompany && !company && fullName && !firstName && !lastName) company = fullName;
  if (!firstName && !lastName) {
    if (company && (!fullName || displayKey(fullName) === displayKey(company))) {
      firstName = company; lastName = ''; stats.company_not_split += 1;
    } else if (fullName) {
      if (!company && looksLikeCompany(fullName)) {
        company = fullName; firstName = fullName; lastName = ''; stats.company_not_split += 1;
      } else {
        ({ firstName, lastName } = splitPersonName(fullName)); stats.name_split += 1;
      }
    } else if (company) {
      firstName = company; lastName = ''; stats.company_not_split += 1;
    }
  }
  if (!firstName && lastName) { firstName = lastName; lastName = ''; }
  if (!firstName) return fail('missing_name', 'no first / last / full / company name', 'firstName');

  // Type: explicit column (mapped through typeMap) > Is Company? > company present
  let type;
  const typeRaw = get('type');
  if (typeRaw) {
    type = typeMap[typeRaw.toLowerCase()];
    if (!type || !CUSTOMER_TYPES.includes(type)) return fail('unknown_type', `type "${typeRaw}" is not mapped (mapping.typeMap) to ${CUSTOMER_TYPES.join(' | ')}`, 'type');
  } else if (isCompany === true) { type = 'commercial'; stats.type_from_company += 1; }
  else if (isCompany === false) type = 'residential';
  else if (company) { type = 'commercial'; stats.type_from_company += 1; }
  else type = 'residential';

  // Email (first of a list; the rest go to notes)
  let email = null;
  const emailRaw = get('email');
  if (emailRaw) {
    const list = emailRaw.split(/[;,\s]+/).filter(Boolean);
    email = list[0];
    if (list.length > 1) { notesExtra.push(`Other email: ${list.slice(1).join(', ')}`); stats.extra_values_to_notes += 1; }
    if (email !== email.toLowerCase()) stats.email_lowercased += 1;
    email = email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail('invalid_email', `"${emailRaw}"`, 'email');
  }

  // Phones → E.164
  let phone = '';
  const phoneRaw = get('phone');
  const phones = phoneRaw ? phoneRaw.split(/\s*[;,/|]\s*/).filter(Boolean) : [];
  if (phones.length) {
    phone = normalisePhone(phones[0], country);
    if (!phone) return fail('invalid_phone', `"${phones[0]}" is not a valid ${country} phone number`, 'phone');
    if (phone !== phones[0]) stats.phone_normalised += 1;
    if (phones.length > 1) { notesExtra.push(`Other phone: ${phones.slice(1).join(', ')}`); stats.extra_values_to_notes += 1; }
  }
  const alt = get('phoneAlt');
  if (alt) {
    const n = normalisePhone(alt, country);
    if (!phone && n) { phone = n; stats.phone_normalised += 1; }
    else if (n !== phone) { notesExtra.push(`Alt phone: ${n || alt}`); stats.extra_values_to_notes += 1; }
  }
  if (!phone) {
    if (opts.missingPhone !== 'blank') return fail('missing_phone', 'no phone number (options.missingPhone = "blank" stores an empty phone — needs client approval at Gate 2)', 'phone');
    phone = '';
  }

  // Address
  let address = get('address');
  let addressLine2 = get('addressLine2') || null;
  let city = get('city') || null;
  let state = get('state') || null;
  let zip = get('zip') || null;
  const full = get('addressFull');
  if (!address && full) {
    const p = parseFullAddress(full, country);
    address = p.address; addressLine2 = addressLine2 || p.addressLine2; city = city || p.city; state = state || p.state; zip = zip || p.zip;
    stats.address_parsed += 1;
  }
  if (country === 'US' && state && /^[a-z]{2}$/i.test(state)) state = state.toUpperCase();
  if (zip) {
    const z = zip.toUpperCase();
    if (z !== zip) stats.postcode_normalised += 1;
    zip = z;
    if (country === 'US' && /^\d{3,4}$/.test(zip)) return fail('invalid_postcode', `ZIP "${zip}" has ${zip.length} digits — leading zero lost (file opened and saved in Excel?)`, 'zip');
  }
  const extra = get('extraAddress');
  let multiSite = false;
  if (extra && displayKey(extra) !== displayKey(address || full)) {
    multiSite = true; notesExtra.push(`Other address: ${extra}`); stats.extra_values_to_notes += 1;
  }
  let addr;
  try {
    addr = validateAddress({ address: address || '', addressLine2, city, state, zip, country }, { create: true }, locale);
  } catch (e) {
    return fail(e.extra && e.extra.code === 'REQUIRED' ? 'address_required' : 'invalid_postcode', e.message, e.extra && e.extra.field);
  }
  if (addr.zip && addr.zip !== zip) stats.postcode_normalised += 1;

  // Dates / amounts
  let createdAt = null;
  try { createdAt = parseDate(get('createdAt'), dateFormat); } catch (e) { return fail(e.rule, `created date ${e.detail}`, 'createdAt'); }
  let lifetimeValueCents = null;
  try { lifetimeValueCents = parseCents(get('lifetimeValue')); } catch (e) { return fail(e.rule, `lifetime value ${e.detail}`, 'lifetimeValue'); }

  const tags = get('tags');
  if (tags) notesExtra.push(`Tags: ${tags}`);
  const baseNotes = get('notes');
  const notes = [baseNotes, ...notesExtra].filter(Boolean).join('\n') || null;
  const taxNumber = get('taxNumber') || null;

  const data = {
    firstName, lastName: lastName || '', company, email, phone,
    address: addr.address || '', addressLine2: addr.addressLine2 || null, city: addr.city || null,
    state: addr.state || null, zip: addr.zip || null, country: addr.country || country,
    type, taxNumber, notes,
  };
  for (const [k, max] of Object.entries(MAX)) {
    if (data[k] != null && String(data[k]).length > max) return fail('too_long', `${k} longer than ${max} characters`, k);
  }
  return {
    ok: true, sourceId, data, raw,
    createdAt, sourceSystem,
    meta: { lifetimeValueCents, multiSite, emailKey: email || '', phoneKey: phone || '', postKey: postKey(data.zip), nameKey: displayKey(displayName(data)) },
  };
}

// ── Decisions file ───────────────────────────────────────────────────────────
/** JSON { "<sourceId>": "merge"|"create"|"exclude" | {decision, target, decidedBy} } or CSV with key,decision[,target,decided_by] */
function parseDecisions(input) {
  if (input == null || input === '') return {};
  if (typeof input === 'object' && !Buffer.isBuffer(input)) return normaliseDecisions(input);
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const t = text.trim();
  if (!t) return {};
  if (t.startsWith('{')) {
    let obj; try { obj = JSON.parse(t); } catch (e) { throw new ImportError(`decisions: invalid JSON (${e.message})`, 'INVALID_JSON', { field: 'decisions' }); }
    return normaliseDecisions(obj.decisions && typeof obj.decisions === 'object' ? obj.decisions : obj);
  }
  const { headers, rows } = parseCsv(t);
  const h = headers.map(normHeader);
  const ki = h.indexOf('key'); const di = h.indexOf('decision');
  if (ki < 0 || di < 0) throw new ImportError('decisions CSV needs columns key and decision (fill in the merge-candidates.csv from a dry run)', 'INVALID_INPUT', { field: 'decisions' });
  const ti = h.indexOf('target'); const bi = h.indexOf('decided_by');
  const out = {};
  for (const r of rows) {
    const key = (r[ki] || '').trim(); const decision = (r[di] || '').trim().toLowerCase();
    if (!key || !decision) continue;
    out[key] = { decision, target: ti >= 0 ? (r[ti] || '').trim() || null : null, decidedBy: bi >= 0 ? (r[bi] || '').trim() || null : null };
  }
  return normaliseDecisions(out);
}

function normaliseDecisions(obj) {
  const out = {};
  for (const [key, v] of Object.entries(obj || {})) {
    const d = typeof v === 'string' ? { decision: v } : (v || {});
    const decision = String(d.decision || '').toLowerCase();
    if (!['merge', 'create', 'exclude'].includes(decision)) throw new ImportError(`decisions["${key}"]: decision must be merge, create or exclude`, 'INVALID_ENUM', { field: 'decisions', allowed: ['merge', 'create', 'exclude'] });
    const target = d.target ? String(d.target) : null;
    if (target && !/^(customer|row):\d+$/.test(target)) throw new ImportError(`decisions["${key}"]: target must look like customer:12 or row:7`, 'INVALID_INPUT', { field: 'decisions' });
    out[key] = { decision, target, decidedBy: d.decidedBy || d.decided_by || null };
  }
  return out;
}

// ── Planning ─────────────────────────────────────────────────────────────────
/**
 * @param {object} p
 * @param {{name:string, content:Buffer|string}[]} p.files  one or more CSV files with the same header row
 * @param {string} p.source            housecallpro | jobber | generic
 * @param {object} [p.mapping]         { sourceSystem?, fields?, dateFormat?, typeMap?, options? }
 * @param {object} [p.decisions]       parsed decisions (parseDecisions)
 * @param {object} [p.options]         overrides DEFAULT_OPTIONS (mapping.options apply first)
 * @param {object} [p.prisma]          defaults to helpers/prisma
 */
async function planCustomerImport({ files, source = 'generic', mapping = {}, decisions = {}, options = {}, prisma, locale = getLocale(), actor = null } = {}) {
  prisma = prisma || require('./prisma');
  if (!Array.isArray(files) || !files.length) throw new ImportError('a CSV file is required', 'REQUIRED', { field: 'file' });
  for (const src of [(mapping && mapping.options) || {}, options || {}]) {
    for (const k of Object.keys(src)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, k)) throw new ImportError(`unknown option "${k}" (${Object.keys(DEFAULT_OPTIONS).join(', ')})`, 'INVALID_INPUT', { field: `options.${k}` });
    }
  }
  const opts = { ...DEFAULT_OPTIONS, ...((mapping && mapping.options) || {}), ...options };
  opts.excludeArchived = opts.excludeArchived === true || opts.excludeArchived === 'true';
  opts.sharedEmailThreshold = Math.max(2, Math.min(1000, Number(opts.sharedEmailThreshold) || DEFAULT_OPTIONS.sharedEmailThreshold));
  opts.spotCheckSize = Math.max(1, Math.min(200, Number(opts.spotCheckSize) || DEFAULT_OPTIONS.spotCheckSize));
  opts.maxRows = Math.max(1, Math.min(DEFAULT_OPTIONS.maxRows, Number(opts.maxRows) || DEFAULT_OPTIONS.maxRows));
  if (!['hold', 'create'].includes(opts.undecided)) throw new ImportError('options.undecided must be hold or create', 'INVALID_ENUM', { field: 'undecided', allowed: ['hold', 'create'] });
  if (!['error', 'blank'].includes(opts.missingPhone)) throw new ImportError('options.missingPhone must be error or blank', 'INVALID_ENUM', { field: 'missingPhone', allowed: ['error', 'blank'] });
  opts.batchSize = Math.max(1, Math.min(1000, Number(opts.batchSize) || DEFAULT_OPTIONS.batchSize));
  const preset = PRESETS[source];
  if (!preset) throw new ImportError(`Unknown source "${source}" — use one of: ${Object.keys(PRESETS).join(', ')}`, 'INVALID_ENUM', { field: 'source', allowed: Object.keys(PRESETS) });
  const sourceSystem = String((mapping && mapping.sourceSystem) || preset.sourceSystem).trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/i.test(sourceSystem)) throw new ImportError('sourceSystem must be 1–48 letters, digits, . _ -', 'INVALID_INPUT', { field: 'sourceSystem' });
  const dateFormat = (mapping && mapping.dateFormat !== undefined) ? mapping.dateFormat : preset.dateFormat;
  if (dateFormat != null && !['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'].includes(dateFormat)) throw new ImportError('dateFormat must be YYYY-MM-DD, MM/DD/YYYY or DD/MM/YYYY', 'INVALID_ENUM', { field: 'dateFormat', allowed: ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'] });
  const typeMap = { ...DEFAULT_TYPE_MAP };
  for (const [k, v] of Object.entries((mapping && mapping.typeMap) || {})) typeMap[String(k).toLowerCase()] = String(v).toLowerCase();

  // Read + checksum every file (Gate 1)
  const fileInfo = [];
  let headers = null; let map = null;
  const rows = []; // { ref, file, line, cells }
  for (const f of files) {
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8');
    let parsed;
    try { parsed = parseCsv(buf); } catch (e) { throw new ImportError(`${f.name}: ${e.message}`, 'INVALID_CSV', { file: f.name, line: e.line }); }
    if (!parsed.headers.length) throw new ImportError(`${f.name}: the file is empty`, 'INVALID_CSV', { file: f.name });
    if (!headers) { headers = parsed.headers; map = resolveMapping(headers, source, mapping); }
    else if (parsed.headers.map(normHeader).join('\u0001') !== headers.map(normHeader).join('\u0001')) {
      throw new ImportError(`${f.name}: header row differs from ${files[0].name}`, 'INVALID_CSV', { file: f.name });
    }
    fileInfo.push({ name: f.name, bytes: buf.length, sha256: sha256(buf), rows: parsed.rows.length });
    parsed.rows.forEach((cells, i) => rows.push({ file: f.name, line: parsed.lineOf[i], cells }));
  }
  if (rows.length > opts.maxRows) throw new ImportError(`too many rows (${rows.length} > ${opts.maxRows}) — split the file`, 'TOO_MANY_ROWS');

  // Existing state
  const existing = await prisma.customer.findMany({
    select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true, address: true, addressLine2: true, city: true, state: true, zip: true, country: true, type: true, taxNumber: true, notes: true, sourceSystem: true, sourceId: true, createdAt: true, version: true },
  });
  const linkProvider = `import:${sourceSystem}`;
  const links = await prisma.integrationLink.findMany({ where: { provider: linkProvider, entity: 'customer' }, select: { remoteId: true, localId: true } });
  const linkBySource = new Map(links.map((l) => [l.remoteId, l.localId]));
  const byId = new Map(existing.map((c) => [c.id, c]));
  const bySource = new Map(existing.filter((c) => c.sourceSystem === sourceSystem && c.sourceId).map((c) => [c.sourceId, c]));

  const stats = emptyStats();
  const ctx = { map, stats, locale, opts, typeMap, dateFormat, sourceSystem };
  const prepared = rows.map((r, i) => {
    const p = prepareRow(r.cells, ctx);
    return { ...p, row: i + 1, file: r.file, line: r.line, cells: r.cells };
  });

  // Shared emails: distinct identities per email across DB + file (never merge on them)
  const emailIds = new Map();
  const addEmail = (e, id) => { if (!e) return; if (!emailIds.has(e)) emailIds.set(e, new Set()); emailIds.get(e).add(id); };
  existing.forEach((c) => addEmail((c.email || '').toLowerCase(), `c${c.id}`));
  prepared.forEach((p) => { if (p.ok) addEmail(p.meta.emailKey, `s${p.sourceId}`); });
  const sharedEmails = [...emailIds].filter(([, s]) => s.size >= opts.sharedEmailThreshold).map(([e, s]) => ({ email: e, identities: s.size }));
  const shared = new Set(sharedEmails.map((s) => s.email));

  // Candidate pool: existing customers + accepted earlier rows
  const keyOfExisting = (c) => {
    const ctry = c.country || locale.country;
    return { emailKey: (c.email || '').toLowerCase(), phoneKey: normalisePhone(c.phone, ctry) || '', postKey: postKey(c.zip), nameKey: displayKey(displayName(c)) };
  };
  const pool = existing.map((c) => ({ kind: 'customer', id: c.id, ref: `customer:${c.id}`, keys: keyOfExisting(c), rec: c }));

  function findCandidate(p) {
    const k = p.meta;
    const rules = [
      { rule: 'auto_merge', why: 'same email and same phone or postcode (§5.2 rule 3)', test: (c) => k.emailKey && !shared.has(k.emailKey) && c.keys.emailKey === k.emailKey && ((k.phoneKey && c.keys.phoneKey === k.phoneKey) || (k.postKey && c.keys.postKey === k.postKey)) },
      { rule: 'review', why: 'same phone and same postcode (§5.2 rule 4)', test: (c) => k.phoneKey && k.postKey && c.keys.phoneKey === k.phoneKey && c.keys.postKey === k.postKey },
      { rule: 'review', why: 'same display name and same postcode (§5.2 rule 5)', test: (c) => k.nameKey && k.postKey && c.keys.nameKey === k.nameKey && c.keys.postKey === k.postKey },
    ];
    for (const r of rules) {
      const hit = pool.find(r.test);
      if (hit) return { ...r, candidate: hit };
    }
    return null;
  }

  const outcomes = [];
  const firstRowOfSource = new Map();
  const mergeCandidates = [];
  const plannedCreates = new Map(); // row → pool entry
  for (const p of prepared) {
    const base = { row: p.row, file: p.file, line: p.line, sourceId: p.sourceId || (p.raw && p.raw.sourceId) || null };
    if (!p.ok) {
      outcomes.push({ ...base, outcome: p.excluded ? 'excluded' : 'errored', rule: p.rule, detail: p.detail, field: p.field || null });
      continue;
    }
    // Repeated source id in the file
    if (firstRowOfSource.has(p.sourceId)) {
      const first = firstRowOfSource.get(p.sourceId);
      const firstOutcome = outcomes[first.row - 1];
      if (first.meta.nameKey === p.meta.nameKey && firstOutcome && ['created', 'updated'].includes(firstOutcome.outcome)) {
        const addr = [p.data.address, p.data.addressLine2, p.data.city, p.data.state, p.data.zip].filter(Boolean).join(', ');
        outcomes.push({ ...base, outcome: 'merged', rule: 'same_source_id_extra_row', detail: `same source id and name as row ${first.row}; its address goes to that customer's notes`, target: `row:${first.row}`, customerId: firstOutcome.customerId, appendNote: addr ? `Other address: ${addr}` : null, prep: p });
      } else {
        outcomes.push({ ...base, outcome: 'excluded', rule: 'duplicate_source_id_conflict', detail: `source id already used by row ${first.row} with a different name (or that row was not loaded)` });
      }
      continue;
    }
    firstRowOfSource.set(p.sourceId, p);

    // 1. same source system + id → update (idempotent re-run)
    const ex = bySource.get(p.sourceId);
    if (ex) {
      const changes = diffFields(ex, p);
      outcomes.push({ ...base, outcome: 'updated', rule: changes.length ? 'same_source_id' : 'same_source_id_unchanged', customerId: ex.id, changes, prep: p, before: pick(ex, [...changes, 'version']) });
      continue;
    }
    if (linkBySource.has(p.sourceId)) {
      outcomes.push({ ...base, outcome: 'merged', rule: 'previously_merged', detail: 'merged into this customer by an earlier run (IntegrationLink)', customerId: linkBySource.get(p.sourceId), previous: true });
      continue;
    }
    // 3–5. dedupe candidates
    const cand = findCandidate(p);
    const decision = decisions[p.sourceId];
    if (cand) {
      const entry = {
        key: p.sourceId, rule: cand.rule, why: cand.why, row: p.row,
        source: { name: displayName(p.data), email: p.data.email, phone: p.data.phone, postcode: p.data.zip, address: p.data.address },
        candidate: { ref: cand.candidate.ref, name: displayName(cand.candidate.rec), email: cand.candidate.rec.email, phone: cand.candidate.rec.phone, postcode: cand.candidate.rec.zip, address: cand.candidate.rec.address },
        decision: decision ? decision.decision : null, decidedBy: decision ? decision.decidedBy : null,
      };
      mergeCandidates.push(entry);
      if (!decision) {
        if (opts.undecided === 'create') {
          outcomes.push({ ...base, outcome: 'created', rule: 'created_undecided_candidate', detail: `possible duplicate of ${cand.candidate.ref} (${cand.why}) — created because options.undecided = create`, prep: p, flagged: true });
          const e = { kind: 'row', id: p.row, ref: `row:${p.row}`, keys: p.meta, rec: p.data };
          pool.push(e); plannedCreates.set(p.row, e);
        } else {
          outcomes.push({ ...base, outcome: 'excluded', rule: 'pending_merge_decision', detail: `possible duplicate of ${cand.candidate.ref} (${cand.why}) — decide in merge-candidates.csv and re-run` });
        }
        continue;
      }
    }
    if (decision && decision.decision === 'exclude') {
      outcomes.push({ ...base, outcome: 'excluded', rule: 'decision_exclude', detail: `excluded by decision${decision.decidedBy ? ` (${decision.decidedBy})` : ''}` });
      continue;
    }
    if (decision && decision.decision === 'merge') {
      const target = decision.target || (cand && cand.candidate.ref);
      if (!target) { outcomes.push({ ...base, outcome: 'errored', rule: 'merge_without_target', detail: 'decision merge but no candidate / target' }); continue; }
      const [kind, idStr] = target.split(':'); const id = Number(idStr);
      if (kind === 'customer') {
        const t = byId.get(id);
        if (!t) { outcomes.push({ ...base, outcome: 'errored', rule: 'merge_target_missing', detail: `${target} does not exist` }); continue; }
        const fill = fillFields(t, p);
        outcomes.push({ ...base, outcome: 'merged', rule: cand ? `decision_merge_${cand.rule}` : 'decision_merge', detail: `merged into ${target}${decision.decidedBy ? ` (decided by ${decision.decidedBy})` : ''}`, customerId: id, target, fill, prep: p, before: pick(t, [...Object.keys(fill), 'notes', 'createdAt', 'version']) });
      } else {
        if (!plannedCreates.has(id)) { outcomes.push({ ...base, outcome: 'excluded', rule: 'merge_target_not_loaded', detail: `${target} is not being created in this run` }); continue; }
        outcomes.push({ ...base, outcome: 'merged', rule: cand ? `decision_merge_${cand.rule}` : 'decision_merge', detail: `merged into ${target}`, target, prep: p });
      }
      continue;
    }
    // create (no candidate, or decision create)
    outcomes.push({ ...base, outcome: 'created', rule: decision ? 'decision_create' : 'new', prep: p });
    const e = { kind: 'row', id: p.row, ref: `row:${p.row}`, keys: p.meta, rec: p.data };
    pool.push(e); plannedCreates.set(p.row, e);
  }

  const report = buildReport({ fileInfo, headers, map, source, sourceSystem, opts, dateFormat, stats, outcomes, prepared, mergeCandidates, sharedEmails, actor });
  return { report, outcomes, opts, sourceSystem, linkProvider, prisma };
}

function pick(obj, keys) {
  const out = {};
  for (const k of new Set(keys)) out[k] = obj[k] instanceof Date ? obj[k].toISOString() : obj[k];
  return out;
}

const same = (a, b) => (a == null || a === '' ? null : String(a)) === (b == null || b === '' ? null : String(b));

/** Fields the source would change on an existing customer (blank source values never clear). */
function diffFields(ex, p) {
  const changes = [];
  for (const f of WRITE_FIELDS) {
    const v = p.data[f];
    if (v == null || v === '') continue;
    if (f === 'notes' && ex.notes && ex.notes.startsWith(v)) continue; // merged notes appended after the source notes
    if (!same(ex[f], v)) changes.push(f);
  }
  return changes;
}

/** Merge: only fill the target's blank fields, never overwrite. */
function fillFields(target, p) {
  const fill = {};
  for (const f of WRITE_FIELDS) {
    if (f === 'notes' || f === 'type' || f === 'firstName' || f === 'lastName') continue;
    if ((target[f] == null || target[f] === '') && p.data[f] != null && p.data[f] !== '') fill[f] = p.data[f];
  }
  return fill;
}

// ── Report ───────────────────────────────────────────────────────────────────
const OUTCOMES = ['created', 'updated', 'merged', 'excluded', 'errored'];

function tally(outcomes) {
  const c = { sourceRows: outcomes.length, created: 0, updated: 0, updatedUnchanged: 0, merged: 0, excluded: 0, errored: 0 };
  for (const o of outcomes) {
    c[o.outcome] += 1;
    if (o.outcome === 'updated' && !(o.changes && o.changes.length)) c.updatedUnchanged += 1;
  }
  c.unexplained = c.sourceRows - OUTCOMES.reduce((s, k) => s + c[k], 0);
  return c;
}

function buildReport({ fileInfo, headers, map, source, sourceSystem, opts, dateFormat, stats, outcomes, prepared, mergeCandidates, sharedEmails, actor }) {
  const okRows = prepared.filter((p) => p.ok);
  const coverage = {};
  for (const f of [...WRITE_FIELDS, 'createdAt']) {
    const filled = okRows.filter((p) => (f === 'createdAt' ? p.createdAt : !isBlank(p.data[f]))).length;
    coverage[f] = { filled, blank: okRows.length - filled, pct: okRows.length ? Math.round((filled / okRows.length) * 1000) / 10 : 0 };
  }
  const sourceColumns = headers.map((h, i) => {
    const filled = prepared.filter((p) => !isBlank(p.cells[i])).length;
    const mappedTo = Object.entries(map.fields).filter(([, m]) => m.index === i).map(([f]) => f);
    if (map.derive && map.derive.includes(i)) mappedTo.push('sourceId(derived)');
    return { header: h, filled, mappedTo };
  });
  const loaded = outcomes.filter((o) => ['created', 'updated', 'merged'].includes(o.outcome) && o.prep);
  const byType = {}; const byCountry = {};
  for (const o of loaded.filter((x) => x.outcome !== 'merged')) {
    byType[o.prep.data.type] = (byType[o.prep.data.type] || 0) + 1;
    byCountry[o.prep.data.country] = (byCountry[o.prep.data.country] || 0) + 1;
  }
  const exceptions = outcomes.filter((o) => o.outcome === 'excluded' || o.outcome === 'errored' || o.flagged).map((o) => ({
    file: o.file, row: o.row, line: o.line, source_id: o.sourceId, outcome: o.outcome, rule: o.rule, field: o.field || '', detail: o.detail || '', decision: '', decided_by: '',
  }));
  const byRule = {};
  for (const o of outcomes) { const k = `${o.outcome}:${o.rule}`; byRule[k] = (byRule[k] || 0) + 1; }
  const counts = tally(outcomes);
  return {
    kind: 'customer-import',
    version: 1,
    runId: `imp_${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`,
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    committed: false,
    actor,
    source, sourceSystem, dateFormat,
    options: { ...opts },
    files: fileInfo,
    mapping: Object.fromEntries(Object.entries(map.fields).map(([f, m]) => [f, m.header || m])),
    derivedSourceIds: !!map.derive,
    unmappedColumns: map.unmapped,
    sourceColumns,
    counts,
    gate3: { equation: 'sourceRows = created + updated + merged + excluded + errored', holds: counts.unexplained === 0 },
    byRule, byType, byCountry,
    cleaning: stats,
    fieldCoverage: coverage,
    sharedEmails,
    mergeCandidates,
    pendingDecisions: mergeCandidates.filter((m) => !m.decision).length,
    exceptions,
    spotCheck: spotCheck(outcomes, map, headers, fileInfo, opts),
    rows: outcomes.map(publicOutcome),
  };
}

function publicOutcome(o) {
  const out = { row: o.row, file: o.file, line: o.line, sourceId: o.sourceId, outcome: o.outcome, rule: o.rule };
  for (const k of ['detail', 'field', 'customerId', 'target', 'changes', 'before', 'fill', 'flagged']) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

/** Gate 5: stratified sample for the client's side-by-side check. */
function spotCheck(outcomes, map, headers, fileInfo, opts) {
  const loaded = outcomes.filter((o) => ['created', 'updated', 'merged'].includes(o.outcome) && o.prep);
  const rnd = seededRandom(fileInfo[0] ? fileInfo[0].sha256 : '1');
  const chosen = new Map();
  const take = (list, n, stratum) => { for (const o of list) { if ([...chosen.values()].filter((c) => c.stratum === stratum).length >= n) break; if (!chosen.has(o.row)) chosen.set(o.row, { o, stratum }); } };
  const shuffled = loaded.slice().sort(() => rnd() - 0.5);
  const size = opts.spotCheckSize || 25;
  const withValue = loaded.filter((o) => o.prep.meta.lifetimeValueCents != null).sort((a, b) => b.prep.meta.lifetimeValueCents - a.prep.meta.lifetimeValueCents);
  const notes = [];
  if (withValue.length) take(withValue, 10, 'top_by_lifetime_value'); else notes.push('no lifetime value column mapped — "top 10 by revenue" stratum filled at random');
  take(shuffled.filter((o) => o.prep.data.type !== 'residential'), 5, 'commercial');
  const multi = shuffled.filter((o) => o.prep.meta.multiSite || o.rule === 'same_source_id_extra_row');
  take(multi, 5, 'multiple_sites');
  if (!multi.length) notes.push('no customers with more than one address in the file');
  take(shuffled.filter((o) => o.outcome === 'merged'), 3, 'merged');
  take(shuffled, Math.max(0, size - chosen.size), 'random');
  const sample = [...chosen.values()].slice(0, size).map(({ o, stratum }, i) => ({
    sample: i + 1, stratum, row: o.row, sourceId: o.sourceId, outcome: o.outcome, customerId: o.customerId || null,
    target: o.target || null,
    sourceValues: Object.fromEntries(Object.entries(map.fields).filter(([, m]) => m.index !== undefined).map(([f, m]) => [m.header, o.prep.cells[m.index] == null ? '' : o.prep.cells[m.index]])),
    mbcValues: { ...o.prep.data, createdAt: o.prep.createdAt ? o.prep.createdAt.toISOString() : null },
  }));
  return { size: sample.length, notes, sample };
}

// ── Commit ───────────────────────────────────────────────────────────────────
async function commitCustomerImport(plan) {
  const { report, outcomes, opts, sourceSystem, linkProvider, prisma } = plan;
  report.mode = 'commit';
  report.batches = [];
  const rowCustomer = new Map(); // row → customer id (created in this run)
  const work = outcomes.filter((o) => ['created', 'updated', 'merged'].includes(o.outcome) && !o.previous);
  let aborted = null;
  for (let b = 0; b < work.length; b += opts.batchSize) {
    const batch = work.slice(b, b + opts.batchSize);
    const batchNo = report.batches.length + 1;
    if (aborted) {
      for (const o of batch) { o.outcome = 'errored'; o.rule = 'not_attempted_after_batch_failure'; o.detail = `batch ${aborted.batch} failed: ${aborted.error}`; }
      report.batches.push({ batch: batchNo, rows: batch.length, status: 'not_attempted' });
      continue;
    }
    const createdHere = new Map();
    try {
      await prisma.$transaction(async (tx) => {
        for (const o of batch) {
          const p = o.prep;
          if (o.outcome === 'created') {
            const c = await tx.customer.create({ data: { ...p.data, sourceSystem, sourceId: p.sourceId, ...(p.createdAt ? { createdAt: p.createdAt } : {}) }, select: { id: true } });
            createdHere.set(o.row, c.id); o.customerId = c.id;
          } else if (o.outcome === 'updated') {
            if (o.changes.length) {
              const cur = await tx.customer.findUnique({ where: { id: o.customerId } });
              if (!cur) throw new Error(`customer ${o.customerId} disappeared during the import`);
              o.before = pick(cur, [...o.changes, 'version']);
              const data = Object.fromEntries(o.changes.map((f) => [f, p.data[f]]));
              await tx.customer.update({ where: { id: o.customerId }, data: { ...data, version: { increment: 1 } } });
            }
          } else if (o.outcome === 'merged') {
            let targetId = o.customerId;
            if (!targetId) {
              const r = Number(o.target.split(':')[1]);
              targetId = createdHere.get(r) || rowCustomer.get(r);
              if (!targetId) throw new Error(`merge target ${o.target} was not created`);
              o.customerId = targetId;
            }
            const t = await tx.customer.findUnique({ where: { id: targetId } });
            if (!t) throw new Error(`merge target customer ${targetId} disappeared during the import`);
            // a target may have changed since planning: only fill what is still blank
            if (o.fill) for (const k of Object.keys(o.fill)) if (t[k] != null && t[k] !== '') delete o.fill[k];
            o.before = pick(t, [...Object.keys(o.fill || {}), 'notes', 'createdAt', 'version']);
            const note = o.appendNote || `[merged ${sourceSystem}:${p.sourceId}${o.rule.startsWith('decision') ? ` — ${displayName(p.data)}` : ''}]`;
            const hasNote = !!(t.notes && t.notes.split('\n').includes(note));
            const older = p.createdAt && p.createdAt < t.createdAt;
            if (hasNote && !older && !Object.keys(o.fill || {}).length) {
              // re-run of an extra-address row already folded in: nothing to write
              delete o.before; o.noop = true;
            } else {
              const data = { ...(o.fill || {}), version: { increment: 1 } };
              if (!hasNote) data.notes = [t.notes, note].filter(Boolean).join('\n').slice(0, MAX.notes);
              if (older) data.createdAt = p.createdAt;
              await tx.customer.update({ where: { id: targetId }, data });
            }
            if (o.rule !== 'same_source_id_extra_row') {
              await tx.integrationLink.create({ data: { provider: linkProvider, entity: 'customer', remoteId: p.sourceId, localId: targetId, data: { runId: report.runId, rule: o.rule } } });
            }
          }
        }
      }, { timeout: 120000, maxWait: 20000 });
      for (const [r, id] of createdHere) rowCustomer.set(r, id);
      report.batches.push({ batch: batchNo, rows: batch.length, status: 'committed' });
    } catch (e) {
      aborted = { batch: batchNo, error: String(e.message || e).slice(0, 300) };
      for (const o of batch) {
        if (o.outcome === 'created') delete o.customerId;
        o.outcome = 'errored'; o.rule = 'batch_rolled_back'; o.detail = `batch ${batchNo} rolled back: ${aborted.error}`;
      }
      report.batches.push({ batch: batchNo, rows: batch.length, status: 'rolled_back', error: aborted.error });
    }
  }
  report.aborted = aborted;
  report.committed = !aborted;
  report.counts = tally(outcomes);
  report.gate3.holds = report.counts.unexplained === 0;
  report.rows = outcomes.map(publicOutcome);
  // refresh sample ids now that customers exist
  for (const s of report.spotCheck.sample) {
    const o = outcomes[s.row - 1];
    s.customerId = o.customerId || null; s.outcome = o.outcome;
  }
  report.exceptions = outcomes.filter((o) => o.outcome === 'excluded' || o.outcome === 'errored' || o.flagged).map((o) => ({
    file: o.file, row: o.row, line: o.line, source_id: o.sourceId, outcome: o.outcome, rule: o.rule, field: o.field || '', detail: o.detail || '', decision: '', decided_by: '',
  }));
  report.byRule = {};
  for (const o of outcomes) { const k = `${o.outcome}:${o.rule}`; report.byRule[k] = (report.byRule[k] || 0) + 1; }
  return report;
}

/**
 * Roll back a committed run from its report. Created customers are deleted while they still
 * carry the run's source id and have no jobs / communications; updated and merged customers
 * get their `before` values back while their version is still the one this run produced.
 * Anything that cannot be undone safely is listed in `skipped`.
 */
async function undoCustomerImport(report, { prisma } = {}) {
  prisma = prisma || require('./prisma');
  if (!report || report.kind !== 'customer-import' || report.mode !== 'commit') throw new ImportError('not a committed customer-import report', 'INVALID_INPUT');
  const result = { runId: report.runId, deleted: 0, restored: 0, unlinked: 0, skipped: [] };
  const rows = report.rows.slice().reverse();
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      if (r.outcome === 'merged' && r.customerId) {
        const link = await tx.integrationLink.deleteMany({ where: { provider: `import:${report.sourceSystem}`, entity: 'customer', remoteId: r.sourceId, localId: r.customerId } });
        result.unlinked += link.count;
      }
    }
    // Restore before-images per customer: the run bumped the version once per change, so the
    // current version must be (last before.version + 1); the earliest before-image of each
    // field wins. One version increment for the restore.
    const touched = new Map();
    for (const r of report.rows) {
      if (!r.customerId || !r.before || !['updated', 'merged'].includes(r.outcome)) continue;
      if (r.outcome === 'updated' && !(r.changes && r.changes.length)) continue;
      if (!touched.has(r.customerId)) touched.set(r.customerId, []);
      touched.get(r.customerId).push(r);
    }
    for (const [id, list] of touched) {
      const c = await tx.customer.findUnique({ where: { id }, select: { version: true } });
      if (!c) continue;
      const expected = list[list.length - 1].before.version + 1;
      if (c.version !== expected) { result.skipped.push({ customerId: id, rows: list.map((r) => r.row), reason: 'edited since the import (version changed) — restore by hand' }); continue; }
      const data = {};
      for (const r of list.slice().reverse()) { const { version, ...fields } = r.before; Object.assign(data, fields); }
      if (data.createdAt) data.createdAt = new Date(data.createdAt);
      await tx.customer.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      result.restored += 1;
    }
    for (const r of rows) {
      if (r.outcome !== 'created' || !r.customerId) continue;
      const c = await tx.customer.findUnique({ where: { id: r.customerId }, select: { sourceSystem: true, sourceId: true, _count: { select: { jobs: true, communications: true } } } });
      if (!c) continue;
      if (c.sourceSystem !== report.sourceSystem || c.sourceId !== r.sourceId) { result.skipped.push({ row: r.row, customerId: r.customerId, reason: 'source id changed' }); continue; }
      if (c._count.jobs || c._count.communications) { result.skipped.push({ row: r.row, customerId: r.customerId, reason: 'has jobs or communications now' }); continue; }
      const links = await tx.integrationLink.count({ where: { localId: r.customerId, entity: 'customer' } });
      if (links) { result.skipped.push({ row: r.row, customerId: r.customerId, reason: 'other rows were merged into it' }); continue; }
      await tx.customer.delete({ where: { id: r.customerId } });
      result.deleted += 1;
    }
  }, { timeout: 120000 });
  return result;
}

// ── Renderers ────────────────────────────────────────────────────────────────
function renderMarkdown(r) {
  const c = r.counts;
  const n = (x) => Number(x).toLocaleString('en-US');
  const lines = [];
  lines.push(`# Customer import — ${r.mode === 'commit' ? (r.committed ? 'COMMITTED' : 'COMMIT FAILED (partial, see batches)') : 'DRY RUN (nothing written)'}`);
  lines.push('');
  lines.push(`Run \`${r.runId}\` · ${r.generatedAt} · source \`${r.source}\` → sourceSystem \`${r.sourceSystem}\`${r.derivedSourceIds ? ' · **source ids DERIVED from row values (weak — confirm at Gate 2)**' : ''}`);
  lines.push('');
  lines.push('## Gate 1 — files');
  lines.push('| file | rows | bytes | sha256 |'); lines.push('|---|---:|---:|---|');
  for (const f of r.files) lines.push(`| ${f.name} | ${n(f.rows)} | ${n(f.bytes)} | \`${f.sha256}\` |`);
  lines.push('');
  lines.push('## Gate 3 — record counts');
  lines.push('```');
  lines.push('entity     source  created  updated  merged  excluded  errored  unexplained');
  lines.push(`customers ${String(n(c.sourceRows)).padStart(7)} ${String(n(c.created)).padStart(8)} ${String(n(c.updated)).padStart(8)} ${String(n(c.merged)).padStart(7)} ${String(n(c.excluded)).padStart(9)} ${String(n(c.errored)).padStart(8)} ${String(n(c.unexplained)).padStart(12)}`);
  lines.push('```');
  lines.push(`${r.gate3.holds ? 'PASS' : 'FAIL'}: ${r.gate3.equation}. Updated includes ${n(c.updatedUnchanged)} unchanged row(s).`);
  if (r.pendingDecisions) lines.push(`\n**${r.pendingDecisions} merge decision(s) pending** — fill in merge-candidates.csv (decision = merge | create | exclude) and re-run with it as the decisions file.`);
  if (r.aborted) lines.push(`\n**Batch ${r.aborted.batch} rolled back:** ${r.aborted.error}. Later batches were not attempted. Fix and re-run (idempotent).`);
  lines.push('');
  lines.push('### Outcomes by rule'); lines.push('| outcome:rule | rows |'); lines.push('|---|---:|');
  for (const [k, v] of Object.entries(r.byRule).sort()) lines.push(`| ${k} | ${n(v)} |`);
  lines.push('');
  lines.push('### Counts by type (G3 spot SQL: `SELECT type, count(*) FROM "Customer" WHERE "sourceSystem" = …`)');
  lines.push('| type | rows |'); lines.push('|---|---:|');
  for (const [k, v] of Object.entries(r.byType)) lines.push(`| ${k} | ${n(v)} |`);
  lines.push('');
  lines.push('## Gate 2 — mapping, cleaning, dedupe');
  lines.push('| MBC field | source column |'); lines.push('|---|---|');
  for (const [k, v] of Object.entries(r.mapping)) lines.push(`| ${k} | ${typeof v === 'string' ? v : JSON.stringify(v)} |`);
  lines.push('');
  lines.push(`Unmapped source columns: ${r.unmappedColumns.length ? r.unmappedColumns.map((h) => `\`${h}\``).join(', ') : 'none'}`);
  lines.push(`Date format: ${r.dateFormat || 'ISO only (YYYY-MM-DD)'} · undecided candidates: ${r.options.undecided} · missing phone: ${r.options.missingPhone} · exclude archived: ${r.options.excludeArchived}`);
  lines.push('');
  lines.push('| cleaning rule (§5.1) | cells / rows |'); lines.push('|---|---:|');
  for (const [k, v] of Object.entries(r.cleaning)) lines.push(`| ${k} | ${n(v)} |`);
  lines.push('');
  lines.push(`Merge candidates: ${r.mergeCandidates.length} (${r.mergeCandidates.filter((m) => m.rule === 'auto_merge').length} auto-merge, ${r.mergeCandidates.filter((m) => m.rule === 'review').length} review). Shared emails (never merged on): ${r.sharedEmails.length ? r.sharedEmails.map((s) => `${s.email} ×${s.identities}`).join(', ') : 'none'}`);
  lines.push('');
  lines.push('### Field coverage (loadable rows)'); lines.push('| field | filled | blank | % |'); lines.push('|---|---:|---:|---:|');
  for (const [k, v] of Object.entries(r.fieldCoverage)) lines.push(`| ${k} | ${n(v.filled)} | ${n(v.blank)} | ${v.pct} |`);
  lines.push('');
  lines.push('## Gate 5 — spot-check sample');
  lines.push(`${r.spotCheck.size} customer(s) in spot-check.csv — compare every field against the source side by side; pass = ≥ 98 % fields correct and 0 wrong-customer links.${r.spotCheck.notes.length ? ` Notes: ${r.spotCheck.notes.join('; ')}.` : ''}`);
  lines.push('| # | stratum | row | source id | outcome | customer |'); lines.push('|---:|---|---:|---|---|---|');
  for (const s of r.spotCheck.sample) lines.push(`| ${s.sample} | ${s.stratum} | ${s.row} | ${s.sourceId} | ${s.outcome} | ${s.customerId || s.target || '(new)'} |`);
  lines.push('');
  lines.push(`Exceptions: ${r.exceptions.length} row(s) in exceptions.csv.`);
  lines.push('');
  lines.push('Sign-off: Gate 2 ____________  Gate 3 ____________  Gate 5 ____________ (client owner, date)');
  return lines.join('\n');
}

function exceptionsCsv(r) {
  const cols = ['file', 'row', 'line', 'source_id', 'outcome', 'rule', 'field', 'detail', 'decision', 'decided_by'];
  return [cols.join(','), ...r.exceptions.map((e) => csvLine(cols.map((k) => e[k])))].join('\n');
}

function mergeCsv(r) {
  const cols = ['key', 'rule', 'why', 'row', 'source_name', 'source_email', 'source_phone', 'source_postcode', 'source_address', 'candidate', 'candidate_name', 'candidate_email', 'candidate_phone', 'candidate_postcode', 'candidate_address', 'decision', 'target', 'decided_by'];
  return [cols.join(','), ...r.mergeCandidates.map((m) => csvLine([
    m.key, m.rule, m.why, m.row, m.source.name, m.source.email, m.source.phone, m.source.postcode, m.source.address,
    m.candidate.ref, m.candidate.name, m.candidate.email, m.candidate.phone, m.candidate.postcode, m.candidate.address,
    m.decision || '', '', m.decidedBy || '',
  ]))].join('\n');
}

function spotCheckCsv(r) {
  const cols = ['sample', 'stratum', 'row', 'source_id', 'outcome', 'customer_id', 'source_column', 'source_value', 'mbc_field', 'mbc_value', 'correct_y_n', 'notes'];
  const out = [cols.join(',')];
  for (const s of r.spotCheck.sample) {
    const mapping = r.mapping;
    const fields = [...WRITE_FIELDS, 'createdAt'];
    for (const f of fields) {
      const header = typeof mapping[f] === 'string' ? mapping[f] : '';
      out.push(csvLine([s.sample, s.stratum, s.row, s.sourceId, s.outcome, s.customerId || s.target || '', header, header ? s.sourceValues[header] : '', f, s.mbcValues[f], '', '']));
    }
  }
  return out.join('\n');
}

/** The generic template CSV (header + two synthetic example rows). */
function templateCsv() {
  const cols = ['source_id', 'company', 'first_name', 'last_name', 'email', 'phone', 'phone_alt', 'line1', 'line2', 'city', 'region', 'postcode', 'country', 'type', 'tax_number', 'notes', 'created_at', 'lifetime_value', 'service_address', 'archived'];
  return [
    cols.join(','),
    csvLine(['C-1001', '', 'Maeve', 'Synthetic', 'maeve@example.com', '(620) 555-0142', '', '12 Example Ave', '', 'Hutchinson', 'KS', '67501', 'US', 'residential', '', 'Gate code 1234', '2024-03-15', '1250.00', '', 'false']),
    csvLine(['C-1002', 'Example Builders LLC', 'Tom', 'Placeholder', 'office@example.org', '620-555-0199', '', '400 Sample St', 'Suite 2', 'Wichita', 'KS', '67202', 'US', 'commercial', '', '', '2023-11-02', '8400.00', '410 Sample St, Wichita, KS 67202', 'false']),
  ].join('\n') + '\n';
}

module.exports = {
  PRESETS, TARGET_FIELDS, DEFAULT_OPTIONS, ImportError,
  cleanValue, normalisePhone, parseDate, parseCents, splitPersonName, parseFullAddress, looksLikeCompany, normaliseCountry,
  resolveMapping, prepareRow, parseDecisions, planCustomerImport, commitCustomerImport, undoCustomerImport,
  renderMarkdown, exceptionsCsv, mergeCsv, spotCheckCsv, templateCsv, tally,
};
