/**
 * routes/quickbooks.js  — QuickBooks Online integration (helpers/qbo.js; plain fetch, no SDK)
 * Requires: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI, QB_ENVIRONMENT (sandbox | production)
 * Disabled (503, no network call) when SANDBOX_MODE=true, DEMO_MODE=true or a credential is a
 * placeholder (helpers/integrations.js).
 *
 * GET  /api/quickbooks/status               — connection status (signed in; never returns tokens)
 * POST /api/quickbooks/connect              — admin session: start OAuth → { authUrl }
 * GET  /api/quickbooks/connect              — admin session: same, answered with a 302 to Intuit
 * GET  /api/quickbooks/callback             — Intuit redirects here; validates state, exchanges the code
 * POST /api/quickbooks/disconnect           — admin session: forget stored tokens
 * POST /api/quickbooks/sync-invoice/:id     — admin: create / update the QBO Customer + Invoice (with lines, tax per line)
 * GET  /api/quickbooks/invoice/:id          — admin: link status of an invoice (local only, no network)
 * POST /api/quickbooks/sync-payments        — admin: payment sync-back → marks fully paid invoices paid
 *
 * PLAT-4 (kept):
 *  - `state` is 32 random bytes, single-use, valid 10 minutes, bound to the admin who started the
 *    flow (server-side record) AND to their browser (HttpOnly SameSite=Lax cookie that must match).
 *  - tokens are persisted in IntegrationToken (provider "quickbooks"), encrypted at rest
 *    (helpers/secretBox.js) — they survive restarts; refresh tokens rotate and are re-stored.
 *  - status requires a signed-in user and never returns tokens.
 * Optional job: QBO_PAYMENT_SYNC_CRON (node-cron expression) runs the payment sync-back while the
 * integration is enabled.
 */
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { requireAuth, requireRole, requireSession, loadActiveUser } = require('./auth');
const brand   = require('../../brand.config');
const { ADMIN } = require('../helpers/roles');
const { integrationStatus, sendDisabled } = require('../helpers/integrations');
const { getCookie, setCookie, clearCookie } = require('../helpers/cookies');
const { isProduction } = require('../helpers/security');
const { parseId } = require('../helpers/httpError');
const qbo = require('../helpers/qbo');
const prisma = require('../helpers/prisma');

const STATE_COOKIE = 'mbc_qbo_state';
const STATE_TTL_MS = 10 * 60 * 1000;

// state → { userId, expires }. In-memory, single process (the cookie still binds
// the flow to one browser); a multi-instance deployment needs a shared store.
const pendingStates = new Map();

function pruneStates() {
  const now = Date.now();
  for (const [s, rec] of pendingStates) if (rec.expires <= now) pendingStates.delete(s);
}

function newState(userId) {
  pruneStates();
  const state = crypto.randomBytes(32).toString('base64url');
  pendingStates.set(state, { userId, expires: Date.now() + STATE_TTL_MS });
  return state;
}

/** Validate + consume a state. @returns {{ userId } | null} */
function consumeState(queryState, cookieState) {
  pruneStates();
  if (typeof queryState !== 'string' || typeof cookieState !== 'string' || !queryState || queryState.length !== cookieState.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(queryState), Buffer.from(cookieState))) return null;
  const rec = pendingStates.get(queryState);
  pendingStates.delete(queryState);
  if (!rec || rec.expires <= Date.now()) return null;
  return { userId: rec.userId };
}

/** 503 when disabled; returns true when the route may go on. */
function enabled(res) {
  const qb = integrationStatus('quickbooks');
  if (!qb.enabled) { sendDisabled(res, 'quickbooks', qb); return false; }
  return true;
}

function sendQboError(res, next, err) {
  if (err instanceof qbo.QboError) return res.status(err.status).json({ error: err.message, ...err.extra });
  return next(err);
}

// GET /api/quickbooks/status
router.get('/status', requireAuth, async (_req, res, next) => {
  try {
    const qb = integrationStatus('quickbooks');
    const row = await prisma.integrationToken.findUnique({
      where: { provider: qbo.PROVIDER },
      select: { realmId: true, expiresAt: true, refreshExpiresAt: true, updatedAt: true },
    });
    let sync = null;
    if (row && row.realmId) {
      const provider = qbo.providerFor(row.realmId);
      const [invoices, customers, cursor] = await Promise.all([
        prisma.integrationLink.count({ where: { provider, entity: 'invoice' } }),
        prisma.integrationLink.count({ where: { provider, entity: 'customer' } }),
        prisma.integrationLink.findUnique({ where: { provider_entity_remoteId: { provider, entity: 'cursor', remoteId: 'payments' } } }),
      ]);
      sync = { linkedInvoices: invoices, linkedCustomers: customers, lastPaymentSyncAt: cursor && cursor.data ? cursor.data.lastRunAt || null : null };
    }
    res.json({
      enabled:        qb.enabled,
      disabledReason: qb.reason,
      connected:      !!row,
      environment:    process.env.QB_ENVIRONMENT || 'sandbox',
      companyName:    brand.companyName,
      realmId:        row ? row.realmId : null,
      connectedAt:    row ? row.updatedAt : null,
      refreshExpiresAt: row ? row.refreshExpiresAt : null,
      sync,
    });
  } catch (err) { next(err); }
});

// Start the OAuth flow. Returns { authUrl } or null after answering.
function startConnect(req, res) {
  const qb = integrationStatus('quickbooks');
  if (!qb.enabled && qb.reason === 'demo') {
    res.status(200).json({ demo: true, message: 'QuickBooks live auth is disabled in demo mode. In production this redirects to Intuit OAuth.' });
    return null;
  }
  if (!qb.enabled) { sendDisabled(res, 'quickbooks', qb); return null; }
  const state = newState(req.user.id);
  setCookie(res, STATE_COOKIE, state, { maxAge: STATE_TTL_MS / 1000, path: '/api/quickbooks', secure: isProduction() });
  return qbo.authorizeUrl(state);
}

// POST /api/quickbooks/connect — { authUrl }
router.post('/connect', requireAuth, requireSession, requireRole(...ADMIN), (req, res, next) => {
  try {
    const authUrl = startConnect(req, res);
    if (authUrl) res.json({ authUrl });
  } catch (err) { sendQboError(res, next, err); }
});

// GET /api/quickbooks/connect — 302 to Intuit (needs the bearer header, so
// it is for API clients; the UI should use POST and navigate to authUrl)
router.get('/connect', requireAuth, requireSession, requireRole(...ADMIN), (req, res, next) => {
  try {
    const authUrl = startConnect(req, res);
    if (authUrl) res.redirect(authUrl);
  } catch (err) { sendQboError(res, next, err); }
});

// GET /api/quickbooks/callback?code=&state=&realmId=
router.get('/callback', async (req, res) => {
  try {
    // Never exchange an auth code with Intuit unless the integration is live.
    if (!enabled(res)) return undefined;
    const cookieState = getCookie(req, STATE_COOKIE);
    clearCookie(res, STATE_COOKIE, { path: '/api/quickbooks' });
    const bound = consumeState(req.query.state, cookieState);
    if (!bound) return res.redirect('/?qbo=error&reason=state');
    if (typeof req.query.error === 'string') return res.redirect('/?qbo=error&reason=denied');
    const user = await loadActiveUser(bound.userId);
    if (!user || !ADMIN.includes(user.role)) return res.redirect('/?qbo=error&reason=forbidden');
    const { code, realmId } = req.query;
    if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(code)) return res.redirect('/?qbo=error&reason=code');
    if (typeof realmId !== 'string' || !/^\d{1,32}$/.test(realmId)) return res.redirect('/?qbo=error&reason=realm');
    await qbo.exchangeCode(code, { realmId, userId: user.id });
    return res.redirect('/?qbo=connected');
  } catch (err) {
    console.error('[QBO] callback failed:', err.message);
    return res.redirect('/?qbo=error&reason=exchange');
  }
});

// POST /api/quickbooks/disconnect — links (QBO ids) are kept per company (realmId), so a
// reconnect to the same company stays idempotent.
router.post('/disconnect', requireAuth, requireSession, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    await prisma.integrationToken.deleteMany({ where: { provider: qbo.PROVIDER } });
    res.json({ success: true, connected: false });
  } catch (err) { next(err); }
});

// POST /api/quickbooks/sync-invoice/:id
router.post('/sync-invoice/:id', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!enabled(res)) return;
    const out = await qbo.pushInvoice(id, { brandTz: brand.timezone });
    res.json({ success: true, ...out });
  } catch (err) { sendQboError(res, next, err); }
});

// GET /api/quickbooks/invoice/:id — { linked, qboId, syncToken, syncedAt, totalAmt, balance, warnings }
router.get('/invoice/:id', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const link = await qbo.linkStatus('invoice', id);
    res.json(link ? { linked: true, invoiceId: id, ...link } : { linked: false, invoiceId: id });
  } catch (err) { next(err); }
});

// POST /api/quickbooks/sync-payments { since? ISO date } — payment sync-back
router.post('/sync-payments', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    if (!enabled(res)) return;
    const since = req.body && req.body.since;
    if (since !== undefined && (typeof since !== 'string' || Number.isNaN(new Date(since).getTime()))) {
      return res.status(400).json({ error: 'since must be an ISO date', code: 'INVALID_INPUT', field: 'since' });
    }
    const out = await qbo.syncPayments({ since });
    res.json({ success: true, ...out });
  } catch (err) { sendQboError(res, next, err); }
});

// Optional scheduled payment sync-back
let cronTask = null;
if (process.env.QBO_PAYMENT_SYNC_CRON) {
  try {
    const cron = require('node-cron');
    if (cron.validate(process.env.QBO_PAYMENT_SYNC_CRON)) {
      cronTask = cron.schedule(process.env.QBO_PAYMENT_SYNC_CRON, async () => {
        if (!integrationStatus('quickbooks').enabled) return;
        try {
          const out = await qbo.syncPayments();
          if (out.markedPaid.length) console.log(`[QBO] payment sync: ${out.markedPaid.length} invoice(s) marked paid`);
        } catch (e) { console.error('[QBO] payment sync failed:', e.message); }
      }, { timezone: brand.timezone || 'UTC' });
    } else {
      console.error(`[QBO] QBO_PAYMENT_SYNC_CRON="${process.env.QBO_PAYMENT_SYNC_CRON}" is not a valid cron expression — payment sync job not scheduled`);
    }
  } catch (e) { console.error('[QBO] could not schedule payment sync:', e.message); }
}

module.exports = router;
module.exports._test = { newState, consumeState, saveTokens: qbo.saveTokens, loadTokens: qbo.loadTokens, pendingStates, cronTask: () => cronTask };
