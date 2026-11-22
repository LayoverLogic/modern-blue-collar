/**
 * routes/invoices.js  — Invoice CRUD + email + from-quote (line items: Phase 2b)
 * status: unpaid | paid | overdue | void
 *
 * Shared logic: helpers/documentRoutes.js and helpers/documents.js.
 *
 *   GET    /api/invoices[?status=]            list (technicians: own jobs, RT-21), with lines
 *   GET    /api/invoices/:id                  invoice + lines + customer + `print` block + `locked`
 *   POST   /api/invoices                      { jobId, lines[] | amount, status?, dueDate?, notes?, reverseCharge?, issuedAt? }
 *   POST   /api/invoices/from-quote/:quoteId  { dueDate?, notes? } → copies lines, totals, currency, reverse charge;
 *                                             sets quoteId. One live (non-void) invoice per quote → else 409 DUPLICATE.
 *                                             A job may have several quotes and invoices (B3, GAP-8).
 *   PATCH  /api/invoices/:id                  same fields + version (PUT is an alias)
 *   DELETE /api/invoices/:id                  only while unpaid and never sent
 *   POST   /api/invoices/:id/email            { message? } → customer email, logs a communication, sets sentAt
 * Writes: BILLING roles. Total must be > 0. Locked once sent, or while
 * paid / overdue / void: then only status changes (paidAt follows status).
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { BILLING } = require('../helpers/roles');
const { parseId, notFound, conflict } = require('../helpers/httpError');
const v = require('../helpers/validate');
const prisma = require('../helpers/prisma');
const docs = require('../helpers/documents');
const { getLocale } = require('../helpers/locale');
const { mountDocumentRoutes, LINES } = require('../helpers/documentRoutes');
const activity = require('../helpers/activity');

function onStatus(d, current) {
  if (!d.status) return;
  const was = current ? current.status : null;
  if (d.status === 'paid' && was !== 'paid') d.paidAt = new Date();
  if (d.status !== 'paid' && was === 'paid') d.paidAt = null;
}

// POST /api/invoices/from-quote/:quoteId — before the shared /:id routes
router.post('/from-quote/:quoteId', requireAuth, requireRole(...BILLING), async (req, res, next) => {
  try {
    const quoteId = parseId(req.params.quoteId, 'quoteId');
    const body = req.body || {};
    const quote = await prisma.quote.findUnique({ where: { id: quoteId }, include: { lines: LINES } });
    if (!quote) throw notFound('Quote not found');
    if (quote.status === 'declined') throw conflict('This quote was declined — it cannot be invoiced', { code: 'QUOTE_DECLINED' });
    docs.assertTotal('invoice', quote.amount);
    // GAP-8: a job may have several invoices, but one quote is billed once
    // (a voided invoice can be re-billed). The partial unique index
    // "Invoice_quoteId_live_key" backs this up under concurrency (P2002 → 409).
    const existing = await prisma.invoice.findFirst({ where: { quoteId: quote.id, status: { not: 'void' } }, select: { id: true, number: true } });
    if (existing) throw conflict(`Quote ${quote.number} was already invoiced as ${existing.number}`, { code: 'DUPLICATE', invoiceId: existing.id });
    const d = { status: 'unpaid' };
    if (body.dueDate !== undefined) d.dueDate = require('../helpers/calendarDate').calendarDate(body.dueDate, 'dueDate', require('../../brand.config').timezone);
    d.notes = body.notes !== undefined ? v.str(body.notes, 'notes', { max: 5000 }) : quote.notes;
    const lines = quote.lines.map((l) => ({
      position: l.position, description: l.description, quantity: String(l.quantity), unitPrice: String(l.unitPrice),
      taxRateKey: l.taxRateKey, taxRate: String(l.taxRate), lineTotal: String(l.lineTotal), pricebookItemId: l.pricebookItemId,
    }));
    const locale = getLocale();
    const invoice = await prisma.$transaction(async (tx) => {
      const number = await docs.allocateNumber(tx, 'invoice', locale);
      const created = await tx.invoice.create({
        data: {
          jobId: quote.jobId, quoteId: quote.id, number, ...d,
          amount: String(quote.amount), subtotal: String(quote.subtotal), taxTotal: String(quote.taxTotal),
          currency: quote.currency, reverseCharge: quote.reverseCharge,
          ...(lines.length ? { lines: { create: lines } } : {}),
        },
        include: { lines: LINES },
      });
      // GTM-18: same entry as POST /api/invoices, plus the quote it came from
      await activity.log(tx, req, created.jobId, 'invoice_created', {
        to: { invoiceId: created.id, number: created.number, amount: Number(created.amount), currency: created.currency, status: created.status, fromQuoteId: quote.id, fromQuoteNumber: quote.number },
      });
      return created;
    }); // the quote already has a live invoice (concurrent request) → P2002 → 409 DUPLICATE
    res.status(201).json({ ...invoice, fromQuote: { id: quote.id, number: quote.number } });
  } catch (e) { next(e); }
});

mountDocumentRoutes(router, {
  type: 'invoice', model: 'invoice', label: 'Invoice', lineModel: 'invoiceLine', fk: 'invoiceId',
  statuses: v.INVOICE_STATUSES, onStatus,
});

module.exports = router;
