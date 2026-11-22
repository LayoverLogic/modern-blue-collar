/**
 * routes/users.js
 * Team / user management. Role label uses brand.config.js technicianLabel.
 *
 * Roles: super-admin | admin | dispatcher | office | technician (helpers/roles.js)
 *
 * Who may do what (RT-1, RT-7, RT-21):
 *   - anyone signed in: read and edit their OWN firstName / lastName / phone
 *   - office roles: read any user record
 *   - admin: create / edit / deactivate dispatchers, office staff, technicians
 *   - super-admin: also create / edit / promote / deactivate admins and super-admins,
 *     and delete users
 *   - nobody changes their own role or active flag; API keys cannot manage users
 */

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { requireAuth, requireRole, requireSession } = require('./auth');
const brand   = require('../../brand.config');
const { ROLES, ADMIN, PRIVILEGED, SUPER_ADMIN, isOffice, isAdmin, isSuper } = require('../helpers/roles');
const { parseId, badRequest, forbidden, notFound } = require('../helpers/httpError');
const v = require('../helpers/validate');
const { normalisePhone } = require('../helpers/phone');

const prisma = require('../helpers/prisma');

const PUBLIC_SELECT = { id: true, email: true, role: true, firstName: true, lastName: true, phone: true, active: true };
const MIN_PASSWORD = 10;

/** Disconnect the user's live sockets (server.js disconnectUserSockets). */
function dropSockets(req, userId) {
  const fn = req.app && req.app.get('disconnectUserSockets');
  if (typeof fn === 'function') {
    try { fn(userId); } catch (e) { console.warn('[USERS] could not disconnect sockets:', e.message); }
  }
}

function validRole(role) {
  if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`, { code: 'INVALID_ROLE' });
  return role;
}

function validPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) {
    throw badRequest(`password must be at least ${MIN_PASSWORD} characters`, { code: 'WEAK_PASSWORD' });
  }
  if (Buffer.byteLength(pw) > 72) throw badRequest('password must be at most 72 bytes', { code: 'INVALID_PASSWORD' });
  return pw;
}

// GET /api/users  — admin+
router.get('/', requireAuth, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { ...PUBLIC_SELECT, createdAt: true },
      orderBy: { lastName: 'asc' },
    });
    res.json(users);
  } catch (err) { next(err); }
});

// GET /api/users/technicians — active technicians (+ admins) for the job
// assignment dropdown and the schedule: { technicianLabel, technicians:
// [{ id, firstName, lastName, email, phone, role }] }. Any signed-in user.
router.get('/technicians', requireAuth, async (_req, res, next) => {
  try {
    const techs = await prisma.user.findMany({
      where:  { active: true, role: { in: ['technician', 'admin', 'super-admin'] } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true },
      orderBy: { firstName: 'asc' },
    });
    // Surface the trade-specific label so the UI can say "Electricians" vs "Plumbers" etc.
    res.json({ technicianLabel: brand.technicianLabel, technicians: techs });
  } catch (err) { next(err); }
});

// GET /api/users/me — the caller's own record (same shape as /api/users/:id)
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: PUBLIC_SELECT });
    if (!user) throw notFound('User not found');
    res.json(user);
  } catch (err) { next(err); }
});

// GET /api/users/:id — self, or office roles
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id !== req.user.id && !isOffice(req.user)) throw forbidden('Forbidden — you can only view your own user record');
    const user = await prisma.user.findUnique({ where: { id }, select: PUBLIC_SELECT });
    if (!user) throw notFound('User not found');
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/users — admin+ (only a super-admin may create admins / super-admins)
router.post('/', requireAuth, requireSession, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const body = req.body || {};
    const email     = v.email(body.email, 'email', { required: true });
    const password  = validPassword(body.password);
    const firstName = v.str(body.firstName, 'firstName', { required: true, max: 100 });
    const lastName  = v.str(body.lastName, 'lastName', { required: true, max: 100 });
    const phone     = normalisePhone(body.phone, 'phone'); // E.164, brand country (WL-12)
    const role      = body.role == null || body.role === '' ? 'technician' : validRole(body.role);
    if (PRIVILEGED.includes(role) && !isSuper(req.user)) {
      throw forbidden('Only a super-admin can create admin or super-admin accounts');
    }

    const hashed = await bcrypt.hash(password, 12);
    const user   = await prisma.user.create({
      data:   { email, password: hashed, firstName, lastName, role, phone },
      select: { id: true, email: true, role: true, firstName: true, lastName: true },
    });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id
router.patch('/:id', requireAuth, requireSession, async (req, res, next) => {
  try {
    const id   = parseId(req.params.id);
    const body = req.body || {};
    const self = id === req.user.id;

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, active: true } });
    if (!target) {
      if (!isAdmin(req.user)) throw forbidden();
      throw notFound('User not found');
    }

    const data = {};
    if (body.firstName !== undefined) data.firstName = v.str(body.firstName, 'firstName', { required: true, max: 100 });
    if (body.lastName  !== undefined) data.lastName  = v.str(body.lastName, 'lastName', { required: true, max: 100 });
    if (body.phone     !== undefined) data.phone     = normalisePhone(body.phone, 'phone');
    const wantsEmail  = body.email  !== undefined;
    const wantsRole   = body.role   !== undefined;
    const wantsActive = body.active !== undefined;

    if (self) {
      if (wantsRole || wantsActive) throw forbidden('You cannot change your own role or active status');
      if (wantsEmail && !isAdmin(req.user)) throw forbidden('Ask an admin to change your email address');
    } else {
      if (!isAdmin(req.user)) throw forbidden('Forbidden — you can only edit your own profile');
      if (PRIVILEGED.includes(target.role) && !isSuper(req.user)) {
        throw forbidden('Only a super-admin can edit admin or super-admin accounts');
      }
    }
    if (wantsEmail) data.email = v.email(body.email, 'email', { required: true });
    if (wantsRole) {
      data.role = validRole(body.role);
      if (PRIVILEGED.includes(data.role) && !isSuper(req.user)) throw forbidden('Only a super-admin can grant admin or super-admin');
    }
    if (wantsActive) {
      if (typeof body.active !== 'boolean') throw badRequest('active must be true or false');
      data.active = body.active;
    }
    if (body.password !== undefined) throw badRequest('password cannot be changed via this route');

    const user = await prisma.user.update({ where: { id }, data, select: PUBLIC_SELECT });
    // Live sockets keep the identity of their handshake: drop them when the
    // user loses access or changes role, so the next connect re-authenticates.
    if ((target.active && !user.active) || target.role !== user.role) dropSockets(req, id);
    res.json(user);
  } catch (err) { next(err); }
});

// DELETE /api/users/:id — super-admin only (soft-delete by setting active=false is preferred)
router.delete('/:id', requireAuth, requireSession, requireRole(...SUPER_ADMIN), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === req.user.id) throw badRequest('You cannot delete your own account');
    await prisma.user.delete({ where: { id } });
    dropSockets(req, id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
