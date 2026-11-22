/**
 * helpers/documents.js — shared logic for line-item quotes and invoices (Phase 2b).
 *
 * Money maths uses Prisma.Decimal (decimal.js), never floats:
 *   lineTotal = round_half_up(quantity × unitPrice, 2)            per line
 *   subtotal  = Σ lineTotal
 *   tax       = round_half_up(Σ lineTotal of a rate × rate / 100, 2)  per tax rate
 *               (0 for every rate when reverseCharge is set)
 *   taxTotal  = Σ tax,   amount (= total) = subtotal + taxTotal
 * Totals sent by the client are ignored whenever lines are sent.
 *
 * Numbers: allocateNumber(tx, type) calls the SQL function
 * mbc_next_document_number(type, prefix) inside the caller's transaction; the
 * counter row stays locked until that transaction ends, so concurrent creates
 * get distinct, ordered numbers and a rolled-back create leaves no gap.
 *
 * Locking: a quote is locked once sent (sentAt set) or no longer draft; an
 * invoice once sent, or while paid / overdue / void. Locked documents only
 * accept status changes (and the automatic paidAt / sentAt).
 */
'use strict';

const { Prisma } = require('@prisma/client');
const { badRequest, HttpError } = require('./httpError');
const v = require('./validate');
const { getLocale, formatMoney, formatDate } = require('./locale');
const { ymdOf } = require('./calendarDate');

const D = Prisma.Decimal;
const HALF_UP = D.ROUND_HALF_UP;
const MAX_LINES = 200;
const MAX_QUANTITY = 1_000_000;

const isDecimal = (x) => x != null && typeof x === 'object' && D.isDecimal(x);

/** Parse a decimal input (number or numeric string) with at most `dp` decimals. */
function decimal(value, field, { dp = 2, min = null, max = null, minExclusive = false, required = true } = {}) {
  if (v.isBlank(value)) {
    if (required) throw badRequest(`${field} is required`, { code: 'REQUIRED', field });
    return undefined;
  }
  let s;
  if (typeof value === 'number' && Number.isFinite(value)) s = String(value);
  else if (typeof value === 'string') s = value.trim();
  else throw badRequest(`${field} must be a number`, { code: 'INVALID_AMOUNT', field });
  if (!/^-?\d{1,12}(\.\d+)?$/.test(s)) throw badRequest(`${field} must be a number`, { code: 'INVALID_AMOUNT', field });
  const d = new D(s);
  if (d.decimalPlaces() > dp) throw badRequest(`${field} must have at most ${dp} decimal places`, { code: 'INVALID_AMOUNT', field });
  if (min != null && (minExclusive ? d.lte(min) : d.lt(min))) {
    throw badRequest(`${field} must be ${minExclusive ? 'greater than' : 'at least'} ${min}`, { code: 'INVALID_AMOUNT', field });
  }
  if (max != null && d.gt(max)) throw badRequest(`${field} must be at most ${max}`, { code: 'INVALID_AMOUNT', field });
  return d;
}

const round2 = (d) => d.toDecimalPlaces(2, HALF_UP);
const num = (d) => (isDecimal(d) ? d.toNumber() : Number(d));

/**
 * Validate `lines` from a request body. Pricebook items (pricebookItemId)
 * supply description / unitPrice / taxRateKey when the line omits them.
 * @returns normalised lines: { position, description, quantity: Decimal,
 *          unitPrice: Decimal, taxRateKey, taxRate: Decimal, pricebookItemId }
 */
async function parseLines(raw, client, locale = getLocale()) {
  if (!Array.isArray(raw)) throw badRequest('lines must be an array', { code: 'INVALID_INPUT', field: 'lines' });
  if (raw.length > MAX_LINES) throw badRequest(`at most ${MAX_LINES} lines`, { code: 'INVALID_INPUT', field: 'lines' });

  const ids = [];
  raw.forEach((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw badRequest(`lines[${i}] must be an object`, { code: 'INVALID_INPUT', field: `lines[${i}]` });
    if (l.pricebookItemId != null && l.pricebookItemId !== '') ids.push(require('./httpError').parseId(l.pricebookItemId, `lines[${i}].pricebookItemId`));
  });
  const items = ids.length ? await client.priceBookItem.findMany({ where: { id: { in: [...new Set(ids)] } } }) : [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const rateByKey = new Map(locale.taxRates.map((r) => [r.key, r.rate]));
  const keys = locale.taxRates.map((r) => r.key);

  return raw.map((l, i) => {
    const f = (name) => `lines[${i}].${name}`;
    let item = null;
    if (l.pricebookItemId != null && l.pricebookItemId !== '') {
      item = byId.get(require('./httpError').parseId(l.pricebookItemId, f('pricebookItemId')));
      if (!item) throw badRequest(`${f('pricebookItemId')} does not match a price book item`, { code: 'UNKNOWN_PRICEBOOK_ITEM', field: f('pricebookItemId') });
    }
    const description = v.str(l.description !== undefined && l.description !== '' ? l.description : (item ? item.name : undefined),
      f('description'), { required: true, max: 1000 });
    const quantity = decimal(l.quantity === undefined ? 1 : l.quantity, f('quantity'), { dp: 3, min: 0, minExclusive: true, max: MAX_QUANTITY });
    const unitPrice = decimal(l.unitPrice !== undefined ? l.unitPrice : (item ? String(item.price) : undefined), f('unitPrice'),
      { dp: 2, min: -v.MONEY_MAX, max: v.MONEY_MAX });

    let taxRateKey;
    if (l.taxRateKey !== undefined) {
      taxRateKey = v.isBlank(l.taxRateKey) ? null : l.taxRateKey;
    } else if (item && item.taxRateKey) {
      taxRateKey = item.taxRateKey;
    } else {
      taxRateKey = locale.taxDefault;
    }
    if (taxRateKey != null) {
      if (typeof taxRateKey !== 'string' || !rateByKey.has(taxRateKey.toLowerCase())) {
        throw badRequest(`${f('taxRateKey')} must be one of: ${keys.join(', ') || '(no tax rates configured)'}`,
          { code: 'INVALID_ENUM', field: f('taxRateKey'), allowed: keys });
      }
      taxRateKey = taxRateKey.toLowerCase();
    }
    const taxRate = new D(String(taxRateKey != null ? rateByKey.get(taxRateKey) : 0));
    return { position: i + 1, description, quantity, unitPrice, taxRateKey, taxRate, pricebookItemId: item ? item.id : null };
  });
}

/**
 * Totals for normalised lines (Decimal fields, or numbers from stored rows).
 * @returns { lines (with lineTotal), subtotal, taxTotal, total, breakdown[] } — Decimals
 */
function computeTotals(lines, { reverseCharge = false } = {}) {
  const out = lines.map((l) => {
    const quantity = new D(String(l.quantity));
    const unitPrice = new D(String(l.unitPrice));
    const taxRate = new D(String(l.taxRate || 0));
    return { ...l, quantity, unitPrice, taxRate, lineTotal: round2(quantity.times(unitPrice)) };
  });
  const subtotal = out.reduce((s, l) => s.plus(l.lineTotal), new D(0));
  const groups = new Map();
  for (const l of out) {
    const k = `${l.taxRateKey || ''}|${l.taxRate.toString()}`;
    if (!groups.has(k)) groups.set(k, { taxRateKey: l.taxRateKey || null, rate: l.taxRate, net: new D(0) });
    groups.get(k).net = groups.get(k).net.plus(l.lineTotal);
  }
  const breakdown = [...groups.values()].map((g) => ({
    ...g, tax: reverseCharge ? new D(0) : round2(g.net.times(g.rate).dividedBy(100)),
  }));
  const taxTotal = breakdown.reduce((s, g) => s.plus(g.tax), new D(0));
  return { lines: out, subtotal, taxTotal, total: subtotal.plus(taxTotal), breakdown };
}

/** Check a document total against the type's rule (invoice > 0, quote >= 0, <= MONEY_MAX). */
function assertTotal(type, total) {
  const t = new D(String(total));
  if (type === 'invoice' ? t.lte(0) : t.lt(0)) {
    throw badRequest(`${type} total must be ${type === 'invoice' ? 'greater than 0' : 'at least 0'}`, { code: 'INVALID_AMOUNT', field: 'amount' });
  }
  if (t.gt(v.MONEY_MAX)) throw badRequest(`${type} total must be at most ${v.MONEY_MAX}`, { code: 'INVALID_AMOUNT', field: 'amount' });
}

/** Prisma `data` for line rows. */
function lineRows(totals) {
  return totals.lines.map((l) => ({
    position: l.position, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
    taxRateKey: l.taxRateKey, taxRate: l.taxRate, lineTotal: l.lineTotal, pricebookItemId: l.pricebookItemId || null,
  }));
}

/** Next document number, inside the caller's transaction `tx`. */
async function allocateNumber(tx, type, locale = getLocale()) {
  const prefix = type === 'quote' ? locale.quotePrefix : locale.invoicePrefix;
  const rows = await tx.$queryRaw`SELECT mbc_next_document_number(${type}::text, ${prefix}::text) AS n`;
  if (!rows.length || !rows[0].n) throw new Error(`document counter for ${type} is missing (migration 20261121140000_documents_locale)`);
  return rows[0].n;
}

function isLocked(type, doc) {
  if (!doc) return false;
  if (doc.sentAt) return true;
  if (type === 'quote') return doc.status !== 'draft';
  return doc.status !== 'unpaid';
}

const lockedError = (type, doc, action = 'edited') => new HttpError(409,
  `This ${type} has been ${doc.sentAt ? 'sent' : doc.status} and can no longer be ${action}${action === 'edited' ? ' — only its status can change' : ''}`,
  { code: 'DOCUMENT_LOCKED', status: doc.status });

// ── Print / email view ─────────────────────────────────────────────────────
function customerName(c) {
  if (!c) return '';
  const person = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return c.company ? (person ? `${c.company} (attn. ${person})` : c.company) : person;
}

function addressLines(c, locale = getLocale()) {
  if (!c) return [];
  const country = (c.country || locale.country || 'US').toUpperCase();
  const lines = [c.address, c.addressLine2].filter((x) => x && String(x).trim());
  if (country === 'US') {
    const cityState = [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (cityState) lines.push(cityState);
  } else {
    for (const x of [c.city, c.state, c.zip]) if (x && String(x).trim()) lines.push(x);
  }
  if (c.country && c.country.toUpperCase() !== locale.country) lines.push(c.country.toUpperCase());
  return lines;
}

/**
 * Everything a print view / email needs, with formatted strings.
 * `doc` must include `lines` and `job.customer`.
 */
function printView(type, doc, brand, locale = getLocale()) {
  const currency = doc.currency || locale.currency;
  const money = (n) => formatMoney(n, currency, locale);
  const lines = (doc.lines || []).slice().sort((a, b) => a.position - b.position);
  const totals = lines.length ? computeTotals(lines, { reverseCharge: doc.reverseCharge }) : null;
  const breakdown = totals
    ? totals.breakdown.map((g) => ({ taxRateKey: g.taxRateKey, rate: num(g.rate), net: num(g.net), tax: num(g.tax) }))
    : [];
  const customer = doc.job && doc.job.customer;
  const short = (d) => (d ? formatDate(d, locale, brand.timezone, { style: 'short' }) : '');
  return {
    type,
    title: type === 'quote' ? 'Quote' : (locale.taxEnabled && locale.country === 'IE' ? 'VAT Invoice' : 'Invoice'),
    number: doc.number,
    status: doc.status,
    currency,
    issuedAt: doc.issuedAt,
    // calendar date 'YYYY-MM-DD' (stored at UTC midnight; never shifted by a time zone)
    dueDate: doc.dueDate ? ymdOf(doc.dueDate) : null,
    seller: {
      companyName: brand.companyName, address: brand.companyAddress || '', phone: brand.companyPhone || '',
      email: brand.companyEmail || '', logoUrl: brand.logoUrl || '', taxNumber: locale.taxNumber, taxLabel: locale.taxLabel,
    },
    customer: customer ? {
      id: customer.id, name: customerName(customer), company: customer.company || null, email: customer.email || null,
      phone: customer.phone || null, taxNumber: customer.taxNumber || null, addressLines: addressLines(customer, locale),
    } : null,
    jobTitle: doc.job ? doc.job.title : '',
    lines: lines.map((l) => ({
      position: l.position, description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice),
      taxRateKey: l.taxRateKey, taxRate: num(l.taxRate), lineTotal: num(l.lineTotal),
      formatted: { unitPrice: money(l.unitPrice), lineTotal: money(l.lineTotal) },
    })),
    subtotal: num(doc.subtotal), taxTotal: num(doc.taxTotal), total: num(doc.amount),
    taxEnabled: locale.taxEnabled, taxLabel: locale.taxLabel, taxBreakdown: breakdown,
    reverseCharge: !!doc.reverseCharge,
    reverseChargeNote: doc.reverseCharge ? locale.reverseChargeNote : null,
    reverseChargeNoteIsPlaceholder: doc.reverseCharge ? locale.reverseChargeNoteIsPlaceholder : false,
    notes: doc.notes || '',
    formatted: {
      subtotal: money(doc.subtotal), taxTotal: money(doc.taxTotal), total: money(doc.amount),
      issuedAt: short(doc.issuedAt), dueDate: doc.dueDate ? short(ymdOf(doc.dueDate)) : '',
      taxBreakdown: breakdown.map((g) => ({ label: `${locale.taxLabel} ${g.rate}%`, net: money(g.net), tax: money(g.tax) })),
    },
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** { subject, text, html } for emailing a document. All values HTML-escaped. */
function renderEmail(view, { message = '' } = {}) {
  const subject = `${view.seller.companyName} — ${view.title} ${view.number}`;
  const greeting = view.customer && view.customer.name ? `Hello ${view.customer.name},` : 'Hello,';
  const intro = view.type === 'quote'
    ? `Please find your quote ${view.number}${view.jobTitle ? ` for "${view.jobTitle}"` : ''} below.`
    : `Please find your invoice ${view.number}${view.jobTitle ? ` for "${view.jobTitle}"` : ''} below.`;
  const showTax = view.taxEnabled || view.taxTotal > 0 || view.reverseCharge;

  const t = [];
  t.push(greeting, '', intro);
  if (message) t.push('', message);
  t.push('', `${view.title} ${view.number}`, `Date: ${view.formatted.issuedAt}`);
  if (view.formatted.dueDate) t.push(`Due: ${view.formatted.dueDate}`);
  t.push('');
  for (const l of view.lines) t.push(`${l.quantity} x ${l.description} @ ${l.formatted.unitPrice} = ${l.formatted.lineTotal}`);
  if (view.lines.length) t.push('');
  if (showTax) {
    t.push(`Subtotal: ${view.formatted.subtotal}`);
    for (const g of view.formatted.taxBreakdown) t.push(`${g.label} on ${g.net}: ${g.tax}`);
    if (!view.formatted.taxBreakdown.length) t.push(`${view.taxLabel}: ${view.formatted.taxTotal}`);
  }
  t.push(`Total: ${view.formatted.total}`);
  // The default wording is an accountant-to-confirm PLACEHOLDER: never send it to a customer
  // (same rule as the print view).
  const rcNote = view.reverseChargeNote && !view.reverseChargeNoteIsPlaceholder ? view.reverseChargeNote : '';
  if (rcNote) t.push('', rcNote);
  if (view.notes) t.push('', view.notes);
  t.push('', view.seller.companyName);
  for (const x of [view.seller.address, view.seller.phone, view.seller.email]) if (x) t.push(x);
  if (view.seller.taxNumber) t.push(`${view.seller.taxLabel} no.: ${view.seller.taxNumber}`);
  const text = t.join('\n');

  const rows = view.lines.map((l) => `<tr><td style="padding:4px 8px">${esc(l.description)}</td>` +
    `<td style="padding:4px 8px;text-align:right">${esc(l.quantity)}</td>` +
    `<td style="padding:4px 8px;text-align:right">${esc(l.formatted.unitPrice)}</td>` +
    (showTax ? `<td style="padding:4px 8px;text-align:right">${esc(l.taxRate)}%</td>` : '') +
    `<td style="padding:4px 8px;text-align:right">${esc(l.formatted.lineTotal)}</td></tr>`).join('');
  const taxRows = showTax
    ? `<tr><td>Subtotal</td><td style="text-align:right">${esc(view.formatted.subtotal)}</td></tr>` +
      view.formatted.taxBreakdown.map((g) => `<tr><td>${esc(g.label)} on ${esc(g.net)}</td><td style="text-align:right">${esc(g.tax)}</td></tr>`).join('')
    : '';
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<p>${esc(greeting)}</p><p>${esc(intro)}</p>${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
<h2 style="margin:16px 0 4px">${esc(view.title)} ${esc(view.number)}</h2>
<p style="margin:0">Date: ${esc(view.formatted.issuedAt)}${view.formatted.dueDate ? ` &middot; Due: ${esc(view.formatted.dueDate)}` : ''}</p>
${view.lines.length ? `<table style="border-collapse:collapse;margin-top:12px" border="0"><thead><tr>
<th style="padding:4px 8px;text-align:left">Description</th><th style="padding:4px 8px;text-align:right">Qty</th>
<th style="padding:4px 8px;text-align:right">Unit price</th>${showTax ? `<th style="padding:4px 8px;text-align:right">${esc(view.taxLabel)}</th>` : ''}
<th style="padding:4px 8px;text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<table style="margin-top:12px">${taxRows}<tr><td><strong>Total</strong></td><td style="text-align:right"><strong>${esc(view.formatted.total)}</strong></td></tr></table>
${rcNote ? `<p><em>${esc(rcNote)}</em></p>` : ''}
${view.notes ? `<p>${esc(view.notes).replace(/\n/g, '<br>')}</p>` : ''}
<p style="margin-top:24px">${esc(view.seller.companyName)}${[view.seller.address, view.seller.phone, view.seller.email].filter(Boolean).map((x) => `<br>${esc(x)}`).join('')}
${view.seller.taxNumber ? `<br>${esc(view.seller.taxLabel)} no.: ${esc(view.seller.taxNumber)}` : ''}</p>
</body></html>`;
  return { subject, text, html };
}

module.exports = {
  D, MAX_LINES, decimal, parseLines, computeTotals, assertTotal, lineRows, allocateNumber,
  isLocked, lockedError, printView, renderEmail, customerName, addressLines, isDecimal, num,
};
