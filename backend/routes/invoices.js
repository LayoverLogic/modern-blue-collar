/**
 * routes/invoices.js  — Invoice CRUD
 * status: unpaid | paid | overdue | void
 *
 * Reads: office roles see all; technicians see invoices of their own jobs (RT-21).
 * Writes: BILLING roles only. Amounts must be finite, > 0, at most
 * helpers/validate MONEY_MAX, 2 decimals (RT-11). PATCH/PUT need `version`.
 * Money is still stored as Float — moving to Decimal is a later schema change.
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { optimisticUpdate } = require('../helpers/optimisticUpdate');
const { BILLING } = require('../helpers/roles');
const { jobScope, assertJobAccess } = require('../helpers/access');
const { parseId, badRequest, notFound } = require('../helpers/httpError');
const v = require('../helpers/validate');
const prisma = require('../helpers/prisma');

const INCLUDE = { job: { include: { customer: true } } };

function invoiceFields(body, { create = false } = {}) {
  const d = {};
  if (create || body.amount !== undefined) d.amount = v.money(body.amount, 'amount', { min: 0, exclusive: true });
  if (body.status !== undefined) d.status = v.oneOf(body.status, v.INVOICE_STATUSES, 'status', { required: true });
  if (body.dueDate !== undefined) d.dueDate = v.date(body.dueDate, 'dueDate');
  if (body.notes !== undefined) d.notes = v.str(body.notes, 'notes', { max: 5000 });
  return d;
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const where = {};
    if (typeof req.query.status === 'string' && req.query.status) where.status = req.query.status;
    const scope = jobScope(req.user);
    if (Object.keys(scope).length) where.job = scope;
    const invoices = await prisma.invoice.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' } });
    res.json(invoices);
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const inv = await prisma.invoice.findUnique({ where: { id: parseId(req.params.id) }, include: INCLUDE });
    if (!inv) throw notFound('Invoice not found');
    await assertJobAccess(req.user, inv.jobId);
    res.json(inv);
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole(...BILLING), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.jobId == null || body.jobId === '') throw badRequest('jobId and amount are required', { code: 'REQUIRED', field: 'jobId' });
    const jobId = parseId(body.jobId, 'jobId');
    const d = invoiceFields(body, { create: true });
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) throw badRequest('jobId does not match a job', { code: 'UNKNOWN_JOB', field: 'jobId' });
    if (d.status === 'paid') d.paidAt = new Date();
    const inv = await prisma.invoice.create({ data: { jobId, ...d } }); // duplicate per job → P2002 → 409
    res.status(201).json(inv);
  } catch (e) { next(e); }
});

async function updateInvoice(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const body = req.body || {};
    const d = invoiceFields(body);
    if (d.status) {
      const current = await prisma.invoice.findUnique({ where: { id }, select: { status: true } });
      if (!current) throw notFound('Invoice not found');
      if (d.status === 'paid' && current.status !== 'paid') d.paidAt = new Date();
      if (d.status !== 'paid' && current.status === 'paid') d.paidAt = null;
    }
    const inv = await optimisticUpdate('invoice', id, { ...d, version: body.version });
    res.json(inv);
  } catch (e) { next(e); }
}
router.patch('/:id', requireAuth, requireRole(...BILLING), updateInvoice);
router.put('/:id', requireAuth, requireRole(...BILLING), updateInvoice);

router.delete('/:id', requireAuth, requireRole(...BILLING), async (req, res, next) => {
  try {
    await prisma.invoice.delete({ where: { id: parseId(req.params.id) } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
