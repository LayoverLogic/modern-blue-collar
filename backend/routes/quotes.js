/**
 * routes/quotes.js  — Quote CRUD
 * status: draft | sent | approved | declined
 *
 * Reads: office roles see all; technicians see quotes of their own jobs (RT-21).
 * Writes: BILLING roles only. Amounts must be finite, >= 0 (a $0 estimate is
 * allowed), at most helpers/validate MONEY_MAX, 2 decimals (RT-11).
 * PATCH/PUT need `version`. Money is still Float (Decimal is a later change).
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

function quoteFields(body, { create = false } = {}) {
  const d = {};
  if (create || body.amount !== undefined) d.amount = v.money(body.amount, 'amount', { min: 0 });
  if (body.status !== undefined) d.status = v.oneOf(body.status, v.QUOTE_STATUSES, 'status', { required: true });
  if (body.notes !== undefined) d.notes = v.str(body.notes, 'notes', { max: 5000 });
  return d;
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const scope = jobScope(req.user);
    const where = Object.keys(scope).length ? { job: scope } : {};
    const quotes = await prisma.quote.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' } });
    res.json(quotes);
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const q = await prisma.quote.findUnique({ where: { id: parseId(req.params.id) }, include: INCLUDE });
    if (!q) throw notFound('Quote not found');
    await assertJobAccess(req.user, q.jobId);
    res.json(q);
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireRole(...BILLING), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.jobId == null || body.jobId === '') throw badRequest('jobId and amount are required', { code: 'REQUIRED', field: 'jobId' });
    const jobId = parseId(body.jobId, 'jobId');
    const d = quoteFields(body, { create: true });
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
    if (!job) throw badRequest('jobId does not match a job', { code: 'UNKNOWN_JOB', field: 'jobId' });
    const q = await prisma.quote.create({ data: { jobId, ...d } }); // duplicate per job → 409
    res.status(201).json(q);
  } catch (e) { next(e); }
});

async function updateQuote(req, res, next) {
  try {
    const body = req.body || {};
    const q = await optimisticUpdate('quote', parseId(req.params.id), { ...quoteFields(body), version: body.version });
    res.json(q);
  } catch (e) { next(e); }
}
router.patch('/:id', requireAuth, requireRole(...BILLING), updateQuote);
router.put('/:id', requireAuth, requireRole(...BILLING), updateQuote);

router.delete('/:id', requireAuth, requireRole(...BILLING), async (req, res, next) => {
  try {
    await prisma.quote.delete({ where: { id: parseId(req.params.id) } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

module.exports = router;
