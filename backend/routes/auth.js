/**
 * routes/auth.js
 * JWT-based authentication.
 * No client-specific data — all company strings come from brand.config.js.
 *
 * Endpoints:
 *   POST /api/auth/login    — email + password → { token, user } (user.mustChangePassword)
 *   GET  /api/auth/me       — return current user
 *   POST /api/auth/logout   — (stateless — client discards token)
 *   POST /api/auth/forgot   — { email } → always 200 (no account enumeration); emails a
 *                             single-use 30-minute reset link (helpers/authTokens.js)
 *   POST /api/auth/reset/validate — { token } → { valid, email, expiresAt } | 400 INVALID_RESET_TOKEN
 *   POST /api/auth/reset    — { token, newPassword } → { success }; revokes every session
 *   (forgot / reset are rate limited in server.js: RESET_RATE_MAX per IP / 15 min)
 *
 * Sessions: tokens carry the user's sessionVersion (`sv`); bumping it (password
 * change / reset, deactivation) revokes every earlier token.
 * Temporary passwords: while user.mustChangePassword is true, requireAuth only
 * lets through GET /api/users/me, GET /api/auth/me, PATCH /api/users/me/password
 * and POST /api/auth/logout — everything else → 403 PASSWORD_CHANGE_REQUIRED.
 *
 * Middleware exported for every router:
 *   requireAuth      — a valid session JWT or API key. The user row is re-read
 *                      on every request: deleted / deactivated users are
 *                      rejected and the role comes from the DB, not the token
 *                      (RT-5). API keys are limited by their scopes (RT-4).
 *   requireRole(...) — req.user.role must be one of the given roles.
 *   requireSession   — a person, not an API key (user / key management etc.).
 */

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');

const prisma = require('../helpers/prisma');
const { signToken, verifyToken } = require('../helpers/security');
const tokens = require('../helpers/authTokens');
const { trySendMail } = require('../helpers/mailer');
const { badRequest } = require('../helpers/httpError');

const USER_SELECT = { id: true, email: true, role: true, firstName: true, lastName: true, active: true, sessionVersion: true, mustChangePassword: true };

/** The user object returned by login / google exchange / accept-invite / reset. */
const sessionUser = (u) => ({ id: u.id, email: u.email, role: u.role, firstName: u.firstName, lastName: u.lastName, mustChangePassword: !!u.mustChangePassword });

/** Load an active user by id, or null. */
async function loadActiveUser(id) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const user = await prisma.user.findUnique({ where: { id }, select: USER_SELECT });
  if (!user || !user.active) return null;
  return user;
}

/**
 * Verify a bearer token and return the CURRENT user row, or null.
 * Used by requireAuth and by the Socket.io handshake.
 */
async function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  let payload;
  try { payload = verifyToken(token); } catch { return null; }
  const user = await loadActiveUser(payload.id);
  if (!user) return null;
  // Revoked session (password changed / reset, account deactivated since)
  if ((Number(payload.sv) || 0) !== user.sessionVersion) return null;
  return { id: user.id, email: user.email, role: user.role, firstName: user.firstName, lastName: user.lastName, mustChangePassword: user.mustChangePassword };
}

// Allowed while a temporary password is still in use (method + full path).
const PASSWORD_CHANGE_ALLOWED = new Set([
  'GET /api/users/me', 'GET /api/auth/me', 'PATCH /api/users/me/password', 'POST /api/auth/logout',
]);
function passwordChangeAllowed(req) {
  const p = `${req.baseUrl || ''}${req.path || ''}`.replace(/\/+$/, '') || '/';
  return PASSWORD_CHANGE_ALLOWED.has(`${String(req.method).toUpperCase()} ${p}`);
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Which scope a request needs when made with an API key. */
function scopeFor(method) {
  return READ_METHODS.has(String(method).toUpperCase()) ? 'read' : 'write';
}

// ── Middleware ─────────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    // API key already authenticated by middleware/apiKeyAuth.js
    if (req.apiKey && req.user) {
      const needed = scopeFor(req.method);
      const scopes = req.user.scopes || [];
      if (!scopes.includes(needed)) {
        return res.status(403).json({ error: `API key missing required scope: ${needed}`, code: 'SCOPE_REQUIRED', scope: needed });
      }
      return next();
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorised — no token or API key' });
    }
    const user = await userFromToken(header.slice(7).trim());
    if (!user) return res.status(401).json({ error: 'Unauthorised — invalid or expired token' });
    if (user.mustChangePassword && !passwordChangeAllowed(req)) {
      return res.status(403).json({ error: 'You must change your temporary password before continuing', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    req.user = user;
    next();
  } catch (err) { next(err); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }
    next();
  };
}

/** Reject API keys: the action needs a signed-in person. Use after requireAuth. */
function requireSession(req, res, next) {
  if (req.apiKey) return res.status(403).json({ error: 'This action requires a signed-in user, not an API key', code: 'SESSION_REQUIRED' });
  next();
}

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
    res.json({ token: signToken(user), user: sessionUser(user) });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { id: true, email: true, role: true, firstName: true, lastName: true, phone: true, active: true, mustChangePassword: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (_req, res) => {
  // JWT is stateless — client should discard the token
  res.json({ success: true });
});

// ── Forgot / reset password (GAP-1) ──────────────────────────────────────────
const FORGOT_MESSAGE = 'If an account exists for that email address, a password reset link has been sent to it.';
const MAX_RESETS_PER_WINDOW = 3; // per account per 15 min (silently ignored beyond; in memory)
const RESET_WINDOW_MS = 15 * 60 * 1000;
const resetsByUser = new Map(); // userId → timestamps of reset mails sent
function resetAllowed(userId) {
  const now = Date.now();
  const recent = (resetsByUser.get(userId) || []).filter((t) => t > now - RESET_WINDOW_MS);
  if (recent.length >= MAX_RESETS_PER_WINDOW) { resetsByUser.set(userId, recent); return false; }
  recent.push(now);
  resetsByUser.set(userId, recent);
  if (resetsByUser.size > 10000) resetsByUser.clear(); // bounded
  return true;
}

async function sendResetEmail(req, user, link, expiresAt) {
  const brand = require('../../brand.config');
  const mins = Math.round((expiresAt - Date.now()) / 60000);
  const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return trySendMail({
    to: user.email,
    subject: `Reset your ${brand.companyName} password`,
    text: `Hi ${user.firstName || ''},\n\nSomeone (hopefully you) asked to reset the password for ${user.email}.\n` +
      `Open this link within ${mins} minutes to choose a new password (it works once):\n${link}\n\n` +
      'If you did not ask for this, ignore this email - your password stays the same.',
    html: `<p>Hi ${esc(user.firstName || '')},</p><p>Someone (hopefully you) asked to reset the password for ${esc(user.email)}.</p>` +
      `<p><a href="${esc(link)}">Choose a new password</a> (valid for ${mins} minutes, works once).</p>` +
      '<p>If you did not ask for this, ignore this email - your password stays the same.</p>',
  }, { fromName: brand.companyName });
}

// POST /api/auth/forgot { email } — always the same 200 answer
router.post('/forgot', async (req, res, next) => {
  try {
    const raw = req.body && typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!raw) throw badRequest('email is required', { code: 'REQUIRED', field: 'email' });
    const answer = { success: true, message: FORGOT_MESSAGE };
    if (raw.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(raw)) return res.json(answer);

    const user = await prisma.user.findUnique({ where: { email: raw } });
    if (user && user.active) {
      if (resetAllowed(user.id)) {
        const { token, expiresAt } = await tokens.issueToken(prisma, { userId: user.id, kind: 'reset' });
        const link = tokens.resetLink(req, token);
        // Not awaited: the answer must not reveal (by timing) that the account exists.
        setImmediate(() => { sendResetEmail(req, user, link, expiresAt).catch(() => {}); });
      }
    }
    res.json(answer);
  } catch (err) { next(err); }
});

const invalidReset = () => badRequest('This reset link is invalid, expired or already used — ask for a new one', { code: 'INVALID_RESET_TOKEN' });

// POST /api/auth/reset/validate { token } — lets the reset page say early that a link is dead
router.post('/reset/validate', async (req, res, next) => {
  try {
    const row = await tokens.findToken(prisma, req.body && req.body.token, 'reset');
    if (!row || !row.user.active) throw invalidReset();
    res.json({ valid: true, email: row.user.email, expiresAt: row.expiresAt });
  } catch (err) { next(err); }
});

// POST /api/auth/reset { token, newPassword }
router.post('/reset', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await tokens.findToken(prisma, body.token, 'reset');
    if (!row || !row.user.active) throw invalidReset();
    const pw = tokens.validPassword(body.newPassword, 'newPassword');
    const hashed = await tokens.hashPassword(pw);
    await prisma.$transaction(async (tx) => {
      if (!(await tokens.consumeToken(tx, row))) throw invalidReset();
      await tx.user.update({
        where: { id: row.userId },
        data: { password: hashed, mustChangePassword: false, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
      });
      await tokens.revokeTokens(tx, row.userId, 'reset');
    });
    const drop = req.app && req.app.get('disconnectUserSockets');
    if (typeof drop === 'function') { try { drop(row.userId); } catch { /* ignore */ } }
    res.json({ success: true, message: 'Password changed — sign in with your new password.', email: row.user.email });
  } catch (err) { next(err); }
});

module.exports = { router, requireAuth, requireRole, requireSession, userFromToken, loadActiveUser, scopeFor, sessionUser, passwordChangeAllowed };
