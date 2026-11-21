/**
 * routes/auth.js
 * JWT-based authentication.
 * No client-specific data — all company strings come from brand.config.js.
 *
 * Endpoints:
 *   POST /api/auth/login    — email + password → JWT
 *   GET  /api/auth/me       — return current user
 *   POST /api/auth/logout   — (stateless — client discards token)
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

const USER_SELECT = { id: true, email: true, role: true, firstName: true, lastName: true, active: true };

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
  return { id: user.id, email: user.email, role: user.role, firstName: user.firstName, lastName: user.lastName };
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

    res.json({
      token: signToken(user),
      user: { id: user.id, email: user.email, role: user.role, firstName: user.firstName, lastName: user.lastName },
    });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { id: true, email: true, role: true, firstName: true, lastName: true, phone: true, active: true },
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

module.exports = { router, requireAuth, requireRole, requireSession, userFromToken, loadActiveUser, scopeFor };
