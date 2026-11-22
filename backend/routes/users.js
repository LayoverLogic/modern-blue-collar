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
 *   - the last active super-admin cannot be deactivated, demoted or deleted (409 LAST_SUPER_ADMIN)
 *
 * Endpoints (B3 additions marked +):
 *   GET    /api/users                       admin+: list (+ mustChangePassword, lastLoginAt, invitePending)
 *   GET    /api/users/technicians           anyone signed in
 *   GET    /api/users/me | /:id
 *   + PATCH /api/users/me/password          { currentPassword, newPassword } → { success, token, user }
 *   POST   /api/users                       admin+: create with a TEMPORARY password (mustChangePassword
 *                                           true unless the body says mustChangePassword:false)
 *   PATCH  /api/users/:id                   profile; admins: email / role / active
 *   + POST  /api/users/:id/deactivate | /reactivate
 *   + PATCH /api/users/:id/role             { role }
 *   + POST  /api/users/:id/reset-password   { mode: 'temporary' | 'link' }
 *   DELETE /api/users/:id                   super-admin
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

const tokens = require('../helpers/authTokens');
const { trySendMail } = require('../helpers/mailer');
const { signToken } = require('../helpers/security');
const { conflict } = require('../helpers/httpError');

const PUBLIC_SELECT = { id: true, email: true, role: true, firstName: true, lastName: true, phone: true, active: true, mustChangePassword: true, lastLoginAt: true };

/** Disconnect the user's live sockets (server.js disconnectUserSockets). */
function dropSockets(req, userId) {
  const fn = req.app && req.app.get('disconnectUserSockets');
  if (typeof fn === 'function') {
    try { fn(userId); } catch (e) { console.warn('[USERS] could not disconnect sockets:', e.message); }
  }
}

function validRole(role) {
  if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`, { code: 'INVALID_ROLE', field: 'role', allowed: ROLES });
  return role;
}

const validPassword = (pw) => tokens.validPassword(pw, 'password');

/**
 * Refuse to leave the instance without an active super-admin. Call inside the
 * transaction that deactivates / demotes / deletes `targetId` (a super-admin);
 * the advisory lock serialises two concurrent removals.
 */
async function assertNotLastSuperAdmin(tx, targetId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4243, 1)`;
  const others = await tx.user.count({ where: { role: 'super-admin', active: true, id: { not: targetId } } });
  if (others === 0) {
    throw conflict('This is the last active super-admin — make another user super-admin first', { code: 'LAST_SUPER_ADMIN' });
  }
}

/** Role matrix for acting on another user (RT-1 / RT-7). */
function assertCanManage(actor, target) {
  if (!isAdmin(actor)) throw forbidden('Forbidden — you can only edit your own profile');
  if (PRIVILEGED.includes(target.role) && !isSuper(actor)) {
    throw forbidden('Only a super-admin can edit admin or super-admin accounts');
  }
}

/**
 * Apply an active / role change to another user (PATCH /:id, /deactivate,
 * /reactivate, PATCH /:id/role). Deactivation revokes sessions (sessionVersion)
 * and unused reset / invite links; any loss of access or role change drops the
 * user's live sockets.
 */
async function applyAccessChange(req, target, data) {
  const removesSuper = target.role === 'super-admin' && target.active &&
    (data.active === false || (data.role !== undefined && data.role !== 'super-admin'));
  const deactivating = target.active && data.active === false;
  const user = await prisma.$transaction(async (tx) => {
    if (removesSuper) await assertNotLastSuperAdmin(tx, target.id);
    const d = { ...data };
    if (deactivating) {
      d.sessionVersion = { increment: 1 };
      await tokens.revokeTokens(tx, target.id);
    }
    return tx.user.update({ where: { id: target.id }, data: d, select: PUBLIC_SELECT });
  });
  if ((target.active && !user.active) || target.role !== user.role) dropSockets(req, target.id);
  return user;
}

async function loadTarget(req) {
  const id = parseId(req.params.id);
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, active: true, email: true, firstName: true, lastName: true } });
  if (!target) {
    if (!isAdmin(req.user)) throw forbidden();
    throw notFound('User not found');
  }
  return target;
}

// GET /api/users  — admin+
// Each user: id, email, role, firstName, lastName, phone, active, mustChangePassword,
// lastLoginAt, createdAt, invitePending (an unused, unexpired invite link exists).
router.get('/', requireAuth, requireRole(...ADMIN), async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { ...PUBLIC_SELECT, createdAt: true },
      orderBy: { lastName: 'asc' },
    });
    const pending = await prisma.authToken.findMany({
      where: { kind: 'invite', usedAt: null, expiresAt: { gt: new Date() } }, select: { userId: true },
    });
    const pendingIds = new Set(pending.map((p) => p.userId));
    res.json(users.map((u) => ({ ...u, invitePending: pendingIds.has(u.id) })));
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

// PATCH /api/users/me/password { currentPassword, newPassword } — any signed-in
// person (not API keys). Allowed while a temporary password is in use. Revokes
// every OTHER session: the response carries a fresh token for this one.
router.patch('/me/password', requireAuth, requireSession, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (typeof body.currentPassword !== 'string' || !body.currentPassword) {
      throw badRequest('currentPassword is required', { code: 'REQUIRED', field: 'currentPassword' });
    }
    const pw = tokens.validPassword(body.newPassword, 'newPassword');
    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!me) throw notFound('User not found');
    if (!(await bcrypt.compare(body.currentPassword, me.password))) {
      throw badRequest('Your current password is not correct', { code: 'INVALID_CURRENT_PASSWORD', field: 'currentPassword' });
    }
    if (await bcrypt.compare(pw, me.password)) {
      throw badRequest('Choose a password different from the current one', { code: 'PASSWORD_UNCHANGED', field: 'newPassword' });
    }
    const hashed = await tokens.hashPassword(pw);
    const updated = await prisma.$transaction(async (tx) => {
      await tokens.revokeTokens(tx, me.id, 'reset');
      return tx.user.update({
        where: { id: me.id },
        data: { password: hashed, mustChangePassword: false, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
      });
    });
    dropSockets(req, me.id); // sockets of the old sessions; this page reconnects with the new token
    res.json({
      success: true,
      token: signToken(updated),
      user: { id: updated.id, email: updated.email, role: updated.role, firstName: updated.firstName, lastName: updated.lastName, mustChangePassword: false },
    });
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
    // The admin typed this password, so it is a temporary one: the user must
    // change it at first sign-in unless the admin explicitly opts out.
    const mustChangePassword = body.mustChangePassword === undefined ? true : v.bool(body.mustChangePassword, 'mustChangePassword');

    const hashed = await tokens.hashPassword(password);
    const user   = await prisma.user.create({
      data:   { email, password: hashed, firstName, lastName, role, phone, mustChangePassword },
      select: { id: true, email: true, role: true, firstName: true, lastName: true, mustChangePassword: true },
    });
    res.status(201).json(user);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id — profile fields; admins also email / role / active
router.patch('/:id', requireAuth, requireSession, async (req, res, next) => {
  try {
    const body = req.body || {};
    const target = await loadTarget(req);
    const self = target.id === req.user.id;

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
      assertCanManage(req.user, target);
    }
    if (wantsEmail) data.email = v.email(body.email, 'email', { required: true });
    if (wantsRole) {
      data.role = validRole(body.role);
      if (PRIVILEGED.includes(data.role) && !isSuper(req.user)) throw forbidden('Only a super-admin can grant admin or super-admin');
    }
    if (wantsActive) {
      if (typeof body.active !== 'boolean') throw badRequest('active must be true or false', { code: 'INVALID_INPUT', field: 'active' });
      data.active = body.active;
    }
    if (body.password !== undefined) {
      throw badRequest('password cannot be changed via this route — use PATCH /api/users/me/password or POST /api/users/:id/reset-password', { code: 'INVALID_INPUT', field: 'password' });
    }

    const user = await applyAccessChange(req, target, data);
    res.json(user);
  } catch (err) { next(err); }
});

// POST /api/users/:id/deactivate | /reactivate — leavers (GAP-2). Admin+;
// admins / super-admins only by a super-admin; never yourself; never the last
// active super-admin (409 LAST_SUPER_ADMIN). Deactivation ends every session
// and live socket at once and voids unused reset / invite links.
for (const [action, active] of [['deactivate', false], ['reactivate', true]]) {
  router.post(`/:id/${action}`, requireAuth, requireSession, requireRole(...ADMIN), async (req, res, next) => {
    try {
      const target = await loadTarget(req);
      if (target.id === req.user.id) throw forbidden('You cannot change your own active status');
      assertCanManage(req.user, target);
      res.json(await applyAccessChange(req, target, { active }));
    } catch (err) { next(err); }
  });
}

// PATCH /api/users/:id/role { role } — admin+ (role matrix as PATCH /:id)
router.patch('/:id/role', requireAuth, requireSession, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    if (target.id === req.user.id) throw forbidden('You cannot change your own role');
    assertCanManage(req.user, target);
    const role = validRole((req.body || {}).role);
    if (PRIVILEGED.includes(role) && !isSuper(req.user)) throw forbidden('Only a super-admin can grant admin or super-admin');
    res.json(await applyAccessChange(req, target, { role }));
  } catch (err) { next(err); }
});

// POST /api/users/:id/reset-password { mode?: 'temporary' | 'link' } — admin+
//   temporary (default): sets a one-time temporary password (shown once in the
//     response), forces a change at next sign-in, revokes the user's sessions.
//   link: emails a single-use reset link (RESET_TOKEN_TTL_MINUTES, default 30) and
//     returns it so the admin can pass it on when email fails / is off.
router.post('/:id/reset-password', requireAuth, requireSession, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    if (target.id === req.user.id) throw badRequest('Use PATCH /api/users/me/password to change your own password', { code: 'INVALID_INPUT' });
    assertCanManage(req.user, target);
    if (!target.active) throw conflict('This account is deactivated — reactivate it first', { code: 'USER_INACTIVE' });
    const body = req.body || {};
    const mode = body.mode == null || body.mode === '' ? 'temporary' : v.oneOf(body.mode, ['temporary', 'link'], 'mode', { required: true });

    if (mode === 'temporary') {
      const temp = tokens.temporaryPassword();
      const hashed = await tokens.hashPassword(temp);
      const user = await prisma.$transaction(async (tx) => {
        await tokens.revokeTokens(tx, target.id, 'reset');
        return tx.user.update({
          where: { id: target.id },
          data: { password: hashed, mustChangePassword: true, passwordChangedAt: new Date(), sessionVersion: { increment: 1 } },
          select: PUBLIC_SELECT,
        });
      });
      dropSockets(req, target.id);
      return res.json({
        success: true, mode, temporaryPassword: temp, mustChangePassword: true, user,
        message: `Temporary password set for ${target.email}. It is shown only once; they must change it when they sign in.`,
      });
    }

    const { token, expiresAt } = await tokens.issueToken(prisma, { userId: target.id, kind: 'reset', createdById: req.user.id });
    const link = tokens.resetLink(req, token);
    const brand = require('../../brand.config');
    const mins = Math.round((expiresAt - Date.now()) / 60000);
    const mail = await trySendMail({
      to: target.email,
      subject: `Set a new ${brand.companyName} password`,
      text: `Hi ${target.firstName || ''},\n\nAn admin asked for a password reset for ${target.email}.\nOpen this link within ${mins} minutes to choose a new password (it works once):\n${link}\n`,
    }, { fromName: brand.companyName });
    res.json({
      success: true, mode, resetLink: link, expiresAt,
      emailed: !!mail.delivered, mailDriver: mail.driver, ...(mail.failed ? { mailError: mail.reason } : {}),
      message: mail.delivered ? `Reset link sent to ${target.email}` : `Email was not sent — copy this link to ${target.email} yourself (valid ${mins} minutes, single use)`,
    });
  } catch (err) { next(err); }
});

// DELETE /api/users/:id — super-admin only (soft-delete by setting active=false is preferred)
router.delete('/:id', requireAuth, requireSession, requireRole(...SUPER_ADMIN), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === req.user.id) throw badRequest('You cannot delete your own account');
    await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { role: true, active: true } });
      if (!target) throw notFound('User not found');
      if (target.role === 'super-admin' && target.active) await assertNotLastSuperAdmin(tx, id);
      await tx.user.delete({ where: { id } });
    });
    dropSockets(req, id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.assertNotLastSuperAdmin = assertNotLastSuperAdmin;
