/**
 * tests/whitelabel.test.js — white-label brand config, demo seeding and demo:check.
 *
 *   npm run test:whitelabel
 *   TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_wl_test?schema=public npm run test:whitelabel
 *
 * Part 1 (no database): brand validation (WL-5), colours/logo (WL-6/WL-7),
 *   boot fail-fast, the demo dataset for every trade × locale (job types,
 *   per-trade pricebook, amounts > 0, fictional contacts, no client names,
 *   relative dates in the brand time zone, determinism), guards, --print-env.
 * Part 2 (database; skipped if PostgreSQL is unreachable): seed:demo via the CLI,
 *   idempotency, trade switching (WL-4), the thin seed_jobs / seed_pricebook
 *   wrappers, demo:check PASS on fresh data and FAIL on deliberately broken
 *   records, and the API checks against a booted server.
 *
 * The database (default mbc_wl_test) is created + migrated if missing and is
 * wiped by the seeding tests — never point TEST_DATABASE_URL at real data
 * (seed:demo refuses names without demo/sandbox/test/wl anyway).
 * Client-name denylist: backend/demo/denylist.local.txt when present (gitignored);
 * the tests always add their own synthetic terms as well.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const TEST_DB = process.env.TEST_DATABASE_URL || 'postgresql://mbc:mbc_sandbox@localhost:5432/mbc_wl_test?schema=public';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-wl-test-'));

const bv = require('../helpers/brandValidate');
const { buildDataset } = require('../demo/lib/dataset');
const { loadProspect, loadLocale, loadTrade, validateProspect } = require('../demo/lib/fixtures');
const guard = require('../demo/lib/guard');
const demo = require('../demo');

const NOW = new Date('2026-11-21T18:00:00Z'); // a Saturday, mid-afternoon in Chicago
const LOCAL_DENY = guard.loadDenylist(path.join(BACKEND, 'demo', 'denylist.local.txt'));
const SYNTHETIC_DENY = ['Zzyzx Test Client', 'zzyzx-client.com'];
const DENY = [...LOCAL_DENY.terms, ...SYNTHETIC_DENY];

// ═════════════════════════════════════════════════════════════════════════════
// Part 1 — brand config
// ═════════════════════════════════════════════════════════════════════════════
test('WL-5: trade normalisation accepts case/spacing/aliases', () => {
  const cases = {
    electrical: 'electrical', ' Electrical ': 'electrical', ELECTRICIAN: 'electrical',
    plumbing: 'plumbing', Plumber: 'plumbing',
    HVAC: 'hvac', hvac: 'hvac', 'Heating & Cooling': 'hvac',
    'plumbing-hvac': 'plumbing-hvac', 'Plumbing & HVAC': 'plumbing-hvac', plumbing_hvac: 'plumbing-hvac',
    'plumbing and hvac': 'plumbing-hvac', 'PLUMBING/HVAC': 'plumbing-hvac',
    contracting: 'contracting', 'General Contracting': 'contracting', GC: 'contracting',
    '': 'electrical', [undefined]: 'electrical',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(bv.normaliseTrade(raw === 'undefined' ? undefined : raw), want, raw);
});

test('WL-5: unknown trade fails with a clear message naming the variable and the choices', () => {
  assert.throws(() => bv.normaliseTrade('roofing'), (e) => e instanceof bv.BrandConfigError
    && /BRAND_TRADE_TYPE="roofing"/.test(e.message) && /electrical \| plumbing \| hvac \| plumbing-hvac \| contracting/.test(e.message));
  assert.throws(() => bv.buildBrand({ BRAND_TRADE_TYPE: 'electrcal' }), /not a supported trade/);
});

test('WL-5: the server refuses to boot on an unknown trade (fail fast, exit 1)', () => {
  const r = spawnSync(process.execPath, ['server.js'], {
    cwd: BACKEND, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', BRAND_TRADE_TYPE: 'Roofing', JWT_SECRET: 'x'.repeat(40), DATABASE_URL: TEST_DB, PORT: '0' },
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status} (signal ${r.signal})\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /\[brand\] BRAND_TRADE_TYPE="Roofing" is not a supported trade/);
});

test('brand: every trade builds; labels, job types and palette follow the trade', () => {
  for (const t of bv.TRADES) {
    const b = bv.buildBrand({ BRAND_TRADE_TYPE: t.toUpperCase() });
    assert.equal(b.tradeType, t);
    assert.equal(b.industryLabel, bv.INDUSTRY_LABELS[t]);
    assert.deepEqual(b.jobTypes, bv.JOB_TYPES[t]);
    assert.equal(b.colors.primary, bv.TRADE_PALETTES[t].primary);
    assert.ok(b.jobTypes.includes('Other') || b.jobTypes.includes('General Repair'));
  }
  assert.equal(bv.buildBrand({ BRAND_TRADE_TYPE: 'hvac', BRAND_TECH_LABEL: 'Engineer' }).technicianLabel, 'Engineer');
});

test('WL-6: colors.primaryDark is derived from primary unless set; colours are validated', () => {
  const b = bv.buildBrand({ BRAND_COLOR_PRIMARY: '#2563EB' });
  assert.equal(b.colors.primary, '#2563eb');
  assert.match(b.colors.primaryDark, /^#[0-9a-f]{6}$/);
  assert.notEqual(b.colors.primaryDark, b.colors.primary);
  assert.equal(b.colors.primaryDark, bv.darken('#2563eb'));
  assert.equal(bv.buildBrand({ BRAND_COLOR_PRIMARY: '#abc' }).colors.primary, '#aabbcc');
  assert.equal(bv.buildBrand({ BRAND_COLOR_PRIMARY_DARK: '"#111111"' }).colors.primaryDark, '#111111');
  assert.equal(bv.buildBrand({ BRAND_COLOR_PRIMARY: '#ffff00' }).colors.primaryContrast, '#000000');
  assert.equal(bv.buildBrand({ BRAND_COLOR_PRIMARY: '#1e3a8a' }).colors.primaryContrast, '#ffffff');
  for (const k of ['primary', 'primaryDark', 'primaryContrast', 'secondary', 'accent', 'navBg', 'navText', 'headerBg', 'headerText']) {
    assert.match(b.colors[k], /^#[0-9a-f]{6}$/, k);
  }
  assert.throws(() => bv.buildBrand({ BRAND_COLOR_PRIMARY: 'red;}body{display:none' }), /BRAND_COLOR_PRIMARY=.*not a hex colour/);
  assert.throws(() => bv.buildBrand({ BRAND_COLOR_NAV_BG: '#12345' }), /BRAND_COLOR_NAV_BG/);
});

test('WL-7: BRAND_LOGO_URL / BRAND_FAVICON_URL are validated and exposed', () => {
  const b = bv.buildBrand({ BRAND_LOGO_URL: 'https://cdn.example.com/logo.svg' });
  assert.equal(b.logoUrl, 'https://cdn.example.com/logo.svg');
  assert.equal(b.faviconUrl, b.logoUrl, 'favicon defaults to the logo');
  assert.equal(bv.buildBrand({ BRAND_LOGO_URL: '/brand/logo.png', BRAND_FAVICON_URL: '/brand/fav.ico' }).faviconUrl, '/brand/fav.ico');
  assert.equal(bv.buildBrand({}).logoUrl, '');
  assert.ok(bv.buildBrand({ BRAND_LOGO_URL: 'data:image/png;base64,iVBORw0KGgo=' }).logoUrl.startsWith('data:image/png'));
  for (const bad of ['javascript:alert(1)', '//evil.example/x.png', 'logo.png" onerror="x', 'data:text/html;base64,PHN2Zz4=']) {
    assert.throws(() => bv.buildBrand({ BRAND_LOGO_URL: bad }), /BRAND_LOGO_URL/, bad);
  }
  const pub = bv.publicBrand(b, { demoMode: true });
  for (const k of ['companyName', 'tradeType', 'technicianLabel', 'industryLabel', 'jobTypes', 'colors', 'logoUrl', 'faviconUrl', 'demoMode']) assert.ok(k in pub, k);
});

test('brand: invalid BRAND_TIMEZONE fails; brand object is plain JSON (no getters)', () => {
  assert.throws(() => bv.buildBrand({ BRAND_TIMEZONE: 'Mars/Olympus' }), /BRAND_TIMEZONE/);
  const b = bv.buildBrand({ BRAND_TRADE_TYPE: 'plumbing-hvac', BRAND_TIMEZONE: 'Europe/Dublin' });
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
  for (const k of Object.keys(b)) assert.equal(typeof Object.getOwnPropertyDescriptor(b, k).get, 'undefined', k);
});

// ═════════════════════════════════════════════════════════════════════════════
// Part 1 — demo dataset (pure)
// ═════════════════════════════════════════════════════════════════════════════
const COMBOS = [];
for (const t of bv.TRADES) for (const cc of ['US', 'IE']) COMBOS.push({ trade: t, locale: cc, prospect: 'default' });
COMBOS.push({ trade: 'plumbing', locale: 'US', prospect: 'ks-plumbing-example' });
COMBOS.push({ trade: 'plumbing-hvac', locale: 'IE', prospect: 'ie-heating-example' });

function build({ trade, locale, prospect, now = NOW, seed }) {
  const tz = locale === 'IE' ? 'Europe/Dublin' : 'America/Chicago';
  const brand = bv.buildBrand({ BRAND_TRADE_TYPE: trade, BRAND_TIMEZONE: tz, BRAND_COMPANY_NAME: 'Test Co' });
  return { brand, ds: buildDataset({ brand, prospect: loadProspect(prospect), locale: loadLocale(locale), now, seed }) };
}

const family = (a, b) => a === b || (a === 'plumbing-hvac' && ['plumbing', 'hvac'].includes(b)) || (b === 'plumbing-hvac' && ['plumbing', 'hvac'].includes(a));

for (const c of COMBOS) {
  test(`seed data ${c.trade} / ${c.locale} / ${c.prospect}: trade-correct, fictional, no client names`, () => {
    const { brand, ds } = build(c);
    const json = JSON.stringify(ds);

    // no client names (local denylist if present + synthetic), no garbage text
    const hits = guard.denylistHits(json, DENY);
    assert.deepEqual(hits, [], `denylisted strings in ${c.trade}/${c.locale}: ${hits}`);
    assert.doesNotMatch(json, /undefined|NaN|\[object Object\]/);
    assert.doesNotMatch(json, /@email\.com/i);

    // job types and trade
    assert.ok(ds.jobs.length >= 10);
    for (const j of ds.jobs) {
      assert.ok(brand.jobTypes.includes(j.type), `${j.title}: ${j.type} not a ${brand.tradeType} job type`);
      assert.equal(j.tradeType, brand.tradeType);
      assert.ok(j.amount > 0, `${j.title} amount ${j.amount}`);
      if (j.quote) assert.ok(j.quote.amount > 0);
      if (j.invoice) assert.ok(j.invoice.amount > 0);
    }

    // pricebook: this trade's items, stamped with this industry, priced > 0, unique
    assert.ok(ds.pricebook.length >= 15);
    for (const p of ds.pricebook) {
      assert.equal(p.industry, brand.industryLabel);
      assert.ok(p.price > 0, `${p.name} price ${p.price}`);
    }
    assert.equal(new Set(ds.pricebook.map((p) => p.name)).size, ds.pricebook.length, 'duplicate pricebook names');
    const loc = loadLocale(c.locale);
    for (const other of bv.TRADES.filter((t) => !family(t, brand.tradeType))) {
      const foreign = new Set(loadTrade(other, loc).pricebook.filter((p) => p.category !== 'Labor').map((p) => p.name));
      const leaked = ds.pricebook.filter((p) => p.category !== 'Labor' && foreign.has(p.name)).map((p) => p.name);
      assert.deepEqual(leaked, [], `${brand.tradeType} pricebook contains ${other} items`);
    }
    if (brand.tradeType === 'plumbing-hvac') {
      const types = new Set(ds.pricebook.map((p) => p.category));
      assert.ok(types.has('Plumbing Service') && types.has('HVAC Service'), 'plumbing-hvac gets both trades');
    }

    // fictional contacts
    const phoneRe = new RegExp(loc.phone.pattern);
    for (const person of [...ds.customers, ...ds.team]) {
      assert.ok(guard.isReservedEmailDomain(guard.emailDomain(person.email)), person.email);
      assert.match(person.phone, phoneRe, person.phone);
    }
    if (c.prospect === 'ie-heating-example') for (const cu of ds.customers) assert.match(cu.zip, /^[A-Z][0-9W]{2} [A-Z0-9]{4}$/, cu.zip);

    // relative dates around "today" in the brand time zone
    const today = ds.meta.today;
    assert.equal(ds.jobs.filter((j) => j.scheduledDate === today).length, 3);
    assert.ok(ds.jobs.filter((j) => j.scheduledDate > today).length >= 4);
    assert.ok(ds.jobs.filter((j) => j.status === 'completed').every((j) => j.scheduledDate < today));
    assert.ok(ds.jobs.some((j) => j.invoice && j.invoice.status === 'overdue' && new Date(j.invoice.dueDate) < NOW));
    assert.ok(ds.jobs.some((j) => j.invoice && j.invoice.status === 'paid' && new Date(j.invoice.paidAt) <= NOW));
    for (const j of ds.jobs) assert.ok(new Date(j.createdAt) <= NOW, `${j.title} created in the future`);
  });
}

test('seed data is deterministic for the same inputs and changes with --seed', () => {
  const a = build({ trade: 'electrical', locale: 'US', prospect: 'default' }).ds;
  const b = build({ trade: 'electrical', locale: 'US', prospect: 'default' }).ds;
  assert.deepEqual(a, b);
  const c = build({ trade: 'electrical', locale: 'US', prospect: 'default', seed: 'another' }).ds;
  assert.notDeepEqual(a.customers.map((x) => x.lastName), c.customers.map((x) => x.lastName));
});

test('WL-9: "today" is the brand time zone date, not the UTC date', () => {
  const late = new Date('2026-11-22T05:30:00Z'); // 23:30 Nov 21 in Chicago, 05:30 Nov 22 in Dublin
  const us = build({ trade: 'hvac', locale: 'US', prospect: 'default', now: late }).ds;
  const ie = build({ trade: 'hvac', locale: 'IE', prospect: 'default', now: late }).ds;
  assert.equal(us.meta.today, '2026-11-21');
  assert.equal(ie.meta.today, '2026-11-22');
  const j = us.jobs.find((x) => x.scheduledDate === '2026-11-21' && x.scheduledTime === '08:00');
  assert.equal(j.scheduledAt, '2026-11-21T14:00:00.000Z', '08:00 CST = 14:00 UTC');
});

test('prospects: reserved email domains only; prospect/instance trade mismatch is refused', () => {
  const p = loadProspect('ks-plumbing-example');
  assert.throws(() => validateProspect({ ...p, emailDomain: 'gmail.com' }, 'x'), /reserved domain/);
  assert.throws(() => validateProspect({ ...p, brand: { BRAND_TRADE_TYPE: 'roofing' } }, 'x'), /not a supported trade/);
  assert.throws(() => demo.assertProspectMatchesBrand(p, bv.buildBrand({ BRAND_TRADE_TYPE: 'hvac' })),
    (e) => e.name === 'TradeConflictError' && /--print-env/.test(e.message));
  demo.assertProspectMatchesBrand(p, bv.buildBrand({ BRAND_TRADE_TYPE: 'Plumbing' }));
  demo.assertProspectMatchesBrand(loadProspect('default'), bv.buildBrand({ BRAND_TRADE_TYPE: 'contracting' }));
});

test('guard: only demo-named databases are seeded', () => {
  const url = (db) => `postgresql://mbc:x@localhost:5432/${db}?schema=public`;
  for (const ok of ['mbc_sandbox', 'mbc_demo_acme', 'mbc_wl_hvac', 'mbc_redteam_test', 'demo']) {
    assert.equal(guard.assertDemoDatabase(url(ok), { allowDb: undefined, nodeEnv: 'development' }), ok);
  }
  for (const bad of ['mbc', 'mbc_prod', 'client_platform', 'mbc_demolition', 'testing_db']) {
    assert.throws(() => guard.assertDemoDatabase(url(bad), { allowDb: undefined, nodeEnv: 'development' }), /does not look like a demo database/, bad);
  }
  assert.equal(guard.assertDemoDatabase(url('mbc'), { allowDb: 'mbc', nodeEnv: 'development' }), 'mbc');
  assert.throws(() => guard.assertDemoDatabase(url('mbc_sandbox'), { allowDb: undefined, nodeEnv: 'production' }), /production/);
  assert.ok(guard.isReservedEmailDomain('demo.test') && guard.isReservedEmailDomain('acme.example') && guard.isReservedEmailDomain('example.com'));
  assert.ok(!guard.isReservedEmailDomain('example.ie') && !guard.isReservedEmailDomain('gmail.com') && !guard.isReservedEmailDomain('examples.com'));
});

test('--print-env renders a loadable env file with the prospect brand', () => {
  const text = demo.renderProspectEnv({
    prospect: loadProspect('ie-heating-example'), brandTrade: 'electrical', port: 3199,
    exampleFile: path.join(BACKEND, '.env.sandbox.example'),
  });
  const env = require('dotenv').parse(text);
  assert.equal(env.DEMO_PROSPECT, 'ie-heating-example');
  assert.equal(env.PORT, '3199');
  assert.match(env.DATABASE_URL, /\/mbc_demo_ie_heating_example\?/);
  const b = bv.buildBrand(env);
  assert.equal(b.companyName, 'Brightwater Heating & Plumbing Ltd');
  assert.equal(b.tradeType, 'plumbing-hvac');
  assert.equal(b.timezone, 'Europe/Dublin');
  assert.equal(b.colors.primary, '#0f766e');
  assert.equal(b.technicianLabel, 'Engineer');
  // default prospect: no trade of its own → keeps the instance trade
  const d = require('dotenv').parse(demo.renderProspectEnv({ prospect: loadProspect('default'), brandTrade: 'contracting', exampleFile: path.join(BACKEND, '.env.sandbox.example') }));
  assert.equal(d.BRAND_TRADE_TYPE, 'contracting');
});

test('denylist: real list stays out of git; example file has placeholders only', (t) => {
  const ex = guard.loadDenylist(path.join(BACKEND, 'demo', 'denylist.example.txt'));
  assert.ok(ex.found && ex.terms.length >= 3);
  const r = spawnSync('git', ['check-ignore', '-q', 'backend/demo/denylist.local.txt'], { cwd: path.join(BACKEND, '..') });
  assert.equal(r.status, 0, 'backend/demo/denylist.local.txt must be gitignored');
  assert.deepEqual(guard.denylistHits('Call Zzyzx test client today', SYNTHETIC_DENY), ['Zzyzx Test Client']);
  if (!LOCAL_DENY.found) t.diagnostic('denylist.local.txt not found — real client names not checked in this run');
});

// ═════════════════════════════════════════════════════════════════════════════
// Part 2 — database: seed:demo CLI, wrappers, trade switch, demo:check
// ═════════════════════════════════════════════════════════════════════════════
const DENY_FILE = path.join(TMP, 'denylist.txt');
fs.writeFileSync(DENY_FILE, DENY.join('\n') + '\n');

function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB,
    DEFAULT_PASSWORD: 'demo1234', ADMIN_EMAIL: 'admin@demo.test', ADMIN_PASSWORD: 'demo1234',
    JWT_SECRET: 'whitelabel_test_secret_0123456789abcdef0123456789', SANDBOX_MODE: 'true',
    MAIL_DRIVER: 'none', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: path.join(TMP, 'storage'),
    BRAND_TIMEZONE: 'America/Chicago', DEMO_DENYLIST_FILE: DENY_FILE, NODE_ENV: 'development', ...extra,
  };
}
function run(script, args = [], extra = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: BACKEND, env: baseEnv(extra), encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let dbOk = false;
let prisma;
test.before(async () => {
  try {
    const { Client } = require('pg');
    const u = new URL(TEST_DB);
    const db = decodeURIComponent(u.pathname.slice(1));
    guard.assertDemoDatabase(TEST_DB, { nodeEnv: 'development' });
    u.pathname = '/postgres'; u.search = '';
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [db]);
    if (!rowCount) await c.query(`CREATE DATABASE "${db.replace(/"/g, '""')}"`);
    await c.end();
    const m = run('scripts/migrate-deploy.mjs', ['--quiet']);
    if (m.code !== 0) throw new Error(m.out);
    process.env.DATABASE_URL = TEST_DB;
    process.env.ENV_FILE = '/dev/null';
    prisma = require('../helpers/prisma');
    // super-admin, as the sandbox creates it
    const s = run('seed_superadmin.js');
    if (s.code !== 0) throw new Error(s.out);
    dbOk = true;
  } catch (e) {
    console.error(`[whitelabel] database tests skipped: ${e.message.split('\n')[0]}`);
  }
});
test.after(async () => { if (prisma) await prisma.$disconnect(); });

const dbTest = (name, fn) => test(name, async (t) => { if (!dbOk) return t.skip('PostgreSQL not reachable'); await fn(t); });

dbTest('seed:demo --reset (electrical): per-trade pricebook, electrical jobs, quotes/invoices > 0', async () => {
  const r = run('scripts/seed-demo.js', ['--reset'], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /office@demo\.test \(admin\)/);
  const pb = await prisma.priceBookItem.findMany();
  const fixture = loadTrade('electrical', loadLocale('US')).pricebook;
  assert.equal(pb.length, fixture.length);
  assert.ok(pb.every((p) => p.industry === 'Electrical' && p.price > 0));
  assert.ok(pb.some((p) => /Panel Upgrade/.test(p.name)) && !pb.some((p) => /Water Heater|Furnace|Drain/.test(p.name)));
  const jobs = await prisma.job.findMany();
  assert.equal(jobs.length, 14);
  assert.ok(jobs.every((j) => bv.JOB_TYPES.electrical.includes(j.type) && j.tradeType === 'electrical'));
  assert.ok((await prisma.quote.findMany()).every((q) => q.amount > 0));
  assert.ok((await prisma.invoice.findMany()).every((i) => i.amount > 0));
  assert.ok(await prisma.user.findUnique({ where: { email: 'admin@demo.test' } }), 'reset keeps the super-admin');
});

dbTest('seed:demo and the seed_jobs / seed_pricebook wrappers are idempotent', async () => {
  const before = { pb: await prisma.priceBookItem.count(), jobs: await prisma.job.count(), cust: await prisma.customer.count(), users: await prisma.user.count() };
  assert.equal(run('scripts/seed-demo.js', [], { BRAND_TRADE_TYPE: 'electrical' }).code, 0);
  const w1 = run('seed_pricebook.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  const w2 = run('seed_jobs.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(w1.code, 0, w1.out);
  assert.equal(w2.code, 0, w2.out);
  assert.deepEqual({ pb: await prisma.priceBookItem.count(), jobs: await prisma.job.count(), cust: await prisma.customer.count(), users: await prisma.user.count() }, before);
});

dbTest('demo:check passes on freshly seeded data (DB checks)', async () => {
  const r = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS\s+db\.denylist/);
  assert.match(r.out, /→ READY/);
});

dbTest('demo:check FAILs (exit 1) on deliberately broken records', async () => {
  const job = await prisma.job.findFirst({ orderBy: { id: 'asc' } });
  const inv = await prisma.invoice.findFirst({ orderBy: { id: 'asc' } });
  const cust = await prisma.customer.findFirst({ orderBy: { id: 'asc' } });
  const saved = { type: job.type, amount: inv.amount, lastName: cust.lastName, city: cust.city };
  try {
    await prisma.job.update({ where: { id: job.id }, data: { type: 'Water Heater' } });          // plumbing type in an electrical demo
    await prisma.invoice.update({ where: { id: inv.id }, data: { amount: 0 } });                  // $0 invoice (GTM-1)
    await prisma.customer.update({ where: { id: cust.id }, data: { lastName: 'undefined', city: 'Zzyzx Test Client' } });
    const r = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL\s+db\.job-types .*Water Heater/);
    assert.match(r.out, /FAIL\s+db\.amounts .*invoice#/);
    assert.match(r.out, /FAIL\s+db\.garbage-text/);
    assert.match(r.out, /FAIL\s+db\.denylist .*Zzyzx Test Client/);
    assert.match(r.out, /NOT READY/);
  } finally {
    await prisma.job.update({ where: { id: job.id }, data: { type: saved.type } });
    await prisma.invoice.update({ where: { id: inv.id }, data: { amount: saved.amount } });
    await prisma.customer.update({ where: { id: cust.id }, data: { lastName: saved.lastName, city: saved.city } });
  }
});

dbTest('demo:check catches another trade\'s items stamped with this industry (WL-3)', async () => {
  const row = await prisma.priceBookItem.create({ data: { industry: 'Electrical', category: 'Plumbing Service', name: 'Water Heater Install – Tank', price: 1800 } });
  try {
    const r = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL\s+db\.pricebook-trade .*Water Heater Install/);
  } finally {
    await prisma.priceBookItem.delete({ where: { id: row.id } });
  }
});

dbTest('WL-4: switching trade on an existing DB is refused without --reset, safe with it', async () => {
  const refused = run('scripts/seed-demo.js', [], { BRAND_TRADE_TYPE: 'HVAC' });
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.out, /another trade \(14 electrical\).*--reset/s);
  const wrapper = run('seed_jobs.js', [], { BRAND_TRADE_TYPE: 'hvac' });
  assert.equal(wrapper.code, 0, 'boot sequences are not blocked');
  assert.match(wrapper.out, /WARNING — skipped/);
  assert.equal(await prisma.job.count({ where: { tradeType: 'hvac' } }), 0, 'nothing mixed in');

  const stale = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'hvac' });
  assert.equal(stale.code, 1);
  assert.match(stale.out, /FAIL\s+db\.job-trade/);

  const ok = run('scripts/seed-demo.js', ['--reset'], { BRAND_TRADE_TYPE: 'hvac' });
  assert.equal(ok.code, 0, ok.out);
  const trades = await prisma.job.groupBy({ by: ['tradeType'], _count: { _all: true } });
  assert.deepEqual(trades.map((t) => t.tradeType), ['hvac']);
  const industries = await prisma.priceBookItem.groupBy({ by: ['industry'], _count: { _all: true } });
  assert.deepEqual(industries.map((i) => i.industry), ['HVAC']);
  assert.equal(run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'hvac' }).code, 0);
});

dbTest('seed:demo with a prospect: Irish heating firm on a plumbing-hvac instance', async () => {
  const env = { BRAND_TRADE_TYPE: 'plumbing-hvac', BRAND_TIMEZONE: 'Europe/Dublin', BRAND_COMPANY_NAME: 'Brightwater Heating & Plumbing Ltd' };
  const r = run('scripts/seed-demo.js', ['--prospect', 'ie-heating-example', '--reset'], env);
  assert.equal(r.code, 0, r.out);
  const custs = await prisma.customer.findMany();
  assert.ok(custs.every((c) => c.state === 'Co. Kildare' && /^0(20|89) /.test(c.phone)));
  assert.ok((await prisma.priceBookItem.findMany()).some((p) => p.name === 'Annual Boiler Service'));
  const chk = run('scripts/demo-check.js', [], env);
  assert.equal(chk.code, 0, chk.out);
  const wrong = run('scripts/seed-demo.js', ['--prospect', 'ks-plumbing-example'], env);
  assert.equal(wrong.code, 2);
  assert.match(wrong.out, /plumbing business but this instance runs BRAND_TRADE_TYPE=plumbing-hvac/);
});

dbTest('guards: non-demo database and production are refused before connecting', async () => {
  const other = TEST_DB.replace(/\/[^/?]+\?/, '/mbc_customer_live?');
  const r1 = run('scripts/seed-demo.js', ['--reset'], { DATABASE_URL: other });
  assert.equal(r1.code, 2, r1.out);
  assert.match(r1.out, /does not look like a demo database/);
  const r2 = run('scripts/seed-demo.js', [], { NODE_ENV: 'production' });
  assert.equal(r2.code, 2);
  const r3 = run('seed_jobs.js', [], { DATABASE_URL: other });
  assert.equal(r3.code, 1);
  assert.match(r3.out, /REFUSED/);
  // no hard-coded fallback password for the demo team (checked before anything is deleted)
  const jobsBefore = await prisma.job.count();
  const r4 = run('scripts/seed-demo.js', ['--reset'], { DEFAULT_PASSWORD: '', BRAND_TRADE_TYPE: 'contracting' });
  assert.equal(r4.code, 1, r4.out);
  assert.match(r4.out, /DEFAULT_PASSWORD is not set/);
  assert.equal(await prisma.job.count(), jobsBefore, 'nothing was reset');
});

dbTest('demo:check API pass: /api/brand exposes colors.primaryDark; list endpoints have display fields', async () => {
  const env = baseEnv({ BRAND_TRADE_TYPE: 'contracting', PORT: '3135', DEMO_MODE: 'true' });
  assert.equal(run('scripts/seed-demo.js', ['--reset'], env).code, 0);
  const srv = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch('http://localhost:3135/api/health')).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const brand = await (await fetch('http://localhost:3135/api/brand')).json();
    assert.equal(brand.tradeType, 'contracting');
    assert.equal(brand.colors.primaryDark, bv.darken(bv.TRADE_PALETTES.contracting.primary));
    const r = run('scripts/demo-check.js', ['--port', '3135'], env);
    assert.equal(r.code, 0, r.out);
    for (const p of ['api.brand ', 'api.login', 'api.jobs', 'api.customers', 'api.quotes', 'api.invoices', 'api.pricebook', 'api.users']) {
      assert.match(r.out, new RegExp(`PASS\\s+${p.replace('.', '\\.')}`), p);
    }
  } finally {
    srv.kill();
  }
});
