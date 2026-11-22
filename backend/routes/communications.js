/**
 * routes/communications.js
 * Customer communication history: calls, emails, texts, notes.
 * Gmail integration endpoint structure.
 *
 * Access: office roles see / log everything; technicians see and log comms
 * only for customers on their assigned jobs (RT-21). Deleting a log entry
 * (the audit trail) is admin-only (RT-8).
 */
const express          = require('express');
const crypto           = require('crypto');
const router           = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { ADMIN, isOffice } = require('../helpers/roles');
const { customerScope, jobScope, assertCustomerAccess } = require('../helpers/access');
const { parseId, notFound, badRequest } = require('../helpers/httpError');
const { isPlaceholder } = require('../helpers/integrations');
const v = require('../helpers/validate');
// WL-10: money in the timeline uses the document's currency + locale format
const { formatMoney } = require('../helpers/locale');
const prisma           = require('../helpers/prisma');

// GET /api/communications?customerId=X — timeline for a customer
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const customerId = typeof req.query.customerId === 'string' && req.query.customerId ? parseId(req.query.customerId, 'customerId') : null;
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    const where = {};
    if (customerId) {
      await assertCustomerAccess(req.user, customerId);
      where.customerId = customerId;
    } else if (!isOffice(req.user)) {
      where.customer = customerScope(req.user);
    }
    if (type) where.type = type;

    const comms = await prisma.communication.findMany({
      where,
      include: { customer: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // If customerId provided, also fetch quotes and invoices for timeline
    if (customerId) {
      const jobs = await prisma.job.findMany({
        where: { customerId, ...jobScope(req.user) },
        include: { quote: true, invoice: true },
      });

      const timeline = [];

      comms.forEach(c => {
        timeline.push({
          id: `comm-${c.id}`,
          type: c.type,
          direction: c.direction,
          subject: c.subject,
          body: c.body,
          from: c.from,
          to: c.to,
          createdAt: c.createdAt,
          category: 'communication',
        });
      });

      jobs.forEach(j => {
        if (j.quote) {
          timeline.push({
            id: `quote-${j.quote.id}`,
            type: 'quote',
            subject: `Quote ${j.quote.number || `#${j.quote.id}`} for Job #${j.id}`,
            body: `Amount: ${formatMoney(j.quote.amount, j.quote.currency)} — Status: ${j.quote.status}`,
            createdAt: j.quote.createdAt,
            category: 'financial',
            jobId: j.id,
          });
        }
        if (j.invoice) {
          timeline.push({
            id: `invoice-${j.invoice.id}`,
            type: 'invoice',
            subject: `Invoice ${j.invoice.number || `#${j.invoice.id}`} for Job #${j.id}`,
            body: `Amount: ${formatMoney(j.invoice.amount, j.invoice.currency)} — Status: ${j.invoice.status}`,
            createdAt: j.invoice.createdAt,
            category: 'financial',
            jobId: j.id,
          });
        }
      });

      timeline.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.json({ communications: comms, timeline });
    }

    res.json(comms);
  } catch (err) { next(err); }
});

// GET /api/communications/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const comm = await prisma.communication.findUnique({
      where: { id: parseId(req.params.id) },
      include: { customer: true },
    });
    if (!comm) throw notFound('Communication not found');
    await assertCustomerAccess(req.user, comm.customerId);
    res.json(comm);
  } catch (err) { next(err); }
});

// POST /api/communications — log a call, text, email, or note
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.customerId == null || body.customerId === '' || !body.type) {
      throw badRequest('customerId and type are required', { code: 'REQUIRED' });
    }
    const customerId = parseId(body.customerId, 'customerId');
    const data = {
      customerId,
      type:      v.oneOf(body.type, v.COMM_TYPES, 'type', { required: true }),
      direction: v.oneOf(body.direction, v.COMM_DIRECTIONS, 'direction') || 'outbound',
      subject:   v.str(body.subject, 'subject', { max: 500 }),
      body:      v.str(body.body, 'body', { max: 20000 }),
      from:      v.str(body.from, 'from', { max: 254 }),
      to:        v.str(body.to, 'to', { max: 254 }),
    };
    await assertCustomerAccess(req.user, customerId);
    const comm = await prisma.communication.create({ data });
    res.status(201).json(comm);
  } catch (err) { next(err); }
});

// DELETE /api/communications/:id — admin+ (the log is an audit trail)
router.delete('/:id', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    await prisma.communication.delete({ where: { id: parseId(req.params.id) } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Gmail Integration Endpoints ─────────────────────────────────────────────

// POST /api/communications/gmail/sync — sync emails for a customer
router.post('/gmail/sync', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const { customerId, email } = req.body;
    if (!customerId || !email) {
      return res.status(400).json({ error: 'customerId and email are required' });
    }

    // Gmail API integration placeholder
    // In production, this would use Google Gmail API with OAuth2 to:
    // 1. Search for messages to/from the customer email
    // 2. Import them as Communication records with gmailMsgId
    // 3. Deduplicate using gmailMsgId

    res.json({
      message: 'Gmail sync endpoint ready. Configure GOOGLE_CLIENT_ID and enable Gmail API scope to activate.',
      customerId,
      email,
    });
  } catch (err) { next(err); }
});

// POST /api/communications/gmail/webhook — receive Gmail push notifications
// Disabled (503) unless GMAIL_WEBHOOK_SECRET is set; then the caller must send
// it as `X-Webhook-Secret: <secret>` or `?token=<secret>` (the form a Pub/Sub
// push subscription can carry). RT-26.
function webhookSecretOk(req) {
  const secret = process.env.GMAIL_WEBHOOK_SECRET;
  const given  = req.get('x-webhook-secret') || (typeof req.query.token === 'string' ? req.query.token : '');
  if (!given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.post('/gmail/webhook', async (req, res, next) => {
  try {
    if (isPlaceholder(process.env.GMAIL_WEBHOOK_SECRET) || String(process.env.GMAIL_WEBHOOK_SECRET).length < 16) {
      return res.status(503).json({ error: 'Gmail webhook is not configured (set GMAIL_WEBHOOK_SECRET, 16+ chars)', code: 'WEBHOOK_DISABLED' });
    }
    if (!webhookSecretOk(req)) return res.status(401).json({ error: 'Invalid webhook secret', code: 'WEBHOOK_UNAUTHORISED' });
    // Gmail push notification handler placeholder
    // In production: parse notification, fetch new messages
    res.json({ received: true });
  } catch (err) { next(err); }
});

module.exports = router;
