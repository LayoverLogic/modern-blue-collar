/**
 * helpers/documentRoutes.js — the CRUD + email routes shared by quotes and
 * invoices (routes/quotes.js, routes/invoices.js). Phase 2b.
 *
 * Reads: office roles see all; technicians see documents of their own jobs (RT-21).
 * Writes and email: BILLING roles (admin / super-admin) only.
 *
 * Body (POST / PATCH / PUT):
 *   lines[]        { description, quantity, unitPrice, taxRateKey?, pricebookItemId? }
 *                  → server computes lineTotal / subtotal / taxTotal / amount
 *                    (helpers/documents.js); client totals are ignored.
 *   amount         legacy single total (used only when no lines are sent):
 *                  subtotal = amount, taxTotal = 0.
 *   reverseCharge, status, notes, issuedAt, dueDate (invoice)
 *   version        required on PATCH / PUT (optimistic locking, RT-9)
 * number / currency / sentAt / paidAt are set by the server only.
 * Sent / paid (locked) documents only accept status changes → 409 DOCUMENT_LOCKED.
 */
'use strict';

const { requireAuth, requireRole } = require('../routes/auth');
const { optimisticUpdate } = require('./optimisticUpdate');
const { BILLING } = require('./roles');
const { jobScope, assertJobAccess } = require('./access');
const { parseId, badRequest, notFound, HttpError } = require('./httpError');
const v = require('./validate');
const prisma = require('./prisma');
const { getLocale } = require('./locale');
const { sendMail } = require('./mailer');
const docs = require('./documents');

const LINES = { orderBy: { position: 'asc' } };
const INCLUDE = { job: { include: { customer: true } }, lines: LINES };

const sameDate = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());

/**
 * @param {object} cfg { type: 'quote'|'invoice', model, label, lineModel, fk,
 *   statuses, defaultStatus, onStatus(d, current) }
 */
function mountDocumentRoutes(router, cfg) {
  const { type, model, label, lineModel, fk } = cfg;
  const brand = require('../../brand.config');

  /** Validated scalar fields present in body (no totals). */
  function scalarFields(body, { create = false } = {}) {
    const d = {};
    if (body.status !== undefined) d.status = v.oneOf(body.status, cfg.statuses, 'status', { required: true });
    if (body.notes !== undefined) d.notes = v.str(body.notes, 'notes', { max: 5000 });
    if (body.reverseCharge !== undefined) d.reverseCharge = v.bool(body.reverseCharge, 'reverseCharge');
    if (body.issuedAt !== undefined) {
      const at = v.date(body.issuedAt, 'issuedAt');
      if (at) d.issuedAt = at; else if (!create) throw badRequest('issuedAt cannot be cleared', { code: 'INVALID_INPUT', field: 'issuedAt' });
    }
    if (type === 'invoice' && body.dueDate !== undefined) d.dueDate = v.date(body.dueDate, 'dueDate');
    return d;
  }

  const legacyAmount = (value, required) => v.money(value, 'amount', { required, min: 0, exclusive: type === 'invoice' });

  // ── GET / ──────────────────────────────────────────────────────────────
  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const where = {};
      if (type === 'invoice' && typeof req.query.status === 'string' && req.query.status) where.status = req.query.status;
      const scope = jobScope(req.user);
      if (Object.keys(scope).length) where.job = scope;
      const rows = await prisma[model].findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' } });
      res.json(rows);
    } catch (e) { next(e); }
  });

  // ── GET /:id — document + lines + customer + print block ───────────────
  router.get('/:id', requireAuth, async (req, res, next) => {
    try {
      const doc = await prisma[model].findUnique({ where: { id: parseId(req.params.id) }, include: INCLUDE });
      if (!doc) throw notFound(`${label} not found`);
      await assertJobAccess(req.user, doc.jobId);
      res.json(withPrint(doc));
    } catch (e) { next(e); }
  });

  function withPrint(doc) {
    const view = docs.printView(type, doc, brand, getLocale());
    return { ...doc, customer: doc.job ? doc.job.customer : null, locked: docs.isLocked(type, doc), print: view };
  }

  // ── POST / ─────────────────────────────────────────────────────────────
  router.post('/', requireAuth, requireRole(...BILLING), async (req, res, next) => {
    try {
      const body = req.body || {};
      if (body.jobId == null || body.jobId === '') throw badRequest('jobId and amount (or lines) are required', { code: 'REQUIRED', field: 'jobId' });
      const jobId = parseId(body.jobId, 'jobId');
      const d = scalarFields(body, { create: true });
      const locale = getLocale();

      let lines = [];
      if (Array.isArray(body.lines) && body.lines.length) {
        const totals = docs.computeTotals(await docs.parseLines(body.lines, prisma, locale), { reverseCharge: !!d.reverseCharge });
        docs.assertTotal(type, totals.total);
        Object.assign(d, { subtotal: totals.subtotal, taxTotal: totals.taxTotal, amount: totals.total });
        lines = docs.lineRows(totals);
      } else {
        if (body.lines !== undefined && !Array.isArray(body.lines)) throw badRequest('lines must be an array', { code: 'INVALID_INPUT', field: 'lines' });
        const amount = legacyAmount(body.amount, true);
        Object.assign(d, { amount, subtotal: amount, taxTotal: 0 });
      }
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
      if (!job) throw badRequest('jobId does not match a job', { code: 'UNKNOWN_JOB', field: 'jobId' });
      if (cfg.onStatus) cfg.onStatus(d, null);

      const doc = await prisma.$transaction(async (tx) => {
        const number = await docs.allocateNumber(tx, type, locale);
        return tx[model].create({
          data: { jobId, ...d, number, currency: locale.currency, ...(lines.length ? { lines: { create: lines } } : {}) },
          include: { lines: LINES },
        });
      }); // duplicate per job → P2002 → 409 (number rolled back with it)
      res.status(201).json(doc);
    } catch (e) { next(e); }
  });

  // ── PATCH / PUT /:id ───────────────────────────────────────────────────
  async function update(req, res, next) {
    try {
      const id = parseId(req.params.id);
      const body = req.body || {};
      const current = await prisma[model].findUnique({ where: { id }, include: { lines: LINES } });
      if (!current) throw notFound(`${label} not found`);
      const d = scalarFields(body);
      const hasLines = current.lines.length > 0;
      let newLines = null; // null = keep, [] = remove all, [...] = replace

      if (body.lines !== undefined) {
        if (!Array.isArray(body.lines)) throw badRequest('lines must be an array', { code: 'INVALID_INPUT', field: 'lines' });
        newLines = body.lines.length ? await docs.parseLines(body.lines, prisma) : [];
      }
      let legacy;
      if (body.amount !== undefined && !(newLines && newLines.length)) {
        legacy = legacyAmount(body.amount, false);
        if (newLines === null && hasLines && legacy !== undefined && legacy !== Number(current.amount)) {
          throw badRequest(`This ${type} has line items — its total is computed from the lines. Send lines (or lines: [] and amount) instead.`, { code: 'TOTALS_FROM_LINES', field: 'amount' });
        }
      }

      // Locked: only status may change (unchanged echoes of other fields are tolerated).
      if (docs.isLocked(type, current)) {
        const changed = [];
        for (const [k, val] of Object.entries(d)) {
          if (k === 'status') continue;
          const same = (k === 'issuedAt' || k === 'dueDate') ? sameDate(val, current[k]) : val === current[k];
          if (!same) changed.push(k);
        }
        if (newLines !== null) changed.push('lines');
        if (legacy !== undefined && legacy !== Number(current.amount)) changed.push('amount');
        if (changed.length) {
          const err = docs.lockedError(type, current);
          err.extra.fields = changed;
          throw err;
        }
        for (const k of Object.keys(d)) if (k !== 'status') delete d[k];
        newLines = null; legacy = undefined;
      }

      const reverseCharge = d.reverseCharge !== undefined ? d.reverseCharge : current.reverseCharge;
      let rows = null;
      if (newLines && newLines.length) {
        const totals = docs.computeTotals(newLines, { reverseCharge });
        docs.assertTotal(type, totals.total);
        Object.assign(d, { subtotal: totals.subtotal, taxTotal: totals.taxTotal, amount: totals.total });
        rows = docs.lineRows(totals);
      } else if (newLines && !newLines.length) {
        const amount = legacy !== undefined ? legacy : Number(current.amount);
        docs.assertTotal(type, amount);
        Object.assign(d, { amount, subtotal: amount, taxTotal: 0 });
        rows = [];
      } else if (hasLines && d.reverseCharge !== undefined && d.reverseCharge !== current.reverseCharge) {
        const totals = docs.computeTotals(current.lines, { reverseCharge });
        Object.assign(d, { subtotal: totals.subtotal, taxTotal: totals.taxTotal, amount: totals.total });
      } else if (legacy !== undefined && !hasLines) {
        Object.assign(d, { amount: legacy, subtotal: legacy, taxTotal: 0 });
      }
      if (cfg.onStatus) cfg.onStatus(d, current);

      const doc = await prisma.$transaction(async (tx) => {
        if (rows !== null) {
          await tx[lineModel].deleteMany({ where: { [fk]: id } });
          if (rows.length) await tx[lineModel].createMany({ data: rows.map((r) => ({ ...r, [fk]: id })) });
        }
        // version check last: a 409 rolls the line changes back
        return optimisticUpdate(model, id, { ...d, version: body.version }, { client: tx, include: { lines: LINES } });
      });
      res.json(doc);
    } catch (e) { next(e); }
  }
  router.patch('/:id', requireAuth, requireRole(...BILLING), update);
  router.put('/:id', requireAuth, requireRole(...BILLING), update);

  // ── DELETE /:id — drafts only ──────────────────────────────────────────
  router.delete('/:id', requireAuth, requireRole(...BILLING), async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const current = await prisma[model].findUnique({ where: { id } });
      if (!current) throw notFound(`${label} not found`);
      if (docs.isLocked(type, current)) throw docs.lockedError(type, current, type === 'invoice' ? 'deleted (set its status to void instead)' : 'deleted');
      await prisma[model].delete({ where: { id } }); // lines cascade
      res.json({ success: true });
    } catch (e) { next(e); }
  });

  // ── POST /:id/email — HTML + text email to the customer (outbox in sandbox) ──
  router.post('/:id/email', requireAuth, requireRole(...BILLING), async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      const body = req.body || {};
      const message = v.str(body.message, 'message', { max: 5000 }) || '';
      const doc = await prisma[model].findUnique({ where: { id }, include: INCLUDE });
      if (!doc) throw notFound(`${label} not found`);
      const customer = doc.job && doc.job.customer;
      if (!customer || !customer.email) {
        throw badRequest('The customer has no email address on record', { code: 'NO_CUSTOMER_EMAIL', field: 'email' });
      }
      const view = docs.printView(type, doc, brand, getLocale());
      const mail = docs.renderEmail(view, { message });
      const result = await sendMail({
        to: customer.email, subject: mail.subject, text: mail.text, html: mail.html,
        ...(brand.companyEmail ? { replyTo: brand.companyEmail } : {}),
      }, { fromName: brand.companyName });
      if (!result.delivered) {
        throw new HttpError(503, 'Email is not configured on this server (set MAIL_DRIVER / SMTP_HOST)', { code: 'EMAIL_DISABLED', delivered: false });
      }
      const from = process.env.SMTP_FROM || process.env.SMTP_USER || null;
      const out = await prisma.$transaction(async (tx) => {
        const comm = await tx.communication.create({
          data: { customerId: customer.id, type: 'email', direction: 'outbound', subject: mail.subject, body: mail.text, from, to: customer.email },
        });
        const data = { version: { increment: 1 } };
        if (!doc.sentAt) data.sentAt = new Date();
        if (type === 'quote' && doc.status === 'draft') data.status = 'sent';
        const updated = await tx[model].update({ where: { id }, data, include: INCLUDE });
        return { comm, updated };
      });
      res.json({
        delivered: true, driver: result.driver, messageId: result.messageId || null,
        to: customer.email, subject: mail.subject, communicationId: out.comm.id, document: withPrint(out.updated),
      });
    } catch (e) { next(e); }
  });

  return { INCLUDE, LINES, withPrint };
}

module.exports = { mountDocumentRoutes, INCLUDE, LINES };
