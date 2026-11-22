/**
 * tests/integrations.test.js — Phase 2c integrations: CSV customer import (migration gates),
 * exports (quotes, document lines, exit-export zip), Xero sales-invoice CSV, QuickBooks Online
 * over plain fetch (OAuth, refresh, invoice push, payment sync-back).
 *
 * Setup / run:
 *   1. PostgreSQL reachable (role mbc / mbc_sandbox, CREATEDB).
 *   2. cd backend && npm install
 *   3. TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_integrations_test?schema=public \
 *        npm run test:integrations
 *      (the database name must contain "test"; it is created + migrated if missing)
 *
 * NO external calls: QuickBooks is a local HTTP stub on 127.0.0.1 (token endpoint, accounting
 * API, query). Every server child runs with ENV_FILE=/dev/null; the sandbox server has
 * SANDBOX_MODE=true, the QBO server points QBO_TOKEN_URL / QBO_API_BASE / QBO_AUTHORIZE_URL at
 * the stub. Synthetic, run-tagged rows only; removed afterwards.
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
  console.error('[integrations-test] TEST_DATABASE_URL is required (a throwaway database whose name contains "test").');
  process.exit(1);
}
if (!/test/i.test(new URL(TEST_DB).pathname)) {
  console.error('[integrations-test] refusing: the TEST_DATABASE_URL database name must contain "test".');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
process.env.ENV_FILE = '/dev/null';
const SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = 'test';

const RUN      = `it${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const PASSWORD = 'Integrations!2345';
const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-integrations-test-'));
const STORAGE  = path.join(TMP, 'storage');
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256   = (b) => crypto.createHash('sha256').update(b).digest('hex');

let prisma;
const U = {};
const servers = [];
let S; let IE; let Q; let stub;

let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `127.3.${1 + Math.floor(ipSeq / 250) % 250}.${1 + (ipSeq % 250)}`; };

function request(base, method, p, { token, body, headers = {}, raw, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const h = { ...headers };
    let data;
    if (raw) { data = raw.body; h['Content-Type'] = raw.contentType; h['Content-Length'] = data.length; }
    else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    if (token) h.Authorization = `Bearer ${token}`;
    if (cookie) h.Cookie = cookie;
    const rq = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: h, localAddress: nextIp() }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json, buf });
      });
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

/** multipart/form-data body from { name: string | { filename, content } } */
function multipart(fields) {
  const boundary = `----mbc${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [name, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (typeof v === 'object' && v.filename) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${v.filename}"\r\nContent-Type: text/csv\r\n\r\n`));
      parts.push(Buffer.isBuffer(v.content) ? v.content : Buffer.from(v.content));
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${v}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
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
    SANDBOX_MODE: 'true', DEMO_MODE: 'false', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: STORAGE,
    MAIL_DRIVER: 'outbox', MAIL_OUTBOX_DIR: path.join(TMP, 'outbox'), BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(TMP, 'backups'),
    BRAND_TRADE_TYPE: 'plumbing-hvac', RATE_LIMIT_USER_MAX: '100000', RATE_LIMIT_IP_MAX: '100000',
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
    if (!s.alive()) throw new Error(`server exited:\n${out}`);
    try { if ((await request(base, 'GET', '/api/health')).status === 200) return s; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`server did not start:\n${out}`);
}

async function pgQuery(dbUrl, sql, params) {
  const { Client } = require('pg');
  const url = new URL(dbUrl); url.search = '';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function ensureDatabase(dbUrl) {
  const admin = new URL(dbUrl); admin.pathname = '/postgres'; admin.search = '';
  const db = decodeURIComponent(new URL(dbUrl).pathname.replace(/^\//, ''));
  const { rowCount } = await pgQuery(admin.toString(), 'SELECT 1 FROM pg_database WHERE datname = $1', [db]);
  if (!rowCount) await pgQuery(admin.toString(), `CREATE DATABASE "${db.replace(/"/g, '""')}"`);
  const r = spawnSync(process.execPath, [path.join(BACKEND, 'scripts', 'migrate-deploy.mjs'), '--quiet'], {
    cwd: BACKEND, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: dbUrl, ENV_FILE: '/dev/null' }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrate-deploy failed:\n${r.stdout}\n${r.stderr}`);
}

async function mkUser(role, tag = role) {
  const bcrypt = require('bcryptjs');
  return prisma.user.create({ data: { email: `${RUN}-${tag}@integrations.test`, password: await bcrypt.hash(PASSWORD, 4), firstName: 'IT', lastName: tag, role, active: true } });
}
async function login(srv, email) {
  const r = await srv.api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
const mkCustomer = (over = {}) => prisma.customer.create({
  data: { firstName: 'Nora', lastName: `Synthetic-${RUN}`, phone: '+16205550142', email: `nora-${RUN}@example.com`, address: '9 Example Ave', city: 'Hutchinson', state: 'KS', zip: '67501', ...over },
});
const mkJob = (customerId, over = {}) => prisma.job.create({ data: { title: `IT job ${RUN}`, customerId, ...over } });

/** unzip → { name: Buffer } */
function unzip(buf) {
  const { unzipSync } = require('fflate');
  const files = unzipSync(new Uint8Array(buf));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}
const { parseCsv } = require('../helpers/csv');

// ── QuickBooks stub (127.0.0.1 only) ─────────────────────────────────────────
function startQboStub() {
  const st = {
    requests: [], clientId: 'it-qb-client', clientSecret: 'it-qb-secret-value',
    access: null, refresh: null, gen: 0, usedRefresh: new Set(),
    customers: new Map(), invoices: new Map(), payments: [], nextId: 100, failNext401: false,
  };
  const issue = () => { st.gen += 1; st.access = `stub-at-${st.gen}-${crypto.randomBytes(4).toString('hex')}`; st.refresh = `stub-rt-${st.gen}-${crypto.randomBytes(4).toString('hex')}`; return { access_token: st.access, refresh_token: st.refresh, token_type: 'bearer', expires_in: 3600, x_refresh_token_expires_in: 8726400 }; };
  const fault = (code, Message, Detail = '') => ({ Fault: { Error: [{ Message, Detail, code: String(code) }], type: 'ValidationFault' }, time: new Date().toISOString() });
  const totalOf = (inv) => Math.round((inv.Line || []).reduce((s, l) => s + Number(l.Amount || 0), 0) * 100 + Number((inv.TxnTaxDetail && inv.TxnTaxDetail.TotalTax) || 0) * 100) / 100;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, 'http://stub');
      const rec = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, raw };
      st.requests.push(rec);
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/oauth2/v1/tokens/bearer' && req.method === 'POST') {
        const expected = `Basic ${Buffer.from(`${st.clientId}:${st.clientSecret}`).toString('base64')}`;
        if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' });
        const form = Object.fromEntries(new URLSearchParams(raw));
        rec.form = form;
        if (form.grant_type === 'authorization_code') {
          if (form.code !== 'good-code' || !form.redirect_uri) return send(400, { error: 'invalid_grant' });
          return send(200, issue());
        }
        if (form.grant_type === 'refresh_token') {
          if (form.refresh_token !== st.refresh || st.usedRefresh.has(form.refresh_token)) return send(400, { error: 'invalid_grant' });
          st.usedRefresh.add(form.refresh_token);
          return send(200, issue());
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      const m = /^\/v3\/company\/(\d+)\/(.+)$/.exec(u.pathname);
      if (!m) return send(404, { error: 'not found' });
      if (st.failNext401) { st.failNext401 = false; return send(401, { Fault: { Error: [{ Message: 'AuthenticationFailed', code: '3200' }], type: 'AuthenticationFault' } }); }
      if (req.headers.authorization !== `Bearer ${st.access}`) return send(401, { Fault: { Error: [{ Message: 'AuthenticationFailed', code: '3200' }], type: 'AuthenticationFault' } });
      if (u.searchParams.get('minorversion') !== '75') return send(400, fault(2010, 'minorversion missing'));
      const [entity, id] = m[2].split('/');
      const body = raw ? JSON.parse(raw) : null;
      rec.body = body;
      if (entity === 'query') {
        const sql = u.searchParams.get('query');
        rec.sql = sql;
        let mm;
        if ((mm = /FROM Payment WHERE MetaData\.LastUpdatedTime >= '([^']+)'/.exec(sql))) {
          const since = new Date(mm[1]);
          return send(200, { QueryResponse: { Payment: st.payments.filter((p) => new Date(p.MetaData.LastUpdatedTime) >= since) } });
        }
        if ((mm = /FROM Invoice WHERE Id IN \((.+)\)/.exec(sql))) {
          const ids = mm[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
          return send(200, { QueryResponse: { Invoice: ids.map((i) => st.invoices.get(i)).filter(Boolean) } });
        }
        if ((mm = /FROM Invoice WHERE DocNumber = '(.+)'$/.exec(sql))) {
          return send(200, { QueryResponse: { Invoice: [...st.invoices.values()].filter((i) => i.DocNumber === mm[1]) } });
        }
        if ((mm = /FROM Customer WHERE DisplayName = '(.+)'$/.exec(sql))) {
          return send(200, { QueryResponse: { Customer: [...st.customers.values()].filter((c) => c.DisplayName === mm[1].replace(/\\'/g, "'")) } });
        }
        return send(400, fault(4000, 'unsupported query in stub', sql));
      }
      const store = entity === 'customer' ? st.customers : entity === 'invoice' ? st.invoices : null;
      if (!store) return send(400, fault(2500, `unknown entity ${entity}`));
      const key = entity === 'customer' ? 'Customer' : 'Invoice';
      if (req.method === 'GET' && id) { const e = store.get(id); return e ? send(200, { [key]: e }) : send(400, fault(610, 'Object Not Found')); }
      if (req.method !== 'POST') return send(405, fault(405, 'method'));
      if (entity === 'customer' && [...st.customers.values()].some((c) => c.DisplayName === body.DisplayName && c.Id !== body.Id)) {
        return send(400, fault(6240, 'Duplicate Name Exists Error', 'The name supplied already exists.'));
      }
      if (body.Id) {
        const cur = store.get(body.Id);
        if (!cur) return send(400, fault(610, 'Object Not Found'));
        if (String(body.SyncToken) !== cur.SyncToken) return send(400, fault(5010, 'Stale Object Error'));
        const next = { ...cur, ...body, SyncToken: String(Number(cur.SyncToken) + 1) };
        delete next.sparse;
        if (entity === 'invoice') { const paid = cur.TotalAmt - cur.Balance; next.TotalAmt = totalOf(next); next.Balance = Math.round((next.TotalAmt - paid) * 100) / 100; }
        store.set(body.Id, next);
        return send(200, { [key]: next });
      }
      const Id = String(st.nextId++);
      const created = { ...body, Id, SyncToken: '0', MetaData: { CreateTime: new Date().toISOString(), LastUpdatedTime: new Date().toISOString() } };
      if (entity === 'invoice') { created.TotalAmt = totalOf(created); created.Balance = created.TotalAmt; }
      store.set(Id, created);
      return send(200, { [key]: created });
    });
  });
  st.pay = (invoiceId, amount, txnDate = '2026-11-20') => {
    const inv = st.invoices.get(String(invoiceId));
    inv.Balance = Math.round((inv.Balance - amount) * 100) / 100;
    inv.SyncToken = String(Number(inv.SyncToken) + 1);
    const p = { Id: String(st.nextId++), SyncToken: '0', TxnDate: txnDate, TotalAmt: amount, CustomerRef: inv.CustomerRef, Line: [{ Amount: amount, LinkedTxn: [{ TxnId: String(invoiceId), TxnType: 'Invoice' }] }], MetaData: { LastUpdatedTime: new Date().toISOString() } };
    st.payments.push(p);
    return p;
  };
  st.reset = () => { st.requests.length = 0; };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { st.base = `http://127.0.0.1:${server.address().port}`; st.close = () => new Promise((r) => server.close(r)); resolve(st); }));
}

async function cleanup() {
  if (!prisma) return;
  const safe = (p) => p.catch(() => {});
  const users = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map((u) => u.id);
  const custs = (await prisma.customer.findMany({ where: { OR: [{ lastName: { contains: RUN } }, { sourceSystem: { contains: RUN } }, { email: { contains: RUN } }, { firstName: { contains: RUN } }, { company: { contains: RUN } }] }, select: { id: true } })).map((c) => c.id);
  const jobs = (await prisma.job.findMany({ where: { OR: [{ customerId: { in: custs } }, { title: { contains: RUN } }] }, select: { id: true } })).map((j) => j.id);
  await safe(prisma.jobPhoto.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.invoice.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.quote.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.jobActivity.deleteMany({ where: { jobRef: { in: jobs } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobs } } }));
  await safe(prisma.communication.deleteMany({ where: { customerId: { in: custs } } }));
  await safe(prisma.customer.deleteMany({ where: { id: { in: custs } } }));
  await safe(prisma.integrationLink.deleteMany({ where: { OR: [{ provider: { contains: RUN } }, { provider: { startsWith: 'quickbooks:' } }] } }));
  await safe(prisma.integrationToken.deleteMany({ where: { provider: 'quickbooks' } }));
  await safe(prisma.apiKey.deleteMany({ where: { createdById: { in: users } } }));
  await safe(prisma.user.deleteMany({ where: { id: { in: users } } }));
}

before(async () => {
  await ensureDatabase(TEST_DB);
  prisma = require('../helpers/prisma');
  stub = await startQboStub();
  [S, IE, Q] = await Promise.all([
    bootServer({ BRAND_COMPANY_NAME: 'Example Plumbing Co', BRAND_TIMEZONE: 'America/Chicago' }),
    bootServer({
      BRAND_COUNTRY: 'IE', BRAND_TIMEZONE: 'Europe/Dublin', BRAND_COMPANY_NAME: 'Brightwater Heating Ltd',
      XERO_TAX_TYPES: 'standard=23% (VAT on Income)|none=No VAT', XERO_SALES_ACCOUNT_CODE: '4000',
    }),
    bootServer({
      SANDBOX_MODE: 'false', DEMO_MODE: 'false', BRAND_TAX_RATES: 'sales:8.5', BRAND_TIMEZONE: 'America/Chicago',
      QB_CLIENT_ID: stub.clientId, QB_CLIENT_SECRET: stub.clientSecret, QB_REDIRECT_URI: 'http://localhost/api/quickbooks/callback', QB_ENVIRONMENT: 'sandbox',
      QBO_AUTHORIZE_URL: `${stub.base}/connect/oauth2`, QBO_TOKEN_URL: `${stub.base}/oauth2/v1/tokens/bearer`, QBO_API_BASE: stub.base,
      QBO_US_TAX_CODE: '7', QBO_ITEM_ID: '42',
    }),
  ]);
  for (const [k, role] of [['admin', 'admin'], ['dispatcher', 'dispatcher'], ['tech', 'technician']]) {
    const u = await mkUser(role, k);
    U[k] = { id: u.id, email: u.email, token: await login(S, u.email) };
  }
});

after(async () => {
  try { await cleanup(); } finally {
    for (const s of servers) await s.stop();
    if (stub) await stub.close();
    if (prisma) await prisma.$disconnect().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CSV + cleaning (pure)
// ═════════════════════════════════════════════════════════════════════════════
test('csv: RFC 4180 quotes, doubled quotes, CRLF, newline inside a field, BOM, blank lines; unterminated quote fails', () => {
  const { parseCsv: p, CsvError } = require('../helpers/csv');
  const r = p('﻿a,b,c\r\n"x, y","say ""hi""","multi\nline"\r\n\r\n1,,3\n');
  assert.deepEqual(r.headers, ['a', 'b', 'c']);
  assert.deepEqual(r.rows, [['x, y', 'say "hi"', 'multi\nline'], ['1', '', '3']]);
  assert.deepEqual(r.lineOf, [2, 5]);
  assert.throws(() => p('a,b\n"open,1\n'), CsvError);
});

test('importer cleaning: Excel wrappers, E.164 (US/IE), strict dates, company names never split, name particles, address parsing', () => {
  const imp = require('../helpers/importer');
  const stats = { excel_wrapper_stripped: 0, non_printing_removed: 0, whitespace_collapsed: 0 };
  assert.equal(imp.cleanValue('="00501"', stats), '00501');
  assert.equal(imp.cleanValue('=52550', stats), '52550');
  assert.equal(imp.cleanValue('=SUM(A1)', stats), '=SUM(A1)', 'a real formula is not unwrapped');
  assert.equal(imp.cleanValue(' Ann​  Lee  ', stats), 'Ann Lee');
  assert.equal(stats.excel_wrapper_stripped, 2);
  assert.equal(imp.normalisePhone('(620) 555-0142', 'US'), '+16205550142');
  assert.equal(imp.normalisePhone('1-620-555-0142 ext 12', 'US'), '+16205550142');
  assert.equal(imp.normalisePhone('020 910 0142', 'IE'), '+353209100142');
  assert.equal(imp.normalisePhone('087 123 4567', 'IE'), '+353871234567');
  assert.equal(imp.normalisePhone('555-0142', 'US'), null);
  assert.equal(imp.normalisePhone('(120) 555-0142', 'US'), null, 'NANP area code cannot start with 1');
  assert.equal(imp.parseDate('2024-03-15', null).toISOString(), '2024-03-15T00:00:00.000Z');
  assert.throws(() => imp.parseDate('03/04/2024', null), (e) => e.rule === 'date_format_required');
  assert.equal(imp.parseDate('03/04/2024', 'DD/MM/YYYY').toISOString().slice(0, 10), '2024-04-03');
  assert.equal(imp.parseDate('03/04/2024', 'MM/DD/YYYY').toISOString().slice(0, 10), '2024-03-04');
  assert.throws(() => imp.parseDate('31/02/2024', 'DD/MM/YYYY'), (e) => e.rule === 'invalid_date');
  assert.equal(imp.parseCents('$1,234.50'), 123450);
  assert.equal(imp.parseCents('(10.5)'), -1050);
  assert.deepEqual(imp.splitPersonName('Aoife Ní Bhriain'), { firstName: 'Aoife', lastName: 'Ní Bhriain' });
  assert.deepEqual(imp.splitPersonName('Mary Ann Example'), { firstName: 'Mary Ann', lastName: 'Example' });
  assert.ok(imp.looksLikeCompany('X Construction LLC'));
  assert.ok(imp.looksLikeCompany('Smith & Sons'));
  assert.ok(!imp.looksLikeCompany('Sean Murphy'));
  assert.deepEqual(imp.parseFullAddress('12 Main St, Apt 4, Hutchinson, KS 67501', 'US'), { address: '12 Main St', addressLine2: 'Apt 4', city: 'Hutchinson', state: 'KS', zip: '67501' });
  assert.deepEqual(imp.parseFullAddress('3 Main St, Naas, Co. Kildare, W91X2Y4', 'IE'), { address: '3 Main St', addressLine2: null, city: 'Naas', state: 'Co. Kildare', zip: 'W91X2Y4' });
});

// ═════════════════════════════════════════════════════════════════════════════
// Customer import via API (sandbox server, US)
// ═════════════════════════════════════════════════════════════════════════════
function hcpCsv(tag) {
  return [
    'Customer ID,Customer,First Name,Last Name,Company,Email,Mobile Phone,Home Phone,Address,Job revenue,Notes,Tags',
    `${tag}-1,Maeve ${tag},Maeve,${tag},,MAEVE-${tag}@Example.com,="6205550142",,"12 Example Ave, Hutchinson, KS 67501","$1,250.00",Gate code,VIP`,
    `${tag}-2,Example Builders ${tag} LLC,,,Example Builders ${tag} LLC,office-${tag}@example.org,620-555-0199,,"400 Sample St, Suite 2, Wichita, KS 67202",8400,,`,
    `${tag}-3,Tom Placeholder,,,,,(316) 555-0100,,"9 Test Rd, Wichita, KS 6720",,,`,
    `${tag}-4,No Phone ${tag},,,,np-${tag}@example.com,,,"1 A St, Hutchinson, KS 67501",,,`,
    `${tag}-1,Maeve ${tag},Maeve,${tag},,maeve-${tag}@example.com,6205550142,,"77 Second Site Rd, Hutchinson, KS 67502",,,`,
    `${tag}-5,Maeve ${tag},Maeve,${tag},,maeve-${tag}@example.com,6205550142,,"12 Example Ave, Hutchinson, KS 67501",,dup person different id,`,
    `${tag}-6,Bad Type,,,,bt-${tag}@example.com,6205550111,,"2 B St, Hutchinson, KS 67501",,,`,
    `${tag}-7,"Smith & Sons ${tag}",,,,ss-${tag}@example.com,6205550122,,"3 C St, Hutchinson, KS 67501",,,`,
    `,No Id ${tag},,,,noid-${tag}@example.com,6205550133,,"4 D St, Hutchinson, KS 67501",,,`,
  ].join('\r\n') + '\r\n';
}

const importUrl = (q) => `/api/imports/customers?${new URLSearchParams(q)}`;

test('import dry run: every row explained (G3 equation), rules fail closed, nothing written; reports carry G1/G2/G5', async () => {
  const tag = `${RUN}a`;
  const csv = hcpCsv(tag);
  const before = await prisma.customer.count();
  const mapping = JSON.stringify({ sourceSystem: `hcp-${RUN}`, typeMap: {} });
  const r = await S.api('POST', importUrl({ source: 'housecallpro' }), { token: U.admin.token, raw: multipart({ file: { filename: 'customers.csv', content: csv }, mapping }) });
  assert.equal(r.status, 200, r.text);
  const rep = r.json;
  assert.equal(rep.mode, 'dry-run');
  assert.equal(await prisma.customer.count(), before, 'dry run wrote customers');
  assert.equal(rep.counts.sourceRows, 9);
  assert.equal(rep.counts.unexplained, 0);
  assert.equal(rep.counts.created + rep.counts.updated + rep.counts.merged + rep.counts.excluded + rep.counts.errored, 9);
  const byRow = Object.fromEntries(rep.rows.map((x) => [x.row, x]));
  assert.equal(byRow[1].outcome, 'created');
  assert.equal(byRow[2].outcome, 'created');
  assert.equal(byRow[3].rule, 'invalid_postcode', 'ZIP lost its leading zero → fail closed');
  assert.equal(byRow[4].rule, 'missing_phone');
  assert.equal(byRow[5].outcome, 'merged'); assert.equal(byRow[5].rule, 'same_source_id_extra_row');
  assert.equal(byRow[6].rule, 'pending_merge_decision', 'possible duplicate is held, not silently merged');
  assert.equal(byRow[8].outcome, 'created');
  assert.equal(byRow[9].rule, 'missing_source_id');
  // G1: checksum of the exact bytes
  assert.equal(rep.files[0].sha256, sha256(Buffer.from(csv)));
  // G2: mapping + unmapped + cleaning + merge candidates
  assert.equal(rep.mapping.sourceId, 'Customer ID');
  assert.equal(rep.mapping.addressFull, 'Address');
  assert.ok(rep.cleaning.excel_wrapper_stripped >= 1);
  assert.equal(rep.mergeCandidates.length, 1);
  assert.equal(rep.mergeCandidates[0].rule, 'auto_merge');
  assert.equal(rep.mergeCandidates[0].candidate.ref, 'row:1');
  assert.equal(rep.pendingDecisions, 1);
  // company names are never split: "Smith & Sons" is a company, type commercial
  const smith = rep.spotCheck.sample.find((s) => s.row === 8);
  assert.ok(smith, 'commercial stratum should include the Smith & Sons row');
  assert.equal(smith.mbcValues.company, `Smith & Sons ${tag}`);
  assert.equal(smith.mbcValues.firstName, `Smith & Sons ${tag}`);
  assert.equal(smith.mbcValues.lastName, '');
  assert.equal(smith.mbcValues.type, 'commercial');
  // G5 strata: top by lifetime value first
  assert.equal(rep.spotCheck.sample[0].stratum, 'top_by_lifetime_value');
  assert.equal(rep.spotCheck.sample[0].row, 2);
  assert.match(rep.markdown, /PASS: sourceRows = created \+ updated \+ merged \+ excluded \+ errored/);
  assert.match(rep.markdown, /1 merge decision\(s\) pending/);
  // zip bundle of all report artifacts
  const z = await S.api('POST', importUrl({ source: 'housecallpro', format: 'zip' }), { token: U.admin.token, raw: multipart({ file: { filename: 'customers.csv', content: csv }, mapping }) });
  assert.equal(z.status, 200);
  assert.equal(z.headers['content-type'], 'application/zip');
  const files = unzip(z.buf);
  assert.deepEqual(Object.keys(files).sort(), ['exceptions.csv', 'merge-candidates.csv', 'report.json', 'report.md', 'spot-check.csv']);
  const exc = parseCsv(files['exceptions.csv']);
  assert.deepEqual(exc.headers, ['file', 'row', 'line', 'source_id', 'outcome', 'rule', 'field', 'detail', 'decision', 'decided_by']);
  assert.equal(exc.rows.length, rep.counts.excluded + rep.counts.errored);
});

test('import: admin only, file required, bad source / options rejected, real run refused for API keys', async () => {
  const csv = hcpCsv(`${RUN}b`);
  assert.equal((await S.api('POST', importUrl({}), { token: U.dispatcher.token, raw: multipart({ file: { filename: 'x.csv', content: csv } }) })).status, 403);
  assert.equal((await S.api('POST', importUrl({}), { token: U.tech.token, raw: multipart({ file: { filename: 'x.csv', content: csv } }) })).status, 403);
  assert.equal((await S.api('POST', importUrl({}), { raw: multipart({ file: { filename: 'x.csv', content: csv } }) })).status, 401);
  const none = await S.api('POST', importUrl({}), { token: U.admin.token, raw: multipart({ mapping: '{}' }) });
  assert.equal(none.status, 400); assert.equal(none.json.code, 'REQUIRED');
  const bad = await S.api('POST', importUrl({ source: 'servicetitan' }), { token: U.admin.token, raw: multipart({ file: { filename: 'x.csv', content: csv } }) });
  assert.equal(bad.status, 400); assert.equal(bad.json.code, 'INVALID_ENUM');
  const badMap = await S.api('POST', importUrl({ source: 'housecallpro' }), { token: U.admin.token, raw: multipart({ file: { filename: 'x.csv', content: csv }, mapping: '{"fields":{"phone":"Fax"}}' }) });
  assert.equal(badMap.status, 400); assert.match(badMap.json.error, /Fax/);
  const badJson = await S.api('POST', importUrl({}), { token: U.admin.token, raw: multipart({ file: { filename: 'x.csv', content: csv }, mapping: '{nope' }) });
  assert.equal(badJson.status, 400); assert.equal(badJson.json.code, 'INVALID_JSON');
  const badOpt = await S.api('POST', importUrl({ options: '{"maxRow":5}' }), { token: U.admin.token, raw: multipart({ file: { filename: 'x.csv', content: csv } }) });
  assert.equal(badOpt.status, 400); assert.match(badOpt.json.error, /unknown option "maxRow"/);
  const unterminated = await S.api('POST', importUrl({}), { token: U.admin.token, raw: multipart({ file: { filename: 'x.csv', content: 'source_id,first_name\n"1,Ann\n' } }) });
  assert.equal(unterminated.status, 400); assert.equal(unterminated.json.code, 'INVALID_CSV');
  // API key (write scope) may dry-run but not commit
  const key = await S.api('POST', '/api/api-keys', { token: U.admin.token, body: { name: `it-${RUN}`, scopes: ['read', 'write'] } });
  assert.equal(key.status, 201, key.text);
  const k = key.json.key || key.json.apiKey || key.json.plaintext;
  const dry = await S.api('POST', importUrl({}), { headers: { 'X-API-Key': k }, raw: multipart({ file: { filename: 'x.csv', content: 'source_id,first_name,phone\n1,Ann,6205550100\n' } }) });
  assert.equal(dry.status, 200, dry.text);
  const real = await S.api('POST', importUrl({ dryRun: 'false' }), { headers: { 'X-API-Key': k }, raw: multipart({ file: { filename: 'x.csv', content: 'source_id,first_name,phone\n1,Ann,6205550100\n' } }) });
  assert.equal(real.status, 403); assert.equal(real.json.code, 'SESSION_REQUIRED');
  // template + presets
  const t = await S.api('GET', '/api/imports/templates/customers.csv', { token: U.admin.token });
  assert.equal(t.status, 200);
  assert.match(t.headers['content-disposition'], /filename\*=UTF-8''mbc_customers_import_template\.csv/);
  assert.equal(parseCsv(t.text).headers[0], 'source_id');
  assert.equal(fs.readFileSync(path.join(BACKEND, 'import-templates', 'customers-generic.csv'), 'utf8'), t.text, 'published template differs from the served one');
  const pr = await S.api('GET', '/api/imports/presets', { token: U.admin.token });
  assert.deepEqual(Object.keys(pr.json.presets).sort(), ['generic', 'housecallpro', 'jobber']);
});

test('import commit: one transaction per batch, idempotent re-run, merge decisions recorded, sha guard, undo restores', async () => {
  const tag = `${RUN}c`;
  const csv = hcpCsv(tag);
  const sourceSystem = `hcp-${RUN}c`;
  const mapping = JSON.stringify({ sourceSystem });
  const file = () => ({ filename: 'customers.csv', content: csv });
  // sha guard
  const guard = await S.api('POST', importUrl({ source: 'housecallpro', dryRun: 'false', expectSha256: 'f'.repeat(64) }), { token: U.admin.token, raw: multipart({ file: file(), mapping }) });
  assert.equal(guard.status, 409); assert.equal(guard.json.code, 'FILE_CHANGED');
  assert.equal(await prisma.customer.count({ where: { sourceSystem } }), 0, 'sha mismatch wrote rows');

  const r1 = await S.api('POST', importUrl({ source: 'housecallpro', dryRun: 'false', expectSha256: sha256(Buffer.from(csv)), options: JSON.stringify({ batchSize: 2 }) }), { token: U.admin.token, raw: multipart({ file: file(), mapping }) });
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.mode, 'commit'); assert.equal(r1.json.committed, true);
  assert.equal(r1.json.counts.created, 4); assert.equal(r1.json.counts.unexplained, 0);
  assert.ok(r1.json.batches.length >= 2 && r1.json.batches.every((b) => b.status === 'committed'));
  const rows = await prisma.customer.findMany({ where: { sourceSystem }, orderBy: { sourceId: 'asc' } });
  assert.equal(rows.length, 4);
  const maeve = rows.find((c) => c.sourceId === `${tag}-1`);
  assert.equal(maeve.email, `maeve-${tag}@example.com`, 'email lowercased');
  assert.equal(maeve.phone, '+16205550142', 'Excel wrapper stripped + E.164');
  assert.equal(maeve.city, 'Hutchinson'); assert.equal(maeve.state, 'KS'); assert.equal(maeve.zip, '67501');
  assert.match(maeve.notes, /^Gate code\nTags: VIP\nOther address: 77 Second Site Rd, Hutchinson, KS, 67502$/);
  const builders = rows.find((c) => c.sourceId === `${tag}-2`);
  assert.equal(builders.type, 'commercial'); assert.equal(builders.company, `Example Builders ${tag} LLC`); assert.equal(builders.lastName, '');
  assert.equal(builders.addressLine2, 'Suite 2');

  // re-run: nothing new, nothing changed (idempotent)
  const r2 = await S.api('POST', importUrl({ source: 'housecallpro', dryRun: 'false' }), { token: U.admin.token, raw: multipart({ file: file(), mapping }) });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.counts.created, 0);
  assert.equal(r2.json.counts.updated, 4); assert.equal(r2.json.counts.updatedUnchanged, 4);
  assert.equal(await prisma.customer.count({ where: { sourceSystem } }), 4);
  assert.equal((await prisma.customer.findUnique({ where: { id: maeve.id } })).notes, maeve.notes, 'extra-address note appended twice');

  // decide the held duplicate: merge it into the existing Maeve (by its key from merge-candidates.csv)
  const dry = await S.api('POST', importUrl({ source: 'housecallpro', format: 'zip' }), { token: U.admin.token, raw: multipart({ file: file(), mapping }) });
  const mc = parseCsv(unzip(dry.buf)['merge-candidates.csv']);
  assert.equal(mc.rows.length, 1);
  const ki = mc.headers.indexOf('key'); const di = mc.headers.indexOf('decision'); const bi = mc.headers.indexOf('decided_by');
  assert.equal(mc.rows[0][ki], `${tag}-5`);
  assert.equal(mc.rows[0][mc.headers.indexOf('candidate')], `customer:${maeve.id}`);
  mc.rows[0][di] = 'merge'; mc.rows[0][bi] = 'Client owner 2026-11-21';
  const decisions = [mc.headers.join(','), ...mc.rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n');
  const r3 = await S.api('POST', importUrl({ source: 'housecallpro', dryRun: 'false' }), { token: U.admin.token, raw: multipart({ file: file(), mapping, decisions: { filename: 'merge-candidates.csv', content: decisions } }) });
  assert.equal(r3.status, 200, r3.text);
  const merged = r3.json.rows.find((x) => x.sourceId === `${tag}-5`);
  assert.equal(merged.outcome, 'merged'); assert.equal(merged.customerId, maeve.id);
  assert.equal(r3.json.pendingDecisions, 0);
  const link = await prisma.integrationLink.findFirst({ where: { provider: `import:${sourceSystem}`, entity: 'customer', remoteId: `${tag}-5` } });
  assert.equal(link.localId, maeve.id);
  assert.match((await prisma.customer.findUnique({ where: { id: maeve.id } })).notes, new RegExp(`\\[merged ${sourceSystem}:${tag}-5`));
  // and a further run treats it as previously merged
  const r4 = await S.api('POST', importUrl({ source: 'housecallpro' }), { token: U.admin.token, raw: multipart({ file: file(), mapping }) });
  assert.equal(r4.json.rows.find((x) => x.sourceId === `${tag}-5`).rule, 'previously_merged');

  // undo the first committed run's creations needs the merge undone first → undo r3 then r1
  const u3 = await S.api('POST', '/api/imports/customers/undo', { token: U.admin.token, raw: multipart({ report: { filename: 'report.json', content: JSON.stringify(r3.json) } }) });
  assert.equal(u3.status, 200, u3.text);
  assert.equal(u3.json.unlinked, 1); assert.equal(u3.json.restored, 1);
  assert.equal((await prisma.customer.findUnique({ where: { id: maeve.id } })).notes, maeve.notes);
  const u1 = await S.api('POST', '/api/imports/customers/undo', { token: U.admin.token, body: r1.json });
  assert.equal(u1.status, 200, u1.text);
  assert.equal(u1.json.deleted, 4);
  assert.equal(await prisma.customer.count({ where: { sourceSystem } }), 0);
});

test('import commit: a failing batch rolls back completely and later batches are not attempted (rows stay explained)', async () => {
  const imp = require('../helpers/importer');
  const sourceSystem = `gen-${RUN}d`;
  const lines = ['source_id,first_name,last_name,phone,email'];
  for (let i = 1; i <= 6; i += 1) lines.push(`D${i},Row${i},${RUN},620555${String(1000 + i)},d${i}-${RUN}@example.com`);
  const plan = await imp.planCustomerImport({ files: [{ name: 'g.csv', content: lines.join('\n') }], source: 'generic', mapping: { sourceSystem }, options: { batchSize: 2 }, prisma });
  assert.equal(plan.report.counts.created, 6);
  // someone creates D4 between the dry run and the commit → batch 2 hits the unique key
  await prisma.customer.create({ data: { firstName: 'Race', lastName: RUN, phone: '', address: '', sourceSystem, sourceId: 'D4' } });
  const rep = await imp.commitCustomerImport(plan);
  assert.equal(rep.committed, false);
  assert.deepEqual(rep.batches.map((b) => b.status), ['committed', 'rolled_back', 'not_attempted']);
  assert.equal(rep.counts.created, 2); assert.equal(rep.counts.errored, 4); assert.equal(rep.counts.unexplained, 0);
  assert.deepEqual(rep.rows.filter((r) => r.outcome === 'errored').map((r) => r.rule), ['batch_rolled_back', 'batch_rolled_back', 'not_attempted_after_batch_failure', 'not_attempted_after_batch_failure']);
  const ids = (await prisma.customer.findMany({ where: { sourceSystem }, select: { sourceId: true } })).map((c) => c.sourceId).sort();
  assert.deepEqual(ids, ['D1', 'D2', 'D4'], 'D3 of the failed batch must have been rolled back');
  assert.match(imp.renderMarkdown(rep), /Batch 2 rolled back/);
});

test('import Jobber + IE locale: Is Company?, Archived scope rule, Eircode normalised, county required, DD/MM/YYYY dates', async () => {
  const tag = `${RUN}e`;
  const csv = [
    'J-ID,Display name,First name,Last name,Company name,Is Company?,E-mails,Main phone,Billing street 1,Billing street 2,Billing city,Billing state,Billing zip code,Billing country,Archived,Created date',
    `J1,Aoife ${tag},Aoife,${tag},,FALSE,aoife-${tag}@example.ie,087 123 4567,2 Synthetic Rd,,Naas,Co. Kildare,w91x2y4,Ireland,FALSE,15/03/2024`,
    `J2,Brightwater ${tag},,,Brightwater ${tag},TRUE,"acc-${tag}@example.ie, ops-${tag}@example.ie",01 555 0101,Unit 4 Example Park,,Dublin 8,Co. Dublin,D08 X2Y4,IE,FALSE,01/12/2023`,
    `J3,Old Client ${tag},Old,${tag},,FALSE,old-${tag}@example.ie,087 765 4321,1 Gone St,,Cork,Co. Cork,,IE,TRUE,01/01/2020`,
    `J4,No County ${tag},No,${tag},,FALSE,nc-${tag}@example.ie,087 111 2222,5 Somewhere,,Galway,,,IE,FALSE,02/02/2022`,
    `J5,Bad Eircode ${tag},Bad,${tag},,FALSE,be-${tag}@example.ie,087 333 4444,6 Somewhere,,Galway,Co. Galway,ZZZ,IE,FALSE,02/02/2022`,
  ].join('\n');
  const mapping = JSON.stringify({ sourceSystem: `jobber-${RUN}`, dateFormat: 'DD/MM/YYYY', options: { excludeArchived: true } });
  const r = await IE.api('POST', importUrl({ source: 'jobber', dryRun: 'false' }), { token: U.admin.token, raw: multipart({ file: { filename: 'clients.csv', content: csv }, mapping }) });
  assert.equal(r.status, 200, r.text);
  const by = Object.fromEntries(r.json.rows.map((x) => [x.sourceId, x]));
  assert.equal(by.J1.outcome, 'created'); assert.equal(by.J2.outcome, 'created');
  assert.equal(by.J3.outcome, 'excluded'); assert.equal(by.J3.rule, 'archived_out_of_scope');
  assert.equal(by.J4.outcome, 'errored'); assert.equal(by.J4.rule, 'address_required'); assert.equal(by.J4.field, 'state');
  assert.equal(by.J5.rule, 'invalid_postcode');
  assert.equal(r.json.counts.unexplained, 0);
  const a = await prisma.customer.findFirst({ where: { sourceSystem: `jobber-${RUN}`, sourceId: 'J1' } });
  assert.equal(a.zip, 'W91 X2Y4'); assert.equal(a.phone, '+353871234567'); assert.equal(a.country, 'IE'); assert.equal(a.type, 'residential');
  assert.equal(a.createdAt.toISOString().slice(0, 10), '2024-03-15');
  const b = await prisma.customer.findFirst({ where: { sourceSystem: `jobber-${RUN}`, sourceId: 'J2' } });
  assert.equal(b.type, 'commercial'); assert.equal(b.company, `Brightwater ${tag}`); assert.equal(b.firstName, `Brightwater ${tag}`);
  assert.equal(b.email, `acc-${tag}@example.ie`); assert.match(b.notes, new RegExp(`Other email: ops-${tag}@example.ie`));
  assert.equal(b.phone, '+35315550101');
  await prisma.customer.deleteMany({ where: { sourceSystem: `jobber-${RUN}` } });
});

test('import CLI: --dry-run writes the five report files and nothing else; exactly one of --dry-run / --commit', async () => {
  const dir = path.join(TMP, 'cli');
  fs.mkdirSync(dir);
  const f = path.join(dir, 'c.csv');
  fs.writeFileSync(f, `source_id,first_name,last_name,phone,created_at\nCLI1,Ann,${RUN},6205550100,2024-01-02\nCLI2,Bob,${RUN},bad,2024-01-02\n`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB, JWT_SECRET: SECRET };
  const out = path.join(dir, 'out');
  const r = spawnSync(process.execPath, ['scripts/import-customers.js', '--file', f, '--dry-run', '--out', out, '--source-system', `cli-${RUN}`], { cwd: BACKEND, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /customers\s+2\s+1\s+0\s+0\s+0\s+1\s+0/);
  assert.deepEqual(fs.readdirSync(out).sort(), ['exceptions.csv', 'merge-candidates.csv', 'report.json', 'report.md', 'spot-check.csv']);
  assert.equal(await prisma.customer.count({ where: { sourceSystem: `cli-${RUN}` } }), 0);
  const both = spawnSync(process.execPath, ['scripts/import-customers.js', '--file', f], { cwd: BACKEND, env, encoding: 'utf8' });
  assert.equal(both.status, 1); assert.match(both.stderr, /exactly one of --dry-run or --commit/);
  const src = fs.readFileSync(path.join(BACKEND, 'scripts', 'import-customers.js'), 'utf8');
  assert.match(src, /Setup \/ run \(Terminal\):\n \*   1\./, 'numbered setup steps at the top of the script');
});

// ═════════════════════════════════════════════════════════════════════════════
// Exports
// ═════════════════════════════════════════════════════════════════════════════
test('exports: quotes + invoices include lines (linesJson, view=lines), formula escaping kept, admin only', async () => {
  const c = await mkCustomer();
  const j1 = await mkJob(c.id); const j2 = await mkJob(c.id);
  const q = await S.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: j1.id, lines: [{ description: '=cmd|/c calc!A0', quantity: 2, unitPrice: 50 }, { description: 'Valve', quantity: 1, unitPrice: 19.99 }] } });
  assert.equal(q.status, 201, q.text);
  const inv = await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: j2.id, lines: [{ description: 'Call-out', quantity: 1, unitPrice: 85 }] } });
  assert.equal(inv.status, 201, inv.text);
  const qr = await S.api('GET', '/api/exports/quotes', { token: U.admin.token });
  assert.equal(qr.status, 200);
  assert.match(qr.headers['content-disposition'], /filename="Example_Plumbing_Co_quotes\.csv"; filename\*=UTF-8''Example_Plumbing_Co_quotes\.csv/);
  const qcsv = parseCsv(qr.text);
  const row = qcsv.rows.find((r) => r[0] === String(q.json.id));
  assert.equal(row[qcsv.headers.indexOf('lineCount')], '2');
  assert.equal(JSON.parse(row[qcsv.headers.indexOf('linesJson')])[0].description, '=cmd|/c calc!A0');
  const ql = parseCsv((await S.api('GET', '/api/exports/quotes?view=lines', { token: U.admin.token })).text);
  const lineRows = ql.rows.filter((r) => r[0] === String(q.json.id));
  assert.equal(lineRows.length, 2);
  assert.equal(lineRows[0][ql.headers.indexOf('description')], "'=cmd|/c calc!A0", 'formula-leading cell escaped');
  const ir = parseCsv((await S.api('GET', '/api/exports/invoices', { token: U.admin.token })).text);
  assert.deepEqual(ir.headers.slice(0, 14), ['id', 'amount', 'status', 'dueDate', 'paidAt', 'jobTitle', 'customerName', 'createdAt', 'number', 'currency', 'subtotal', 'taxTotal', 'reverseCharge', 'issuedAt'], 'existing columns keep their positions');
  const il = parseCsv((await S.api('GET', '/api/exports/invoices?view=lines', { token: U.admin.token })).text);
  assert.ok(il.rows.some((r) => r[0] === String(inv.json.id) && r[il.headers.indexOf('lineTotal')] === '85'));
  assert.equal((await S.api('GET', '/api/exports/quotes?view=nope', { token: U.admin.token })).status, 400);
  assert.equal((await S.api('GET', '/api/exports/quotes', { token: U.dispatcher.token })).status, 403);
  assert.equal((await S.api('GET', '/api/exports/all', { token: U.tech.token })).status, 403);
});

test('exports/all: zip of every table + photos, manifest row counts and sha256 verify, secrets never exported', async () => {
  const c = await mkCustomer({ notes: '@SUM(1+1)' });
  const j = await mkJob(c.id);
  const key = `jobs/${j.id}/${Date.now()}-${RUN}-pipe.jpg`;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]);
  fs.mkdirSync(path.join(STORAGE, 'jobs', String(j.id)), { recursive: true });
  fs.writeFileSync(path.join(STORAGE, ...key.split('/')), jpeg);
  const ph = await prisma.jobPhoto.create({ data: { jobId: j.id, key, originalName: 'pipe.jpg', contentType: 'image/jpeg', size: jpeg.length } });
  const gone = await prisma.jobPhoto.create({ data: { jobId: j.id, key: `jobs/${j.id}/missing-${RUN}.jpg`, originalName: 'missing.jpg' } });
  await prisma.integrationToken.upsert({ where: { provider: 'quickbooks' }, create: { provider: 'quickbooks', accessToken: 'v1:SECRET-AT', refreshToken: 'v1:SECRET-RT' }, update: { accessToken: 'v1:SECRET-AT', refreshToken: 'v1:SECRET-RT' } });

  const r = await S.api('GET', '/api/exports/all', { token: U.admin.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['content-type'], 'application/zip');
  assert.match(r.headers['content-disposition'], /^attachment; filename="Example_Plumbing_Co_export_\d{4}-\d{2}-\d{2}\.zip"; filename\*=UTF-8''/);
  const files = unzip(r.buf);
  const manifest = JSON.parse(files['manifest.json']);
  for (const f of ['customers.csv', 'jobs.csv', 'quotes.csv', 'quote_lines.csv', 'invoices.csv', 'invoice_lines.csv', 'pricebook.csv', 'communications.csv', 'job_activity.csv', 'users.csv', 'job_photos.csv']) {
    assert.ok(files[f], `${f} missing`);
  }
  // every file in the manifest: bytes + sha256 match; SHA256SUMS lists the same
  for (const f of manifest.files) {
    assert.equal(sha256(files[f.path]), f.sha256, f.path);
    assert.equal(files[f.path].length, f.bytes, f.path);
  }
  const sums = files.SHA256SUMS.toString().trim().split('\n');
  assert.equal(sums.length, manifest.files.length);
  // row counts equal the database
  const counts = { Customer: await prisma.customer.count(), Job: await prisma.job.count(), Invoice: await prisma.invoice.count(), InvoiceLine: await prisma.invoiceLine.count(), Quote: await prisma.quote.count(), User: await prisma.user.count(), JobActivity: await prisma.jobActivity.count() };
  for (const [t, n] of Object.entries(counts)) {
    const entry = manifest.files.find((f) => f.table === t && f.rows !== undefined);
    assert.equal(entry.rows, n, `${t} rows`);
    assert.equal(parseCsv(files[entry.path]).rows.length, n, `${t} csv rows`);
  }
  // secrets
  const users = parseCsv(files['users.csv']);
  assert.ok(!users.headers.includes('password'));
  assert.ok(!files['users.csv'].toString().includes('$2a$') && !files['users.csv'].toString().includes('$2b$'), 'bcrypt hash leaked');
  assert.ok(!Object.keys(files).some((n) => /api_?key|integration_?token/i.test(n)));
  const whole = Object.values(files).map((b) => b.toString('latin1')).join('');
  assert.ok(!whole.includes('SECRET-AT') && !whole.includes('SECRET-RT'), 'OAuth tokens leaked');
  assert.deepEqual(manifest.excluded.map((e) => e.table).sort(), ['ApiKey', 'AuthToken', 'IntegrationToken', '_prisma_migrations']);
  // formula escaping and decimals
  const cust = parseCsv(files['customers.csv']);
  const crow = cust.rows.find((x) => x[0] === String(c.id));
  assert.equal(crow[cust.headers.indexOf('notes')], "'@SUM(1+1)");
  const pb = parseCsv(files['pricebook.csv']);
  if (pb.rows.length) assert.match(pb.rows[0][pb.headers.indexOf('price')], /^-?\d+\.\d{2}$/);
  // photos
  const photoEntry = manifest.files.find((f) => f.photoId === ph.id);
  assert.ok(photoEntry, 'photo not in manifest');
  assert.ok(files[photoEntry.path].equals(jpeg));
  assert.equal(photoEntry.path, `photos/${j.id}/${ph.id}-pipe.jpg`);
  assert.ok(manifest.photos.missing.some((m) => m.photoId === gone.id));
  // photos=false
  const np = unzip((await S.api('GET', '/api/exports/all?photos=false', { token: U.admin.token })).buf);
  assert.ok(!Object.keys(np).some((k) => k.startsWith('photos/')));
  await prisma.integrationToken.deleteMany({ where: { provider: 'quickbooks' } });
  await prisma.jobPhoto.deleteMany({ where: { id: { in: [ph.id, gone.id] } } });
});

// ═════════════════════════════════════════════════════════════════════════════
// Xero
// ═════════════════════════════════════════════════════════════════════════════
test('xero: line tax allocation sums exactly to the document tax per rate group', () => {
  const { allocateLineTax } = require('../helpers/xero');
  const lines = [
    { lineTotal: 100.10, taxRateKey: 'reduced', taxRate: 13.5 }, { lineTotal: 0.10, taxRateKey: 'reduced', taxRate: 13.5 },
    { lineTotal: 19.99, taxRateKey: 'standard', taxRate: 23 }, { lineTotal: 0.65, taxRateKey: 'standard', taxRate: 23 },
    { lineTotal: -10, taxRateKey: 'standard', taxRate: 23 },
  ];
  const m = allocateLineTax(lines, false);
  const sum = [...m.values()].reduce((s, x) => s + x, 0);
  // reduced: 100.20 × 13.5 % = 13.527 → 13.53; standard: 10.64 × 23 % = 2.4472 → 2.45
  assert.equal(sum, 1353 + 245);
  assert.equal(m.get(lines[0]) + m.get(lines[1]), 1353);
  assert.equal([...m.values()].reduce((s, x) => s + x, 0), 1598);
  const rc = allocateLineTax(lines, true);
  assert.ok([...rc.values()].every((x) => x === 0));
});

test('xero-invoices: Xero template columns, one row per line, DD/MM/YYYY (IE), tax names from XERO_TAX_TYPES, void + out-of-range excluded', async () => {
  const c = await mkCustomer({ country: 'IE', address: '2 Synthetic Rd', city: 'Naas', state: 'Co. Kildare', zip: 'W91 X2Y4', company: `Brightwater Client ${RUN}` });
  const j1 = await mkJob(c.id); const j2 = await mkJob(c.id); const j3 = await mkJob(c.id);
  const mk = (jobId, body) => IE.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId, ...body } });
  const i1 = await mk(j1.id, { issuedAt: '2026-10-05T10:00:00Z', dueDate: '2026-10-19', lines: [
    { description: 'Boiler service', quantity: 1, unitPrice: 100.10, taxRateKey: 'reduced' },
    { description: 'Valve', quantity: 2, unitPrice: 19.99, taxRateKey: 'standard' },
    { description: 'Disposal (no VAT)', quantity: 1, unitPrice: 5, taxRateKey: null },
  ] });
  assert.equal(i1.status, 201, i1.text);
  const i2 = await mk(j2.id, { issuedAt: '2026-10-06T10:00:00Z', lines: [{ description: 'Void me', quantity: 1, unitPrice: 10 }] });
  await prisma.invoice.update({ where: { id: i2.json.id }, data: { status: 'void' } });
  const i3 = await mk(j3.id, { issuedAt: '2026-12-01T10:00:00Z', lines: [{ description: 'Later', quantity: 1, unitPrice: 10 }] });
  const r = await IE.api('GET', '/api/exports/xero-invoices?from=2026-10-01&to=2026-10-31', { token: U.admin.token });
  assert.equal(r.status, 200, r.text);
  const { XERO_COLUMNS } = require('../helpers/xero');
  const csv = parseCsv(r.text);
  assert.deepEqual(csv.headers, XERO_COLUMNS);
  const mine = csv.rows.filter((row) => row[csv.headers.indexOf('*InvoiceNumber')] === i1.json.number);
  assert.equal(mine.length, 3, 'one row per invoice line');
  assert.ok(!csv.rows.some((row) => [i2.json.number, i3.json.number].includes(row[csv.headers.indexOf('*InvoiceNumber')])), 'void / out-of-range invoice exported');
  const col = (row, name) => row[csv.headers.indexOf(name)];
  assert.equal(col(mine[0], '*ContactName'), `Brightwater Client ${RUN}`);
  assert.equal(col(mine[0], '*InvoiceDate'), '05/10/2026');
  assert.equal(col(mine[0], '*DueDate'), '19/10/2026');
  assert.equal(col(mine[0], 'POPostalCode'), 'W91 X2Y4');
  assert.equal(col(mine[0], 'POCountry'), 'Ireland');
  assert.equal(col(mine[0], '*AccountCode'), '4000');
  assert.equal(col(mine[0], 'Currency'), 'EUR');
  assert.equal(col(mine[1], '*Quantity'), '2');
  assert.equal(col(mine[1], '*UnitAmount'), '19.99');
  assert.equal(col(mine[1], '*TaxType'), '23% (VAT on Income)');
  assert.equal(col(mine[2], '*TaxType'), 'No VAT');
  assert.equal(col(mine[0], '*TaxType'), '13.5% (VAT on Income)', 'unmapped key → placeholder name');
  assert.match(r.headers['x-mbc-xero-unmapped-tax'], /reduced/);
  const taxSum = mine.reduce((s, row) => s + Math.round(Number(col(row, 'TaxAmount')) * 100), 0);
  assert.equal(taxSum, Math.round(i1.json.taxTotal * 100), 'line TaxAmounts must add up to the invoice tax');
  assert.equal(col(mine[0], 'Total'), i1.json.amount.toFixed(2));
  assert.equal((await IE.api('GET', '/api/exports/xero-invoices?from=2026-11-01&to=2026-10-01', { token: U.admin.token })).status, 400);
  assert.equal((await IE.api('GET', '/api/exports/xero-invoices?from=yesterday', { token: U.admin.token })).status, 400);
  assert.equal((await IE.api('GET', '/api/exports/xero-invoices?status=void', { token: U.admin.token })).status, 400);
  const us = await S.api('GET', '/api/exports/xero-invoices', { token: U.admin.token });
  assert.equal(us.status, 200); assert.equal(us.headers['x-mbc-xero-date-format'], 'MM/DD/YYYY');
  assert.equal((await IE.api('GET', '/api/exports/xero-invoices', { token: U.dispatcher.token })).status, 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// QuickBooks Online
// ═════════════════════════════════════════════════════════════════════════════
test('qbo: intuit-oauth is gone; sandbox server answers 503 for every live action and sends nothing', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies['intuit-oauth'], 'intuit-oauth still a dependency');
  assert.throws(() => require.resolve('intuit-oauth', { paths: [BACKEND] }));
  stub.reset();
  for (const [m, p] of [['POST', '/api/quickbooks/connect'], ['POST', '/api/quickbooks/sync-invoice/1'], ['POST', '/api/quickbooks/sync-payments'], ['GET', '/api/quickbooks/callback?code=good-code&state=x&realmId=1']]) {
    const r = await S.api(m, p, { token: U.admin.token });
    assert.equal(r.status, 503, `${m} ${p} → ${r.status} ${r.text}`);
    assert.equal(r.json.sandbox, true);
  }
  assert.equal(stub.requests.length, 0, 'sandbox made a QuickBooks request');
});

let qboAdmin;
test('qbo OAuth: authorize URL, state bound to admin + cookie, code exchange with Basic auth, tokens encrypted, state single-use', async () => {
  qboAdmin = await login(Q, U.admin.email);
  const c = await Q.api('POST', '/api/quickbooks/connect', { token: qboAdmin });
  assert.equal(c.status, 200, c.text);
  const u = new URL(c.json.authUrl);
  assert.equal(`${u.origin}${u.pathname}`, `${stub.base}/connect/oauth2`);
  assert.equal(u.searchParams.get('client_id'), stub.clientId);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost/api/quickbooks/callback');
  const state = u.searchParams.get('state');
  assert.ok(state.length >= 40);
  const cookie = /mbc_qbo_state=[^;]+/.exec(c.headers['set-cookie'].join(';'))[0];
  // wrong cookie → refused, no exchange
  stub.reset();
  const forged = await Q.api('GET', `/api/quickbooks/callback?code=good-code&state=${state}&realmId=9130357`, { cookie: 'mbc_qbo_state=other' });
  assert.equal(forged.headers.location, '/?qbo=error&reason=state');
  assert.equal(stub.requests.length, 0);
  // state was consumed by the forged attempt? It must not be: a fresh connect gives a new one
  const c2 = await Q.api('POST', '/api/quickbooks/connect', { token: qboAdmin });
  const state2 = new URL(c2.json.authUrl).searchParams.get('state');
  const cookie2 = /mbc_qbo_state=[^;]+/.exec(c2.headers['set-cookie'].join(';'))[0];
  const ok = await Q.api('GET', `/api/quickbooks/callback?code=good-code&state=${encodeURIComponent(state2)}&realmId=9130357`, { cookie: cookie2 });
  assert.equal(ok.status, 302); assert.equal(ok.headers.location, '/?qbo=connected');
  const ex = stub.requests.find((r) => r.path === '/oauth2/v1/tokens/bearer');
  assert.ok(ex, 'no token exchange');
  assert.equal(ex.form.grant_type, 'authorization_code');
  assert.equal(ex.form.code, 'good-code');
  assert.equal(ex.form.redirect_uri, 'http://localhost/api/quickbooks/callback');
  assert.equal(ex.headers['content-type'], 'application/x-www-form-urlencoded');
  const row = await prisma.integrationToken.findUnique({ where: { provider: 'quickbooks' } });
  assert.equal(row.realmId, '9130357');
  assert.ok(row.accessToken.startsWith('v1:') && !row.accessToken.includes(stub.access), 'access token stored in clear');
  assert.ok(!row.refreshToken.includes(stub.refresh));
  const replay = await Q.api('GET', `/api/quickbooks/callback?code=good-code&state=${encodeURIComponent(state2)}&realmId=9130357`, { cookie: cookie2 });
  assert.equal(replay.headers.location, '/?qbo=error&reason=state', 'state reusable');
  const bad = await Q.api('POST', '/api/quickbooks/connect', { token: qboAdmin });
  const st3 = new URL(bad.json.authUrl).searchParams.get('state');
  const ck3 = /mbc_qbo_state=[^;]+/.exec(bad.headers['set-cookie'].join(';'))[0];
  assert.equal((await Q.api('GET', `/api/quickbooks/callback?code=good-code&state=${encodeURIComponent(st3)}&realmId=12;DROP`, { cookie: ck3 })).headers.location, '/?qbo=error&reason=realm');
  const status = await Q.api('GET', '/api/quickbooks/status', { token: qboAdmin });
  assert.equal(status.json.connected, true); assert.equal(status.json.enabled, true);
  assert.ok(!JSON.stringify(status.json).includes(stub.access));
  void state; void cookie;
});

async function qboInvoice(lines, extra = {}) {
  const c = await mkCustomer({ firstName: `Q${crypto.randomBytes(2).toString('hex')}`, ...extra.customer });
  const j = await mkJob(c.id);
  const r = await Q.api('POST', '/api/invoices', { token: qboAdmin, body: { jobId: j.id, lines, issuedAt: '2026-11-10T15:00:00Z', dueDate: '2026-11-24' } });
  assert.equal(r.status, 201, r.text);
  return { invoice: r.json, customer: c };
}

let pushed;
test('qbo invoice push: creates Customer + Invoice with lines, per-line TAX/NON, TxnTaxDetail; idempotent; update uses SyncToken', async () => {
  const { invoice, customer } = await qboInvoice([
    { description: 'Water heater install', quantity: 1, unitPrice: 1200, taxRateKey: 'sales' },
    { description: 'Labour', quantity: 3, unitPrice: 95, taxRateKey: null },
  ]);
  stub.reset();
  const r = await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.action, 'created'); assert.equal(r.json.customer.action, 'created');
  assert.deepEqual(r.json.warnings, []);
  const custReq = stub.requests.find((x) => x.path.endsWith('/customer') && x.method === 'POST');
  assert.equal(custReq.body.DisplayName, `${customer.firstName} ${customer.lastName}`);
  assert.equal(custReq.body.PrimaryEmailAddr.Address, customer.email);
  assert.equal(custReq.body.BillAddr.PostalCode, '67501');
  const invReq = stub.requests.find((x) => x.path.endsWith('/invoice') && x.method === 'POST');
  assert.equal(invReq.query.minorversion, '75');
  assert.equal(invReq.headers.authorization, `Bearer ${stub.access}`);
  assert.equal(invReq.body.DocNumber, invoice.number);
  assert.equal(invReq.body.TxnDate, '2026-11-10');
  assert.equal(invReq.body.DueDate, '2026-11-24');
  assert.equal(invReq.body.Line.length, 2);
  assert.deepEqual(invReq.body.Line.map((l) => l.SalesItemLineDetail.TaxCodeRef.value), ['TAX', 'NON']);
  assert.deepEqual(invReq.body.Line.map((l) => l.SalesItemLineDetail.ItemRef.value), ['42', '42']);
  assert.deepEqual(invReq.body.Line.map((l) => [l.Amount, l.SalesItemLineDetail.Qty, l.SalesItemLineDetail.UnitPrice]), [[1200, 1, 1200], [285, 3, 95]]);
  assert.deepEqual(invReq.body.TxnTaxDetail, { TxnTaxCodeRef: { value: '7' }, TotalTax: 102 });
  assert.equal(r.json.qbo.totalAmt, invoice.amount);
  assert.match(invReq.body.PrivateNote, new RegExp(`MBC invoice ${invoice.number} \\(id ${invoice.id}\\)`));
  // idempotent: second push changes nothing and creates nothing
  stub.reset();
  const again = await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(again.json.action, 'unchanged'); assert.equal(again.json.customer.action, 'unchanged');
  assert.equal(stub.requests.filter((x) => x.method === 'POST' && /\/(invoice|customer)$/.test(x.path)).length, 0);
  // edit the (unsent, unpaid) invoice → update with Id + SyncToken
  const cur = await Q.api('GET', `/api/invoices/${invoice.id}`, { token: qboAdmin });
  const patch = await Q.api('PATCH', `/api/invoices/${invoice.id}`, { token: qboAdmin, body: { version: cur.json.version, lines: [{ description: 'Water heater install', quantity: 1, unitPrice: 1250, taxRateKey: 'sales' }] } });
  assert.equal(patch.status, 200, patch.text);
  stub.reset();
  const upd = await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(upd.json.action, 'updated');
  const u = stub.requests.find((x) => x.path.endsWith('/invoice') && x.method === 'POST');
  assert.equal(u.body.Id, r.json.qbo.id); assert.equal(u.body.SyncToken, '0'); assert.equal(u.body.sparse, true);
  assert.equal(upd.json.qbo.syncToken, '1');
  const link = await Q.api('GET', `/api/quickbooks/invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(link.json.linked, true); assert.equal(link.json.qboId, r.json.qbo.id);
  // stale SyncToken (edited in QBO meanwhile) → re-read and retry once
  stub.invoices.get(r.json.qbo.id).SyncToken = '5';
  const cur2 = await Q.api('GET', `/api/invoices/${invoice.id}`, { token: qboAdmin });
  await Q.api('PATCH', `/api/invoices/${invoice.id}`, { token: qboAdmin, body: { version: cur2.json.version, notes: 'Thanks!' } });
  const stale = await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(stale.status, 200, stale.text); assert.equal(stale.json.qbo.syncToken, '6');
  pushed = { invoice, qboId: r.json.qbo.id };
  // void invoices are refused; unknown id 404
  assert.equal((await Q.api('POST', '/api/quickbooks/sync-invoice/999999999', { token: qboAdmin })).status, 404);
  assert.equal((await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: U.dispatcher.token })).status, 403);
});

test('qbo customer: duplicate DisplayName (6240) never adopts the existing QBO customer — the name is made unique', async () => {
  const { invoice, customer } = await qboInvoice([{ description: 'Call-out', quantity: 1, unitPrice: 85, taxRateKey: null }]);
  stub.customers.set('9001', { Id: '9001', SyncToken: '0', DisplayName: `${customer.firstName} ${customer.lastName}` });
  const r = await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json.customer.qboId, '9001');
  assert.equal(stub.customers.get(r.json.customer.qboId).DisplayName, `${customer.firstName} ${customer.lastName} (MBC ${customer.id})`);
});

test('qbo tokens: expired access token is refreshed (rotating refresh token stored), 401 triggers one refresh + retry, invalid_grant → 409 reauth', async () => {
  const { invoice } = await qboInvoice([{ description: 'Service', quantity: 1, unitPrice: 150, taxRateKey: null }]);
  const oldRefresh = stub.refresh;
  await prisma.integrationToken.update({ where: { provider: 'quickbooks' }, data: { expiresAt: new Date(Date.now() - 1000) } });
  stub.reset();
  const r = await Q.api('POST', `/api/quickbooks/sync-invoice/${invoice.id}`, { token: qboAdmin });
  assert.equal(r.status, 200, r.text);
  const rf = stub.requests.filter((x) => x.path === '/oauth2/v1/tokens/bearer');
  assert.equal(rf.length, 1);
  assert.equal(rf[0].form.grant_type, 'refresh_token'); assert.equal(rf[0].form.refresh_token, oldRefresh);
  const { loadTokens } = require('../helpers/qbo');
  const t = await loadTokens();
  assert.equal(t.refreshToken, stub.refresh, 'rotated refresh token not stored');
  assert.notEqual(t.refreshToken, oldRefresh);
  assert.ok(t.expiresAt > new Date());
  // a 401 from the API → refresh once and retry
  const { invoice: inv2 } = await qboInvoice([{ description: 'Service 2', quantity: 1, unitPrice: 160, taxRateKey: null }]);
  stub.reset(); stub.failNext401 = true;
  const r2 = await Q.api('POST', `/api/quickbooks/sync-invoice/${inv2.id}`, { token: qboAdmin });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(stub.requests.filter((x) => x.path === '/oauth2/v1/tokens/bearer').length, 1);
  // refresh token revoked at Intuit → 409 QBO_REAUTH_REQUIRED, nothing pushed
  const keep = stub.refresh;
  stub.refresh = 'revoked';
  await prisma.integrationToken.update({ where: { provider: 'quickbooks' }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const r3 = await Q.api('POST', `/api/quickbooks/sync-invoice/${inv2.id}`, { token: qboAdmin });
  assert.equal(r3.status, 409); assert.equal(r3.json.code, 'QBO_REAUTH_REQUIRED');
  stub.refresh = keep;
});

test('qbo payment sync-back: full payment marks the invoice paid (paidAt = payment date), partial stays unpaid, re-run is a no-op', async () => {
  assert.ok(pushed, 'invoice push test must run first');
  const { invoice: other } = await qboInvoice([{ description: 'Partial', quantity: 1, unitPrice: 200, taxRateKey: null }]);
  const po = await Q.api('POST', `/api/quickbooks/sync-invoice/${other.id}`, { token: qboAdmin });
  assert.equal(po.status, 200, po.text);
  const full = stub.invoices.get(pushed.qboId);
  stub.pay(pushed.qboId, full.Balance, '2026-11-20');
  stub.pay(po.json.qbo.id, 50, '2026-11-21');
  stub.payments.push({ Id: '77777', TxnDate: '2026-11-21', TotalAmt: 10, Line: [{ Amount: 10, LinkedTxn: [{ TxnId: '55555', TxnType: 'Invoice' }] }], MetaData: { LastUpdatedTime: new Date().toISOString() } });
  stub.reset();
  const r = await Q.api('POST', '/api/quickbooks/sync-payments', { token: qboAdmin, body: { since: '2026-01-01T00:00:00Z' } });
  assert.equal(r.status, 200, r.text);
  const sql = stub.requests.filter((x) => x.sql).map((x) => x.sql);
  assert.ok(sql.some((s) => /^SELECT \* FROM Payment WHERE MetaData\.LastUpdatedTime >= '2026-01-01T00:00:00\.000Z' ORDERBY MetaData\.LastUpdatedTime STARTPOSITION 1 MAXRESULTS 1000$/.test(s)), sql.join('\n'));
  assert.equal(r.json.markedPaid.length, 1);
  assert.equal(r.json.markedPaid[0].invoiceId, pushed.invoice.id);
  assert.equal(r.json.partial.length, 1); assert.equal(r.json.partial[0].invoiceId, other.id); assert.equal(r.json.partial[0].balance, 150);
  assert.equal(r.json.unmatchedPayments, 1);
  const paid = await prisma.invoice.findUnique({ where: { id: pushed.invoice.id } });
  assert.equal(paid.status, 'paid'); assert.equal(paid.paidAt.toISOString().slice(0, 10), '2026-11-20');
  assert.equal((await prisma.invoice.findUnique({ where: { id: other.id } })).status, 'unpaid');
  // cursor stored; second run marks nothing again
  const again = await Q.api('POST', '/api/quickbooks/sync-payments', { token: qboAdmin });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.markedPaid.length, 0);
  assert.ok(again.json.alreadyClosed.some((x) => x.invoiceId === pushed.invoice.id));
  const st = await Q.api('GET', '/api/quickbooks/status', { token: qboAdmin });
  assert.ok(st.json.sync.lastPaymentSyncAt); assert.ok(st.json.sync.linkedInvoices >= 2);
  assert.equal((await Q.api('POST', '/api/quickbooks/sync-payments', { token: qboAdmin, body: { since: 'last tuesday' } })).status, 400);
});

test('qbo tax mapping (non-US): per-line TaxCodeRef from QBO_TAX_CODES, reverse charge, unmapped key fails closed', () => {
  const qbo = require('../helpers/qbo');
  const { buildLocale } = require('../helpers/locale');
  const ie = buildLocale({ BRAND_COUNTRY: 'IE' });
  const saved = process.env.QBO_TAX_CODES;
  try {
    process.env.QBO_TAX_CODES = 'standard=12|reduced=13|none=15|reverse_charge=16';
    const lines = [{ taxRateKey: 'standard', taxRate: 23 }, { taxRateKey: 'reduced', taxRate: 13.5 }, { taxRateKey: null, taxRate: 0 }];
    assert.deepEqual(qbo.taxPlan({ reverseCharge: false }, lines, ie), { lineCodes: ['12', '13', '15'], doc: { GlobalTaxCalculation: 'TaxExcluded' } });
    assert.deepEqual(qbo.taxPlan({ reverseCharge: true }, lines, ie).lineCodes, ['16', '16', '16']);
    process.env.QBO_TAX_CODES = 'standard=12';
    assert.throws(() => qbo.taxPlan({ reverseCharge: false }, lines, ie), (e) => e.status === 409 && e.extra.code === 'QBO_TAX_CODE_UNMAPPED' && e.extra.keys.join() === 'reduced,none');
  } finally { if (saved === undefined) delete process.env.QBO_TAX_CODES; else process.env.QBO_TAX_CODES = saved; }
  assert.equal(qbo.q("O'Brien\\x"), "'O\\'Brien\\\\x'", 'query literal escaping');
});
