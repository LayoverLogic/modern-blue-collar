/**
 * seed_jobs.js — demo team, customers, jobs, quotes, invoices (thin wrapper).
 *
 * How to run (from backend/):
 *   1. npm install
 *   2. npm run sandbox            (DEMO_MODE=true runs this automatically), or
 *      node seed_jobs.js          (needs DEMO_MODE=true or a demo-named database)
 *
 * The data comes from demo/ (see scripts/seed-demo.js for the full tool):
 *   - prospect: $DEMO_PROSPECT, default demo/prospects/default.json (generic "Anytown")
 *   - trade:    BRAND_TRADE_TYPE — job types, pricebook and amounts match the trade
 *   - dates:    relative to today in BRAND_TIMEZONE
 * No client names, real emails or real phone numbers. Team logins are
 * office@ / dispatch@ / tech1@..tech3@ <prospect emailDomain> (default demo.test),
 * password = DEFAULT_PASSWORD (required; no built-in fallback).
 *
 * Idempotent: does nothing if the demo is already there. If the database holds
 * jobs for a different trade it prints how to reset and exits 0, so a boot
 * sequence (sandbox / Docker entrypoint) is never blocked by it.
 *
 * Real businesses: do not run this — add your team, customers and jobs in the UI.
 */
require('./helpers/loadEnv');
const demo = require('./demo');

(async () => {
  const brand = require('../brand.config');
  const isDemo = process.env.DEMO_MODE === 'true';
  try {
    if (!isDemo) demo.assertDemoDatabase(process.env.DATABASE_URL);
  } catch (e) {
    console.error(`[seed_jobs] REFUSED: ${e.message}\n[seed_jobs] Demo data is only seeded with DEMO_MODE=true or into a demo database.`);
    process.exitCode = 1;
    return;
  }
  const prisma = require('./helpers/prisma');
  try {
    const s = await demo.runSeedDemo({
      prisma, brand, prospect: process.env.DEMO_PROSPECT || 'default', mode: 'people',
      password: process.env.DEFAULT_PASSWORD, log: (m) => console.log(`[seed_jobs] ${m}`),
    });
    console.log(`[seed_jobs] logins: ${s.logins.join(', ')}`);
  } catch (e) {
    if (e.name === 'TradeConflictError') {
      console.warn(`[seed_jobs] WARNING — skipped: ${e.message}`);
    } else {
      console.error(`[seed_jobs] ERROR: ${e.message}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
})();
