/**
 * routes/invites.js — team invites (mounted at /api/invites only; RT-29).
 *
 *   POST /api/invites/send   { email, firstName, lastName, role?, phone? }   admin+ (signed in; not API keys)
 *   POST /api/invites        (same — alias used by team.html)
 *       firstName / lastName required (400 REQUIRED, field); phone → E.164 (400 INVALID_PHONE).
 *       Only a super-admin may invite (or re-invite) an admin / super-admin.
 *       A NEW email: the user (active, unusable password, default role technician) and a
 *       single-use invite link are created in ONE transaction → 201.
 *       An email that already has an account is not modified. If that account still has
 *       a pending invite (never accepted), a fresh link replaces it → 200; otherwise no
 *       link is issued (they sign in as usual / use "forgot password") → 200 passwordInvite:false.
 *       The email is sent AFTER the commit. A mail failure never turns into a 500
 *       (GAP-4): the answer says emailed:false + mailError, with the link to copy.
 *     Response: { success, created, userId, emailed, mailDriver, mailError?, message,
 *                 inviteLink (accept-invite page, or null), expiresAt, passwordInvite,
 *                 googleSignIn (true when Google sign-in is configured), googleLink }
 *
 *   GET  /api/invites/:token          public — { valid: true, email, firstName, lastName, role,
 *                                     companyName, expiresAt, googleSignIn } | 404 INVALID_INVITE
 *   POST /api/invites/:token/accept   public — { password, firstName?, lastName? } → sets the
 *                                     password, uses up the link, signs in:
 *                                     { success, token, user } (same shape as POST /api/auth/login)
 *       400 WEAK_PASSWORD / INVALID_PASSWORD, 404 INVALID_INVITE (unknown, used, expired,
 *       or the account was deactivated). Rate limited in server.js (RESET_RATE_MAX per IP).
 *
 * Invites work without Google Workspace: the link opens /accept-invite.html#token=…
 * where the person chooses a password. Google sign-in (when configured) keeps working
 * for the pre-created account as before (routes/googleAuth.js).
 */

require('../helpers/loadEnv');
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole, requireSession, sessionUser } = require('./auth');
const { trySendMail } = require('../helpers/mailer');
const { ROLES, ADMIN, PRIVILEGED, isSuper } = require('../helpers/roles');
const { badRequest, forbidden, notFound } = require('../helpers/httpError');
const v = require('../helpers/validate');
const { normalisePhone } = require('../helpers/phone');
const { integrationStatus } = require('../helpers/integrations');
const { signToken } = require('../helpers/security');
const tokens = require('../helpers/authTokens');
const brand = require('../../brand.config');

const prisma = require('../helpers/prisma');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const googleOn = () => integrationStatus('google').enabled;

function inviteEmail({ email, firstName, link, googleLink, expiresAt }) {
  const days = Math.max(1, Math.round((expiresAt - Date.now()) / 86400000));
  const google = googleOn() && googleLink;
  const text = [
    `Hi ${firstName || ''},`,
    '',
    `You've been invited to join ${brand.companyName}.`,
    link ? `Choose your password here (the link works once, for ${days} day${days === 1 ? '' : 's'}):\n${link}` : '',
    google ? `Or sign in with the Google account for ${email}: ${googleLink}` : '',
  ].filter((l) => l !== '').join('\n');
  const html = `<p>Hi ${escapeHtml(firstName || '')},</p><p>You've been invited to join <strong>${escapeHtml(brand.companyName)}</strong>.</p>` +
    (link ? `<p><a href="${escapeHtml(link)}">Accept the invite and choose a password</a> (works once, for ${days} day${days === 1 ? '' : 's'}).</p>` : '') +
    (google ? `<p>Or sign in with the Google account for ${escapeHtml(email)}: <a href="${escapeHtml(googleLink)}">Sign in with Google</a></p>` : '');
  return { subject: `You've been invited to join ${brand.companyName}`, text, html };
}

async function sendInvite(req, res, next) {
  try {
    const body = req.body || {};
    const email = v.email(body.email, 'email', { required: true });
    const role = body.role == null || body.role === '' ? 'technician' : body.role;
    if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`, { code: 'INVALID_ROLE', field: 'role', allowed: ROLES });
    if (PRIVILEGED.includes(role) && !isSuper(req.user)) throw forbidden('Only a super-admin can invite an admin or super-admin');
    const firstName = v.str(body.firstName, 'firstName', { required: true, max: 100 });
    const lastName  = v.str(body.lastName, 'lastName', { required: true, max: 100 });
    const phone     = normalisePhone(body.phone, 'phone');
    const unusable  = await tokens.unusablePasswordHash();

    // User + invite link together, or neither.
    const out = await prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email }, select: { id: true, role: true, active: true, firstName: true } });
      if (!user) {
        user = await tx.user.create({
          data: { email, password: unusable, firstName, lastName, phone, role, active: true },
          select: { id: true, role: true, active: true, firstName: true },
        });
        const t = await tokens.issueToken(tx, { userId: user.id, kind: 'invite', createdById: req.user.id });
        return { user, created: true, ...t };
      }
      // Existing account: never hand out a password-setting link for an account
      // the inviter could not manage, and only while an invite is still pending.
      if (PRIVILEGED.includes(user.role) && !isSuper(req.user)) throw forbidden('Only a super-admin can re-invite an admin or super-admin');
      const pending = await tx.authToken.count({ where: { userId: user.id, kind: 'invite', usedAt: null } });
      const accepted = await tx.authToken.count({ where: { userId: user.id, kind: 'invite', usedAt: { not: null } } });
      if (user.active && pending > 0 && accepted === 0) {
        const t = await tokens.issueToken(tx, { userId: user.id, kind: 'invite', createdById: req.user.id });
        return { user, created: false, ...t };
      }
      return { user, created: false, token: null, expiresAt: null };
    });

    const link = out.token ? tokens.inviteLink(req, out.token) : null;
    const base = tokens.appBase(req);
    const googleLink = `${base}/api/auth/google`;
    const loginLink = `${base}/`;
    const mail = await trySendMail({
      to: email,
      ...inviteEmail({ email, firstName: out.user.firstName || firstName, link: link || loginLink, googleLink, expiresAt: out.expiresAt || new Date(Date.now() + 86400000) }),
    }, { fromName: brand.companyName });

    let message;
    if (mail.delivered) message = `Invite sent to ${email}`;
    else if (mail.failed) message = `The invite email could not be sent (${mail.reason}) — copy the invite link and send it to ${email} yourself`;
    else message = `Email is not configured — copy the invite link and send it to ${email} yourself`;
    if (!link && !out.created) message += '. This person already has an account: they can sign in, or use "Forgot password".';

    res.status(out.created ? 201 : 200).json({
      success: true,
      created: out.created,
      userId: out.user.id,
      emailed: !!mail.delivered,
      mailDriver: mail.driver,
      ...(mail.failed ? { mailError: mail.reason } : {}),
      message,
      inviteLink: link,
      expiresAt: out.expiresAt,
      passwordInvite: !!link,
      googleSignIn: googleOn(),
      googleLink,
    });
  } catch (err) { next(err); }
}

router.post('/send', requireAuth, requireSession, requireRole(...ADMIN), sendInvite);
router.post('/', requireAuth, requireSession, requireRole(...ADMIN), sendInvite);

const invalidInvite = () => notFound('This invite link is invalid, expired or already used — ask your admin for a new one', { code: 'INVALID_INVITE' });

async function loadInvite(raw) {
  const row = await tokens.findToken(prisma, raw, 'invite');
  if (!row || !row.user.active) throw invalidInvite();
  return row;
}

// GET /api/invites/:token — validate a link (public)
router.get('/:token', async (req, res, next) => {
  try {
    const row = await loadInvite(req.params.token);
    const u = row.user;
    res.json({
      valid: true, email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role,
      companyName: brand.companyName, expiresAt: row.expiresAt, googleSignIn: googleOn(),
    });
  } catch (err) { next(err); }
});

// POST /api/invites/:token/accept { password, firstName?, lastName? } (public)
router.post('/:token/accept', async (req, res, next) => {
  try {
    const body = req.body || {};
    const row = await loadInvite(req.params.token);
    const pw = tokens.validPassword(body.password, 'password');
    const data = { mustChangePassword: false, passwordChangedAt: new Date(), lastLoginAt: new Date(), sessionVersion: { increment: 1 } };
    if (body.firstName !== undefined && body.firstName !== '') data.firstName = v.str(body.firstName, 'firstName', { required: true, max: 100 });
    if (body.lastName !== undefined && body.lastName !== '') data.lastName = v.str(body.lastName, 'lastName', { required: true, max: 100 });
    data.password = await tokens.hashPassword(pw);
    const user = await prisma.$transaction(async (tx) => {
      if (!(await tokens.consumeToken(tx, row))) throw invalidInvite();
      return tx.user.update({ where: { id: row.userId }, data });
    });
    res.json({ success: true, token: signToken(user), user: sessionUser(user) });
  } catch (err) { next(err); }
});

module.exports = router;
