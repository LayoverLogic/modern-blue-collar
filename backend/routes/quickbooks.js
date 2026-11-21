/**
 * routes/quickbooks.js  — QuickBooks Online OAuth2 integration
 * Requires: QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REDIRECT_URI, QB_ENVIRONMENT
 *
 * GET  /api/quickbooks/connect        — redirect to QBO OAuth
 * GET  /api/quickbooks/callback       — OAuth callback, stores tokens
 * POST /api/quickbooks/sync-invoice/:id — push invoice to QBO
 * GET  /api/quickbooks/status         — connection status
 */
const express         = require('express');
const router          = express.Router();
const { requireAuth, requireRole } = require('./auth');
const brand           = require('../../brand.config');
const { integrationStatus, sendDisabled } = require('../helpers/integrations');

// In-memory token store — replace with DB storage in production
let qboTokens = null;

function getOAuthClient() {
  const OAuthClient = require('intuit-oauth');
  return new OAuthClient({
    clientId:     process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    environment:  process.env.QB_ENVIRONMENT || 'sandbox',
    redirectUri:  process.env.QB_REDIRECT_URI,
  });
}

// GET /api/quickbooks/status
router.get('/status', requireAuth, (_req, res) => {
  const qb = integrationStatus('quickbooks');
  res.json({
    enabled:     qb.enabled,
    disabledReason: qb.reason,
    connected:   !!qboTokens,
    environment: process.env.QB_ENVIRONMENT || 'sandbox',
    companyName: brand.companyName,
  });
});

// GET /api/quickbooks/connect  — initiates OAuth flow
router.get('/connect', requireAuth, requireRole('super-admin', 'admin'), (_req, res) => {
  const qb = integrationStatus('quickbooks');
  if (!qb.enabled && qb.reason === 'demo') {
    return res.status(200).json({ demo: true, message: 'QuickBooks live auth is disabled in demo mode. In production this redirects to Intuit OAuth.' });
  }
  if (!qb.enabled) return sendDisabled(res, 'quickbooks', qb);
  const oauthClient = getOAuthClient();
  const authUri = oauthClient.authorizeUri({
    scope:  [require('intuit-oauth').scopes.Accounting],
    state:  'qbo-auth',
  });
  res.redirect(authUri);
});

// GET /api/quickbooks/callback
router.get('/callback', async (req, res, next) => {
  try {
    // Never exchange an auth code with Intuit unless the integration is live.
    const qb = integrationStatus('quickbooks');
    if (!qb.enabled) return sendDisabled(res, 'quickbooks', qb);
    const oauthClient = getOAuthClient();
    const authResponse = await oauthClient.createToken(req.url);
    qboTokens = authResponse.getJson();
    res.redirect('/?qbo=connected');
  } catch (err) { next(err); }
});

// POST /api/quickbooks/sync-invoice/:id — stub; implement full QBO API call as needed
router.post('/sync-invoice/:id', requireAuth, requireRole('super-admin', 'admin'), async (_req, res) => {
  const qb = integrationStatus('quickbooks');
  if (!qb.enabled) return sendDisabled(res, 'quickbooks', qb);
  if (!qboTokens) return res.status(400).json({ error: 'Not connected to QuickBooks. Visit /api/quickbooks/connect first.' });
  // TODO: implement full invoice push to QBO using qboTokens
  res.json({ success: true, message: 'Invoice sync to QuickBooks — implement full QBO API call here.' });
});

module.exports = router;
