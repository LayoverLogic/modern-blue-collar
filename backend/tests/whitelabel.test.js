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
 * Database isolation: the suite never writes to TEST_DATABASE_URL itself. It
 * derives its own database from it — same server, name + "_wl" (e.g.
 * mbc_backend_test → mbc_backend_test_wl; default base mbc_wl_test) — drops any
 * leftover of that name, creates + migrates it, seeds/wipes it freely, and
 * drops it at the end. So npm test, test:redteam, test:backend and
 * test:whitelabel can share one TEST_DATABASE_URL and run in any order. The
 * role in the URL needs CREATEDB. Set WL_KEEP_DB=1 to keep the derived
 * database for inspection. The API test boots the server on a free port.
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
const BASE_DB = process.env.TEST_DATABASE_URL || 'postgresql://mbc:mbc_sandbox@localhost:5432/mbc_wl_test?schema=public';

/** The suite's own database: BASE_DB's name + "_wl" (≤ 63 bytes), same server/credentials. */
function deriveDatabase(base, suffix = '_wl') {
  const u = new URL(base);
  const name = decodeURIComponent(u.pathname.slice(1)).slice(0, 63 - suffix.length) + suffix;
  u.pathname = '/' + encodeURIComponent(name);
  return { url: u.toString(), name };
}
const { url: TEST_DB, name: TEST_DB_NAME } = deriveDatabase(BASE_DB);
async function adminQuery(sql) {
  const { Client } = require('pg');
  const u = new URL(TEST_DB);
  u.pathname = '/postgres'; u.search = '';
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}
const quoteIdent = (s) => `"${s.replace(/"/g, '""')}"`;
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

    // activity trails (GTM-18): start with "created", chronological, never in
    // the future, actors on the team, and they end in the job's own state
    const teamEmails = new Set(ds.team.map((m) => m.email));
    const techEmails = new Set(ds.team.filter((m) => m.role === 'technician').map((m) => m.email));
    for (const j of ds.jobs) {
      const a = j.activity;
      assert.ok(a.length >= 1 && a[0].type === 'created', `${j.title}: trail starts with created`);
      for (let i = 0; i < a.length; i++) {
        assert.ok(teamEmails.has(a[i].actor), `${j.title}: actor ${a[i].actor}`);
        assert.ok(new Date(a[i].at) <= NOW && new Date(a[i].at) >= new Date(j.createdAt), `${j.title}: ${a[i].type} at ${a[i].at}`);
        if (i) assert.ok(a[i].at >= a[i - 1].at, `${j.title}: trail out of order`);
      }
      const statuses = a.filter((e) => e.type === 'status_changed');
      assert.equal(statuses.length ? statuses[statuses.length - 1].to : 'pending', j.status, `${j.title}: trail ends in ${j.status}`);
      const assigned = a.filter((e) => e.type === 'assigned');
      assert.equal(assigned.length ? assigned[assigned.length - 1].tech : null, j.techEmail, `${j.title}: trail assigns ${j.techEmail}`);
      for (const e of statuses.filter((x) => x.to !== 'scheduled')) assert.ok(techEmails.has(e.actor), `${j.title}: ${e.to} by a technician`);
      assert.equal(a.some((e) => e.type === 'quote_created'), !!j.quote);
      assert.equal(a.some((e) => e.type === 'invoice_created'), !!j.invoice);
      if (j.notes) assert.ok(a.some((e) => e.type === 'note'));
    }
    assert.ok(ds.jobs.some((j) => j.activity.some((e) => e.type === 'rescheduled')), 'some job was rescheduled');
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

// random per run (M1): a literal secret in a test file is a published secret
const WL_SECRET = require('crypto').randomBytes(32).toString('hex');
function baseEnv(extra = {}) {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB,
    DEFAULT_PASSWORD: 'demo1234', ADMIN_EMAIL: 'admin@demo.test', ADMIN_PASSWORD: 'demo1234',
    JWT_SECRET: WL_SECRET, SANDBOX_MODE: 'true',
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
    guard.assertDemoDatabase(TEST_DB, { nodeEnv: 'development' });
    // fresh private database every run (a leftover from a killed run is dropped)
    await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdent(TEST_DB_NAME)} WITH (FORCE)`);
    await adminQuery(`CREATE DATABASE ${quoteIdent(TEST_DB_NAME)}`);
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
test.after(async () => {
  if (prisma) await prisma.$disconnect();
  if (dbOk && process.env.WL_KEEP_DB !== '1') {
    await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdent(TEST_DB_NAME)} WITH (FORCE)`)
      .catch((e) => console.error(`[whitelabel] could not drop ${TEST_DB_NAME}: ${e.message}`));
  }
});

async function freePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

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
  const before = { pb: await prisma.priceBookItem.count(), jobs: await prisma.job.count(), cust: await prisma.customer.count(), users: await prisma.user.count(), act: await prisma.jobActivity.count() };
  assert.equal(run('scripts/seed-demo.js', [], { BRAND_TRADE_TYPE: 'electrical' }).code, 0);
  const w1 = run('seed_pricebook.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  const w2 = run('seed_jobs.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(w1.code, 0, w1.out);
  assert.equal(w2.code, 0, w2.out);
  assert.deepEqual({ pb: await prisma.priceBookItem.count(), jobs: await prisma.job.count(), cust: await prisma.customer.count(), users: await prisma.user.count(), act: await prisma.jobActivity.count() }, before);
});

dbTest('demo:check passes on freshly seeded data (DB checks)', async () => {
  const r = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS\s+db\.denylist/);
  assert.match(r.out, /PASS\s+db\.activity .*every one of 14 jobs/);
  assert.match(r.out, /→ READY/);
});

dbTest('seed:demo writes an activity trail per job that matches the job (GTM-18)', async () => {
  const jobs = (await prisma.job.findMany({ include: { quotes: true, invoices: true } })).map((j) => ({ ...j, quote: j.quotes[0] || null, invoice: j.invoices[0] || null }));
  const users = new Map((await prisma.user.findMany()).map((u) => [u.id, u]));
  for (const j of jobs) {
    const a = await prisma.jobActivity.findMany({ where: { jobId: j.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    assert.equal(a[0].type, 'created', `job#${j.id}`);
    assert.equal(a[0].jobRef, j.id);
    assert.equal(a[0].to.title, j.title);
    assert.ok(a.every((e) => e.createdAt <= new Date() && users.has(e.actorUserId)), `job#${j.id}: dates/actors`);
    const st = a.filter((e) => e.type === 'status_changed');
    assert.equal(st.length ? st[st.length - 1].to.status : a[0].to.status, j.status);
    const as = a.filter((e) => e.type === 'assigned');
    assert.equal(as.length ? as[as.length - 1].to.technicianId : null, j.technicianId);
    if (as.length) assert.equal(as[as.length - 1].to.technicianName, `${users.get(j.technicianId).firstName} ${users.get(j.technicianId).lastName}`);
    if (j.quote) assert.equal(a.find((e) => e.type === 'quote_created').to.quoteId, j.quote.id);
    if (j.invoice) assert.equal(a.find((e) => e.type === 'invoice_created').to.invoiceId, j.invoice.id);
    for (const e of st.filter((x) => x.to.status !== 'scheduled')) assert.equal(users.get(e.actorUserId).role, 'technician');
  }
});

dbTest('demo:check FAILs on missing or contradicting activity feeds; seed:demo backfills missing ones', async () => {
  const job = await prisma.job.findFirst({ where: { status: 'scheduled' }, orderBy: { id: 'asc' } });
  const extra = await prisma.jobActivity.create({ data: { jobId: job.id, jobRef: job.id, type: 'status_changed', from: { status: 'scheduled' }, to: { status: 'cancelled' } } });
  try {
    const r = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`FAIL\\s+db\\.activity .*job#${job.id} feed says "cancelled", job is "scheduled"`));
  } finally {
    await prisma.jobActivity.delete({ where: { id: extra.id } });
  }
  const total = await prisma.jobActivity.count();
  const removed = await prisma.jobActivity.deleteMany({ where: { jobId: job.id } });
  assert.ok(removed.count >= 3);
  const missing = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(missing.code, 1);
  assert.match(missing.out, new RegExp(`FAIL\\s+db\\.activity .*job#${job.id} has no activity`));
  const back = run('scripts/seed-demo.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(back.code, 0, back.out);
  assert.match(back.out, new RegExp(`backfilled ${removed.count} activity entries`));
  assert.equal(await prisma.jobActivity.count(), total);
  assert.equal(run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' }).code, 0);
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
  // as in the env file --print-env writes for this prospect (BRAND_COUNTRY / currency included)
  const env = { BRAND_TRADE_TYPE: 'plumbing-hvac', BRAND_TIMEZONE: 'Europe/Dublin', BRAND_COMPANY_NAME: 'Brightwater Heating & Plumbing Ltd', BRAND_COUNTRY: 'IE', BRAND_CURRENCY: 'EUR' };
  const r = run('scripts/seed-demo.js', ['--prospect', 'ie-heating-example', '--reset'], env);
  assert.equal(r.code, 0, r.out);
  const custs = await prisma.customer.findMany();
  assert.ok(custs.every((c) => c.state === 'Co. Kildare' && /^0(20|89) /.test(c.phone)));
  assert.ok((await prisma.priceBookItem.findMany()).some((p) => p.name === 'Annual Boiler Service'));
  // B3 item 10: stored job types are the Irish ones the brand offers
  const ieTypes = bv.buildBrand(env).jobTypes;
  const jobs = await prisma.job.findMany();
  assert.ok(jobs.every((j) => ieTypes.includes(j.type)), jobs.map((j) => j.type).join(', '));
  assert.ok(!jobs.some((j) => /Furnace|AC (Install|Repair)|Tune-Up|Water Heater/.test(j.type)));
  const chk = run('scripts/demo-check.js', [], env);
  assert.equal(chk.code, 0, chk.out);
  assert.match(chk.out, /PASS\s+db\.wording .*IE wording/);
  assert.match(chk.out, /PASS\s+db\.currency .*EUR/);
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
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const env = baseEnv({ BRAND_TRADE_TYPE: 'contracting', PORT: String(port), DEMO_MODE: 'true' });
  assert.equal(run('scripts/seed-demo.js', ['--reset'], env).code, 0);
  const srv = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const brand = await (await fetch(`${base}/api/brand`)).json();
    assert.equal(brand.tradeType, 'contracting');
    assert.equal(brand.colors.primaryDark, bv.darken(bv.TRADE_PALETTES.contracting.primary));
    const r = run('scripts/demo-check.js', ['--port', String(port)], env);
    assert.equal(r.code, 0, r.out);
    for (const p of ['api.brand ', 'api.login', 'api.jobs', 'api.customers', 'api.quotes', 'api.invoices', 'api.pricebook', 'api.users', 'api.activity']) {
      assert.match(r.out, new RegExp(`PASS\\s+${p.replace('.', '\\.')}`), p);
    }
  } finally {
    srv.kill();
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// B3 items 10–12, 14, 16: country job types, demo wording, enough templates,
// canonical due dates, consistent totals, new demo:check checks
// ═════════════════════════════════════════════════════════════════════════════
const { wordingProblems } = require('../demo/lib/wording');
const demoChecks = require('../demo/lib/checks');

test('B3 job types: BRAND_COUNTRY=IE gives Irish wording per trade; US stays as before', () => {
  for (const t of bv.TRADES) {
    assert.deepEqual(bv.buildBrand({ BRAND_TRADE_TYPE: t }).jobTypes, bv.JOB_TYPES[t]);
    assert.deepEqual(bv.buildBrand({ BRAND_TRADE_TYPE: t, BRAND_COUNTRY: 'US' }).jobTypes, bv.JOB_TYPES[t]);
    const ie = bv.buildBrand({ BRAND_TRADE_TYPE: t, BRAND_COUNTRY: 'ie' }).jobTypes;
    assert.deepEqual(ie, bv.JOB_TYPES_IE[t]);
    assert.ok(ie.includes('Other'));
    for (const typ of ie) assert.deepEqual(wordingProblems(typ, 'IE'), [], `${t}: ${typ}`);
  }
  const el = bv.buildBrand({ BRAND_TRADE_TYPE: 'electrical', BRAND_COUNTRY: 'IE' }).jobTypes;
  for (const want of ['Consumer Unit Upgrade', 'Socket / Light Install', 'Rewire', 'Fault Finding']) assert.ok(el.includes(want), want);
  const heat = bv.buildBrand({ BRAND_TRADE_TYPE: 'hvac', BRAND_COUNTRY: 'IE' }).jobTypes;
  for (const want of ['Boiler Service', 'Boiler Repair', 'Heat Pump Install']) assert.ok(heat.includes(want), want);
  assert.ok(!heat.some((x) => /Furnace|AC /.test(x)));
});

test('B3 job types: BRAND_JOB_TYPES overrides the list and is validated (boot refuses a bad list)', () => {
  assert.deepEqual(bv.buildBrand({ BRAND_JOB_TYPES: ' Boiler Service , Leak Repair,Other ' }).jobTypes, ['Boiler Service', 'Leak Repair', 'Other']);
  assert.deepEqual(bv.buildBrand({ BRAND_JOB_TYPES: '' }).jobTypes, bv.JOB_TYPES.electrical, 'blank = default list');
  for (const [bad, re] of [['A,a', /twice/], [',,', /no job types/], ['Ok,<b>x</b>', /not allowed/], [Array.from({ length: 41 }, (_, i) => `T${i}`).join(','), /at most 40/], ['x'.repeat(61), /longer than 60/]]) {
    assert.throws(() => bv.buildBrand({ BRAND_JOB_TYPES: bad }), re, bad);
  }
  const r = spawnSync(process.execPath, ['server.js'], {
    cwd: BACKEND, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', BRAND_JOB_TYPES: 'Boiler,boiler', JWT_SECRET: 'x'.repeat(40), DATABASE_URL: TEST_DB, PORT: '0' },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /\[brand\] BRAND_JOB_TYPES=.*twice/);
});

test('B3 job types: resolveJobType maps US ↔ Irish wording onto a brand list', () => {
  const ie = bv.JOB_TYPES_IE;
  assert.equal(bv.resolveJobType('Furnace Repair', ie.hvac, { tradeType: 'hvac', country: 'IE' }), 'Boiler Repair');
  assert.equal(bv.resolveJobType('Panel Upgrade', ie.electrical, { tradeType: 'electrical', country: 'IE' }), 'Consumer Unit Upgrade');
  assert.equal(bv.resolveJobType('Inspection', ie.electrical, { tradeType: 'electrical', country: 'IE' }), 'Inspection & Cert');
  assert.equal(bv.resolveJobType('Boiler Repair', bv.JOB_TYPES.hvac, { tradeType: 'hvac', country: 'US' }), 'Furnace Repair');
  assert.equal(bv.resolveJobType('Rewire', bv.JOB_TYPES.electrical, { tradeType: 'electrical', country: 'US' }), 'Other');
  assert.equal(bv.resolveJobType('Leak Repair', ['Boiler Service', 'Callout'], {}), 'Boiler Service', 'no Other → first');
});

test('B3 fixtures: every trade × country fills 30 jobs with distinct titles, brand job types and country wording', () => {
  for (const cc of ['US', 'IE']) {
    for (const t of bv.TRADES) {
      const brand = bv.buildBrand({ BRAND_TRADE_TYPE: t, BRAND_COUNTRY: cc, BRAND_TIMEZONE: cc === 'IE' ? 'Europe/Dublin' : 'America/Chicago' });
      const prospect = { ...loadProspect(cc === 'IE' ? 'ie-heating-example' : 'default'), counts: { jobs: 30, customers: 12 } };
      const ds = buildDataset({ brand, prospect, locale: loadLocale(cc), now: NOW });
      const tag = `${cc}/${t}`;
      assert.equal(ds.jobs.length, 30, tag);
      assert.equal(new Set(ds.jobs.map((j) => j.title)).size, 30, `${tag}: titles repeat`);
      for (const j of ds.jobs) {
        assert.ok(brand.jobTypes.includes(j.type), `${tag}: ${j.title} type ${j.type}`);
        assert.deepEqual([...wordingProblems(j.title, cc), ...wordingProblems(j.notes, cc)], [], `${tag}: ${j.title}`);
        if (j.invoice) assert.match(j.invoice.dueDate, /T00:00:00\.000Z$/, `${tag}: due date ${j.invoice.dueDate} is not a calendar date`);
      }
      const created = ds.jobs.map((j) => j.createdAt);
      assert.equal(new Set(created).size, created.length, `${tag}: jobs share a createdAt (Recent Jobs order is ambiguous)`);
      const trade = loadTrade(t, loadLocale(cc));
      assert.ok(trade.jobs.length >= 30, `${tag}: only ${trade.jobs.length} templates`);
    }
  }
  // with a custom list, stored types still come from it
  const brand = bv.buildBrand({ BRAND_TRADE_TYPE: 'plumbing', BRAND_JOB_TYPES: 'Leak Repair,Callout,Other' });
  const ds = buildDataset({ brand, prospect: loadProspect('default'), locale: loadLocale('US'), now: NOW });
  assert.ok(ds.jobs.every((j) => ['Leak Repair', 'Callout', 'Other'].includes(j.type)));
});

function fakePrisma(rows) {
  const t = (k) => ({ findMany: async () => rows[k] || [] });
  return {
    user: t('user'), customer: t('customer'), job: t('job'), quote: t('quote'), invoice: t('invoice'),
    priceBookItem: t('pricebook'), inventoryItem: t('inventory'), communication: t('comms'), jobActivity: t('acts'),
  };
}

test('B3 demo:check DB: totals, currency, wording, due dates (unit, fake rows)', async () => {
  const brand = bv.buildBrand({ BRAND_TRADE_TYPE: 'electrical', BRAND_COUNTRY: 'IE' });
  brand.locale = require('../helpers/locale').buildLocale({ BRAND_COUNTRY: 'IE' }, brand);
  const job = { id: 1, title: 'Half the Living Room Outlets Dead', notes: 'Smart dimmers on the main floor', type: 'Fault Finding', status: 'pending', tradeType: 'electrical', createdAt: NOW, scheduledDate: '2099-01-01' };
  const rows = {
    job: [job],
    quote: [{ id: 1, jobId: 1, amount: 120, subtotal: 0, taxTotal: 0, currency: 'EUR', lines: [] }],
    invoice: [
      { id: 1, jobId: 1, amount: 123, subtotal: 100, taxTotal: 23, currency: 'USD', status: 'unpaid', dueDate: new Date('2026-12-05T17:00:00Z'), lines: [{ lineTotal: 90 }] },
    ],
  };
  const res = await demoChecks.runDbChecks({ prisma: fakePrisma(rows), brand, now: NOW });
  const by = (id) => res.find((r) => r.id === id) || {};
  assert.equal(by('db.totals').level, 'FAIL');
  assert.match(by('db.totals').msg, /quote#1 total 120 ≠ subtotal 0/);
  assert.match(by('db.totals').msg, /invoice#1 subtotal 100 ≠ lines 90\.00/);
  assert.equal(by('db.currency').level, 'FAIL');
  assert.match(by('db.currency').msg, /invoice#1 USD/);
  assert.equal(by('db.wording').level, 'FAIL');
  assert.match(by('db.wording').msg, /outlet.*US wording/);
  assert.equal(by('db.due-dates').level, 'WARN');
  // the same rows, fixed, pass
  const ok = {
    job: [{ ...job, title: 'Half the Living Room Sockets Dead', notes: 'Smart dimmers on the ground floor' }],
    quote: [{ ...rows.quote[0], subtotal: 120 }],
    invoice: [{ ...rows.invoice[0], currency: 'EUR', dueDate: new Date('2026-12-05T00:00:00Z'), lines: [{ lineTotal: 60 }, { lineTotal: 40 }] }],
  };
  const res2 = await demoChecks.runDbChecks({ prisma: fakePrisma(ok), brand, now: NOW });
  for (const id of ['db.totals', 'db.currency', 'db.wording']) assert.equal(res2.find((r) => r.id === id).level, 'PASS', id);
  assert.ok(!res2.some((r) => r.id === 'db.due-dates'));
});

test('B3 demo:check helpers: currency symbols and Recent Jobs order', () => {
  assert.equal(demoChecks.currencySymbol('EUR', 'en-IE'), '€');
  assert.equal(demoChecks.currencySymbol('USD', 'en-US'), '$');
  const text = 'Dashboard\nRecent Jobs\nNew boiler\nOld leak\nOlder drain';
  assert.deepEqual(demoChecks.orderProblems(text, 'Recent Jobs', [
    { title: 'New boiler', createdAt: '2026-11-20' }, { title: 'Old leak', createdAt: '2026-11-19' }, { title: 'Older drain', createdAt: '2026-11-18' },
  ]), []);
  assert.equal(demoChecks.orderProblems(text, 'Recent Jobs', [
    { title: 'New boiler', createdAt: '2026-11-18' }, { title: 'Old leak', createdAt: '2026-11-19' },
  ]).length, 1);
  assert.deepEqual(demoChecks.orderProblems('x', 'Recent Jobs', []), ['no "Recent Jobs" section']);
});

dbTest('B3 seed:demo: amount-only documents have subtotal = amount, due dates are calendar dates; demo:check totals pass', async () => {
  const r = run('scripts/seed-demo.js', ['--reset'], { BRAND_TRADE_TYPE: 'electrical' });
  assert.equal(r.code, 0, r.out);
  const docs = [...await prisma.quote.findMany({ include: { lines: true } }), ...await prisma.invoice.findMany({ include: { lines: true } })];
  assert.ok(docs.length);
  for (const d of docs) {
    assert.equal(Number(d.subtotal), Number(d.amount), `#${d.id} subtotal ${d.subtotal} amount ${d.amount}`);
    assert.equal(Number(d.taxTotal), 0);
  }
  for (const i of await prisma.invoice.findMany()) assert.equal(i.dueDate.toISOString().slice(10), 'T00:00:00.000Z');
  const chk = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
  assert.match(chk.out, /PASS\s+db\.totals/);
  assert.match(chk.out, /PASS\s+db\.currency .*USD/);
  assert.match(chk.out, /PASS\s+db\.wording .*US wording/);
  // a broken total is caught
  const q = await prisma.quote.findFirst();
  await prisma.quote.update({ where: { id: q.id }, data: { subtotal: 0 } });
  try {
    const bad = run('scripts/demo-check.js', [], { BRAND_TRADE_TYPE: 'electrical' });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /FAIL\s+db\.totals .*quote#/);
  } finally { await prisma.quote.update({ where: { id: q.id }, data: { subtotal: q.subtotal } }); }
});
