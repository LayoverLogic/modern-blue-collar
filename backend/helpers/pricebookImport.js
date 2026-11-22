/**
 * helpers/pricebookImport.js — price book CSV import (B3, GAP-14).
 *
 * POST /api/pricebook/import?dryRun=true|false (routes/pricebook.js). The CSV
 * (template: GET /api/pricebook/import/template.csv, also
 * backend/import-templates/pricebook.csv) has a header row; column names are
 * matched case-insensitively, ignoring spaces / _ / - :
 *   sku, name, category, subcategory, description, price (alias unitPrice), cost,
 *   unit, taxRateKey (alias tax), taxable, active, industry, taskCode
 * name + category are required to CREATE an item. Prices may carry a currency
 * sign and thousands separators ("$1,800.00").
 *
 * Stable key (idempotent re-runs):
 *   sku present   → the item with that sku; else an item with the same
 *                   name + category and NO sku (it adopts the sku); else created
 *   sku blank     → the item with the same name + category (case-insensitive)
 * Blank cells never clear a value of an existing item. `active` blank → unchanged
 * (a new item is active). An existing row whose values are all the same → skipped.
 * Two rows with the same key in one file → the later one errored (DUPLICATE_IN_FILE).
 *
 * Report: { kind:'pricebook-import', mode:'dry-run'|'commit', committed, file{rows,bytes,sha256},
 *   columns{recognised[], unknown[]}, counts{rows,created,updated,skipped,errored},
 *   rows[{row, line, key, outcome:'created'|'updated'|'skipped'|'errored', id?, changes?{field:{from,to}},
 *         reason?, errors?[{field, code, error}]}] }
 * Commit: every valid row in ONE transaction; errored rows are left out (fix and re-run).
 */
'use strict';

const crypto = require('crypto');
const { parseCsv, CsvError } = require('./csv');
const { badRequest } = require('./httpError');
const v = require('./validate');
const { getLocale } = require('./locale');

const MAX_ROWS = 5000;

const COLUMNS = {
  sku: 'sku', name: 'name', category: 'category', subcategory: 'subcategory', description: 'description',
  price: 'price', unitprice: 'price', cost: 'cost', unit: 'unit', taxratekey: 'taxRateKey', tax: 'taxRateKey',
  taxable: 'taxable', active: 'active', industry: 'industry', taskcode: 'taskCode',
};
const FIELDS = ['sku', 'name', 'category', 'subcategory', 'description', 'price', 'cost', 'unit', 'taxRateKey', 'taxable', 'active', 'industry', 'taskCode'];

const TEMPLATE = [
  'sku,name,category,subcategory,description,price,cost,unit,taxRateKey,taxable,active',
  'SVC-CALL,Service call,Service,,Diagnostic visit (first 30 minutes),95.00,0,each,,false,true',
  'LAB-HR,Labour,Labour,,Per hour on site,85.00,40.00,hour,,false,true',
  '',
].join('\n');

const keyOf = (name, category) => `${String(name).trim().toLowerCase()}\u0000${String(category).trim().toLowerCase()}`;

function parseBool(raw, field) {
  const s = String(raw).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  throw badRequest(`${field} must be true / false (or yes / no)`, { code: 'INVALID_INPUT', field });
}

function parsePrice(raw, field) {
  const s = String(raw).trim().replace(/^[$€£]\s*/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  return v.money(s, field, { required: false, min: 0 });
}

/** Validated values present (non-blank) in one CSV row. */
function rowValues(cells, taxKeys) {
  const d = {};
  const get = (f) => (cells[f] == null ? '' : String(cells[f]).trim());
  const s = (f, max) => { if (get(f) !== '') d[f] = v.str(get(f), f, { max }); };
  s('sku', 60); s('name', 200); s('category', 100); s('subcategory', 100); s('description', 2000);
  s('unit', 40); s('industry', 100); s('taskCode', 60);
  if (get('price') !== '') d.price = parsePrice(get('price'), 'price');
  if (get('cost') !== '') d.cost = parsePrice(get('cost'), 'cost');
  if (get('taxable') !== '') d.taxable = parseBool(get('taxable'), 'taxable');
  if (get('active') !== '') d.active = parseBool(get('active'), 'active');
  if (get('taxRateKey') !== '') d.taxRateKey = v.oneOf(get('taxRateKey').toLowerCase(), taxKeys, 'taxRateKey');
  return d;
}

const same = (a, b) => (typeof a === 'number' || typeof b === 'number' || (a && typeof a.toNumber === 'function'))
  ? Number(a) === Number(b) : (a ?? null) === (b ?? null);

/**
 * @param prisma   client
 * @param buf      CSV bytes
 * @param opts     { dryRun, industryLabel }
 */
async function importPricebook(prisma, buf, { dryRun = true, industryLabel } = {}) {
  let parsed;
  try { parsed = parseCsv(buf); } catch (e) {
    if (e instanceof CsvError) throw badRequest(e.message, { code: 'INVALID_CSV', line: e.line });
    throw e;
  }
  if (!parsed.headers.length) throw badRequest('The CSV is empty — start from the template', { code: 'INVALID_CSV' });
  const map = parsed.headers.map((h) => COLUMNS[h.toLowerCase().replace(/[\s_-]+/g, '')] || null);
  const unknown = parsed.headers.filter((_, i) => !map[i]);
  if (!map.includes('name') || !map.includes('category')) {
    throw badRequest('The CSV needs at least the columns name and category (see GET /api/pricebook/import/template.csv)', { code: 'REQUIRED', field: map.includes('name') ? 'category' : 'name' });
  }
  if (parsed.rows.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS} rows per import`, { code: 'TOO_MANY_ROWS' });

  const taxKeys = getLocale().taxRates.map((r) => r.key);
  const existing = await prisma.priceBookItem.findMany();
  const bySku = new Map(existing.filter((i) => i.sku).map((i) => [i.sku.toLowerCase(), i]));
  const byName = new Map();
  for (const i of existing) {
    const k = keyOf(i.name, i.category);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(i);
  }

  const seen = new Map();
  const rows = [];
  const plan = []; // { kind:'create'|'update', id?, data, report }
  const counts = { rows: parsed.rows.length, created: 0, updated: 0, skipped: 0, errored: 0 };

  parsed.rows.forEach((cellsArr, idx) => {
    const r = { row: idx + 1, line: parsed.lineOf[idx] };
    const cells = {};
    map.forEach((f, i) => { if (f && cells[f] === undefined) cells[f] = cellsArr[i]; });
    try {
      if (FIELDS.every((f) => cells[f] == null || String(cells[f]).trim() === '')) {
        Object.assign(r, { outcome: 'skipped', reason: 'blank row' });
        return;
      }
      const d = rowValues(cells, taxKeys);
      const fileKey = d.sku ? `sku:${d.sku.toLowerCase()}` : (d.name && d.category ? `name:${keyOf(d.name, d.category)}` : null);
      r.key = d.sku ? `sku:${d.sku}` : `name+category:${d.name || ''} / ${d.category || ''}`;
      if (!fileKey) throw badRequest('name and category are required when sku is blank', { code: 'REQUIRED', field: d.name ? 'category' : 'name' });
      if (seen.has(fileKey)) throw badRequest(`Same key as row ${seen.get(fileKey)} of this file`, { code: 'DUPLICATE_IN_FILE', field: d.sku ? 'sku' : 'name' });
      seen.set(fileKey, r.row);

      let target = null;
      if (d.sku) target = bySku.get(d.sku.toLowerCase()) || null;
      if (!target && d.name && d.category) {
        const cands = (byName.get(keyOf(d.name, d.category)) || []).filter((i) => !d.sku || !i.sku);
        if (cands.length > 1) throw badRequest(`${cands.length} existing items have this name + category — add a sku to tell them apart`, { code: 'AMBIGUOUS_MATCH', field: 'name' });
        target = cands[0] || null;
      }
      if (!target) {
        if (!d.name || !d.category) throw badRequest('name and category are required to create an item', { code: 'REQUIRED', field: d.name ? 'category' : 'name' });
        const data = { industry: industryLabel, price: 0, cost: 0, taxable: false, active: true, ...d };
        plan.push({ kind: 'create', data, report: r });
        Object.assign(r, { outcome: 'created' });
        return;
      }
      const changes = {};
      for (const [k, val] of Object.entries(d)) {
        if (!same(target[k], val)) changes[k] = { from: target[k] == null ? null : (typeof target[k] === 'object' && target[k].toNumber ? target[k].toNumber() : target[k]), to: val };
      }
      r.id = target.id;
      if (!Object.keys(changes).length) {
        Object.assign(r, { outcome: 'skipped', reason: 'unchanged' });
        return;
      }
      plan.push({ kind: 'update', id: target.id, data: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])), report: r });
      Object.assign(r, { outcome: 'updated', changes });
    } catch (e) {
      if (!(e && e.name === 'HttpError')) throw e;
      Object.assign(r, { outcome: 'errored', errors: [{ field: e.extra && e.extra.field, code: e.extra && e.extra.code, error: e.message }] });
    } finally {
      rows.push(r);
    }
  });

  for (const r of rows) counts[r.outcome] += 1;

  let committed = false;
  if (!dryRun && plan.length) {
    await prisma.$transaction(async (tx) => {
      for (const p of plan) {
        // eslint-disable-next-line no-await-in-loop
        const item = p.kind === 'create'
          ? await tx.priceBookItem.create({ data: p.data })
          : await tx.priceBookItem.update({ where: { id: p.id }, data: p.data });
        p.report.id = item.id;
      }
    }, { timeout: 60000 });
    committed = true;
  }

  return {
    kind: 'pricebook-import',
    mode: dryRun ? 'dry-run' : 'commit',
    committed,
    file: { rows: parsed.rows.length, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') },
    columns: { recognised: parsed.headers.filter((_, i) => map[i]), unknown },
    counts,
    rows,
  };
}

module.exports = { importPricebook, TEMPLATE, COLUMNS, MAX_ROWS };
