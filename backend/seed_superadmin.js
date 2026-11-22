/**
 * seed_superadmin.js
 * Creates the initial super-admin account.
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<a long password>' node seed_superadmin.js
 *
 * If ADMIN_PASSWORD is not set, a random TEMPORARY password is generated and
 * printed once; the account is flagged mustChangePassword, so the first sign-in
 * must choose a new password (PATCH /api/users/me/password) before anything else
 * works (B3, GAP-1). ADMIN_FORCE_PASSWORD_CHANGE=true forces that flag for an
 * explicit ADMIN_PASSWORD too.
 */

require('./helpers/loadEnv');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = require('./helpers/prisma');

const EMAIL     = process.env.ADMIN_EMAIL    || 'admin@example.com';
// No published fallback password: if ADMIN_PASSWORD is unset a random one
// is generated and printed ONCE below (RT-23).
const GENERATED = !process.env.ADMIN_PASSWORD;
const PASSWORD  = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
const FIRSTNAME = process.env.ADMIN_FIRST    || 'Super';
const LASTNAME  = process.env.ADMIN_LAST     || 'Admin';
const FORCE     = GENERATED || process.env.ADMIN_FORCE_PASSWORD_CHANGE === 'true';

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) {
    console.log(`Super-admin already exists: ${EMAIL} (id=${existing.id})`);
    return;
  }
  const hashed = await bcrypt.hash(PASSWORD, 12);
  const user   = await prisma.user.create({
    data: {
      email:     EMAIL,
      password:  hashed,
      firstName: FIRSTNAME,
      lastName:  LASTNAME,
      role:      'super-admin',
      active:    true,
      mustChangePassword: FORCE,
    },
  });
  console.log(`Super-admin created: ${user.email} (id=${user.id})`);
  if (GENERATED) console.log(`  Temporary password (shown once — you must choose a new one at first sign-in): ${PASSWORD}`);
  else if (FORCE) console.log('  The password must be changed at first sign-in (ADMIN_FORCE_PASSWORD_CHANGE=true).');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
