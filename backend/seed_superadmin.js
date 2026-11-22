/**
 * seed_superadmin.js
  * Creates the initial super-admin account.
   *
    * Usage:
     *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<a long password>' node seed_superadmin.js
      *
       * If ADMIN_PASSWORD is not set, a random password is generated and printed once.
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
                                                                      },
                                                                        });
                                                                          console.log(`Super-admin created: ${user.email} (id=${user.id})`);
                                                                          if (GENERATED) console.log(`  Generated password (shown once — change it after first sign-in): ${PASSWORD}`);
                                                                          }

                                                                          main()
                                                                            .catch((e) => { console.error(e); process.exitCode = 1; })
                                                                              .finally(() => prisma.$disconnect());
                                                                              
