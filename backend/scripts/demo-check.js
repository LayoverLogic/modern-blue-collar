#!/usr/bin/env node
/**
 * scripts/demo-check.js — is this demo safe to show a prospect?
 *
 * How to run (from backend/, against a sandbox/demo instance):
 *   1. npm install
 *   2. Database checks only (uses DATABASE_URL + BRAND_* from the env file):
 *        ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check
 *   3. Add the running server's API (/api/brand + list endpoints):
 *        ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3101
 *   4. Add a headless-Chrome pass over the main pages (needs Chrome, puppeteer-core):
 *        ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3101 --headless
 *
 * Options
 *   --port <n> | --url <base>   check a running instance's API (default: DB checks only)
 *   --headless                  also render the pages in headless Chrome (implies API)
 *   --repair-onclick-quotes     passed to brand-shot (temporary aid while WL-1/RT-25 is open)
 *   --shots <dir>               save a PNG per page during --headless
 *   --email / --password        login for API/headless (default ADMIN_EMAIL / ADMIN_PASSWORD)
 *   --denylist <file>           client-name denylist (default $DEMO_DENYLIST_FILE or
 *                               demo/denylist.local.txt — gitignored, see denylist.example.txt)
 *   --strict                    WARN also fails
 *   --json                      machine-readable output
 *
 * Output: one line per check, PASS / WARN / FAIL, then a summary.
 * Exit code: 1 if anything FAILs (or WARNs with --strict), otherwise 0.
 * Read-only: never writes to the database.
 */
'use strict';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const flag = (n) => process.argv.includes('--' + n);

require('../helpers/loadEnv');
const { loadDenylist } = require('../demo/lib/guard');
const checks = require('../demo/lib/checks');

(async () => {
  const brand = require('../../brand.config');
  const dlArg = arg('denylist', null);
  const dl = loadDenylist(typeof dlArg === 'string' ? dlArg : undefined);
  const email = arg('email', process.env.ADMIN_EMAIL || 'admin@demo.test');
  const password = arg('password', process.env.ADMIN_PASSWORD || process.env.DEMO_PASSWORD);
  const port = arg('port', null);
  const base = arg('url', null) || (port ? `http://localhost:${port}` : null);
  const all = [];

  if (!dl.found && (typeof dlArg === 'string' || process.env.DEMO_DENYLIST_FILE)) {
    all.push({ level: 'FAIL', id: 'denylist', msg: `denylist file not found: ${dl.file}` });
  }

  const prisma = require('../helpers/prisma');
  try {
    all.push(...await checks.runDbChecks({ prisma, brand, denylist: dl.terms }));
  } catch (e) {
    all.push({ level: 'FAIL', id: 'db', msg: `database check failed: ${e.message.split('\n')[0]}` });
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  if (base || flag('headless')) {
    const b = base || `http://localhost:${process.env.PORT || 3101}`;
    all.push(...await checks.runApiChecks({ base: b, brand, denylist: dl.terms, email, password }));
    if (flag('headless')) {
      const p = new URL(b).port || '80';
      all.push(...await checks.runHeadlessChecks({
        port: p, denylist: dl.terms, email, password, repair: flag('repair-onclick-quotes'),
        shotsDir: arg('shots', null) === true ? null : arg('shots', null),
      }));
    }
  }

  const n = (lvl) => all.filter((r) => r.level === lvl).length;
  const failed = n('FAIL') > 0 || (flag('strict') && n('WARN') > 0);
  if (flag('json')) {
    console.log(JSON.stringify({ trade: brand.tradeType, company: brand.companyName, denylist: dl.found ? dl.file : null, results: all, failed }, null, 1));
  } else {
    console.log(`demo:check — ${brand.companyName} · ${brand.tradeType} · denylist: ${dl.found ? `${dl.terms.length} terms` : 'none'}`);
    for (const r of all) console.log(`${r.level.padEnd(4)}  ${r.id.padEnd(24)} ${r.msg}`);
    console.log(`\n${n('PASS')} pass · ${n('WARN')} warn · ${n('FAIL')} fail → ${failed ? 'NOT READY' : 'READY'}`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(`[demo:check] ERROR: ${e.stack || e.message}`); process.exit(1); });
