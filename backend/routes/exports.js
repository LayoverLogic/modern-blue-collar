/**
 * routes/exports.js  — data exports (admin roles)
 *   GET /api/exports/customers          → <Company>_customers.csv
 *   GET /api/exports/jobs               → <Company>_jobs.csv
 *   GET /api/exports/invoices[?view=lines]  → <Company>_invoices.csv / _invoice_lines.csv
 *   GET /api/exports/quotes[?view=lines]    → <Company>_quotes.csv / _quote_lines.csv
 *   GET /api/exports/xero-invoices?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=unpaid,paid,overdue][&dateFormat=]
 *                                       → <Company>_xero_invoices_<from>_<to>.csv (helpers/xero.js)
 *   GET /api/exports/all[?photos=false] → <Company>_export_<date>.zip — the client's exit export:
 *       every table as CSV (secrets dropped), job photos from storage, manifest.json with row
 *       counts + sha256 per file, SHA256SUMS (verify with `sha256sum -c SHA256SUMS`).
 *
 * Content-Disposition carries an ASCII `filename` fallback plus an RFC 5987
 * `filename*=UTF-8''…` (WL-14). Formula injection (RT-10): cells starting with = + - @ TAB CR
 * get a leading apostrophe (helpers/csv.js). New columns are appended at the end, so existing
 * column positions are kept (invoices/quotes: lineCount, linesJson).
 */
const express = require('express');
const path    = require('path');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { ADMIN } = require('../helpers/roles');
const brand   = require('../../brand.config');
const { csvCell, csvLine, toCSV, contentDisposition } = require('../helpers/csv');
const { badRequest, conflict } = require('../helpers/httpError');
const { getLocale } = require('../helpers/locale');
const { createZipStream } = require('../helpers/zip');
const { buildXeroInvoicesCsv, ymdIn } = require('../helpers/xero');

const prisma = require('../helpers/prisma');

const fileBase = () => brand.companyName.replace(/\s+/g, '_');

function sendCsv(res, what, csv) {
  const name = `${fileBase()}_${what}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.send(csv);
}

const fullName = (p) => (p ? `${p.firstName} ${p.lastName}`.trim() : '');
const LINE_COLS = ['position', 'description', 'quantity', 'unitPrice', 'taxRateKey', 'taxRate', 'lineTotal', 'pricebookItemId'];
const linesJson = (lines) => JSON.stringify((lines || []).map((l) => Object.fromEntries(LINE_COLS.map((k) => [k, l[k]]))));

router.get('/customers', requireAuth, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    const rows = await prisma.customer.findMany({ orderBy: { lastName: 'asc' } });
    sendCsv(res, 'customers', toCSV(rows, [
      'id', 'firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'type', 'createdAt',
      'addressLine2', 'country', 'company', 'taxNumber',
      'sourceSystem', 'sourceId',
    ]));
  } catch (e) { next(e); }
});

router.get('/jobs', requireAuth, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    const rows = await prisma.job.findMany({
      include: { customer: true, technician: true },
      orderBy: { createdAt: 'desc' },
    });
    const flat = rows.map((j) => ({
      id: j.id, title: j.title, status: j.status, priority: j.priority, type: j.type, tradeType: j.tradeType,
      customerName: fullName(j.customer), technicianName: fullName(j.technician),
      scheduledDate: j.scheduledDate, scheduledTime: j.scheduledTime,
      completedAt: j.completedAt, createdAt: j.createdAt,
      customerId: j.customerId, sourceSystem: j.sourceSystem, sourceId: j.sourceId,
    }));
    sendCsv(res, 'jobs', toCSV(flat, ['id', 'title', 'status', 'priority', 'type', 'tradeType', 'customerName', 'technicianName', 'scheduledDate', 'scheduledTime', 'completedAt', 'createdAt', 'customerId', 'sourceSystem', 'sourceId']));
  } catch (e) { next(e); }
});

/** Shared by invoices / quotes: one row per document, or (view=lines) one row per line. */
async function documentExport(req, res, kind) {
  const view = req.query.view || 'documents';
  if (!['documents', 'lines'].includes(view)) throw badRequest('view must be documents or lines', { code: 'INVALID_ENUM', field: 'view', allowed: ['documents', 'lines'] });
  const model = kind === 'invoice' ? prisma.invoice : prisma.quote;
  const rows = await model.findMany({
    include: { job: { include: { customer: true } }, lines: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  const doc = (d) => ({
    id: d.id, amount: d.amount, status: d.status, dueDate: d.dueDate, paidAt: d.paidAt,
    jobTitle: d.job?.title, customerName: fullName(d.job?.customer), createdAt: d.createdAt,
    number: d.number, currency: d.currency, subtotal: d.subtotal, taxTotal: d.taxTotal,
    reverseCharge: d.reverseCharge, issuedAt: d.issuedAt, sentAt: d.sentAt, notes: d.notes,
    jobId: d.jobId, customerId: d.job?.customerId,
    lineCount: d.lines.length, linesJson: linesJson(d.lines),
  });
  const base = kind === 'invoice'
    ? ['id', 'amount', 'status', 'dueDate', 'paidAt', 'jobTitle', 'customerName', 'createdAt', 'number', 'currency', 'subtotal', 'taxTotal', 'reverseCharge', 'issuedAt', 'lineCount', 'linesJson', 'jobId', 'customerId', 'sentAt']
    : ['id', 'number', 'amount', 'status', 'jobTitle', 'customerName', 'createdAt', 'currency', 'subtotal', 'taxTotal', 'reverseCharge', 'issuedAt', 'sentAt', 'notes', 'lineCount', 'linesJson', 'jobId', 'customerId'];
  if (view === 'documents') return sendCsv(res, `${kind}s`, toCSV(rows.map(doc), base));
  const lineRows = [];
  for (const d of rows) {
    for (const l of d.lines) {
      lineRows.push({ documentId: d.id, number: d.number, status: d.status, currency: d.currency, issuedAt: d.issuedAt, customerName: fullName(d.job?.customer), jobId: d.jobId, ...Object.fromEntries(LINE_COLS.map((k) => [k, l[k]])), lineId: l.id });
    }
  }
  return sendCsv(res, `${kind}_lines`, toCSV(lineRows, ['documentId', 'number', 'status', 'currency', 'issuedAt', 'customerName', 'jobId', 'lineId', ...LINE_COLS]));
}

router.get('/invoices', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try { await documentExport(req, res, 'invoice'); } catch (e) { next(e); }
});
router.get('/quotes', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try { await documentExport(req, res, 'quote'); } catch (e) { next(e); }
});

// ── Xero sales invoice CSV ───────────────────────────────────────────────────
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function ymdParam(v, field) {
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || !YMD.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
    throw badRequest(`${field} must be a date in YYYY-MM-DD format`, { code: 'INVALID_INPUT', field });
  }
  return v;
}

router.get('/xero-invoices', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const from = ymdParam(req.query.from, 'from');
    const to = ymdParam(req.query.to, 'to');
    if (from && to && from > to) throw badRequest('from must not be after to', { code: 'INVALID_INPUT', field: 'from' });
    const allowed = ['unpaid', 'paid', 'overdue'];
    const statuses = req.query.status ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean) : allowed;
    for (const s of statuses) if (!allowed.includes(s)) throw badRequest(`status must be a comma list of ${allowed.join(', ')} (void invoices are never exported)`, { code: 'INVALID_ENUM', field: 'status', allowed });
    const dateFormat = req.query.dateFormat;
    if (dateFormat !== undefined && !['DD/MM/YYYY', 'MM/DD/YYYY'].includes(dateFormat)) throw badRequest('dateFormat must be DD/MM/YYYY or MM/DD/YYYY', { code: 'INVALID_ENUM', field: 'dateFormat', allowed: ['DD/MM/YYYY', 'MM/DD/YYYY'] });
    const tz = brand.timezone || 'UTC';
    // Widen the UTC window by a day each side, then filter on the issue date in the brand time zone.
    const where = { status: { in: statuses } };
    if (from || to) {
      where.issuedAt = {};
      if (from) where.issuedAt.gte = new Date(new Date(`${from}T00:00:00Z`).getTime() - 86400000);
      if (to) where.issuedAt.lt = new Date(new Date(`${to}T00:00:00Z`).getTime() + 2 * 86400000);
    }
    const invoices = (await prisma.invoice.findMany({
      where, include: { job: { include: { customer: true } }, lines: { orderBy: { position: 'asc' } } }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    })).filter((i) => { const d = ymdIn(i.issuedAt, tz); return (!from || d >= from) && (!to || d <= to); });
    const out = buildXeroInvoicesCsv(invoices, { locale: getLocale(), timezone: tz, dateFormat });
    res.setHeader('X-MBC-Xero-Invoices', String(out.invoiceCount));
    res.setHeader('X-MBC-Xero-Lines', String(out.lineCount));
    res.setHeader('X-MBC-Xero-Date-Format', out.dateFormat);
    if (out.unmappedTax.length) res.setHeader('X-MBC-Xero-Unmapped-Tax', out.unmappedTax.join(','));
    if (out.warnings.length) res.setHeader('X-MBC-Xero-Warnings', encodeURIComponent(out.warnings.join(' | ')).slice(0, 2000));
    res.setHeader('Access-Control-Expose-Headers', 'X-MBC-Xero-Invoices, X-MBC-Xero-Lines, X-MBC-Xero-Date-Format, X-MBC-Xero-Unmapped-Tax, X-MBC-Xero-Warnings, Content-Disposition');
    sendCsv(res, `xero_invoices_${from || 'start'}_${to || 'today'}`, out.csv);
  } catch (e) { next(e); }
});

// ── Exit export: everything as a zip ─────────────────────────────────────────
// Friendly file names for the known tables; any other table is exported under its own name.
const TABLE_FILES = {
  Customer: 'customers.csv', Job: 'jobs.csv', Quote: 'quotes.csv', QuoteLine: 'quote_lines.csv',
  Invoice: 'invoices.csv', InvoiceLine: 'invoice_lines.csv', PriceBookItem: 'pricebook.csv',
  Communication: 'communications.csv', JobActivity: 'job_activity.csv', JobPhoto: 'job_photos.csv',
  JobPart: 'job_parts.csv', InventoryItem: 'inventory_items.csv', User: 'users.csv',
  DocumentCounter: 'document_counters.csv', IntegrationLink: 'integration_links.csv',
};
// Never exported: credentials / OAuth tokens / engine bookkeeping.
const EXCLUDED_TABLES = {
  ApiKey: 'API keys: hashed secrets — re-issue keys after migrating',
  IntegrationToken: 'OAuth access / refresh tokens (encrypted) — reconnect integrations instead',
  _prisma_migrations: 'database engine bookkeeping',
};
const SECRET_COLUMN = /(password|secret|hashedkey)|^(access|refresh|id)Token$/i;
const PAGE = 1000;

let exportRunning = false;

async function tableColumns() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT table_name, column_name, ordinal_position, data_type, numeric_scale FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position',
  );
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, { columns: [], scale: {} });
    const t = tables.get(r.table_name);
    t.columns.push(r.column_name);
    if (r.data_type === 'numeric' && r.numeric_scale != null) t.scale[r.column_name] = Number(r.numeric_scale);
  }
  return tables;
}

/** Decimal columns keep their scale ("5825.00"), everything else via csvLine. */
function cellOf(value, scale) {
  if (scale != null && value != null && typeof value === 'object' && typeof value.toFixed === 'function') return value.toFixed(scale);
  if (scale != null && typeof value === 'number') return value.toFixed(scale);
  return value;
}

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function* tableCsv(table, columns, scale, counter) {
  const line = (r) => `${csvLine(columns.map((c) => cellOf(r[c], scale[c])))}\n`;
  yield `${columns.join(',')}\n`;
  const cols = columns.map(qi).join(', ');
  if (columns.includes('id')) {
    let last = 0;
    for (;;) {
      const rows = await prisma.$queryRawUnsafe(`SELECT ${cols} FROM ${qi(table)} WHERE "id" > $1 ORDER BY "id" LIMIT ${PAGE}`, last);
      if (!rows.length) break;
      counter.rows += rows.length;
      yield rows.map(line).join('');
      last = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
  } else {
    const rows = await prisma.$queryRawUnsafe(`SELECT ${cols} FROM ${qi(table)} ORDER BY 1`);
    counter.rows += rows.length;
    if (rows.length) yield rows.map(line).join('');
  }
}

const safeName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'photo';

router.get('/all', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  let zip = null;
  let claimed = false;
  try {
    if (req.query.photos !== undefined && !['true', 'false'].includes(req.query.photos)) throw badRequest('photos must be true or false', { code: 'INVALID_INPUT', field: 'photos' });
    const photos = req.query.photos !== 'false';
    if (exportRunning) throw conflict('An export is already running — try again in a moment', { code: 'EXPORT_RUNNING' });
    exportRunning = true; claimed = true;
    const tables = await tableColumns();
    const generatedAt = new Date();
    const stamp = generatedAt.toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(`${fileBase()}_export_${stamp}.zip`));
    res.setHeader('Cache-Control', 'no-store');
    zip = createZipStream(res);
    const manifest = {
      format: 'mbc-exit-export', version: 1, generatedAt: generatedAt.toISOString(),
      company: brand.companyName, generatedBy: { userId: req.user.id, email: req.user.email },
      csv: {
        encoding: 'UTF-8, comma-separated, every cell double-quoted, first row = column names',
        formulaEscaping: 'cells beginning with = + - @ TAB or CR are prefixed with an apostrophe (\') so spreadsheets show them as text — strip one leading apostrophe when re-importing such cells',
        nulls: 'empty cell', dates: 'ISO 8601 UTC', money: 'decimal with 2 places', json: 'JSON text',
      },
      files: [], excluded: [], droppedColumns: [], photos: { included: photos, count: 0, bytes: 0, missing: [] },
    };
    const names = [...tables.keys()].sort((a, b) => (TABLE_FILES[a] ? 0 : 1) - (TABLE_FILES[b] ? 0 : 1) || a.localeCompare(b));
    for (const table of names) {
      if (EXCLUDED_TABLES[table]) { manifest.excluded.push({ table, reason: EXCLUDED_TABLES[table] }); continue; }
      const { columns: all, scale } = tables.get(table);
      const columns = all.filter((c) => !SECRET_COLUMN.test(c));
      for (const c of all) if (SECRET_COLUMN.test(c)) manifest.droppedColumns.push({ table, column: c, reason: 'credential' });
      const counter = { rows: 0 };
      const file = TABLE_FILES[table] || `tables/${safeName(table)}.csv`;
      const entry = await zip.addChunks(file, tableCsv(table, columns, scale, counter));
      manifest.files.push({ path: entry.path, table, columns: columns.length, rows: counter.rows, bytes: entry.bytes, sha256: entry.sha256 });
    }
    if (photos) {
      const storage = require('../helpers/storage');
      if (!storage.isConfigured()) {
        manifest.photos.included = false;
        manifest.photos.note = 'object storage is not configured — photos not included';
      } else {
        let last = 0;
        for (;;) {
          const batch = await prisma.jobPhoto.findMany({ where: { id: { gt: last } }, orderBy: { id: 'asc' }, take: 200 });
          if (!batch.length) break;
          for (const p of batch) {
            const name = `photos/${p.jobId}/${p.id}-${safeName(p.originalName || path.basename(p.key))}`;
            try {
              const obj = await storage.getObject(p.key);
              const entry = await zip.addStream(name, obj.Body, { compress: false });
              manifest.files.push({ path: entry.path, table: 'JobPhoto', photoId: p.id, jobId: p.jobId, key: p.key, bytes: entry.bytes, sha256: entry.sha256 });
              manifest.photos.count += 1; manifest.photos.bytes += entry.bytes;
            } catch (e) {
              manifest.photos.missing.push({ photoId: p.id, jobId: p.jobId, key: p.key, error: e.status === 404 || e.name === 'NoSuchKey' ? 'not found in storage' : String(e.message || e).slice(0, 200) });
            }
          }
          last = batch[batch.length - 1].id;
        }
      }
    }
    manifest.totals = {
      tables: manifest.files.filter((f) => !f.photoId).length,
      rows: manifest.files.reduce((s, f) => s + (f.rows || 0), 0),
      byTable: Object.fromEntries(manifest.files.filter((f) => f.rows !== undefined).map((f) => [f.table, f.rows])),
    };
    const sums = manifest.files.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n';
    await zip.addText('manifest.json', JSON.stringify(manifest, null, 2));
    await zip.addText('SHA256SUMS', sums);
    await zip.finish();
    res.end();
  } catch (e) {
    if (zip && res.headersSent) {
      console.error('[exports/all] failed mid-stream:', e.message);
      zip.abort();
      res.destroy(e);
    } else next(e);
  } finally {
    if (claimed) exportRunning = false;
  }
});

module.exports = router;
module.exports.csvCell = csvCell;
module.exports.contentDisposition = contentDisposition;
