/**
 * routes/invites.js — team invites (mounted at /api/invites only; RT-29).
 *
 *   POST /api/invites/send   { email, role?, firstName?, lastName?, phone? }
 *   POST /api/invites        (same — alias used by team.html)
 *
 * Admin+ (signed in; not API keys). Inviting PRE-CREATES the user (active,
 * unusable password, default role technician) if the email is new — that row
 * is what lets them pass the fail-closed Google sign-in gate
 * (routes/googleAuth.js). Only a super-admin may invite an admin / super-admin.
 * An email that already has an account is not modified; the invite is re-sent.
 *
 * Response: { success, inviteLink, emailed, mailDriver, message, userId, created }
 */

require('../helpers/loadEnv');
const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const router  = express.Router();
const { requireAuth, requireRole, requireSession } = require('./auth');
const { sendMail } = require('../helpers/mailer');
const { ROLES, ADMIN, PRIVILEGED, isSuper } = require('../helpers/roles');
const { badRequest, forbidden } = require('../helpers/httpError');
const v = require('../helpers/validate');
const brand = require('../../brand.config');

const prisma = require('../helpers/prisma');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function sendInvite(req, res, next) {
  try {
    const body = req.body || {};
    const email = v.email(body.email, 'email', { required: true });
    const role = body.role == null || body.role === '' ? 'technician' : body.role;
    if (!ROLES.includes(role)) throw badRequest(`role must be one of: ${ROLES.join(', ')}`, { code: 'INVALID_ROLE' });
    if (PRIVILEGED.includes(role) && !isSuper(req.user)) throw forbidden('Only a super-admin can invite an admin or super-admin');

    let user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    let created = false;
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          password:  await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10), // unusable: Google sign-in
          firstName: v.str(body.firstName, 'firstName', { max: 100 }) || '',
          lastName:  v.str(body.lastName, 'lastName', { max: 100 }) || '',
          phone:     v.str(body.phone, 'phone', { max: 40 }),
          role,
          active:    true,
        },
        select: { id: true },
      });
      created = true;
    }

    // Build invite link that starts the Google OAuth flow
    const base = (process.env.APP_URL || '').replace(/\/+$/, '');
    const inviteLink = `${base}/api/auth/google`;

    const mail = await sendMail({
      to:      email,
      subject: `You've been invited to join ${brand.companyName}`,
      text:    `You've been invited to join ${brand.companyName}. Sign in with the Google account for ${email}: ${inviteLink}`,
      html:    `<p>You've been invited to join <strong>${escapeHtml(brand.companyName)}</strong>.</p><p>Sign in with the Google account for ${escapeHtml(email)}:</p><p><a href="${escapeHtml(inviteLink)}">Accept Invite</a></p>`,
    }, { fromName: brand.companyName });

    res.json({
      success: true,
      inviteLink,
      emailed: mail.delivered,
      mailDriver: mail.driver,
      message: mail.delivered ? `Invite sent to ${email}` : `Email is not configured — share this invite link with ${email} manually`,
      userId: user.id,
      created,
    });
  } catch (err) { next(err); }
}

router.post('/send', requireAuth, requireSession, requireRole(...ADMIN), sendInvite);
router.post('/', requireAuth, requireSession, requireRole(...ADMIN), sendInvite);

module.exports = router;
