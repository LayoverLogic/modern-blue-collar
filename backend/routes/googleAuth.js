/**
 * routes/googleAuth.js — "Sign in with Google" (mounted at /api/auth).
 * Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL
 *
 *   GET  /api/auth/google            → redirect to Google (sets a state cookie)
 *   GET  /api/auth/google/callback   → Google returns here; on success redirects
 *                                      to  /?auth_code=<one-time code>
 *                                      on failure to /?auth_error=<message>
 *   POST /api/auth/google/exchange   { code } → { token, user }  (same shape as
 *                                      POST /api/auth/login); the code is
 *                                      single-use and expires after 60 s
 *
 * Fail-closed sign-in gate (PLAT-3):
 *   - an existing ACTIVE user with that (Google-verified) email signs in —
 *     admins pre-create people on the Team page or via POST /api/invites;
 *   - an unknown email is created as an active technician ONLY if its domain is
 *     listed in GOOGLE_ALLOWED_DOMAINS (comma-separated, e.g. "example.com");
 *     unset/empty → nobody is auto-provisioned;
 *   - deactivated users and unverified Google emails are refused.
 * The session JWT never appears in a URL; it honours JWT_EXPIRES.
 * OAuth state: random value in an HttpOnly SameSite=Lax cookie, checked on callback.
 */

require('../helpers/loadEnv');
const express  = require('express');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const passport = require('passport');
const router   = express.Router();
const { integrationStatus, sendDisabled } = require('../helpers/integrations');
const { signToken, isProduction } = require('../helpers/security');
const { getCookie, setCookie, clearCookie } = require('../helpers/cookies');
const prisma = require('../helpers/prisma');

const STATE_COOKIE = 'mbc_google_state';
const CODE_TTL_MS  = 60 * 1000;
const STATE_TTL_S  = 10 * 60;

// One-time login codes: code → { userId, expires }. In-memory (single process);
// a multi-instance deployment needs a shared store (DB/Redis) here.
const loginCodes = new Map();

function pruneCodes() {
  const now = Date.now();
  for (const [code, rec] of loginCodes) if (rec.expires <= now) loginCodes.delete(code);
}

function issueLoginCode(userId) {
  pruneCodes();
  const code = crypto.randomBytes(32).toString('base64url');
  loginCodes.set(code, { userId, expires: Date.now() + CODE_TTL_MS });
  return code;
}

function allowedDomains() {
  return String(process.env.GOOGLE_ALLOWED_DOMAINS || '')
    .split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
}

/**
 * Decide who a Google profile signs in as. Exported for tests.
 * @returns {Promise<{ user?: object, error?: string }>}
 */
async function resolveGoogleUser(profile) {
  const emailObj = profile && Array.isArray(profile.emails) ? profile.emails[0] : null;
  const email = emailObj && typeof emailObj.value === 'string' ? emailObj.value.toLowerCase().trim() : '';
  if (!email) return { error: 'Your Google account did not share an email address.' };
  // Fail closed: Google must positively assert email_verified (a missing flag is refused too).
  const verified = profile._json && profile._json.email_verified !== undefined ? profile._json.email_verified : emailObj.verified;
  if (verified !== true && verified !== 'true') return { error: 'Your Google email address is not verified.' };

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.active) return { error: 'Account is deactivated. Contact an admin.' };
    // A pending password invite is fulfilled by signing in with Google.
    await prisma.authToken.updateMany({ where: { userId: existing.id, kind: 'invite', usedAt: null }, data: { usedAt: new Date() } }).catch(() => {});
    return { user: existing };
  }

  const domain = email.split('@')[1] || '';
  if (!allowedDomains().includes(domain)) {
    return { error: 'This Google account has not been invited. Ask an admin to invite you.' };
  }
  const user = await prisma.user.create({
    data: {
      email,
      password:  await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10), // unusable: Google sign-in only
      firstName: (profile.name && profile.name.givenName) || '',
      lastName:  (profile.name && profile.name.familyName) || '',
      role:      'technician',
      active:    true,
    },
  });
  return { user };
}

// ── Passport Google strategy (lazy init) ───────────────────────────────────────
let passportConfigured = false;
function ensurePassportGoogle() {
  if (passportConfigured) return;
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const { user, error } = await resolveGoogleUser(profile);
      if (error) return done(null, false, { message: error });
      done(null, user);
    } catch (err) { done(err); }
  }));
  passportConfigured = true;
}

const failRedirect = (res, msg) => res.redirect(`/?auth_error=${encodeURIComponent(msg)}`);

// GET /api/auth/google
router.get('/google', (req, res, next) => {
  const g = integrationStatus('google');
  if (!g.enabled) return sendDisabled(res, 'google', g);
  ensurePassportGoogle();
  const state = crypto.randomBytes(24).toString('base64url');
  setCookie(res, STATE_COOKIE, state, { maxAge: STATE_TTL_S, path: '/api/auth/google', secure: isProduction() });
  passport.authenticate('google', { scope: ['profile', 'email'], session: false, state })(req, res, next);
});

// GET /api/auth/google/callback
router.get('/google/callback', (req, res, next) => {
  // Never exchange an auth code with Google unless the integration is live.
  const g = integrationStatus('google');
  if (!g.enabled) return sendDisabled(res, 'google', g);

  const expected = getCookie(req, STATE_COOKIE);
  clearCookie(res, STATE_COOKIE, { path: '/api/auth/google' });
  const given = typeof req.query.state === 'string' ? req.query.state : '';
  if (!expected || !given || expected.length !== given.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) {
    return failRedirect(res, 'Sign-in expired or was not started here — please try again.');
  }

  ensurePassportGoogle();
  passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err) {
      console.error('[GOOGLE] OAuth error:', err.message);
      return failRedirect(res, 'Google sign-in failed.');
    }
    if (!user) return failRedirect(res, (info && info.message) || 'Google sign-in failed.');
    res.redirect(`/?auth_code=${encodeURIComponent(issueLoginCode(user.id))}`);
  })(req, res, next);
});

// POST /api/auth/google/exchange — { code } → { token, user }
router.post('/google/exchange', async (req, res, next) => {
  try {
    const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
    pruneCodes();
    const rec = code ? loginCodes.get(code) : null;
    if (code) loginCodes.delete(code); // single use, even on failure below
    if (!rec || rec.expires <= Date.now()) {
      return res.status(401).json({ error: 'Sign-in code is invalid or expired — please sign in again', code: 'INVALID_LOGIN_CODE' });
    }
    const user = await prisma.user.findUnique({ where: { id: rec.userId } });
    if (!user || !user.active) return res.status(401).json({ error: 'Account is not active', code: 'INVALID_LOGIN_CODE' });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
    res.json({ token: signToken(user), user: require('./auth').sessionUser(user) });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.resolveGoogleUser = resolveGoogleUser;
module.exports.issueLoginCode = issueLoginCode;
module.exports.allowedDomains = allowedDomains;
