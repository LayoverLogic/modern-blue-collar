/**
 * routes/sms.js  — Twilio SMS notifications
 * Requires (production): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * POST /api/sms/send                 { to, body }  — SMS to a phone number ON RECORD for a customer
 * POST /api/sms/customer/:customerId { body? }     — SMS to that customer's phone (default: generic check-in text)
 * POST /api/sms/job-confirm/:jobId                 — send job confirmation SMS to customer
 *
 * All sends: office roles only (super-admin, admin, dispatcher, office) — RT-16.
 * Recipients are sent to Twilio in E.164 (helpers/phone.js, WL-12); `sentTo`
 * in the response is that E.164 number. A number on record that cannot be
 * normalised → 400 INVALID_PHONE (sent:false).
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
const { getLocale, formatDate, formatTime } = require('../helpers/locale');
const { toE164, matchVariants } = require('../helpers/phone');

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

// WL-8: human trade label ("Plumbing & HVAC", not the slug "plumbing-hvac"),
// and the appointment date in the brand's locale / time zone.
function serviceLabel() {
  return brand.industryLabel || brand.tradeType;
}

/** { date, time } for the SMS: scheduledDate (calendar date) / scheduledAt (brand time zone). */
function whenText(job) {
  const loc = getLocale();
  if (job.scheduledDate) {
    return { date: formatDate(job.scheduledDate, loc, brand.timezone, { year: false }), time: job.scheduledTime ? formatTime(job.scheduledTime, loc) : '' };
  }
  if (job.scheduledAt) {
    const at = new Date(job.scheduledAt);
    const hhmm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: brand.timezone }).format(at);
    return { date: formatDate(at, loc, brand.timezone, { year: false }), time: job.scheduledTime ? formatTime(job.scheduledTime, loc) : formatTime(hhmm, loc) };
  }
  return { date: 'TBD', time: '' };
}

/**
 * WL-12: Twilio gets E.164. A customer's number on record is read with the
 * customer's country (or else the brand country); rows written before
 * phones were normalised are converted here.
 */
function customerE164(customer) {
  return toE164(customer.phone, String(customer.country || getLocale().country).toUpperCase());
}

function invalidPhone(raw) {
  return badRequest(`"${String(raw)}" is not a valid phone number`, { code: 'INVALID_PHONE', field: 'phone', sent: false });
}

/** Customer whose phone on record is the same number as `e164`, or null. */
async function customerForPhone(e164) {
  const variants = matchVariants(e164);
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
    const e164 = toE164(to);
    const customer = e164 ? await customerForPhone(e164) : null;
    if (!customer) {
      return res.status(400).json({ error: 'SMS can only be sent to a customer phone number on record', code: 'RECIPIENT_NOT_CUSTOMER', sent: false });
    }
    const msg = await deliverSms(e164, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message, sentTo: e164 });
  } catch (err) { next(err); }
});

// POST /api/sms/customer/:customerId — SMS the customer's phone on record
router.post('/customer/:customerId', requireAuth, requireRole(...SMS), async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: parseId(req.params.customerId, 'customerId') } });
    if (!customer) throw notFound('Customer not found');
    if (!customer.phone) throw badRequest('Customer has no phone number', { sent: false });
    const to = customerE164(customer);
    if (!to) throw invalidPhone(customer.phone);
    const given = (req.body || {}).body;
    const body = given !== undefined && given !== '' ? smsBody(given)
      : `Hi ${customer.firstName}, this is ${brand.companyName}. Questions about your ${serviceLabel()} service? Call us at ${brand.companyPhone || 'our office'}.`;
    const msg = await deliverSms(to, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message, sentTo: to });
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
    const to = customerE164(job.customer);
    if (!to) throw invalidPhone(job.customer.phone);

    const { date: dateStr, time: timeStr } = whenText(job);
    const body = `Hi ${job.customer.firstName}, this is ${brand.companyName}. ` +
      `Your ${serviceLabel()} service is confirmed for ${dateStr}${timeStr ? ' at ' + timeStr : ''}. ` +
      `Questions? Call us at ${brand.companyPhone || 'our office'}.`;

    const msg = await deliverSms(to, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message, sentTo: to });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.whenText = whenText;
module.exports.serviceLabel = serviceLabel;
