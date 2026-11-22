/*
 * js/format.js — escaping and display formatting shared by every page.
 *
 *   MBC.fmt.esc(v)            HTML-escape anything before it goes into innerHTML
 *   MBC.fmt.money(n, cur?)    Intl currency: cur (a document's snapshot) → brand locale.currency → USD
 *   MBC.fmt.tax()             {enabled, label, rates[{key, rate}], defaultKey, reverseChargeNote…} from /api/brand locale
 *   MBC.fmt.reverseChargeAvailable()  true only where the brand allows reverse charge (VAT + RCT; never US sales tax)
 *   MBC.fmt.datePattern()     'DD/MM/YYYY' / 'MM/DD/YYYY' (brand); formatDateInput(iso) / parseDateInput(text) → iso | null
 *   MBC.fmt.timeZone()        brand time zone (timestamps are shown in it; calendar dates never shift)
 *   MBC.fmt.parseDate(v)      'YYYY-MM-DD' → LOCAL midnight (never UTC); other values → Date
 *   MBC.fmt.date(v)/time(t)/dateTime(v)/schedule(job)
 *   MBC.fmt.todayISO()        today's YYYY-MM-DD in the BRAND time zone (zonedISO(v): any instant's date there)
 *   MBC.fmt.phone(p)          E.164 → national display style for the brand country (tel:/sms: keep E.164)
 *   MBC.fmt.name(x)           display name: company if set, else firstName + lastName (then name / email)
 *   MBC.fmt.contactName(x)    firstName + lastName only;  contactLine(x): the person when a company is shown
 *   MBC.fmt.bytes(n)          1536 → "1.5 KB"
 *   MBC.fmt.address(c)        one-line address incl. postcode
 *   MBC.fmt.addressLabels()   {address, addressLine2, city, region, postal, required[], …} from the locale block
 *
 * Values that are missing render as an em dash, never "undefined"/"NaN"/"Invalid Date".
 */
(function () {
  'use strict';
  const MBC = (window.MBC = window.MBC || {});
  const DASH = '—';

  const COUNTRY = {
    US: { locale: 'en-US', currency: 'USD', region: 'State', postal: 'ZIP' },
    IE: { locale: 'en-IE', currency: 'EUR', region: 'County', postal: 'Eircode' },
    GB: { locale: 'en-GB', currency: 'GBP', region: 'County', postal: 'Postcode' },
    UK: { locale: 'en-GB', currency: 'GBP', region: 'County', postal: 'Postcode' },
    CA: { locale: 'en-CA', currency: 'CAD', region: 'Province', postal: 'Postal code' },
    AU: { locale: 'en-AU', currency: 'AUD', region: 'State', postal: 'Postcode' },
    NZ: { locale: 'en-NZ', currency: 'NZD', region: 'Region', postal: 'Postcode' },
  };

  function brand() { return (MBC.brand && MBC.brand.current) || {}; }
  // GET /api/brand `locale` block (Phase 2b) — tolerate its absence (older servers).
  function loc() { const l = brand().locale; return l && typeof l === 'object' ? l : {}; }
  function country() {
    const c = String(loc().country || brand().country || brand().countryCode || 'US').toUpperCase();
    return COUNTRY[c] ? c : (/^[A-Z]{2}$/.test(c) ? c : 'US');
  }
  function locale() {
    const b = brand();
    if (loc().numberLocale) return loc().numberLocale;
    if (typeof b.locale === 'string' && b.locale) return b.locale;
    if (COUNTRY[country()] && (loc().country || b.country || b.countryCode)) return COUNTRY[country()].locale;
    return (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
  }
  function currency() { return loc().currency || brand().currency || (COUNTRY[country()] || COUNTRY.US).currency; }
  // Brand time zone for timestamps (GET /api/brand timezone); undefined → browser zone.
  let tzOk = null;
  function timeZone() {
    const tz = brand().timezone;
    if (!tz) return undefined;
    if (tzOk && tzOk[0] === tz) return tzOk[1] ? tz : undefined;
    let ok = true;
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (e) { ok = false; }
    tzOk = [tz, ok];
    return ok ? tz : undefined;
  }
  // Tax configuration from the locale block.
  function tax() {
    const l = loc();
    const rates = Array.isArray(l.taxRates) ? l.taxRates.filter((r) => r && r.key != null && Number.isFinite(Number(r.rate))) : [];
    return {
      enabled: !!l.taxEnabled && rates.length > 0, label: l.taxLabel || 'Tax', number: l.taxNumber || null,
      rates: rates.map((r) => ({ key: String(r.key), rate: Number(r.rate) })), defaultKey: l.taxDefault || null,
      reverseChargeNote: l.reverseChargeNote || '', reverseChargeNoteIsPlaceholder: !!l.reverseChargeNoteIsPlaceholder,
    };
  }

  // GAP-16: may a document be marked reverse charge (no tax; the customer accounts for it)?
  // Newer servers say so in the locale block (reverseChargeAvailable, or reverseCharge.available);
  // older ones do not: then only VAT brands (tax on, outside the US) — never US sales tax.
  function reverseChargeAvailable() {
    const l = loc(); const b = brand();
    const flag = [l.reverseChargeAvailable, l.reverseCharge && typeof l.reverseCharge === 'object' ? l.reverseCharge.available : undefined,
      typeof l.reverseCharge === 'boolean' ? l.reverseCharge : undefined, b.reverseChargeAvailable].find((v) => typeof v === 'boolean');
    if (typeof flag === 'boolean') return flag && tax().enabled;
    const t = tax();
    return t.enabled && country() !== 'US' && (/\bVAT\b/i.test(t.label) || ['IE', 'GB', 'UK'].includes(country()));
  }

  const esc = (v) => (v == null ? '' : String(v))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Same as esc but shows a dash for empty values.
  const text = (v) => (v == null || v === '' ? DASH : esc(v));

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  // money(n, currency?) — a document's own currency snapshot wins over the brand's.
  function money(v, cur) {
    const n = num(v);
    if (n == null) return DASH;
    const c = (typeof cur === 'string' && /^[A-Z]{3}$/i.test(cur)) ? cur.toUpperCase() : currency();
    try { return new Intl.NumberFormat(locale(), { style: 'currency', currency: c }).format(n); }
    catch (e) { return c + ' ' + n.toFixed(2); }
  }
  function percent(r) {
    const n = num(r); if (n == null) return '';
    try { return new Intl.NumberFormat(locale(), { maximumFractionDigits: 3 }).format(n) + '%'; } catch (e) { return n + '%'; }
  }

  const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    const s = String(v);
    const m = s.match(DATE_ONLY);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function isoDate(d) {
    const x = parseDate(d); if (!x) return '';
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }
  // Calendar date (YYYY-MM-DD) of an instant in the brand time zone (browser zone if unknown).
  function zonedISO(v) {
    const d = v instanceof Date ? v : parseDate(v);
    if (!d) return '';
    const tz = timeZone();
    if (!tz) return isoDate(d);
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      const g = (t) => (parts.find((p) => p.type === t) || {}).value;
      return g('year') + '-' + g('month') + '-' + g('day');
    } catch (e) { return isoDate(d); }
  }
  // Today in the brand time zone: an Irish office viewed from a US laptop still sees Irish "today".
  function todayISO() { return zonedISO(new Date()); }
  function addDays(iso, n) { const d = parseDate(iso) || new Date(); d.setDate(d.getDate() + n); return isoDate(d); }

  // A 'YYYY-MM-DD' value is a calendar date (never shifted); a timestamp is
  // shown in the brand time zone.
  const isCalendar = (v) => typeof v === 'string' && DATE_ONLY.test(v);
  function date(v, opts) {
    const d = parseDate(v);
    if (!d) return DASH;
    const o = Object.assign({}, opts || { year: 'numeric', month: 'short', day: 'numeric' });
    if (!isCalendar(v) && !(v instanceof Date) && timeZone()) o.timeZone = timeZone();
    return d.toLocaleDateString(locale(), o);
  }
  // Numeric date in the brand convention (MM/DD/YYYY US, DD/MM/YYYY IE).
  function dateShort(v) { return date(v, { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function dateLong(v) { return date(v, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function dateTime(v) {
    const d = parseDate(v);
    if (!d) return DASH;
    const o = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (!isCalendar(v) && timeZone()) o.timeZone = timeZone();
    return d.toLocaleString(locale(), o);
  }
  // 'HH:MM' (24h) → localised clock time.
  function time(t) {
    if (!t) return '';
    const m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return String(t);
    const d = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
    return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  }
  function schedule(job, opts) {
    if (!job || !job.scheduledDate) return 'Not scheduled';
    const day = (opts && opts.long) ? dateLong(job.scheduledDate) : date(job.scheduledDate);
    return job.scheduledTime ? day + ', ' + time(job.scheduledTime) : day;
  }

  // ── Typed dates in the BRAND convention (js/ui.js date fields) ───────────────
  // Order of day / month / year for a locale ('mdy', 'dmy', 'ymd').
  function dateOrder(lc) {
    try {
      return new Intl.DateTimeFormat(lc || locale(), { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(2026, 10, 25))
        .filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.type[0]).join('');
    } catch (e) { return 'mdy'; }
  }
  // 'DD/MM/YYYY' (IE) / 'MM/DD/YYYY' (US): the locale's dateFormat, else derived from its number locale.
  function datePattern() {
    const f = String(loc().dateFormat || '').toUpperCase();
    if (/^(DD|MM|YYYY)([\/.-])(DD|MM|YYYY)\2(DD|MM|YYYY)$/.test(f)) return f;
    const o = dateOrder();
    const sep = o === 'ymd' ? '-' : '/';
    return o.split('').map((c) => ({ d: 'DD', m: 'MM', y: 'YYYY' })[c]).join(sep);
  }
  function formatDateInput(v) {
    const m = DATE_ONLY.exec(String(v || ''));
    if (!m) return '';
    return datePattern().replace('YYYY', m[1]).replace('MM', m[2]).replace('DD', m[3]);
  }
  // Text typed in the brand order → 'YYYY-MM-DD', or null when it is not a real date.
  // Also accepts ISO (2026-11-25), any of / . - or spaces as separators and 2-digit years (→ 20xx).
  function parseDateInput(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    let y, mo, d;
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
    if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
    else {
      const parts = t.split(/[\/.\-\s]+/);
      if (parts.length !== 3 || !parts.every((x) => /^\d{1,4}$/.test(x))) return null;
      const order = datePattern().replace(/[^DMY]/g, '').replace('DD', 'd').replace('MM', 'm').replace('YYYY', 'y');
      const val = {}; order.split('').forEach((k, i) => { val[k] = parts[i]; });
      if (!val.y || val.y.length === 3 || val.y.length === 1) return null;
      y = val.y.length === 2 ? 2000 + Number(val.y) : Number(val.y); mo = Number(val.m); d = Number(val.d);
    }
    if (!(y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // Display name: the company when set, else first + last name (then name / email / #id).
  function name(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    const company = typeof x.company === 'string' ? x.company.trim() : '';
    return company || contactName(x) || x.name || x.email || (x.id != null ? 'User #' + x.id : '');
  }
  // The person's own name (first + last), regardless of company.
  function contactName(x) {
    if (!x || typeof x !== 'object') return '';
    return [x.firstName, x.lastName].filter(Boolean).join(' ').trim();
  }
  // Secondary line under a company name: the contact person, when both are set.
  function contactLine(x) {
    const company = x && typeof x.company === 'string' ? x.company.trim() : '';
    const person = contactName(x);
    return company && person ? person : '';
  }
  // 1536 → "1.5 KB"
  function bytes(n) {
    const v = num(n); if (v == null) return DASH;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Labels / rules for address fields from the locale block (fallback: COUNTRY table).
  function addressLabels() {
    const b = brand();
    const l = loc();
    const c = COUNTRY[country()] || COUNTRY.US;
    const al = (l.addressLabels && typeof l.addressLabels === 'object') ? l.addressLabels : {};
    const required = Array.isArray(l.requiredAddressFields) ? l.requiredAddressFields.slice() : null;
    return {
      address: al.address || 'Street address', addressLine2: al.addressLine2 || 'Address line 2',
      city: al.city || 'Town / City', region: al.state || b.regionLabel || c.region, postal: al.zip || b.postalLabel || c.postal,
      countryLabel: al.country || 'Country', country: country(),
      // null = an older server that does not say: keep the historic US form rules.
      required, postcodePattern: l.postcodePattern || null, postcodeExample: l.postcodeExample || '',
      defaultState: l.defaultState || b.defaultState || '',
    };
  }
  // One-line address in the brand convention.
  //   US: 12 Main St, Apt 2, Hutchinson, KS 67501      IE: 3 Main St, Naas, Co. Kildare, W91 X2Y4
  function address(c) {
    if (!c) return '';
    if (country() === 'US') {
      const tail = [c.state, c.zip].filter(Boolean).join(' ');
      return [c.address, c.addressLine2, [c.city, tail].filter(Boolean).join(', ')].filter(Boolean).join(', ');
    }
    return [c.address, c.addressLine2, c.city, c.state, c.zip].filter(Boolean).join(', ');
  }

  const STATUS_LABELS = { 'in-progress': 'In progress' };
  function statusLabel(s) {
    if (!s) return DASH;
    return STATUS_LABELS[s] || (String(s).charAt(0).toUpperCase() + String(s).slice(1));
  }
  function badge(s) {
    const cls = String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return '<span class="badge badge-' + cls + '">' + esc(statusLabel(s)) + '</span>';
  }
  function phoneDigits(p) { return p ? String(p).replace(/[^0-9+]/g, '') : ''; }
  // Phones are stored E.164 (+16205550142, +353871234567). Display them in the brand
  // country's national style; other countries (and older free-text rows) as stored.
  function phone(p) {
    if (p == null || p === '') return '';
    const s = String(p).trim();
    const m = /^\+(\d{6,15})$/.exec(s);
    if (!m) return s;
    const n = m[1];
    const c = country();
    if (n.length === 11 && n[0] === '1' && (c === 'US' || c === 'CA')) return '(' + n.slice(1, 4) + ') ' + n.slice(4, 7) + '-' + n.slice(7);
    if (n.indexOf('353') === 0 && c === 'IE') {
      const nat = '0' + n.slice(3);
      if (/^08\d/.test(nat) && nat.length === 10) return nat.slice(0, 3) + ' ' + nat.slice(3, 6) + ' ' + nat.slice(6);
      if (/^01/.test(nat)) return nat.slice(0, 2) + ' ' + nat.slice(2, nat.length - 4) + ' ' + nat.slice(-4);
      return nat.slice(0, 3) + ' ' + nat.slice(3, nat.length - 4) + ' ' + nat.slice(-4);
    }
    return s;
  }

  MBC.fmt = {
    DASH, esc, text, num, money, parseDate, isoDate, todayISO, addDays, date, dateLong, dateTime, time,
    schedule, name, address, addressLabels, statusLabel, badge, phoneDigits, phone, locale, currency,
    timeZone, tax, percent, dateShort, country, contactName, contactLine, bytes, zonedISO, reverseChargeAvailable,
    dateOrder, formatDateInput, parseDateInput, datePattern,
  };
})();
