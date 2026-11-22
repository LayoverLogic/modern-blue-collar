/*
 * js/format.js — escaping and display formatting shared by every page.
 *
 *   MBC.fmt.esc(v)            HTML-escape anything before it goes into innerHTML
 *   MBC.fmt.money(n)          Intl currency (brand.currency, else by brand.country, else USD)
 *   MBC.fmt.parseDate(v)      'YYYY-MM-DD' → LOCAL midnight (never UTC); other values → Date
 *   MBC.fmt.date(v)/time(t)/dateTime(v)/schedule(job)
 *   MBC.fmt.todayISO()        local YYYY-MM-DD
 *   MBC.fmt.name(x)           display name from company / firstName + lastName / name / email
 *   MBC.fmt.address(c)        one-line address incl. postcode
 *   MBC.fmt.addressLabels()   {region, postal} labels for the brand country (US default)
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
  function country() {
    const c = String(brand().country || brand().countryCode || 'US').toUpperCase();
    return COUNTRY[c] ? c : 'US';
  }
  function locale() {
    const b = brand();
    if (b.locale) return b.locale;
    if (b.country || b.countryCode) return COUNTRY[country()].locale;
    return (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
  }
  function currency() { return brand().currency || COUNTRY[country()].currency; }

  const esc = (v) => (v == null ? '' : String(v))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Same as esc but shows a dash for empty values.
  const text = (v) => (v == null || v === '' ? DASH : esc(v));

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

  function money(v) {
    const n = num(v);
    if (n == null) return DASH;
    try { return new Intl.NumberFormat(locale(), { style: 'currency', currency: currency() }).format(n); }
    catch (e) { return '$' + n.toFixed(2); }
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
  function todayISO() { return isoDate(new Date()); }
  function addDays(iso, n) { const d = parseDate(iso) || new Date(); d.setDate(d.getDate() + n); return isoDate(d); }

  function date(v, opts) {
    const d = parseDate(v);
    if (!d) return DASH;
    return d.toLocaleDateString(locale(), opts || { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function dateLong(v) { return date(v, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function dateTime(v) {
    const d = parseDate(v);
    if (!d) return DASH;
    return d.toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

  function name(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    const person = [x.firstName, x.lastName].filter(Boolean).join(' ').trim();
    if (x.company && person) return x.company + ' (' + person + ')';
    return x.company || person || x.name || x.email || (x.id != null ? 'User #' + x.id : '');
  }

  function addressLabels() {
    const b = brand();
    const c = COUNTRY[country()];
    return { region: b.regionLabel || c.region, postal: b.postalLabel || c.postal, country: country() };
  }
  function address(c) {
    if (!c) return '';
    const tail = [c.state, c.zip].filter(Boolean).join(' ');
    return [c.address, c.city, tail].filter(Boolean).join(', ');
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

  MBC.fmt = {
    DASH, esc, text, num, money, parseDate, isoDate, todayISO, addDays, date, dateLong, dateTime, time,
    schedule, name, address, addressLabels, statusLabel, badge, phoneDigits, locale, currency,
  };
})();
