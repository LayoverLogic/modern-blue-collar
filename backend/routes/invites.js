/**
 * routes/invites.js  — Google OAuth team invite flow
  * Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL
   *
    * GET /api/invites/send?email=x   — send invite email
     * GET /api/auth/google            — redirect to Google OAuth (initiated by invite link)
      * GET /api/auth/google/callback   — Google callback, creates/activates user
       *
        * Note: this router is mounted at BOTH /api/invites AND /api/auth
         * so that the Google callback URL works as /api/auth/google/callback.
          */

          require('../helpers/loadEnv');
          const express   = require('express');
          const router    = express.Router();
          const passport  = require('passport');
          const jwt       = require('jsonwebtoken');
          const bcrypt    = require('bcryptjs');
          const { requireAuth, requireRole } = require('./auth');
const { sendMail } = require('../helpers/mailer');
const { integrationStatus, sendDisabled } = require('../helpers/integrations');
          const brand     = require('../../brand.config');

          const prisma = require('../helpers/prisma');

          // ── Configure Passport Google strategy (lazy init) ─────────────────────────────
          let passportConfigured = false;
          function ensurePassportGoogle() {
            if (passportConfigured) return;
              const GoogleStrategy = require('passport-google-oauth20').Strategy;
                passport.use(new GoogleStrategy({
                    clientID:     process.env.GOOGLE_CLIENT_ID,
                        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                            callbackURL:  process.env.GOOGLE_CALLBACK_URL,
                                passReqToCallback: true,
                                  }, async (_req, _accessToken, _refreshToken, profile, done) => {
                                      try {
                                            const email = profile.emails?.[0]?.value?.toLowerCase();
                                                  if (!email) return done(new Error('No email from Google profile'));

                                                        let user = await prisma.user.findUnique({ where: { email } });
                                                              if (!user) {
                                                                      // Auto-create invited user with a random password (they'll use Google SSO)
                                                                              const randomPw = await bcrypt.hash(Math.random().toString(36), 10);
                                                                                      user = await prisma.user.create({
                                                                                                data: {
                                                                                                            email,
                                                                                                                        password: randomPw,
                                                                                                                                    firstName: profile.name?.givenName  || '',
                                                                                                                                                lastName:  profile.name?.familyName || '',
                                                                                                                                                            role:      'technician',
                                                                                                                                                                        active:    true,
                                                                                                                                                                                  },
                                                                                                                                                                                          });
                                                                                                                                                                                                } else if (!user.active) {
                                                                                                                                                                                                        return done(new Error('Account is deactivated. Contact an admin.'));
                                                                                                                                                                                                              }
                                                                                                                                                                                                                    done(null, user);
                                                                                                                                                                                                                        } catch (err) { done(err); }
                                                                                                                                                                                                                          }));
                                                                                                                                                                                                                            passportConfigured = true;
                                                                                                                                                                                                                            }
                                                                                                                                                                                                                            
                                                                                                                                                                                                                            // GET /api/auth/google
                                                                                                                                                                                                                            router.get('/google', (_req, res, next) => {
                                                                                                                                                                                                                              const g = integrationStatus('google');
  if (!g.enabled) return sendDisabled(res, 'google', g);
                                                                                                                                                                                                                                ensurePassportGoogle();
                                                                                                                                                                                                                                  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(_req, res, next);
                                                                                                                                                                                                                                  });
                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                  // GET /api/auth/google/callback
                                                                                                                                                                                                                                  router.get('/google/callback', (req, res, next) => {
  // Never exchange an auth code with Google unless the integration is live.
  const g = integrationStatus('google');
  if (!g.enabled) return sendDisabled(res, 'google', g);
                                                                                                                                                                                                                                    ensurePassportGoogle();
                                                                                                                                                                                                                                      passport.authenticate('google', { session: false }, (err, user) => {
                                                                                                                                                                                                                                          if (err || !user) {
                                                                                                                                                                                                                                                return res.redirect(`/?auth_error=${encodeURIComponent(err?.message || 'OAuth failed')}`);
                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                        const token = jwt.sign(
                                                                                                                                                                                                                                                              { id: user.id, email: user.email, role: user.role, firstName: user.firstName, lastName: user.lastName },
                                                                                                                                                                                                                                                                    process.env.JWT_SECRET,
                                                                                                                                                                                                                                                                          { expiresIn: '8h' }
                                                                                                                                                                                                                                                                              );
                                                                                                                                                                                                                                                                                  // Redirect to frontend with token (front-end stores it)
                                                                                                                                                                                                                                                                                      res.redirect(`/?token=${token}`);
                                                                                                                                                                                                                                                                                        })(req, res, next);
                                                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                                                        // POST /api/invites/send — admin+ sends an invite email
                                                                                                                                                                                                                                                                                        router.post('/send', requireAuth, requireRole('super-admin', 'admin'), async (req, res, next) => {
                                                                                                                                                                                                                                                                                          try {
                                                                                                                                                                                                                                                                                              const { email } = req.body;
                                                                                                                                                                                                                                                                                                  if (!email) return res.status(400).json({ error: 'email is required' });
                                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                                      // Build invite link that starts the Google OAuth flow
                                                                                                                                                                                                                                                                                                          const inviteLink = `${process.env.APP_URL}/api/auth/google`;
                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                              // Deliver via helpers/mailer (SMTP, sandbox outbox, or disabled)
    const mail = await sendMail({
      to:      email,
      subject: `You've been invited to join ${brand.companyName}`,
      text:    `Click the link to accept your invite: ${inviteLink}`,
      html:    `<p>You've been invited to join <strong>${brand.companyName}</strong>.</p><p><a href="${inviteLink}">Accept Invite</a></p>`,
    }, { fromName: brand.companyName });

    res.json({
      success: true,
      inviteLink,
      emailed: mail.delivered,
      mailDriver: mail.driver,
      message: mail.delivered ? `Invite sent to ${email}` : `Email is not configured — share this invite link with ${email} manually`,
    });
                                                                                                                                                                                                                                                                                                                                                                                                                  } catch (err) { next(err); }
                                                                                                                                                                                                                                                                                                                                                                                                                  });
                                                                                                                                                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                                                                                                                                                  module.exports = router;
                                                                                                                                                                                                                                                                                                                                                                                                                  
