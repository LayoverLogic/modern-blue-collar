/**
 * routes/quickbooks.js  — QuickBooks Online OAuth2 integration
 * Requires: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI, QB_ENVIRONMENT
 *
 * GET  /api/quickbooks/status            — connection status (signed in)
 * POST /api/quickbooks/connect           — admin: start OAuth → { authUrl } (front-end navigates to it)
 * GET  /api/quickbooks/connect           — admin: same, but answers with a 302 to Intuit
 * GET  /api/quickbooks/callback          — Intuit redirects here; validates state, stores tokens
 * POST /api/quickbooks/disconnect        — admin: forget stored tokens
 * POST /api/quickbooks/sync-invoice/:id  — push invoice to QBO (stub)
 *
 * PLAT-4:
 *  - `state` is 32 random bytes, single-use, valid 10 minutes, bound to the
 *    admin who started the flow (server-side record) AND to their browser (an
 *    HttpOnly SameSite=Lax cookie that must match on the callback).
 *  - tokens are persisted in IntegrationToken (provider "quickbooks"),
 *    encrypted at rest (helpers/secretBox.js) — they survive restarts.
 *  - status requires a signed-in user and never returns tokens.
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
const { seal, open } = require('../helpers/secretBox');
const { parseId } = require('../helpers/httpError');
const prisma = require('../helpers/prisma');

const PROVIDER     = 'quickbooks';
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

function getOAuthClient() {
  const OAuthClient = require('intuit-oauth');
  return new OAuthClient({
    clientId:     process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment:  process.env.QB_ENVIRONMENT || 'sandbox',
    redirectUri:  process.env.QB_REDIRECT_URI,
  });
}

/** Persist a token response from intuit-oauth (getJson() shape). */
async function saveTokens(json, { realmId, userId }) {
  const now = Date.now();
  const data = {
    realmId:          realmId ? String(realmId).slice(0, 64) : null,
    accessToken:      seal(json.access_token),
    refreshToken:     seal(json.refresh_token),
    tokenType:        json.token_type || null,
    expiresAt:        json.expires_in ? new Date(now + Number(json.expires_in) * 1000) : null,
    refreshExpiresAt: json.x_refresh_token_expires_in ? new Date(now + Number(json.x_refresh_token_expires_in) * 1000) : null,
    connectedById:    userId || null,
  };
  return prisma.integrationToken.upsert({ where: { provider: PROVIDER }, create: { provider: PROVIDER, ...data }, update: data });
}

/** Stored tokens (decrypted) or null. */
async function loadTokens() {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  return { ...row, accessToken: open(row.accessToken), refreshToken: open(row.refreshToken) };
}

// GET /api/quickbooks/status
router.get('/status', requireAuth, async (_req, res, next) => {
  try {
    const qb = integrationStatus('quickbooks');
    const row = await prisma.integrationToken.findUnique({
      where: { provider: PROVIDER },
      select: { realmId: true, expiresAt: true, refreshExpiresAt: true, updatedAt: true },
    });
    res.json({
      enabled:        qb.enabled,
      disabledReason: qb.reason,
      connected:      !!row,
      environment:    process.env.QB_ENVIRONMENT || 'sandbox',
      companyName:    brand.companyName,
      realmId:        row ? row.realmId : null,
      connectedAt:    row ? row.updatedAt : null,
      refreshExpiresAt: row ? row.refreshExpiresAt : null,
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
  const authUrl = getOAuthClient().authorizeUri({ scope: [require('intuit-oauth').scopes.Accounting], state });
  return authUrl;
}

// POST /api/quickbooks/connect — { authUrl }
router.post('/connect', requireAuth, requireSession, requireRole(...ADMIN), (req, res) => {
  const authUrl = startConnect(req, res);
  if (authUrl) res.json({ authUrl });
});

// GET /api/quickbooks/connect — 302 to Intuit (needs the bearer header, so
// it is for API clients; the UI should use POST and navigate to authUrl)
router.get('/connect', requireAuth, requireSession, requireRole(...ADMIN), (req, res) => {
  const authUrl = startConnect(req, res);
  if (authUrl) res.redirect(authUrl);
});

// GET /api/quickbooks/callback
router.get('/callback', async (req, res, next) => {
  try {
    // Never exchange an auth code with Intuit unless the integration is live.
    const qb = integrationStatus('quickbooks');
    if (!qb.enabled) return sendDisabled(res, 'quickbooks', qb);

    const cookieState = getCookie(req, STATE_COOKIE);
    clearCookie(res, STATE_COOKIE, { path: '/api/quickbooks' });
    const bound = consumeState(req.query.state, cookieState);
    if (!bound) return res.redirect('/?qbo=error&reason=state');
    const user = await loadActiveUser(bound.userId);
    if (!user || !ADMIN.includes(user.role)) return res.redirect('/?qbo=error&reason=forbidden');

    const authResponse = await getOAuthClient().createToken(req.originalUrl);
    await saveTokens(authResponse.getJson(), { realmId: req.query.realmId, userId: user.id });
    res.redirect('/?qbo=connected');
  } catch (err) {
    console.error('[QBO] callback failed:', err.message);
    res.redirect('/?qbo=error&reason=exchange');
  }
});

// POST /api/quickbooks/disconnect
router.post('/disconnect', requireAuth, requireSession, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    await prisma.integrationToken.deleteMany({ where: { provider: PROVIDER } });
    res.json({ success: true, connected: false });
  } catch (err) { next(err); }
});

// POST /api/quickbooks/sync-invoice/:id — stub; implement full QBO API call as needed
router.post('/sync-invoice/:id', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    parseId(req.params.id);
    const qb = integrationStatus('quickbooks');
    if (!qb.enabled) return sendDisabled(res, 'quickbooks', qb);
    const tokens = await loadTokens();
    if (!tokens) return res.status(400).json({ error: 'Not connected to QuickBooks. Connect it from Settings first.', code: 'QBO_NOT_CONNECTED' });
    // TODO: implement full invoice push to QBO using tokens (refresh when expiresAt has passed)
    res.json({ success: true, message: 'Invoice sync to QuickBooks — implement full QBO API call here.' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports._test = { newState, consumeState, saveTokens, loadTokens, pendingStates };
