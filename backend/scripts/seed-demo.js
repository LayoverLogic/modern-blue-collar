#!/usr/bin/env node
/**
 * scripts/seed-demo.js — seed a believable, trade-correct demo for a prospect.
 *
 * How to run (from backend/, sandbox or demo databases only):
 *   1. npm install
 *   2. Pick a prospect file in demo/prospects/ (default.json = generic "Anytown", US;
 *      ks-plumbing-example.json; ie-heating-example.json) or copy one.
 *   3. Write its env file (company name, trade, colours, time zone, its own DB):
 *        node scripts/seed-demo.js --prospect ks-plumbing-example --print-env
 *      → backend/.env.demo.ks-plumbing-example (gitignored)
 *   4. Start the instance with it (creates + migrates the DB, seeds, starts):
 *        ENV_FILE=.env.demo.ks-plumbing-example npm run sandbox
 *   5. Before each demo, refresh the dates ("today" jobs, overdue invoices...):
 *        ENV_FILE=.env.demo.ks-plumbing-example npm run seed:demo -- --reset
 *   6. Check it:  ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3101
 *
 * Real prospects: keep their file OUTSIDE this (public) repository, e.g.
 *   ~/mbc-prospects/acme-plumbing.json (copy an example and edit it), then
 *        node scripts/seed-demo.js --prospect ~/mbc-prospects/acme-plumbing.json --print-env
 *   The env file then carries DEMO_PROSPECT=<absolute path>; sandbox.js, seed_jobs.js
 *   and this script read the prospect from there. A prospect path inside the
 *   repo (other than demo/prospects/) is refused (helpers/prospectPath.js).
 *
 * --print-env writes a freshly generated random JWT_SECRET into the env file
 * (never the example's placeholder), and the sandbox listens on 127.0.0.1 only
 * (HOST=0.0.0.0 to change that).
 *
 * Options
 *   --prospect <slug|file.json>  default: $DEMO_PROSPECT or "default". DEMO_PROSPECT may be a
 *                                slug or an ABSOLUTE path; --prospect may also be relative to
 *                                the current directory
 *   --locale <US|IE>             override the prospect's locale (default: the prospect's, else
 *                                BRAND_COUNTRY); seeding refuses one that differs from BRAND_COUNTRY
 *   --reset                      wipe customers, jobs, quotes, invoices, pricebook, inventory and
 *                                non-super-admin users first (required to switch trade on a DB)
 *   --print-env [--port N] [--out file] [--force]   write .env.demo.<slug> and exit (no DB needed)
 *   --allow-db <name>            seed a database whose name has no demo token (e.g. Docker's "mbc")
 *   --seed <text>                change the random seed (default: prospect slug + trade + locale)
 *   --now <ISO time>             pretend it is this time (reproducible screenshots)
 *   --dry-run                    build the dataset and print a summary; no database access
 *   --list                       list prospect files
 *
 * Safety: refuses any database whose name does not contain demo/sandbox/test/wl
 * (mbc_sandbox, mbc_demo_<slug>, mbc_wl_*) unless --allow-db names it, and
 * refuses NODE_ENV=production. All people, emails and phone numbers are
 * fictional (reserved .example/.test domains, 555-01xx, ComReg drama ranges).
 * Exit codes: 0 ok · 1 error · 2 refused (guard or trade conflict).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const flag = (name) => process.argv.includes('--' + name);
const log = (m) => console.log(`[seed:demo] ${m}`);
function die(msg, code = 1) { console.error(`[seed:demo] ${code === 2 ? 'REFUSED' : 'ERROR'}: ${msg}`); process.exit(code); }

require('../helpers/loadEnv');
const demo = require('../demo');

(async () => {
  if (flag('list')) {
    for (const s of demo.listProspects()) {
      const p = demo.loadProspect(s);
      console.log(`${s.padEnd(24)} ${p.locale || '(instance country)'}  ${(p.brand && p.brand.BRAND_TRADE_TYPE) || '(instance trade)'}  ${p.description || ''}`);
    }
    return;
  }

  const fromArg = arg('prospect', null);
  let ref;
  try {
    ref = require('../helpers/prospectPath').resolveProspectRef(
      fromArg && fromArg !== true ? fromArg : (process.env.DEMO_PROSPECT || 'default'),
      fromArg && fromArg !== true ? { cwd: process.cwd() } : {},
    );
  } catch (e) { die(e.message); }
  let prospect;
  try { prospect = demo.loadProspect(ref.value); } catch (e) { die(e.message); }

  let brand;
  try { brand = require('../../brand.config'); } catch (e) { die(e.message); }

  if (flag('print-env')) {
    const out = path.resolve(arg('out', path.join(demo.backendDir, `.env.demo.${prospect.slug}`)));
    if (fs.existsSync(out) && !flag('force')) die(`${out} already exists (use --force to overwrite).`);
    const port = arg('port', null);
    let text = demo.renderProspectEnv({
      prospect, brandTrade: brand.tradeType, port: port === true ? null : port,
      exampleFile: path.join(demo.backendDir, '.env.sandbox.example'),
    });
    // A fresh random secret, never the example's placeholder (anyone could forge tokens with it)
    const secret = require('crypto').randomBytes(48).toString('hex');
    text = /^JWT_SECRET=.*$/m.test(text) ? text.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`) : `${text}JWT_SECRET=${secret}\n`;
    // A prospect file outside the repo is referenced by its absolute path
    if (ref.kind === 'file') text = text.replace(/^DEMO_PROSPECT=.*$/m, `DEMO_PROSPECT=${JSON.stringify(ref.value)}`);
    fs.writeFileSync(out, text, { mode: 0o600 });
    log(`wrote ${out}`);
    const rel = path.relative(demo.backendDir, out);
    log(`next: ENV_FILE=${rel.startsWith('..') ? out : rel} npm run sandbox`);
    return;
  }

  const now = arg('now', null) ? new Date(arg('now')) : new Date();
  if (Number.isNaN(now.getTime())) die('--now is not a valid date');

  if (flag('dry-run')) {
    const ds = demo.buildDataset({ brand, prospect, locale: demo.resolveDemoLocale({ brand, prospect, localeCode: arg('locale', null), strict: false }), now, seed: arg('seed', undefined) });
    console.log(JSON.stringify({
      meta: ds.meta, team: ds.team.map((t) => `${t.email} ${t.role}`), customers: ds.customers.length,
      pricebook: ds.pricebook.length, inventory: ds.inventory.length,
      jobs: ds.jobs.map((j) => `${j.scheduledDate || '(unscheduled)'} ${j.scheduledTime || ''} ${j.status} [${j.type}] ${j.title} ${j.amount}`),
    }, null, 1));
    return;
  }

  try {
    const allowDb = arg('allow-db', process.env.SEED_DEMO_ALLOW_DB);
    const db = demo.assertDemoDatabase(process.env.DATABASE_URL, { allowDb: allowDb === true ? undefined : allowDb });
    log(`database ${db} · trade ${brand.tradeType} · prospect ${prospect.slug}`);
  } catch (e) { die(e.message, 2); }

  const prisma = require('../helpers/prisma');
  try {
    const summary = await demo.runSeedDemo({
      prisma, brand, prospect, locale: arg('locale', null), reset: flag('reset'), now, seed: arg('seed', undefined),
      password: process.env.DEFAULT_PASSWORD, keepEmails: [process.env.ADMIN_EMAIL], log,
    });
    if (summary.logins) log(`logins (password = DEFAULT_PASSWORD): ${summary.logins.join(', ')}`);
  } catch (e) {
    await prisma.$disconnect().catch(() => {});
    die(e.message, e.name === 'TradeConflictError' ? 2 : 1);
  }
  await prisma.$disconnect();
})().catch((e) => die(e.stack || e.message));
