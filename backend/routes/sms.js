/**
 * routes/sms.js  — Twilio SMS notifications
 * Requires (production): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * POST /api/sms/send                 { to, body }  — SMS to a phone number ON RECORD for a customer
 * POST /api/sms/customer/:customerId { body? }     — SMS to that customer's phone (default: generic check-in text)
 * POST /api/sms/job-confirm/:jobId                 — send job confirmation SMS to customer
 *
 * All sends: office roles only (super-admin, admin, dispatcher, office) — RT-16.
 * Arbitrary numbers are refused (400 RECIPIENT_NOT_CUSTOMER, sent:false), so a
 * stolen session cannot be used for toll fraud / phishing to any number.
 *
 * When SANDBOX_MODE=true or DEMO_MODE=true, sending is a no-op: the message is
 * logged to the console and a Twilio-shaped response with sent:false is returned,
 * so the sandbox/demo needs no Twilio account. See helpers/integrations.js.
 */
const express          = require('express');
const router           = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { SMS } = require('../helpers/roles');
const { parseId, badRequest, notFound } = require('../helpers/httpError');
const v = require('../helpers/validate');
const { integrationStatus, disabledMessage } = require('../helpers/integrations');
const brand            = require('../../brand.config');

const prisma = require('../helpers/prisma');

function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  return require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Sends an SMS — or, when Twilio is disabled (SANDBOX_MODE / DEMO_MODE), logs it
// and returns a Twilio-shaped { sid, status } with sent:false, so the UI keeps
// working without a Twilio account. Missing/placeholder creds outside
// sandbox/demo → a 503 "not configured" error (never a network call).
async function deliverSms(to, body) {
  const status = integrationStatus('twilio');
  if (!status.enabled && (status.reason === 'sandbox' || status.reason === 'demo')) {
    console.log(`[${status.reason.toUpperCase()}] SMS suppressed → to=${to} | body="${body}"`);
    return {
      sid: `${status.reason}-${Date.now()}`,
      status: `${status.reason}-suppressed`,
      sent: false,
      message: disabledMessage('twilio', status),
    };
  }
  if (!status.enabled) {
    const err = new Error(disabledMessage('twilio', status));
    err.status = 503;
    throw err;
  }
  const client = getTwilioClient();
  const msg = await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
  return { sid: msg.sid, status: msg.status, sent: true };
}

const MAX_SMS = 1600;

/** Digits-only forms of a phone number we treat as equal (US +1 optional). */
function phoneVariants(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length < 7) return [];
  const set = new Set([d]);
  if (d.length === 11 && d.startsWith('1')) set.add(d.slice(1));
  if (d.length === 10) set.add(`1${d}`);
  return [...set];
}

/** Customer whose phone on record matches `to`, or null. */
async function customerForPhone(to) {
  const variants = phoneVariants(to);
  if (!variants.length) return null;
  const rows = await prisma.$queryRaw`
    SELECT id FROM "Customer"
    WHERE regexp_replace(phone, '[^0-9]', '', 'g') = ANY(${variants}::text[])
    ORDER BY id LIMIT 1`;
  return rows.length ? rows[0] : null;
}

function smsBody(value) {
  const b = v.str(value, 'body', { required: true, max: MAX_SMS });
  return b;
}

// POST /api/sms/send — only to a customer phone number on record
router.post('/send', requireAuth, requireRole(...SMS), async (req, res, next) => {
  try {
    const { to } = req.body || {};
    if (!to || !(req.body || {}).body) return res.status(400).json({ error: 'to and body are required', sent: false });
    if (typeof to !== 'string' || to.length > 40) throw badRequest('to must be a phone number', { sent: false });
    const body = smsBody(req.body.body);
    const customer = await customerForPhone(to);
    if (!customer) {
      return res.status(400).json({ error: 'SMS can only be sent to a customer phone number on record', code: 'RECIPIENT_NOT_CUSTOMER', sent: false });
    }
    const msg = await deliverSms(to, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message });
  } catch (err) { next(err); }
});

// POST /api/sms/customer/:customerId — SMS the customer's phone on record
router.post('/customer/:customerId', requireAuth, requireRole(...SMS), async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: parseId(req.params.customerId, 'customerId') } });
    if (!customer) throw notFound('Customer not found');
    if (!customer.phone) throw badRequest('Customer has no phone number', { sent: false });
    const given = (req.body || {}).body;
    const body = given !== undefined && given !== '' ? smsBody(given)
      : `Hi ${customer.firstName}, this is ${brand.companyName}. Questions about your ${brand.tradeType} service? Call us at ${brand.companyPhone || 'our office'}.`;
    const msg = await deliverSms(customer.phone, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message, sentTo: customer.phone });
  } catch (err) { next(err); }
});

// POST /api/sms/job-confirm/:jobId
router.post('/job-confirm/:jobId', requireAuth, requireRole(...SMS), async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: parseId(req.params.jobId, 'jobId') },
      include: { customer: true },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.customer.phone) return res.status(400).json({ error: 'Customer has no phone number' });

    const dateStr = job.scheduledDate || 'TBD';
    const timeStr = job.scheduledTime || '';
    const body = `Hi ${job.customer.firstName}, this is ${brand.companyName}. ` +
      `Your ${brand.tradeType} service is confirmed for ${dateStr}${timeStr ? ' at ' + timeStr : ''}. ` +
      `Questions? Call us at ${brand.companyPhone || 'our office'}.`;

    const msg = await deliverSms(job.customer.phone, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message, sentTo: job.customer.phone });
  } catch (err) { next(err); }
});

module.exports = router;
