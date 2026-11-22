/**
 * routes/exports.js  — CSV data exports (admin roles)
 *   GET /api/exports/customers   → <Company>_customers.csv
 *   GET /api/exports/jobs        → <Company>_jobs.csv
 *   GET /api/exports/invoices    → <Company>_invoices.csv
 *
 * Content-Disposition carries an ASCII `filename` fallback plus an RFC 5987
 * `filename*=UTF-8''…` (WL-14: a brand name with "Ó" or a curly apostrophe used
 * to garble the name or make every export a 500 ERR_INVALID_CHAR).
 * New columns are appended at the end, so existing column positions are kept.
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { ADMIN } = require('../helpers/roles');
const brand   = require('../../brand.config');

const prisma = require('../helpers/prisma');

// CSV injection (RT-10): a cell starting with = + - @ TAB or CR is treated as a
// formula by Excel / Sheets / LibreOffice. Prefix such cells with an apostrophe
// so they are shown as text. Every cell is quoted; quotes are doubled.
function csvCell(value) {
  let v = value == null ? '' : (value instanceof Date ? value.toISOString() : String(value));
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines  = rows.map((r) => columns.map((c) => csvCell(r[c])).join(','));
  return [header, ...lines].join('\n');
}

/** RFC 6266 / 5987 Content-Disposition for a (possibly non-ASCII) file name. */
function contentDisposition(filename) {
  const ascii = filename.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\s+/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function sendCsv(res, what, csv) {
  const name = `${brand.companyName.replace(/\s+/g, '_')}_${what}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.send(csv);
}

router.get('/customers', requireAuth, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    const rows = await prisma.customer.findMany({ orderBy: { lastName: 'asc' } });
    sendCsv(res, 'customers', toCSV(rows, [
      'id', 'firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'type', 'createdAt',
      'addressLine2', 'country', 'company', 'taxNumber',
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
      customerName: j.customer ? `${j.customer.firstName} ${j.customer.lastName}` : '',
      technicianName: j.technician ? `${j.technician.firstName} ${j.technician.lastName}` : '',
      scheduledDate: j.scheduledDate, scheduledTime: j.scheduledTime,
      completedAt: j.completedAt, createdAt: j.createdAt,
    }));
    sendCsv(res, 'jobs', toCSV(flat, ['id', 'title', 'status', 'priority', 'type', 'tradeType', 'customerName', 'technicianName', 'scheduledDate', 'scheduledTime', 'completedAt', 'createdAt']));
  } catch (e) { next(e); }
});

router.get('/invoices', requireAuth, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    const rows = await prisma.invoice.findMany({ include: { job: { include: { customer: true } } }, orderBy: { createdAt: 'desc' } });
    const flat = rows.map((i) => ({
      id: i.id, amount: i.amount, status: i.status, dueDate: i.dueDate, paidAt: i.paidAt,
      jobTitle: i.job?.title, customerName: i.job?.customer ? `${i.job.customer.firstName} ${i.job.customer.lastName}` : '',
      createdAt: i.createdAt,
      number: i.number, currency: i.currency, subtotal: i.subtotal, taxTotal: i.taxTotal,
      reverseCharge: i.reverseCharge, issuedAt: i.issuedAt,
    }));
    sendCsv(res, 'invoices', toCSV(flat, [
      'id', 'amount', 'status', 'dueDate', 'paidAt', 'jobTitle', 'customerName', 'createdAt',
      'number', 'currency', 'subtotal', 'taxTotal', 'reverseCharge', 'issuedAt',
    ]));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.csvCell = csvCell;
module.exports.contentDisposition = contentDisposition;
