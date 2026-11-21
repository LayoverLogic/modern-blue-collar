/**
 * routes/sms.js  — Twilio SMS notifications
 * Requires (production): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *
 * POST /api/sms/send                 { to, body }  — send ad-hoc SMS
 * POST /api/sms/job-confirm/:jobId                 — send job confirmation SMS to customer
 *
 * When SANDBOX_MODE=true or DEMO_MODE=true, sending is a no-op: the message is
 * logged to the console and a Twilio-shaped response with sent:false is returned,
 * so the sandbox/demo needs no Twilio account. See helpers/integrations.js.
 */
const express          = require('express');
const router           = express.Router();
const { requireAuth }  = require('./auth');
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

// POST /api/sms/send
router.post('/send', requireAuth, async (req, res, next) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body are required' });
    const msg = await deliverSms(to, body);
    res.json({ sid: msg.sid, status: msg.status, sent: msg.sent, message: msg.message });
  } catch (err) { next(err); }
});

// POST /api/sms/job-confirm/:jobId
router.post('/job-confirm/:jobId', requireAuth, async (req, res, next) => {
  try {
    const job = await prisma.job.findUnique({
      where: { id: Number(req.params.jobId) },
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
