/**
 * helpers/xero.js — invoices as a CSV in Xero's sales-invoice import format.
 *
 * Column set and rules follow Xero's "Import sales invoices" template (Business → Invoices →
 * Import → Download template file): one row per invoice LINE, rows of one invoice share
 * *InvoiceNumber and repeat the invoice fields; asterisked columns are required; dates in the
 * organisation's date format (DD/MM/YYYY outside the US, MM/DD/YYYY in the US); *TaxType must
 * be the exact NAME of a tax rate in the Xero organisation; UnitAmount is tax-exclusive here
 * (choose "Tax exclusive" in Xero's import dialog); at most 500 invoice lines per file.
 * Sources: Xero template columns as reproduced at docs.moment.team/…/xero-templates and
 * invoicedataextraction.com/blog/import-invoices-xero (see PHASE2-backend-contract.md §2c).
 *
 * Configuration (env, all optional):
 *   XERO_SALES_ACCOUNT_CODE   *AccountCode for every line (default "200", Xero's default "Sales")
 *   XERO_TAX_TYPES            MBC tax-rate key → Xero tax rate name, "key=Name|key=Name",
 *                             e.g. "standard=23% (VAT on Income)|reduced=13.5% (VAT on Income)|zero=Zero Rated"
 *                             plus the special keys none (untaxed lines) and reverse_charge.
 *                             Unmapped keys fall back to a PLACEHOLDER name and are reported in
 *                             the X-MBC-Xero-Unmapped-Tax header — confirm the names against the
 *                             client's Xero organisation before the first import.
 *   XERO_DEFAULT_DUE_DAYS     due date when the invoice has none (issue date + N, default 30)
 *   XERO_BRANDING_THEME       BrandingTheme column (default blank = organisation default)
 */
'use strict';

const { Prisma } = require('@prisma/client');
const { csvLine } = require('./csv');
const { COUNTRIES } = require('./locale');

const XERO_COLUMNS = Object.freeze([
  '*ContactName', 'EmailAddress', 'POAddressLine1', 'POAddressLine2', 'POAddressLine3', 'POAddressLine4',
  'POCity', 'PORegion', 'POPostalCode', 'POCountry', '*InvoiceNumber', 'Reference', '*InvoiceDate', '*DueDate',
  'Total', 'InventoryItemCode', '*Description', '*Quantity', '*UnitAmount', 'Discount', '*AccountCode', '*TaxType',
  'TaxAmount', 'TrackingName1', 'TrackingOption1', 'TrackingName2', 'TrackingOption2', 'Currency', 'BrandingTheme',
]);
const MAX_LINES_PER_FILE = 500;

function parseTaxTypes(raw) {
  const out = {};
  for (const part of String(raw || '').split('|').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Placeholder Xero tax-rate names when XERO_TAX_TYPES has no entry. */
function defaultTaxType(key, rate, country) {
  if (key === 'reverse_charge') return 'Reverse Charge';
  if (country === 'US') return key === 'none' || !rate ? 'Tax Exempt' : 'Tax on Sales';
  if (key === 'none' || rate == null) return 'No VAT';
  if (Number(rate) === 0) return 'Zero Rated';
  return `${Number(rate)}% (VAT on Income)`;
}

function ymdIn(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch { return d.toISOString().slice(0, 10); }
}

function fmtDate(ymd, dateFormat) {
  const [y, m, d] = ymd.split('-');
  return dateFormat === 'MM/DD/YYYY' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`;
}

const D = (v) => new Prisma.Decimal(v == null ? 0 : v);
const money = (d) => D(d).toFixed(2);
const qty = (d) => D(d).toDecimalPlaces(3).toString();

/**
 * Allocate a rate group's tax (computed on the group net, half-up) to its lines so the line
 * TaxAmounts add up exactly to the document's tax (largest remainder, in cents).
 */
function allocateLineTax(lines, reverseCharge) {
  const out = new Map();
  const groups = new Map();
  for (const l of lines) {
    const rate = reverseCharge ? 0 : Number(l.taxRate || 0);
    const k = `${l.taxRateKey || ''}|${rate}`;
    if (!groups.has(k)) groups.set(k, { rate, lines: [] });
    groups.get(k).lines.push(l);
  }
  for (const g of groups.values()) {
    const net = g.lines.reduce((s, l) => s.plus(D(l.lineTotal)), D(0));
    const taxCents = net.times(g.rate).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).times(100).toNumber();
    const raw = g.lines.map((l) => ({ l, exact: D(l.lineTotal).times(g.rate).dividedBy(100).times(100) }));
    const floor = raw.map((r) => ({ ...r, cents: r.exact.floor().toNumber(), frac: r.exact.minus(r.exact.floor()).toNumber() }));
    let rest = taxCents - floor.reduce((s, r) => s + r.cents, 0);
    const order = floor.slice().sort((a, b) => (rest >= 0 ? b.frac - a.frac : a.frac - b.frac));
    for (let i = 0; rest !== 0 && order.length; i = (i + 1) % order.length) { const step = rest > 0 ? 1 : -1; order[i].cents += step; rest -= step; }
    for (const r of floor) out.set(r.l, r.cents);
  }
  return out;
}

/**
 * @param {object[]} invoices  Prisma invoices with lines + job.customer
 * @param {object} opt { locale, timezone, dateFormat, env }
 * @returns {{ csv: string, lineCount: number, invoiceCount: number, unmappedTax: string[], warnings: string[] }}
 */
function buildXeroInvoicesCsv(invoices, { locale, timezone, dateFormat, env = process.env } = {}) {
  const country = locale.country;
  const df = dateFormat || (country === 'US' ? 'MM/DD/YYYY' : 'DD/MM/YYYY');
  const account = (env.XERO_SALES_ACCOUNT_CODE || '200').trim();
  const taxTypes = parseTaxTypes(env.XERO_TAX_TYPES);
  const dueDays = Math.max(0, Number(env.XERO_DEFAULT_DUE_DAYS) || 30);
  const theme = (env.XERO_BRANDING_THEME || '').trim();
  const unmapped = new Set();
  const warnings = [];
  const taxName = (key, rate) => {
    const k = key || 'none';
    if (taxTypes[k]) return taxTypes[k];
    unmapped.add(k);
    return defaultTaxType(k, rate, country);
  };
  const rows = [XERO_COLUMNS.join(',')];
  let lineCount = 0;
  for (const inv of invoices) {
    const c = (inv.job && inv.job.customer) || {};
    const contact = (c.company || `${c.firstName || ''} ${c.lastName || ''}`).trim() || `Customer ${c.id || ''}`.trim();
    const issued = ymdIn(inv.issuedAt || inv.createdAt, timezone);
    const due = inv.dueDate ? ymdIn(inv.dueDate, 'UTC') : // calendar date stored at UTC midnight
      ymdIn(new Date(new Date(`${issued}T12:00:00Z`).getTime() + dueDays * 86400000), 'UTC');
    const lines = (inv.lines && inv.lines.length) ? inv.lines.slice().sort((a, b) => a.position - b.position) : [{
      position: 1, description: `Invoice ${inv.number}${inv.job && inv.job.title ? ` – ${inv.job.title}` : ''}`,
      quantity: 1, unitPrice: inv.subtotal != null ? inv.subtotal : inv.amount, lineTotal: inv.subtotal != null ? inv.subtotal : inv.amount,
      taxRateKey: null, taxRate: 0, legacy: true,
    }];
    const tax = allocateLineTax(lines, inv.reverseCharge);
    const allocated = [...tax.values()].reduce((s, x) => s + x, 0);
    const docTax = Math.round(Number(inv.taxTotal || 0) * 100);
    if (!lines[0].legacy && allocated !== docTax) warnings.push(`${inv.number}: line tax ${allocated / 100} ≠ document tax ${docTax / 100}`);
    const ctry = c.country ? ((COUNTRIES[c.country] && COUNTRIES[c.country].countryName) || c.country) : '';
    for (const l of lines) {
      const key = inv.reverseCharge ? 'reverse_charge' : (Number(l.taxRate || 0) > 0 || l.taxRateKey ? l.taxRateKey || 'none' : 'none');
      rows.push(csvLine([
        contact, c.email || '', c.address || '', c.addressLine2 || '', '', '',
        c.city || '', c.state || '', c.zip || '', ctry,
        inv.number, (inv.job && inv.job.title) ? `${inv.job.title}`.slice(0, 255) : '', fmtDate(issued, df), fmtDate(due, df),
        money(inv.amount), '', String(l.description || '').slice(0, 4000), qty(l.quantity), money(l.unitPrice), '', account,
        taxName(key, l.taxRate), (tax.get(l) / 100).toFixed(2), '', '', '', '', inv.currency || locale.currency, theme,
      ]));
      lineCount += 1;
    }
  }
  if (lineCount > MAX_LINES_PER_FILE) warnings.push(`${lineCount} lines — Xero imports at most ${MAX_LINES_PER_FILE} invoice lines per file; narrow from/to`);
  return { csv: rows.join('\n') + '\n', lineCount, invoiceCount: invoices.length, unmappedTax: [...unmapped], warnings, dateFormat: df };
}

module.exports = { XERO_COLUMNS, MAX_LINES_PER_FILE, buildXeroInvoicesCsv, allocateLineTax, parseTaxTypes, defaultTaxType, ymdIn };
