/**
 * seed_pricebook.js — starter pricebook for the configured trade (thin wrapper).
 *
 * How to run (from backend/):
 *   1. npm install
 *   2. node seed_pricebook.js     (or: npm run seed:prices; the sandbox / Docker demo
 *                                  run it automatically when DEMO_MODE=true)
 *
 * Seeds the starter items for BRAND_TRADE_TYPE from demo/fixtures/trades/<trade>.json
 * (electrical gets electrical items, plumbing-hvac gets both plumbing and HVAC),
 * stamped with brand.industryLabel so GET /api/pricebook shows them. Prices are
 * typical 2026 US ballparks (or Irish ones when $DEMO_PROSPECT is an IE prospect)
 * — edit them in the Pricebook page.
 *
 * Idempotent per (industry, category, name): re-running never duplicates. After a
 * trade switch it adds the new trade's items; the old ones stay (hidden by the
 * pricebook's industry filter) until `npm run seed:demo -- --reset`.
 */
require('./helpers/loadEnv');
const demo = require('./demo');

(async () => {
  const brand = require('../brand.config');
  const prisma = require('./helpers/prisma');
  try {
    await demo.runSeedDemo({
      prisma, brand, prospect: process.env.DEMO_PROSPECT || 'default', mode: 'pricebook',
      log: (m) => console.log(`[seed_pricebook] ${m}`),
    });
    console.log(`[seed_pricebook] total items in pricebook: ${await prisma.priceBookItem.count()}`);
  } catch (e) {
    console.error(`[seed_pricebook] ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
