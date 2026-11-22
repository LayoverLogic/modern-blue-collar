/**
 * helpers/mailer.js — one place that decides how outbound email is delivered.
 *
 * MAIL_DRIVER selects the transport:
 *   smtp    real SMTP / Mailpit (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS).
 *           Default when SMTP_HOST is set — the existing behaviour.
 *   outbox  sandbox sink: nothing leaves the machine. Each message is written
 *           to MAIL_OUTBOX_DIR (default backend/outbox/, gitignored) as a
 *           standard `.eml` file plus a `.json` summary (to/subject/text).
 *   none    email disabled (default when SMTP_HOST is unset).
 *
 * sendMail() resolves to { delivered, driver, messageId, file? } and never
 * throws for the `none` driver, so callers can still return the invite link.
 * It DOES throw when the smtp transport fails (host unreachable, auth refused…).
 *
 * trySendMail() never throws: a transport failure resolves to
 *   { delivered: false, driver, failed: true, reason }
 * where reason is a short, safe description (describeMailError) — used by the
 * invite / reset flows, which must not 500 when mail is down (GAP-4).
 * mailFailedError(err) → HttpError 502 { code: 'EMAIL_FAILED', reason } for
 * endpoints whose whole job is the email (quote / invoice email, GAP-5).
 */
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

function getDriver() {
  const explicit = (process.env.MAIL_DRIVER || '').trim().toLowerCase();
  if (explicit) {
    if (!['smtp', 'outbox', 'none'].includes(explicit)) {
      throw new Error(`Unknown MAIL_DRIVER "${explicit}" (expected smtp | outbox | none)`);
    }
    return explicit;
  }
  return process.env.SMTP_HOST ? 'smtp' : 'none';
}

function getOutboxDir() {
  return path.resolve(process.env.MAIL_OUTBOX_DIR || path.join(__dirname, '..', 'outbox'));
}

let _transport = null;
let _transportDriver = null;
function getTransport() {
  const driver = getDriver();
  if (_transport && _transportDriver === driver) return _transport;
  const nodemailer = require('nodemailer');
  if (driver === 'smtp') {
    const port = Number(process.env.SMTP_PORT) || 587;
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else if (driver === 'outbox') {
    // streamTransport + buffer: nodemailer builds the full RFC 822 message in memory.
    _transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  } else {
    _transport = null;
  }
  _transportDriver = driver;
  return _transport;
}

function defaultFrom(fromName) {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@localhost';
  return fromName ? `"${String(fromName).replace(/"/g, '')}" <${addr}>` : addr;
}

/**
 * @param {object} msg nodemailer message ({ to, subject, text, html, from? })
 * @param {object} [opts] { fromName }
 */
async function sendMail(msg, opts = {}) {
  const driver = getDriver();
  const message = { from: defaultFrom(opts.fromName), ...msg };
  if (driver === 'none') {
    console.log(`[MAIL] Email disabled (no SMTP_HOST / MAIL_DRIVER) — not sent: to=${message.to} subject="${message.subject}"`);
    return { delivered: false, driver };
  }

  const info = await getTransport().sendMail(message);
  if (driver === 'smtp') return { delivered: true, driver, messageId: info.messageId };

  // outbox: persist the rendered message
  const dir = getOutboxDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base  = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
  const emlPath = path.join(dir, `${base}.eml`);
  await fs.promises.writeFile(emlPath, info.message);
  await fs.promises.writeFile(path.join(dir, `${base}.json`), JSON.stringify({
    messageId: info.messageId,
    date: new Date().toISOString(),
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    eml: path.basename(emlPath),
  }, null, 2));
  console.log(`[MAIL] Sandbox outbox → ${emlPath} (to=${message.to})`);
  return { delivered: true, driver, messageId: info.messageId, file: emlPath };
}

/** Short description of a transport error, safe to show an admin (no credentials). */
function describeMailError(err) {
  if (!err) return 'unknown error';
  const code = err.code || err.responseCode || '';
  let msg = String(err.message || err).split('\n')[0];
  // never echo credentials that may appear in an SMTP URL
  msg = msg.replace(/\/\/[^@\s/]+@/g, '//***@');
  if (msg.length > 200) msg = `${msg.slice(0, 197)}...`;
  return code && !msg.includes(String(code)) ? `${code}: ${msg}` : msg;
}

async function trySendMail(msg, opts = {}) {
  let driver = 'none';
  try {
    driver = getDriver();
    return await sendMail(msg, opts);
  } catch (err) {
    const reason = describeMailError(err);
    console.warn(`[MAIL] send failed (driver=${driver}) to=${msg && msg.to}: ${reason}`);
    return { delivered: false, driver, failed: true, reason };
  }
}

function mailFailedError(err) {
  const { HttpError } = require('./httpError');
  const reason = typeof err === 'string' ? err : describeMailError(err);
  return new HttpError(502, `The email could not be sent: ${reason}`, { code: 'EMAIL_FAILED', reason, delivered: false });
}

module.exports = { sendMail, trySendMail, getDriver, getOutboxDir, describeMailError, mailFailedError };
