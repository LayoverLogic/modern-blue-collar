/**
 * helpers/integrations.js — decides whether a third-party integration is live.
 *
 * An integration (twilio | quickbooks | google) is DISABLED, and must make no
 * network call, when any of these is true:
 *   - SANDBOX_MODE=true   (the zero-paid-services sandbox; see .env.sandbox.example)
 *   - DEMO_MODE=true      (the Docker demo stack) — Twilio + QuickBooks only,
 *                         as before; Google SSO still works in demo if configured
 *   - any required credential is missing or an obvious placeholder
 *     ("", "placeholder", "changeme", "your_...", "xxx", "sandbox-disabled", ...)
 *
 * Routes call integrationStatus(name) and, when !enabled, answer with
 * sendDisabled(res, name) → HTTP 503 { error, integration, sandbox: true, reason }.
 */

const REQUIRED = {
  twilio:     ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
  quickbooks: ['QB_CLIENT_ID', 'QB_CLIENT_SECRET', 'QB_REDIRECT_URI'],
  google:     ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL'],
};

// DEMO_MODE has always meant "Twilio + QuickBooks are no-ops" (see .env.example).
const DEMO_DISABLES = ['twilio', 'quickbooks'];

const LABEL = { twilio: 'Twilio SMS', quickbooks: 'QuickBooks Online', google: 'Google OAuth' };

const PLACEHOLDER = /^(|placeholder.*|change[-_ ]?me.*|your[-_ ].*|x{3,}.*|todo|tbd|none|null|undefined|dummy.*|fake.*|test|sandbox[-_]disabled.*|<.*>)$/i;

function isPlaceholder(value) {
  return value == null || PLACEHOLDER.test(String(value).trim());
}

function isSandbox() {
  return process.env.SANDBOX_MODE === 'true';
}

function isDemo() {
  return process.env.DEMO_MODE === 'true';
}

/** @returns {{ enabled: boolean, reason: string|null, missing: string[] }} */
function integrationStatus(name) {
  const required = REQUIRED[name];
  if (!required) throw new Error(`Unknown integration "${name}"`);
  const missing = required.filter((k) => isPlaceholder(process.env[k]));
  if (isSandbox()) return { enabled: false, reason: 'sandbox', missing };
  if (isDemo() && DEMO_DISABLES.includes(name)) return { enabled: false, reason: 'demo', missing };
  if (missing.length) return { enabled: false, reason: 'not-configured', missing };
  return { enabled: true, reason: null, missing: [] };
}

function disabledMessage(name, status) {
  const label = LABEL[name] || name;
  if (status.reason === 'sandbox') return `${label} is disabled in sandbox (SANDBOX_MODE=true) — no request was sent.`;
  if (status.reason === 'demo')    return `${label} is disabled in demo mode (DEMO_MODE=true) — no request was sent.`;
  return `${label} is not configured — set ${status.missing.join(', ')} to enable it. No request was sent.`;
}

function sendDisabled(res, name, status = integrationStatus(name)) {
  return res.status(503).json({
    error: disabledMessage(name, status),
    integration: name,
    sandbox: status.reason === 'sandbox',
    demo: status.reason === 'demo',
    reason: status.reason,
  });
}

module.exports = { integrationStatus, sendDisabled, disabledMessage, isPlaceholder, isSandbox, isDemo };
