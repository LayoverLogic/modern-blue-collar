/**
 * demo/index.js — entry points shared by scripts/seed-demo.js, seed_jobs.js,
 * seed_pricebook.js and the tests.
 *
 * Layout
 *   demo/prospects/<slug>.json        one file per prospect (default = generic "Anytown", US)
 *   demo/fixtures/trades/<trade>.json pricebook, inventory and job templates per trade
 *   demo/fixtures/locales/<CC>.json   names, streets, phone/postcode formats (US, IE)
 *   demo/denylist.example.txt         format of the client-name denylist (real list: denylist.local.txt, gitignored)
 *   demo/lib/                         dataset builder, DB writer, guard, checks
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normaliseTrade, buildBrand } = require('../helpers/brandValidate');
const { loadProspect, loadLocale, listProspects } = require('./lib/fixtures');
const { buildDataset } = require('./lib/dataset');
const { assertDemoDatabase, DemoGuardError } = require('./lib/guard');
const seedLib = require('./lib/seed');

class TradeConflictError extends Error {
  constructor(message) { super(message); this.name = 'TradeConflictError'; }
}

/** Throw if the prospect was written for a different trade than the instance runs. */
function assertProspectMatchesBrand(prospect, brand) {
  const want = prospect.brand && prospect.brand.BRAND_TRADE_TYPE;
  if (want && normaliseTrade(want) !== brand.tradeType) {
    throw new TradeConflictError(
      `Prospect "${prospect.slug}" is a ${normaliseTrade(want)} business but this instance runs BRAND_TRADE_TYPE=${brand.tradeType}.\n` +
      `  Generate its env file and start the instance with it:\n` +
      `    node scripts/seed-demo.js --prospect ${prospect.slug} --print-env\n` +
      `    ENV_FILE=.env.demo.${prospect.slug} npm run sandbox`,
    );
  }
}

/**
 * Seed demo data.
 *   mode: 'all' | 'pricebook' (pricebook only) | 'people' (inventory, team, customers, jobs...)
 * Returns a summary object; throws TradeConflictError when the DB holds another trade's jobs.
 */
async function runSeedDemo({
  prisma, brand, prospect: prospectName = 'default', locale: localeCode, reset = false,
  mode = 'all', now = new Date(), seed, password, keepEmails = [], log = () => {},
}) {
  const prospect = typeof prospectName === 'object' ? prospectName : loadProspect(prospectName);
  const locale = loadLocale(localeCode || prospect.locale || 'US');
  assertProspectMatchesBrand(prospect, brand);
  const dataset = buildDataset({ brand, prospect, locale, now, seed });
  if (mode !== 'pricebook' && !password) {
    throw new Error('DEFAULT_PASSWORD is not set — it is the password for the seeded demo team (e.g. DEFAULT_PASSWORD=demo1234 in .env.sandbox). There is no built-in fallback.');
  }
  const summary = { prospect: prospect.slug, trade: brand.tradeType, industry: brand.industryLabel, locale: locale.code, today: dataset.meta.today };

  if (reset) {
    summary.reset = await seedLib.resetDemoData(prisma, { keepEmails });
    log(`reset: removed ${Object.entries(summary.reset).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
  const state = await seedLib.inspectDemoState(prisma, brand, dataset);
  summary.state = state;

  if (mode !== 'pricebook' && state.otherTrades.length) {
    const other = state.otherTrades.map((t) => `${t.jobs} ${t.tradeType}`).join(', ');
    throw new TradeConflictError(
      `This database already holds demo jobs for another trade (${other}); the instance is now ${brand.tradeType}.\n` +
      '  Switching trade on an existing database needs a reset (it deletes ALL customers, jobs, quotes,\n' +
      '  invoices, pricebook and non-super-admin users in this demo database):\n' +
      `    node scripts/seed-demo.js --prospect ${prospect.slug} --reset`,
    );
  }

  if (mode === 'all' || mode === 'pricebook') {
    summary.pricebook = await seedLib.seedPricebook(prisma, dataset);
    log(`pricebook (${brand.industryLabel}): ${summary.pricebook.created} created, ${summary.pricebook.skipped} already there`);
    if (state.pricebookOtherIndustries.length) {
      log(`note: pricebook also holds items for ${state.pricebookOtherIndustries.map((i) => `${i.industry} (${i.items})`).join(', ')} — hidden by the trade filter; --reset removes them`);
    }
  }
  if (mode === 'all' || mode === 'people') {
    summary.inventory = await seedLib.seedInventory(prisma, dataset);
    summary.people = await seedLib.seedPeopleAndJobs(prisma, dataset, { password });
    const p = summary.people;
    if (!p.jobs && !p.customers && state.seeded) {
      log(`demo data already present for "${prospect.slug}" — nothing added (use --reset for fresh dates)`);
    } else {
      log(`created ${p.users} users, ${p.customers} customers, ${p.jobs} jobs, ${p.quotes} quotes, ${p.invoices} invoices, ${p.parts} parts, ${p.communications} communications`);
    }
    summary.logins = dataset.team.map((t) => `${t.email} (${t.role})`);
  }
  return summary;
}

/** Contents of .env.demo.<slug>: the sandbox example with the prospect's BRAND_* values. */
function renderProspectEnv({ prospect, brandTrade, port, databaseName, exampleFile }) {
  const locale = loadLocale(prospect.locale || 'US');
  const overrides = { ...(prospect.brand || {}) };
  if (!overrides.BRAND_TRADE_TYPE) overrides.BRAND_TRADE_TYPE = brandTrade;
  if (!overrides.BRAND_TIMEZONE) overrides.BRAND_TIMEZONE = locale.timezone;
  buildBrand(overrides); // validate before writing anything
  const db = databaseName || `mbc_demo_${prospect.slug.replace(/-/g, '_')}`;
  const plain = {
    DATABASE_URL: `postgresql://mbc:mbc_sandbox@localhost:5432/${db}?schema=public`,
    DEMO_MODE: 'true',
    DEMO_PROSPECT: prospect.slug,
    ...(port ? { PORT: String(port), APP_URL: `http://localhost:${port}` } : {}),
  };
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = fs.readFileSync(exampleFile, 'utf8').split('\n');
  const done = new Set();
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (!m) return line;
    const k = m[1];
    if (k in plain) { done.add(k); return `${k}=${plain[k]}`; }
    if (k in overrides) { done.add(k); return `${k}=${q(overrides[k])}`; }
    return line;
  });
  const extra = [
    ...Object.keys(plain).filter((k) => !done.has(k)).map((k) => `${k}=${plain[k]}`),
    ...Object.keys(overrides).filter((k) => !done.has(k)).map((k) => `${k}=${q(overrides[k])}`),
  ];
  const header = `# Generated by: node scripts/seed-demo.js --prospect ${prospect.slug} --print-env\n` +
    `# Demo prospect: ${prospect.slug} (${prospect.description || ''})\n` +
    `# Start it with:  ENV_FILE=.env.demo.${prospect.slug} npm run sandbox\n`;
  return header + out.join('\n').replace(/\n*$/, '\n') +
    (extra.length ? `\n# ─── Demo prospect overrides (generated) ─────────────────────────────────────\n${extra.join('\n')}\n` : '');
}

module.exports = {
  runSeedDemo, renderProspectEnv, assertProspectMatchesBrand, TradeConflictError, DemoGuardError,
  assertDemoDatabase, loadProspect, loadLocale, listProspects, buildDataset,
  backendDir: path.join(__dirname, '..'),
};
