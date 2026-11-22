/**
 * tests/documents.test.js — Phase 2b: line-item quotes / invoices, Decimal
 * money, document numbers, locale (US / IE) and the small fixes that ship with it.
 *
 * Setup / run:
 *   1. PostgreSQL reachable (role mbc / mbc_sandbox, CREATEDB).
 *   2. cd backend && npm install
 *   3. TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_documents_test?schema=public \
 *        npm run test:documents
 *      (the database name must contain "test"; it is created + migrated if missing)
 *
 * Covers: totals and half-up rounding incl. 13.5 % and 23 % VAT, reverse
 * charge, number sequence under concurrency (no duplicates, no gaps after a
 * failed create), immutability of sent / paid documents, role checks, IE and US
 * address validation, document email reaching the sandbox outbox (+ logged
 * communication), from-quote copy, amount-only legacy requests, the migration
 * on a database seeded at the previous migration (real WASM engine), Prisma
 * round-trip of every new field, /api/brand locale block, favicon, HTML
 * no-store, CSV filename*, pricebook WL-4, SMS text WL-8, per-user rate limit.
 *
 * Never reads .env; boots `node server.js` children in SANDBOX_MODE; creates
 * run-tagged synthetic rows and deletes them afterwards. Scratch databases are
 * named <test db>_mig_<run> and dropped at the end.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const http   = require('http');
const net    = require('net');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const BACKEND = path.join(__dirname, '..');
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error('[documents-test] TEST_DATABASE_URL is required (a throwaway database whose name contains "test").');
  process.exit(1);
}
if (!/test/i.test(new URL(TEST_DB).pathname)) {
  console.error('[documents-test] refusing: the TEST_DATABASE_URL database name must contain "test".');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
process.env.ENV_FILE = '/dev/null';
const SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = 'test';

const RUN      = `dt${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const PASSWORD = 'Documents!2345';
const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-documents-test-'));
const OUTBOX   = path.join(TMP, 'outbox');
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

let prisma;
const U = {};
const servers = [];
let US; let IE; // servers

let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `127.2.${1 + Math.floor(ipSeq / 250) % 250}.${1 + (ipSeq % 250)}`; };

function request(base, method, p, { token, body, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const h = { ...headers };
    let data;
    if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    if (token) h.Authorization = `Bearer ${token}`;
    const rq = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: h, localAddress: ip || nextIp() }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function bootServer(extraEnv = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB,
    PORT: String(port), APP_URL: `http://localhost:${port}`, NODE_ENV: 'test', JWT_SECRET: SECRET,
    SANDBOX_MODE: 'true', DEMO_MODE: 'false', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: path.join(TMP, 'storage'),
    MAIL_DRIVER: 'outbox', MAIL_OUTBOX_DIR: OUTBOX, SMTP_FROM: 'office@documents.test',
    BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(TMP, 'backups'), BRAND_TRADE_TYPE: 'plumbing-hvac',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const s = {
    base, output: () => out,
    alive: () => child.exitCode == null && child.signalCode == null,
    api: (method, p, opts) => request(base, method, p, opts),
    stop: async () => {
      if (child.exitCode == null && child.signalCode == null) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([gone, sleep(3000)]);
        if (child.exitCode == null) child.kill('SIGKILL');
      }
    },
  };
  servers.push(s);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!s.alive()) return s;
    try { if ((await request(base, 'GET', '/api/health')).status === 200) return s; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`server did not start:\n${out}`);
}

function pgAdminUrl(dbUrl) {
  const url = new URL(dbUrl);
  url.pathname = '/postgres'; url.search = '';
  return url.toString();
}
async function pgQuery(dbUrl, sql, params) {
  const { Client } = require('pg');
  const url = new URL(dbUrl); url.search = '';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

function runMigrate(dbUrl, scriptPath = path.join(BACKEND, 'scripts', 'migrate-deploy.mjs')) {
  return spawnSync(process.execPath, [scriptPath, '--quiet'], {
    cwd: BACKEND, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: dbUrl, ENV_FILE: '/dev/null' }, encoding: 'utf8',
  });
}

async function ensureDatabase(dbUrl) {
  const db = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ''));
  const { rowCount } = await pgQuery(pgAdminUrl(dbUrl), 'SELECT 1 FROM pg_database WHERE datname = $1', [db]);
  if (!rowCount) await pgQuery(pgAdminUrl(dbUrl), `CREATE DATABASE "${db.replace(/"/g, '""')}"`);
  const r = runMigrate(dbUrl);
  if (r.status !== 0) throw new Error(`migrate-deploy failed:\n${r.stdout}\n${r.stderr}`);
}

async function mkUser(role, tag = role) {
  const bcrypt = require('bcryptjs');
  return prisma.user.create({
    data: { email: `${RUN}-${tag}@documents.test`, password: await bcrypt.hash(PASSWORD, 4), firstName: 'DT', lastName: tag, role, active: true },
  });
}
async function login(srv, email) {
  const r = await srv.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
const mkCustomer = (over = {}) => prisma.customer.create({
  data: { firstName: 'Aoife', lastName: `Byrne-${RUN}`, phone: '020 910 0142', email: `aoife-${RUN}@example.com`, address: '2 Synthetic Rd', city: 'Naas', state: 'Co. Kildare', zip: 'W91 X2Y4', ...over },
});
const mkJob = (customerId, over = {}) => prisma.job.create({ data: { title: `DT job ${RUN}`, customerId, ...over } });
async function freshJob(over = {}) { const c = await mkCustomer(); return mkJob(c.id, over); }

function outboxMessages() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')));
}
const seq = (number) => Number(/(\d+)$/.exec(number)[1]);

async function cleanup() {
  if (!prisma) return;
  const safe = (p) => p.catch(() => {});
  const users = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map((u) => u.id);
  const custs = (await prisma.customer.findMany({ where: { lastName: { contains: RUN } }, select: { id: true } })).map((c) => c.id);
  const jobs = (await prisma.job.findMany({ where: { OR: [{ customerId: { in: custs } }, { title: { contains: RUN } }] }, select: { id: true } })).map((j) => j.id);
  await safe(prisma.jobActivity.deleteMany({ where: { OR: [{ jobRef: { in: jobs } }, { actorUserId: { in: users } }] } }));
  await safe(prisma.invoice.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.quote.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobs } } }));
  await safe(prisma.communication.deleteMany({ where: { customerId: { in: custs } } }));
  await safe(prisma.customer.deleteMany({ where: { id: { in: custs } } }));
  await safe(prisma.priceBookItem.deleteMany({ where: { name: { contains: RUN } } }));
  await safe(prisma.user.deleteMany({ where: { id: { in: users } } }));
}

before(async () => {
  await ensureDatabase(TEST_DB);
  prisma = require('../helpers/prisma');
  [US, IE] = await Promise.all([
    bootServer({}),
    bootServer({
      BRAND_COUNTRY: 'IE', BRAND_TIMEZONE: 'Europe/Dublin', BRAND_TAX_NUMBER: 'IE1234567T',
      BRAND_COMPANY_NAME: 'Brightwater Heating Ltd', BRAND_QUOTE_PREFIX: 'BQ-', BRAND_INVOICE_PREFIX: 'BI-',
    }),
  ]);
  assert.ok(US.alive(), US.output());
  assert.ok(IE.alive(), IE.output());
  for (const [k, role] of [['admin', 'admin'], ['dispatcher', 'dispatcher'], ['tech', 'technician'], ['tech2', 'technician']]) {
    const u = await mkUser(role, k);
    U[k] = { id: u.id, email: u.email, token: await login(US, u.email) };
  }
});

after(async () => {
  try { await cleanup(); } finally {
    for (const s of servers) await s.stop();
    if (prisma) await prisma.$disconnect().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ── Totals & rounding (pure) ────────────────────────────────────────────────
test('totals: per-line half-up rounding to cents, Decimal (not float) arithmetic', () => {
  const { computeTotals } = require('../helpers/documents');
  const t = computeTotals([
    { position: 1, description: 'a', quantity: '1.5', unitPrice: '85.55', taxRate: 0 },  // 128.325 → 128.33
    { position: 2, description: 'b', quantity: '0.5', unitPrice: '2.01', taxRate: 0 },   // 1.005 (float: 1.00499…) → 1.01
    { position: 3, description: 'c', quantity: '0.5', unitPrice: '0.25', taxRate: 0 },   // 0.125 → 0.13 (half-even would be 0.12)
    { position: 4, description: 'd', quantity: '3', unitPrice: '-10.00', taxRate: 0 },   // discount line −30.00
  ]);
  assert.deepEqual(t.lines.map((l) => l.lineTotal.toFixed(2)), ['128.33', '1.01', '0.13', '-30.00']);
  assert.equal(t.subtotal.toFixed(2), '99.47');
  assert.equal(t.taxTotal.toFixed(2), '0.00');
  assert.equal(t.total.toFixed(2), '99.47');
});

test('totals: 13.5 % and 23 % VAT per rate, half-up; reverse charge → no tax', () => {
  const { computeTotals } = require('../helpers/documents');
  const lines = [
    { position: 1, description: 'Boiler service', quantity: '1', unitPrice: '100.10', taxRateKey: 'reduced', taxRate: '13.5' }, // 13.5135
    { position: 2, description: 'Call-out', quantity: '1', unitPrice: '0.10', taxRateKey: 'reduced', taxRate: '13.5' },         // group net 100.20 → 13.527 → 13.53
    { position: 3, description: 'Valve', quantity: '1', unitPrice: '19.99', taxRateKey: 'standard', taxRate: '23' },            // 4.5977 → 4.60
    { position: 4, description: 'Washer', quantity: '1', unitPrice: '0.65', taxRateKey: 'standard', taxRate: '23' },            // group net 20.64 → 4.7472 → 4.75
  ];
  const t = computeTotals(lines);
  const byKey = Object.fromEntries(t.breakdown.map((g) => [g.taxRateKey, g]));
  assert.equal(byKey.reduced.net.toFixed(2), '100.20');
  assert.equal(byKey.reduced.tax.toFixed(2), '13.53');
  assert.equal(byKey.standard.net.toFixed(2), '20.64');
  assert.equal(byKey.standard.tax.toFixed(2), '4.75');
  assert.equal(t.subtotal.toFixed(2), '120.84');
  assert.equal(t.taxTotal.toFixed(2), '18.28');
  assert.equal(t.total.toFixed(2), '139.12');
  // exact half cent at 13.5 %: 1.00 × 13.5 % = 0.135 → 0.14
  assert.equal(computeTotals([{ position: 1, description: 'x', quantity: 1, unitPrice: '1.00', taxRateKey: 'reduced', taxRate: 13.5 }]).taxTotal.toFixed(2), '0.14');
  const rc = computeTotals(lines, { reverseCharge: true });
  assert.equal(rc.taxTotal.toFixed(2), '0.00');
  assert.equal(rc.total.toFixed(2), '120.84');
});

test('locale: defaults reproduce US behaviour; IE rates; bad config fails fast', () => {
  const { buildLocale } = require('../helpers/locale');
  const us = buildLocale({});
  assert.equal(us.currency, 'USD');
  assert.equal(us.taxEnabled, false);
  assert.deepEqual(us.taxRates, []);
  assert.equal(us.defaultState, 'KS');
  assert.deepEqual(us.requiredAddressFields, []);
  const ie = buildLocale({ BRAND_COUNTRY: 'ie', BRAND_TAX_DEFAULT: 'reduced' });
  assert.equal(ie.currency, 'EUR');
  assert.equal(ie.taxLabel, 'VAT');
  assert.deepEqual(ie.taxRates, [{ key: 'standard', rate: 23 }, { key: 'reduced', rate: 13.5 }, { key: 'zero', rate: 0 }]);
  assert.equal(ie.taxDefault, 'reduced');
  assert.equal(ie.defaultState, null);
  assert.ok(ie.reverseChargeNoteIsPlaceholder);
  assert.match(ie.reverseChargeNote, /to be confirmed by an accountant/);
  assert.equal(buildLocale({ BRAND_TAX_RATES: 'standard:20' }).taxDefault, 'standard');
  for (const env of [{ BRAND_COUNTRY: 'XX' }, { BRAND_CURRENCY: 'EURO' }, { BRAND_TAX_RATES: 'standard=23' }, { BRAND_TAX_RATES: 'a:1,a:2' },
    { BRAND_TAX_DEFAULT: 'nope' }, { BRAND_INVOICE_PREFIX: 'has space' }]) {
    assert.throws(() => buildLocale(env), (e) => e.name === 'BrandConfigError', JSON.stringify(env));
  }
  const bad = spawnSync(process.execPath, ['-e', "require('./brand.config')"], { cwd: path.join(BACKEND, '..'), env: { PATH: process.env.PATH, BRAND_TAX_RATES: 'oops' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /BRAND_TAX_RATES/);
});

// ── API: lines, totals, snapshot, print view ────────────────────────────────
test('IE quote with lines: server computes totals (client totals ignored), snapshots rate + currency', async () => {
  const job = await freshJob();
  const r = await IE.api('POST', '/api/quotes', {
    token: U.admin.token,
    body: {
      jobId: job.id, amount: 1, subtotal: 1, taxTotal: 1,
      lines: [
        { description: 'Boiler service', quantity: 1, unitPrice: 100.10, taxRateKey: 'reduced', lineTotal: 5 },
        { description: 'Valve', quantity: '2', unitPrice: '9.99' }, // default key = standard (first configured)
      ],
    },
  });
  assert.equal(r.status, 201, r.text);
  const q = r.json;
  assert.match(q.number, /^BQ-\d{4,}$/);
  assert.equal(q.currency, 'EUR');
  assert.equal(q.lines.length, 2);
  assert.equal(q.lines[0].lineTotal, 100.1);
  assert.equal(q.lines[0].taxRate, 13.5);
  assert.equal(q.lines[1].taxRateKey, 'standard');
  assert.equal(q.lines[1].taxRate, 23);
  assert.equal(q.subtotal, 120.08);
  assert.equal(q.taxTotal, 18.11); // 13.51 + 4.60 (19.98 × 23 % = 4.5954)
  assert.equal(q.amount, 138.19);
  for (const k of ['amount', 'subtotal', 'taxTotal']) assert.equal(typeof q[k], 'number');

  const g = await IE.api('GET', `/api/quotes/${q.id}`, { token: U.admin.token });
  assert.equal(g.status, 200);
  assert.equal(g.json.customer.id, job.customerId);
  assert.equal(g.json.locked, false);
  const p = g.json.print;
  assert.equal(p.number, q.number);
  assert.equal(p.seller.companyName, 'Brightwater Heating Ltd');
  assert.equal(p.seller.taxNumber, 'IE1234567T');
  assert.equal(p.taxLabel, 'VAT');
  assert.deepEqual(p.customer.addressLines, ['2 Synthetic Rd', 'Naas', 'Co. Kildare', 'W91 X2Y4']);
  assert.deepEqual(p.taxBreakdown.map((b) => [b.taxRateKey, b.net, b.tax]), [['reduced', 100.1, 13.51], ['standard', 19.98, 4.6]]);
  assert.match(p.formatted.total, /€138\.19/);

  // a rate change in config later does not touch the stored snapshot
  const row = await prisma.quoteLine.findFirst({ where: { quoteId: q.id, position: 1 } });
  assert.equal(row.taxRate, 13.5);
});

test('lines: validation errors are 400s with field names; pricebook item supplies defaults', async () => {
  const job = await freshJob();
  const bad = async (lines, code, field) => {
    const r = await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines } });
    assert.equal(r.status, 400, `${JSON.stringify(lines)} → ${r.status} ${r.text}`);
    assert.equal(r.json.code, code);
    if (field) assert.equal(r.json.field, field);
  };
  await bad([{ description: 'x', quantity: 1, unitPrice: 1, taxRateKey: 'luxury' }], 'INVALID_ENUM', 'lines[0].taxRateKey');
  await bad([{ description: 'x', quantity: 0, unitPrice: 1 }], 'INVALID_AMOUNT', 'lines[0].quantity');
  await bad([{ description: 'x', quantity: 1, unitPrice: '1.005' }], 'INVALID_AMOUNT', 'lines[0].unitPrice');
  await bad([{ description: 'x', quantity: 1, unitPrice: 'NaN' }], 'INVALID_AMOUNT', 'lines[0].unitPrice');
  await bad([{ quantity: 1, unitPrice: 1 }], 'REQUIRED', 'lines[0].description');
  await bad([{ description: 'x', quantity: 1, unitPrice: 1, pricebookItemId: 999999999 }], 'UNKNOWN_PRICEBOOK_ITEM');
  await bad([{ description: 'x', quantity: 1, unitPrice: -5 }], 'INVALID_AMOUNT', 'amount'); // negative total
  await bad('nope', 'INVALID_INPUT', 'lines');

  const item = await prisma.priceBookItem.create({ data: { category: 'Service', name: `Annual service ${RUN}`, price: 149.5, taxRateKey: 'reduced' } });
  const r = await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [{ pricebookItemId: item.id, quantity: 2 }] } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.lines[0].description, r.json.lines[0].unitPrice, r.json.lines[0].taxRateKey, r.json.lines[0].pricebookItemId],
    [`Annual service ${RUN}`, 149.5, 'reduced', item.id]);
  assert.equal(r.json.amount, 339.37); // 299.00 + 13.5 % (40.365 → 40.37)
});

test('legacy: amount-only quote / invoice requests still work (subtotal = amount, tax 0, numbered)', async () => {
  const job = await freshJob();
  const q = await US.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, amount: 2500.5 } });
  assert.equal(q.status, 201, q.text);
  assert.equal(q.json.amount, 2500.5);
  assert.equal(q.json.subtotal, 2500.5);
  assert.equal(q.json.taxTotal, 0);
  assert.equal(q.json.currency, 'USD');
  assert.match(q.json.number, /^Q-\d{4,}$/);
  assert.deepEqual(q.json.lines, []);
  const p = await US.api('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { amount: '2800', version: q.json.version } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.amount, 2800);
  assert.equal(p.json.subtotal, 2800);

  const i0 = await US.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 0 } });
  assert.equal(i0.status, 400);
  assert.equal(i0.json.code, 'INVALID_AMOUNT');
  const i = await US.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 99.99, dueDate: '2026-12-31' } });
  assert.equal(i.status, 201, i.text);
  assert.equal(i.json.amount, 99.99);
  assert.match(i.json.number, /^INV-\d{4,}$/);
  // US has no tax rates: a tax key is refused
  const t = await US.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: (await freshJob()).id, lines: [{ description: 'x', quantity: 1, unitPrice: 1, taxRateKey: 'standard' }] } });
  assert.equal(t.status, 400);
  assert.equal(t.json.code, 'INVALID_ENUM');
  // the list endpoint keeps returning money as numbers
  const list = await US.api('GET', '/api/invoices', { token: U.admin.token });
  const mine = list.json.find((x) => x.id === i.json.id);
  assert.equal(typeof mine.amount, 'number');
});

test('PATCH: lines replace lines and recompute; amount alone on a lined document is refused unless unchanged', async () => {
  const job = await freshJob();
  const q = (await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [{ description: 'a', quantity: 1, unitPrice: 10, taxRateKey: 'zero' }] } })).json;
  const p = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: q.version, lines: [{ description: 'b', quantity: 2, unitPrice: 50, taxRateKey: 'standard' }] } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.lines.length, 1);
  assert.equal(p.json.amount, 123);
  const same = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: p.json.version, amount: 123, notes: 'ok' } });
  assert.equal(same.status, 200, same.text);
  const diff = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: same.json.version, amount: 5 } });
  assert.equal(diff.status, 400);
  assert.equal(diff.json.code, 'TOTALS_FROM_LINES');
  const rc = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: same.json.version, reverseCharge: true } });
  assert.equal(rc.status, 200, rc.text);
  assert.equal(rc.json.taxTotal, 0);
  assert.equal(rc.json.amount, 100);
  const g = await IE.api('GET', `/api/quotes/${q.id}`, { token: U.admin.token });
  assert.match(g.json.print.reverseChargeNote, /to be confirmed by an accountant/);
  assert.equal(g.json.print.reverseChargeNoteIsPlaceholder, true);
  // stale version → 409 and the line change is rolled back
  const stale = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: 1, lines: [{ description: 'zzz', quantity: 1, unitPrice: 1 }] } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');
  const lines = await prisma.quoteLine.findMany({ where: { quoteId: q.id } });
  assert.deepEqual(lines.map((l) => l.description), ['b']);
  // lines: [] + amount → back to a single-amount quote
  const flat = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: rc.json.version, lines: [], amount: 75 } });
  assert.equal(flat.status, 200, flat.text);
  assert.deepEqual([flat.json.lines.length, flat.json.amount, flat.json.subtotal, flat.json.taxTotal], [0, 75, 75, 0]);
});

// ── Numbers ─────────────────────────────────────────────────────────────────
test('numbers: unique and gap-free under 20 concurrent creates; a failed create uses no number', async () => {
  const jobs = [];
  for (let i = 0; i < 20; i++) jobs.push(await freshJob());
  const results = await Promise.all(jobs.map((j, i) => US.api('POST', '/api/invoices', {
    token: U.admin.token, body: { jobId: j.id, lines: [{ description: `item ${i}`, quantity: 1, unitPrice: 10 + i }] },
  })));
  for (const r of results) assert.equal(r.status, 201, r.text);
  const nums = results.map((r) => seq(r.json.number)).sort((a, b) => a - b);
  assert.equal(new Set(nums).size, 20, 'duplicate numbers');
  assert.equal(nums[19] - nums[0], 19, `numbers not contiguous: ${nums.join(',')}`);

  // B3 (GAP-8): a second invoice for the same job is allowed
  const second = await US.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: jobs[0].id, amount: 5 } });
  assert.equal(second.status, 201, second.text);
  assert.equal(seq(second.json.number), nums[19] + 1);
  // one quote is billed once: concurrent from-quote → exactly one 201, the rest 409,
  // and the failed creates (rolled back inside the transaction) use no number
  const qq = await US.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: jobs[1].id, amount: 40 } });
  assert.equal(qq.status, 201, qq.text);
  const race = await Promise.all([1, 2, 3, 4].map(() => US.api('POST', `/api/invoices/from-quote/${qq.json.id}`, { token: U.admin.token, body: {} })));
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409, 409, 409], race.map((r) => r.text).join('\n'));
  for (const r of race.filter((x) => x.status === 409)) assert.equal(r.json.code, 'DUPLICATE');
  const next = await US.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: (await freshJob()).id, amount: 5 } });
  assert.equal(next.status, 201, next.text);
  assert.equal(seq(next.json.number), nums[19] + 3, 'a failed create consumed a number');

  // direct inserts (seeds) are numbered by the DB default, from the same counter
  const direct = await prisma.invoice.create({ data: { jobId: (await freshJob()).id, amount: 7 } });
  assert.equal(seq(direct.number), nums[19] + 4);
  assert.equal(direct.currency, 'USD');
});

// ── Immutability ────────────────────────────────────────────────────────────
test('immutability: a sent quote / paid invoice only accepts status changes', async () => {
  const job = await freshJob();
  const q = (await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [{ description: 'a', quantity: 1, unitPrice: 10 }] } })).json;
  const sent = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: q.version, status: 'sent' } });
  assert.equal(sent.status, 200, sent.text);
  assert.ok(sent.json.sentAt);
  for (const body of [{ notes: 'edit' }, { lines: [{ description: 'b', quantity: 1, unitPrice: 1 }] }, { reverseCharge: true }, { amount: 1 }]) {
    const r = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: sent.json.version, ...body } });
    assert.equal(r.status, body.amount ? 400 : 409, `${JSON.stringify(body)} → ${r.status} ${r.text}`);
    assert.equal(r.json.code, body.amount ? 'TOTALS_FROM_LINES' : 'DOCUMENT_LOCKED');
  }
  // echoing unchanged values with a status change is fine (whole-form saves)
  const ok = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: sent.json.version, status: 'approved', amount: sent.json.amount, notes: null } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'approved');
  // back to draft does not unlock a quote that was sent
  const back = await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: ok.json.version, status: 'draft' } });
  assert.equal(back.status, 200);
  assert.equal((await IE.api('PATCH', `/api/quotes/${q.id}`, { token: U.admin.token, body: { version: back.json.version, notes: 'x' } })).status, 409);
  assert.equal((await IE.api('DELETE', `/api/quotes/${q.id}`, { token: U.admin.token })).status, 409);

  const inv = (await IE.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 50 } })).json;
  const paid = await IE.api('PATCH', `/api/invoices/${inv.id}`, { token: U.admin.token, body: { version: inv.version, status: 'paid' } });
  assert.equal(paid.status, 200);
  assert.ok(paid.json.paidAt);
  const edit = await IE.api('PATCH', `/api/invoices/${inv.id}`, { token: U.admin.token, body: { version: paid.json.version, dueDate: '2027-01-31' } });
  assert.equal(edit.status, 409);
  assert.equal(edit.json.code, 'DOCUMENT_LOCKED');
  assert.equal((await IE.api('DELETE', `/api/invoices/${inv.id}`, { token: U.admin.token })).status, 409);
  const unpaid = await IE.api('PATCH', `/api/invoices/${inv.id}`, { token: U.admin.token, body: { version: paid.json.version, status: 'unpaid' } });
  assert.equal(unpaid.status, 200);
  assert.equal(unpaid.json.paidAt, null);
});

// ── Roles ───────────────────────────────────────────────────────────────────
test('roles: only admin roles write, email or invoice-from-quote; technicians read only their own jobs', async () => {
  const job = await freshJob({ technicianId: U.tech.id });
  const q = (await US.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, amount: 10 } })).json;
  for (const who of ['dispatcher', 'tech']) {
    const t = U[who].token;
    assert.equal((await US.api('POST', '/api/quotes', { token: t, body: { jobId: (await freshJob()).id, amount: 1 } })).status, 403, who);
    assert.equal((await US.api('PATCH', `/api/quotes/${q.id}`, { token: t, body: { version: q.version, notes: 'x' } })).status, 403, who);
    assert.equal((await US.api('POST', `/api/quotes/${q.id}/email`, { token: t })).status, 403, who);
    assert.equal((await US.api('POST', `/api/invoices/from-quote/${q.id}`, { token: t })).status, 403, who);
    assert.equal((await US.api('DELETE', `/api/quotes/${q.id}`, { token: t })).status, 403, who);
  }
  assert.equal((await US.api('GET', `/api/quotes/${q.id}`, { token: U.tech.token })).status, 200);
  const other = await US.api('GET', `/api/quotes/${q.id}`, { token: U.tech2.token });
  assert.equal(other.status, 403);
  assert.equal(other.json.code, 'OUT_OF_SCOPE');
  assert.equal((await US.api('GET', `/api/quotes/${q.id}`)).status, 401);
});

// ── from-quote ──────────────────────────────────────────────────────────────
test('POST /api/invoices/from-quote/:quoteId copies lines, totals, currency and reverse charge', async () => {
  const job = await freshJob();
  const q = (await IE.api('POST', '/api/quotes', {
    token: U.admin.token,
    body: { jobId: job.id, notes: 'Quote notes', lines: [
      { description: 'Heat pump', quantity: 1, unitPrice: 6500, taxRateKey: 'reduced' },
      { description: 'Thermostat', quantity: 2, unitPrice: 89.99, taxRateKey: 'standard' },
    ] },
  })).json;
  const r = await IE.api('POST', `/api/invoices/from-quote/${q.id}`, { token: U.admin.token, body: { dueDate: '2027-01-15' } });
  assert.equal(r.status, 201, r.text);
  const inv = r.json;
  assert.match(inv.number, /^BI-\d{4,}$/);
  assert.deepEqual([inv.amount, inv.subtotal, inv.taxTotal, inv.currency, inv.reverseCharge, inv.status, inv.notes],
    [q.amount, q.subtotal, q.taxTotal, 'EUR', false, 'unpaid', 'Quote notes']);
  assert.deepEqual(inv.lines.map((l) => [l.position, l.description, l.quantity, l.unitPrice, l.taxRateKey, l.taxRate, l.lineTotal]),
    q.lines.map((l) => [l.position, l.description, l.quantity, l.unitPrice, l.taxRateKey, l.taxRate, l.lineTotal]));
  assert.equal(inv.fromQuote.number, q.number);
  const again = await IE.api('POST', `/api/invoices/from-quote/${q.id}`, { token: U.admin.token });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'DUPLICATE');

  const declined = (await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: (await freshJob()).id, amount: 10, status: 'declined' } })).json;
  const d = await IE.api('POST', `/api/invoices/from-quote/${declined.id}`, { token: U.admin.token });
  assert.equal(d.status, 409);
  assert.equal(d.json.code, 'QUOTE_DECLINED');
  assert.equal((await IE.api('POST', '/api/invoices/from-quote/99999999', { token: U.admin.token })).status, 404);
});

// ── Email ───────────────────────────────────────────────────────────────────
test('email: HTML + text document lands in the outbox, logs a communication, marks the quote sent', async () => {
  const job = await freshJob();
  const q = (await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [{ description: 'Boiler <b>service</b>', quantity: 1, unitPrice: 120, taxRateKey: 'reduced' }] } })).json;
  const before = outboxMessages().length;
  const r = await IE.api('POST', `/api/quotes/${q.id}/email`, { token: U.admin.token, body: { message: 'Thanks for having us out.' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.delivered, true);
  assert.equal(r.json.driver, 'outbox');
  const msgs = outboxMessages();
  assert.equal(msgs.length, before + 1);
  const m = msgs.find((x) => x.subject.includes(q.number));
  assert.ok(m, 'no outbox message with the quote number');
  assert.equal(m.to, `aoife-${RUN}@example.com`);
  assert.match(m.subject, /^Brightwater Heating Ltd — Quote BQ-/);
  assert.match(m.text, /Boiler <b>service<\/b>/);
  assert.match(m.text, /VAT 13\.5% on €120\.00: €16\.20/);
  assert.match(m.text, /Total: €136\.20/);
  assert.match(m.html, /Boiler &lt;b&gt;service&lt;\/b&gt;/, 'HTML not escaped');
  assert.doesNotMatch(m.html, /<b>service/);
  assert.match(m.html, /IE1234567T/);
  const comm = await prisma.communication.findUnique({ where: { id: r.json.communicationId } });
  assert.deepEqual([comm.type, comm.direction, comm.to, comm.customerId], ['email', 'outbound', m.to, job.customerId]);
  assert.equal(r.json.document.status, 'sent');
  assert.ok(r.json.document.sentAt);
  assert.equal(r.json.document.locked, true);
  // 2c: the draft → sent flip is in the job activity log, with the creation
  const acts = await prisma.jobActivity.findMany({ where: { jobId: job.id }, orderBy: { id: 'asc' } });
  assert.deepEqual(acts.map((a) => a.type), ['quote_created', 'updated']);
  assert.deepEqual([acts[1].from.status, acts[1].to.status, acts[1].to.quoteId], ['draft', 'sent', q.id]);
  assert.equal(acts[0].to.currency, 'EUR');

  // invoices too
  const inv = (await IE.api('POST', `/api/invoices/from-quote/${q.id}`, { token: U.admin.token })).json;
  const ri = await IE.api('POST', `/api/invoices/${inv.id}/email`, { token: U.admin.token });
  assert.equal(ri.status, 200, ri.text);
  assert.ok(outboxMessages().some((x) => x.subject.includes(inv.number) && /VAT Invoice/.test(x.subject)));
  assert.equal((await IE.api('PATCH', `/api/invoices/${inv.id}`, { token: U.admin.token, body: { version: ri.json.document.version, notes: 'x' } })).status, 409);

  // customer without email → 400; mail disabled → 503 and nothing changes
  const noMail = await mkCustomer({ email: null });
  const q2 = (await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: (await mkJob(noMail.id)).id, amount: 5 } })).json;
  const r2 = await IE.api('POST', `/api/quotes/${q2.id}/email`, { token: U.admin.token });
  assert.equal(r2.status, 400);
  assert.equal(r2.json.code, 'NO_CUSTOMER_EMAIL');
  const off = await bootServer({ MAIL_DRIVER: 'none' });
  const q3 = (await off.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: (await freshJob()).id, amount: 5 } })).json;
  const r3 = await off.api('POST', `/api/quotes/${q3.id}/email`, { token: U.admin.token });
  assert.equal(r3.status, 503);
  assert.equal(r3.json.code, 'EMAIL_DISABLED');
  assert.equal((await prisma.quote.findUnique({ where: { id: q3.id } })).status, 'draft');
  assert.equal(await prisma.jobActivity.count({ where: { jobId: q3.jobId, type: 'updated' } }), 0, 'a failed email logged a status change');
  await off.stop();
});

// ── Customers / addresses ───────────────────────────────────────────────────
test('addresses: IE requires line 1 / town / county and validates Eircodes; US keeps optional fields (never a 500)', async () => {
  const base = { firstName: 'Seán', lastName: `Murphy-${RUN}`, phone: '089 011 0101' };
  const ie = (body) => IE.api('POST', '/api/customers', { token: U.admin.token, body: { ...base, ...body } });
  let r = await ie({ address: '1 Main St', city: 'Naas' });
  assert.equal(r.status, 400, r.text);
  assert.deepEqual([r.json.code, r.json.field], ['REQUIRED', 'state']);
  assert.match(r.json.error, /County/);
  r = await ie({ address: '1 Main St', city: 'Naas', state: 'Co. Kildare', zip: '12345' });
  assert.equal(r.status, 400);
  assert.deepEqual([r.json.code, r.json.field], ['INVALID_INPUT', 'zip']);
  r = await ie({ address: '1 Main St', city: 'Naas', state: 'Co. Kildare', zip: 'w91x2y4', company: 'Murphy Builders', taxNumber: 'IE9876543W', addressLine2: 'Unit 4' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.zip, r.json.country, r.json.company, r.json.taxNumber, r.json.addressLine2], ['W91 X2Y4', 'IE', 'Murphy Builders', 'IE9876543W', 'Unit 4']);
  assert.equal(r.json.phone, '+353890110101');
  r = await ie({ address: '1 Main St', city: 'Naas', state: 'Co. Kildare' }); // Eircode optional
  assert.equal(r.status, 201, r.text);
  const clear = await IE.api('PATCH', `/api/customers/${r.json.id}`, { token: U.admin.token, body: { version: r.json.version, city: '' } });
  assert.equal(clear.status, 400);
  assert.deepEqual([clear.json.code, clear.json.field], ['REQUIRED', 'city']);
  const notes = await IE.api('PATCH', `/api/customers/${r.json.id}`, { token: U.admin.token, body: { version: r.json.version, notes: 'fine' } });
  assert.equal(notes.status, 200, notes.text);

  // US: today's behaviour — city / zip optional, blank → null, default state KS
  // (2c / WL-12: phones are normalised to E.164 by the customer's country — a US number here)
  const us = (body) => US.api('POST', '/api/customers', { token: U.admin.token, body: { ...base, phone: '(620) 555-0142', ...body } });
  r = await us({});
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.json.city, r.json.zip, r.json.state, r.json.country, r.json.address], [null, null, 'KS', 'US', '']);
  r = await us({ address: '1 Main', city: '', zip: '' });
  assert.equal(r.status, 201, r.text);
  r = await us({ zip: 'ABCDE' });
  assert.equal(r.status, 400);
  assert.deepEqual([r.json.code, r.json.field], ['INVALID_INPUT', 'zip']);
  r = await us({ zip: '67501-1234', state: 'KS', city: 'Hutchinson' });
  assert.equal(r.status, 201, r.text);
  r = await us({ country: 'USA' });
  assert.equal(r.status, 400);
  // a customer in another country is not held to the brand country's rules
  r = await us({ country: 'gb', zip: 'SW1A 1AA', phone: '020 7946 0958' });
  assert.equal(r.status, 400, 'no national rules for GB: international format needed');
  assert.equal(r.json.code, 'INVALID_PHONE');
  assert.match(r.json.error, /international format/);
  r = await us({ country: 'gb', zip: 'SW1A 1AA', phone: '+44 20 7946 0958' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.country, 'GB');
  assert.equal(r.json.phone, '+442079460958');
  // address lines in the print view follow the customer's country
  const { addressLines } = require('../helpers/documents');
  assert.deepEqual(addressLines({ address: '1 Main', city: 'Hutchinson', state: 'KS', zip: '67501', country: 'US' }, require('../helpers/locale').buildLocale({})), ['1 Main', 'Hutchinson, KS 67501']);
});

// ── Migration on seeded data (real WASM engine) ─────────────────────────────
test('migration 20261121140000_documents_locale on a database seeded at the previous migration', async () => {
  const dbName = `${decodeURIComponent(new URL(TEST_DB).pathname.slice(1))}_mig_${RUN}`.toLowerCase().slice(0, 63);
  const url = new URL(TEST_DB); url.pathname = `/${dbName}`;
  const MIG_DB = url.toString();
  await pgQuery(pgAdminUrl(TEST_DB), `CREATE DATABASE "${dbName}"`);
  const stage = fs.mkdtempSync(path.join(TMP, 'stage-'));
  try {
    // A copy of the backend's migrate script with only the migrations before this one.
    fs.mkdirSync(path.join(stage, 'scripts'));
    fs.mkdirSync(path.join(stage, 'helpers'));
    fs.mkdirSync(path.join(stage, 'prisma', 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(BACKEND, 'scripts', 'migrate-deploy.mjs'), path.join(stage, 'scripts', 'migrate-deploy.mjs'));
    for (const f of ['loadEnv.js', 'databaseUrl.js']) fs.copyFileSync(path.join(BACKEND, 'helpers', f), path.join(stage, 'helpers', f));
    fs.copyFileSync(path.join(BACKEND, 'prisma', 'schema.prisma'), path.join(stage, 'prisma', 'schema.prisma'));
    fs.copyFileSync(path.join(BACKEND, 'prisma', 'migrations', 'migration_lock.toml'), path.join(stage, 'prisma', 'migrations', 'migration_lock.toml'));
    for (const m of fs.readdirSync(path.join(BACKEND, 'prisma', 'migrations')).filter((m) => /^\d+_/.test(m) && m < '20261121140000')) {
      fs.cpSync(path.join(BACKEND, 'prisma', 'migrations', m), path.join(stage, 'prisma', 'migrations', m), { recursive: true });
    }
    fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(stage, 'node_modules'));
    let r = runMigrate(MIG_DB, path.join(stage, 'scripts', 'migrate-deploy.mjs'));
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // Seed old-shape rows (Float money, NOT NULL city/zip, state default 'KS').
    await pgQuery(MIG_DB, `
      INSERT INTO "Customer" ("firstName","lastName","phone","address","city","zip") VALUES ('Old','One','1','1 St','Town','67501'), ('Old','Two','2','2 St','Town','67502');
      INSERT INTO "Job" ("title","customerId") VALUES ('j1',1),('j2',1),('j3',2);
      INSERT INTO "Quote" ("jobId","amount","status","createdAt") VALUES (2, 1234.5, 'sent', '2026-01-02'), (1, 99.999, 'draft', '2026-03-04'), (3, 10, 'approved', '2026-02-01');
      INSERT INTO "Invoice" ("jobId","amount","status","createdAt") VALUES (3, 250.25, 'paid', '2026-01-05'), (1, 0.1, 'unpaid', '2026-01-06');
      INSERT INTO "PriceBookItem" ("category","name","price","cost") VALUES ('c','p', 12.345, 1.005);
      INSERT INTO "InventoryItem" ("name","unitCost") VALUES ('i', 3.14159);
      INSERT INTO "JobPart" ("jobId","inventoryItemId","quantity","unitCost") VALUES (1, 1, 2, 2.675);`);
    assert.equal((await pgQuery(MIG_DB, 'SELECT "state" FROM "Customer" WHERE id = 1')).rows[0].state, 'KS');

    r = runMigrate(MIG_DB);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /20261121140000_documents_locale/);

    const q = (await pgQuery(MIG_DB, 'SELECT id, number, amount::text, subtotal::text, "taxTotal"::text, currency, "reverseCharge", "issuedAt" = "createdAt" AS same FROM "Quote" ORDER BY id')).rows;
    assert.deepEqual(q.map((x) => [x.id, x.number, x.amount, x.subtotal, x.taxTotal, x.currency, x.reverseCharge, x.same]), [
      [1, 'Q-0001', '1234.50', '1234.50', '0.00', 'USD', false, true],
      [2, 'Q-0002', '100.00', '100.00', '0.00', 'USD', false, true],
      [3, 'Q-0003', '10.00', '10.00', '0.00', 'USD', false, true],
    ]);
    const inv = (await pgQuery(MIG_DB, 'SELECT number, amount::text, subtotal::text FROM "Invoice" ORDER BY id')).rows;
    assert.deepEqual(inv.map((x) => [x.number, x.amount, x.subtotal]), [['INV-0001', '250.25', '250.25'], ['INV-0002', '0.10', '0.10']]);
    const money = (await pgQuery(MIG_DB, 'SELECT (SELECT price::text FROM "PriceBookItem" LIMIT 1) p, (SELECT cost::text FROM "PriceBookItem" LIMIT 1) c, (SELECT "unitCost"::text FROM "InventoryItem" LIMIT 1) i, (SELECT "unitCost"::text FROM "JobPart" LIMIT 1) jp')).rows[0];
    assert.deepEqual(money, { p: '12.35', c: '1.01', i: '3.14', jp: '2.68' });
    const counters = (await pgQuery(MIG_DB, 'SELECT type, prefix, next FROM "DocumentCounter" ORDER BY type')).rows;
    assert.deepEqual(counters, [{ type: 'invoice', prefix: 'INV-', next: 3 }, { type: 'quote', prefix: 'Q-', next: 4 }]);
    // new rows: numbered by the DB default, state has no default any more, city/zip nullable
    await pgQuery(MIG_DB, `INSERT INTO "Customer" ("firstName","lastName","phone","address") VALUES ('New','Three','3','')`);
    const c3 = (await pgQuery(MIG_DB, 'SELECT state, city, zip FROM "Customer" WHERE "lastName" = \'Three\'')).rows[0];
    assert.deepEqual(c3, { state: null, city: null, zip: null });
    await pgQuery(MIG_DB, `INSERT INTO "Job" ("title","customerId") VALUES ('j4',3)`);
    await pgQuery(MIG_DB, 'INSERT INTO "Quote" ("jobId","amount") VALUES (4, 5)');
    assert.equal((await pgQuery(MIG_DB, 'SELECT number FROM "Quote" WHERE "jobId" = 4')).rows[0].number, 'Q-0004');
    // second deploy is a no-op
    r = runMigrate(MIG_DB);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No pending migrations/);
  } finally {
    await pgQuery(pgAdminUrl(TEST_DB), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
  }
});

test('Prisma client round-trips every new field', async () => {
  const c = await prisma.customer.create({
    data: {
      firstName: 'Round', lastName: `Trip-${RUN}`, phone: '1', address: 'a', addressLine2: 'b', city: null, zip: null, state: null,
      country: 'IE', company: 'Co Ltd', taxNumber: 'IE1', sourceSystem: `test-${RUN}`, sourceId: 'c-1',
    },
  });
  const job = await prisma.job.create({ data: { title: `rt ${RUN}`, customerId: c.id, sourceSystem: `test-${RUN}`, sourceId: 'j-1' } });
  const item = await prisma.priceBookItem.create({ data: { category: 'c', name: `rt item ${RUN}`, price: 10.5, cost: 2.25, taxRateKey: 'reduced' } });
  const issuedAt = new Date('2026-11-01T10:00:00Z');
  const q = await prisma.quote.create({
    data: {
      jobId: job.id, number: `RT-${RUN}`, amount: 123.45, subtotal: 100.5, taxTotal: 22.95, currency: 'EUR', reverseCharge: true,
      issuedAt, sentAt: issuedAt,
      lines: { create: [{ position: 1, description: 'd', quantity: 1.125, unitPrice: 100.5, taxRateKey: 'reduced', taxRate: 13.5, lineTotal: 113.06, pricebookItemId: item.id }] },
    },
    include: { lines: true },
  });
  const back = await prisma.quote.findUnique({ where: { id: q.id }, include: { lines: { include: { pricebookItem: true } }, job: { include: { customer: true } } } });
  assert.deepEqual([back.number, back.amount, back.subtotal, back.taxTotal, back.currency, back.reverseCharge, back.issuedAt.toISOString(), back.sentAt.toISOString()],
    [`RT-${RUN}`, 123.45, 100.5, 22.95, 'EUR', true, issuedAt.toISOString(), issuedAt.toISOString()]);
  const l = back.lines[0];
  assert.deepEqual([l.position, l.description, l.quantity, l.unitPrice, l.taxRateKey, l.taxRate, l.lineTotal, l.pricebookItemId, l.pricebookItem.taxRateKey, l.pricebookItem.price],
    [1, 'd', 1.125, 100.5, 'reduced', 13.5, 113.06, item.id, 'reduced', 10.5]);
  const cu = back.job.customer;
  assert.deepEqual([cu.addressLine2, cu.city, cu.zip, cu.state, cu.country, cu.company, cu.taxNumber, cu.sourceSystem, cu.sourceId],
    ['b', null, null, null, 'IE', 'Co Ltd', 'IE1', `test-${RUN}`, 'c-1']);
  assert.deepEqual([back.job.sourceSystem, back.job.sourceId], [`test-${RUN}`, 'j-1']);
  const inv = await prisma.invoice.create({
    data: { jobId: job.id, amount: 5, lines: { create: [{ position: 1, description: 'x', quantity: 2, unitPrice: 2.5, lineTotal: 5 }] } },
    include: { lines: true },
  });
  assert.equal(inv.lines[0].taxRate, 0);
  assert.equal(typeof inv.subtotal, 'number');
  // unique import provenance pairs
  await assert.rejects(prisma.customer.create({ data: { firstName: 'x', lastName: `Dup-${RUN}`, phone: '1', address: '', sourceSystem: `test-${RUN}`, sourceId: 'c-1' } }), (e) => e.code === 'P2002');
  await prisma.customer.create({ data: { firstName: 'x', lastName: `Nulls-${RUN}`, phone: '1', address: '' } });
  await prisma.customer.create({ data: { firstName: 'y', lastName: `Nulls-${RUN}`, phone: '1', address: '' } });
  // lines cascade with their document
  await prisma.quote.delete({ where: { id: q.id } });
  assert.equal(await prisma.quoteLine.count({ where: { quoteId: q.id } }), 0);
  await prisma.invoice.delete({ where: { id: inv.id } });
  await prisma.priceBookItem.delete({ where: { id: item.id } });
});

// ── /api/brand, favicon, HTML caching ───────────────────────────────────────
test('/api/brand: publicBrand fields + locale block; /favicon.ico; HTML is no-store', async () => {
  const b = (await US.api('GET', '/api/brand')).json;
  for (const k of ['companyName', 'companySlogan', 'tradeType', 'technicianLabel', 'industryLabel', 'jobTypes', 'colors', 'logoUrl', 'faviconUrl', 'timezone', 'demoMode', 'demoLogin', 'locale']) {
    assert.ok(k in b, `missing ${k}`);
  }
  assert.deepEqual([b.locale.country, b.locale.currency, b.locale.taxEnabled, b.locale.defaultState], ['US', 'USD', false, 'KS']);
  const ib = (await IE.api('GET', '/api/brand')).json;
  assert.deepEqual([ib.locale.country, ib.locale.currency, ib.locale.taxLabel, ib.locale.taxNumber, ib.locale.addressLabels.zip], ['IE', 'EUR', 'VAT', 'IE1234567T', 'Eircode']);
  assert.equal(ib.locale.taxRates.length, 3);

  assert.equal((await US.api('GET', '/favicon.ico')).status, 204);
  const fav = await bootServer({ BRAND_FAVICON_URL: 'https://cdn.example.com/fav.png' });
  const f = await fav.api('GET', '/favicon.ico');
  assert.equal(f.status, 302);
  assert.equal(f.headers.location, 'https://cdn.example.com/fav.png');
  await fav.stop();
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const dataFav = await bootServer({ BRAND_LOGO_URL: `data:image/png;base64,${png}` });
  const d = await dataFav.api('GET', '/favicon.ico');
  assert.equal(d.status, 200);
  assert.equal(d.headers['content-type'], 'image/png');
  await dataFav.stop();

  for (const p of ['/', '/index.html', '/customers.html']) {
    const r = await US.api('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['cache-control'], 'no-store', p);
  }
});

// ── Small fixes ─────────────────────────────────────────────────────────────
test('WL-14 CSV exports carry an RFC 5987 filename* for non-ASCII brand names', async () => {
  const s = await bootServer({ BRAND_COMPANY_NAME: 'Ó Briain’s Plumbing' });
  const r = await s.api('GET', '/api/exports/invoices', { token: U.admin.token });
  assert.equal(r.status, 200, r.text);
  const cd = r.headers['content-disposition'];
  assert.match(cd, /^attachment; filename="O_Briain_s_Plumbing_invoices\.csv"; filename\*=UTF-8''%C3%93_Briain%E2%80%99s_Plumbing_invoices\.csv$/);
  assert.match(r.text.split('\n')[0], /^id,amount,status,dueDate,paidAt,jobTitle,customerName,createdAt,number,currency,subtotal,taxTotal/);
  for (const p of ['/api/exports/customers', '/api/exports/jobs']) assert.equal((await s.api('GET', p, { token: U.admin.token })).status, 200, p);
  await s.stop();
});

test('WL-4 pricebook lists every item by default; ?industry= filters; POST stamps the industry label; taxRateKey validated', async () => {
  const other = await prisma.priceBookItem.create({ data: { industry: 'Electrical', category: 'c', name: `Other trade ${RUN}`, price: 10 } });
  const all = await US.api('GET', `/api/pricebook?search=${encodeURIComponent(RUN)}`, { token: U.admin.token });
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.json).sort(), ['industry', 'items', 'tradeType']);
  assert.ok(all.json.items.some((i) => i.id === other.id), 'item of another industry label hidden');
  const filtered = await US.api('GET', `/api/pricebook?industry=Plumbing%20%26%20HVAC&search=${encodeURIComponent(RUN)}`, { token: U.admin.token });
  assert.ok(!filtered.json.items.some((i) => i.id === other.id));
  const created = await IE.api('POST', '/api/pricebook', { token: U.admin.token, body: { category: 'c', name: `New ${RUN}`, price: 5, taxRateKey: 'Reduced' } });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual([created.json.industry, created.json.taxRateKey, created.json.price], ['Plumbing & HVAC', 'reduced', 5]);
  const bad = await IE.api('POST', '/api/pricebook', { token: U.admin.token, body: { category: 'c', name: `Bad ${RUN}`, taxRateKey: 'luxury' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_ENUM');
});

test('WL-8 SMS text uses the human trade label and a locale date; WL-10 timeline money uses the document currency', async () => {
  const sms = (env) => spawnSync(process.execPath, ['-e', `
    const s = require('./routes/sms');
    console.log(JSON.stringify([s.serviceLabel(), s.whenText({ scheduledDate: '2026-11-25', scheduledTime: '14:30' }), s.whenText({ scheduledAt: '2026-11-25T23:30:00Z' })]));`],
  { cwd: BACKEND, env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB, BRAND_TRADE_TYPE: 'plumbing-hvac', ...env }, encoding: 'utf8' });
  const us = JSON.parse(sms({ BRAND_TIMEZONE: 'America/Chicago' }).stdout);
  assert.equal(us[0], 'Plumbing & HVAC');
  assert.deepEqual(us[1], { date: 'Wednesday, November 25', time: '2:30 PM' });
  assert.deepEqual(us[2], { date: 'Wednesday, November 25', time: '5:30 PM' }); // 23:30Z = 17:30 in Chicago
  const ie = JSON.parse(sms({ BRAND_COUNTRY: 'IE', BRAND_TIMEZONE: 'Europe/Dublin' }).stdout);
  assert.match(ie[1].date, /^Wednesday,? 25 November$/); // ICU versions differ on the comma
  assert.equal(ie[1].time, '14:30');

  const job = await freshJob();
  await IE.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [{ description: 'x', quantity: 1, unitPrice: 1234.5, taxRateKey: 'zero' }] } });
  const t = await IE.api('GET', `/api/communications?customerId=${job.customerId}`, { token: U.admin.token });
  const entry = t.json.timeline.find((e) => e.type === 'quote');
  assert.match(entry.body, /Amount: €1,234\.50/);
  assert.match(entry.subject, /^Quote BQ-\d+ for Job/);
});

test('UX-15 the API limiter counts signed-in users separately even when they share one IP', async () => {
  const s = await bootServer({ RATE_LIMIT_USER_MAX: '5', RATE_LIMIT_IP_MAX: '3' });
  const ip = '127.3.3.3';
  const hit = (token) => s.api('GET', '/api/users/me', { token, ip });
  for (let i = 0; i < 5; i++) assert.equal((await hit(U.admin.token)).status, 200, `admin #${i}`);
  assert.equal((await hit(U.admin.token)).status, 429, 'per-user limit not applied');
  assert.equal((await hit(U.dispatcher.token)).status, 200, 'a colleague on the same IP was throttled');
  // anonymous calls are still per IP
  for (let i = 0; i < 3; i++) assert.notEqual((await s.api('GET', '/api/health', { ip })).status, 429);
  assert.equal((await s.api('GET', '/api/health', { ip })).status, 429);
  // a forged token falls back to the IP bucket (cannot mint fresh buckets)
  assert.equal((await hit('forged.token.value')).status, 429);
  await s.stop();
});

test('Google sign-in requires a positive email_verified', async () => {
  const { resolveGoogleUser } = require('../routes/googleAuth');
  const p = (extra) => ({ emails: [{ value: U.admin.email }], name: {}, ...extra });
  assert.match((await resolveGoogleUser(p({ _json: {} }))).error, /not verified/);
  assert.match((await resolveGoogleUser(p({ _json: { email_verified: false } }))).error, /not verified/);
  assert.equal((await resolveGoogleUser(p({ _json: { email_verified: true } }))).user.email, U.admin.email);
});

// ── GAP-16 reverse charge only where it exists ──────────────────────────────
test('GAP-16 reverse charge: offered (and accepted) only for VAT / BRAND_REVERSE_CHARGE; US sales tax refuses it', async () => {
  const { buildLocale } = require('../helpers/locale');
  assert.equal(buildLocale({}).reverseChargeAvailable, false, 'US, no tax');
  assert.equal(buildLocale({ BRAND_TAX_RATES: 'sales:8.5' }).reverseChargeAvailable, false, 'US sales tax');
  assert.equal(buildLocale({ BRAND_COUNTRY: 'IE' }).reverseChargeAvailable, true, 'IE VAT');
  assert.equal(buildLocale({ BRAND_COUNTRY: 'IE', BRAND_TAX_RATES: '' }).reverseChargeAvailable, false, 'IE without rates');
  assert.equal(buildLocale({ BRAND_COUNTRY: 'IE', BRAND_REVERSE_CHARGE: 'false' }).reverseChargeAvailable, false);
  assert.equal(buildLocale({ BRAND_TAX_RATES: 'sales:8.5', BRAND_REVERSE_CHARGE: 'true' }).reverseChargeAvailable, true);
  assert.equal(buildLocale({ BRAND_TAX_RATES: 'sales:8.5', BRAND_RCT_NOTE: 'Reverse charge applies.' }).reverseChargeAvailable, true);
  assert.throws(() => buildLocale({ BRAND_REVERSE_CHARGE: 'true' }), /needs tax rates/);
  assert.throws(() => buildLocale({ BRAND_COUNTRY: 'IE', BRAND_REVERSE_CHARGE: 'maybe' }), /true or false/);

  const ieBrand = (await IE.api('GET', '/api/brand')).json;
  assert.equal(ieBrand.locale.reverseChargeAvailable, true);
  const salesTax = await bootServer({ BRAND_TAX_RATES: 'sales:8.5' });
  try {
    const b = (await salesTax.api('GET', '/api/brand')).json;
    assert.equal(b.locale.taxEnabled, true);
    assert.equal(b.locale.reverseChargeAvailable, false, 'US sales tax must not offer reverse charge');
    const job = await freshJob();
    const line = { description: 'Service call', quantity: 1, unitPrice: 100 };
    for (const kind of ['quotes', 'invoices']) {
      const r = await salesTax.api('POST', `/api/${kind}`, { token: U.admin.token, body: { jobId: job.id, lines: [line], reverseCharge: true } });
      assert.equal(r.status, 400, `${kind}: ${r.text}`);
      assert.equal(r.json.code, 'REVERSE_CHARGE_UNAVAILABLE');
    }
    const q = await salesTax.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [line], reverseCharge: false } });
    assert.equal(q.status, 201, q.text);
    assert.equal(q.json.taxTotal, 8.5);
    const on = await salesTax.api('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { version: q.json.version, reverseCharge: true } });
    assert.equal(on.status, 400); assert.equal(on.json.code, 'REVERSE_CHARGE_UNAVAILABLE');
    // a document that already is reverse charge (older data) can be saved as is or switched off
    await prisma.quote.update({ where: { id: q.json.id }, data: { reverseCharge: true } });
    const echo = await salesTax.api('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { version: q.json.version, reverseCharge: true, notes: 'kept' } });
    assert.equal(echo.status, 200, echo.text);
    const off = await salesTax.api('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { version: echo.json.version, reverseCharge: false } });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.taxTotal, 8.5);
  } finally { await salesTax.stop(); }
  // IE: still works
  const job = await freshJob();
  const rc = await IE.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, lines: [{ description: 'Heat pump install', quantity: 1, unitPrice: 1000 }], reverseCharge: true } });
  assert.equal(rc.status, 201, rc.text);
  assert.equal(rc.json.taxTotal, 0);
});
