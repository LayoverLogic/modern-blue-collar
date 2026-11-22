/**
 * routes/quotes.js  — Quote CRUD + email (line items: Phase 2b)
 * status: draft | sent | approved | declined
 *
 * Shared logic: helpers/documentRoutes.js (routes, locking, email) and
 * helpers/documents.js (Decimal totals, numbering, print view).
 *
 *   GET    /api/quotes             list (technicians: own jobs only, RT-21), with lines
 *   GET    /api/quotes/:id         quote + lines + customer + `print` block + `locked`
 *   POST   /api/quotes             { jobId, lines[] | amount, status?, notes?, reverseCharge?, issuedAt? }
 *   PATCH  /api/quotes/:id         same fields + version (PUT is an alias)
 *   DELETE /api/quotes/:id         drafts only (409 DOCUMENT_LOCKED once sent)
 *   POST   /api/quotes/:id/email   { message? } → customer email (outbox in sandbox), logs a communication,
 *                                  marks the quote sent
 * Writes: BILLING roles. A quote may total 0 (free estimate); amounts at most
 * helpers/validate MONEY_MAX, 2 decimals (RT-11). Locked once sent / not draft.
 */
const express = require('express');
const router  = express.Router();
const v = require('../helpers/validate');
const { mountDocumentRoutes } = require('../helpers/documentRoutes');

mountDocumentRoutes(router, {
  type: 'quote', model: 'quote', label: 'Quote', lineModel: 'quoteLine', fk: 'quoteId',
  statuses: v.QUOTE_STATUSES,
  onStatus(d, current) {
    // Moving to "sent" for the first time stamps sentAt — the quote stays locked from then on.
    if (d.status === 'sent' && !(current && current.sentAt)) d.sentAt = new Date();
  },
});

module.exports = router;
