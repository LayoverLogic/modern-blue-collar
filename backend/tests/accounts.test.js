/**
 * tests/accounts.test.js — Phase 2d / B3: first-paid-client blockers from the
 * Implementation dry run (gtm/implementation/round2/first-client-dry-run.md).
 *
 * Setup / run:
 *   1. PostgreSQL reachable (role mbc / mbc_sandbox, CREATEDB for the migration test).
 *   2. cd backend && npm install
 *   3. TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_accounts_test?schema=public \
 *        npm run test:accounts
 *      (the database name must contain "test"; it is created + migrated if missing)
 *
 * Covers: password change (revokes other sessions), admin reset (temporary password /
 * link), forgot / reset (no enumeration, hashed single-use 30-minute token, rate limit),
 * temporary-password gate (server-side), seed_superadmin flag, leavers (deactivate /
 * reactivate / role change, sockets, last super-admin), login limiter (failed only,
 * IP + email), password invites (accept link, mail failure → 201 emailed:false, no
 * half-done state), several quotes / invoices per job, customer company, pricebook CSV
 * import, blank slogan, EMAIL_FAILED 502, due dates as calendar dates, reverse-charge
 * placeholder kept out of emails, migration 20261121180000 on a seeded database.
 *
 * Never reads .env; boots `node server.js` children in SANDBOX_MODE; creates
 * run-tagged synthetic rows and deletes them afterwards.
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
  console.error('[accounts-test] TEST_DATABASE_URL is required (a throwaway database whose name contains "test").');
  process.exit(1);
}
if (!/test/i.test(new URL(TEST_DB).pathname)) {
  console.error('[accounts-test] refusing: the TEST_DATABASE_URL database name must contain "test".');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
process.env.ENV_FILE = '/dev/null';
const SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = 'test';

const RUN      = `ac${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const PASSWORD = 'Accounts!2345';
const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-accounts-test-'));
const OUTBOX   = path.join(TMP, 'outbox');
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

let prisma;
const U = {};
const servers = [];
let S;      // main server (US, America/Chicago, outbox mail)
let LIM;    // tight login / reset limits
let BROKE;  // SMTP pointed at a closed port, blank slogan

let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `127.3.${1 + Math.floor(ipSeq / 250) % 250}.${1 + (ipSeq % 250)}`; };

function request(base, method, p, { token, body, raw, contentType, headers = {}, ip } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const h = { ...headers };
    let data;
    if (raw !== undefined) { data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); h['Content-Type'] = contentType || 'text/csv'; h['Content-Length'] = data.length; }
    else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
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

function multipart(fields) {
  const boundary = `----mbc${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [name, v] of Object.entries(fields)) {
    const file = typeof v === 'object' && v.filename;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? `; filename="${v.filename}"` : ''}\r\n${file ? 'Content-Type: text/csv\r\n' : ''}\r\n`));
    parts.push(Buffer.from(file ? v.content : String(v)));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { raw: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
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
    MAIL_DRIVER: 'outbox', MAIL_OUTBOX_DIR: OUTBOX, SMTP_FROM: 'office@accounts.test',
    BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(TMP, 'backups'), BRAND_TRADE_TYPE: 'plumbing',
    BRAND_TIMEZONE: 'America/Chicago', RESET_RATE_MAX: '500', LOGIN_MAX_PER_IP: '500', LOGIN_MAX_PER_EMAIL: '100',
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

function pgAdminUrl(dbUrl) { const url = new URL(dbUrl); url.pathname = '/postgres'; url.search = ''; return url.toString(); }
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

let userSeq = 0;
async function mkUser(role, tag = role, over = {}) {
  const bcrypt = require('bcryptjs');
  userSeq += 1;
  return prisma.user.create({
    data: { email: `${RUN}-${tag}-${userSeq}@accounts.test`, password: await bcrypt.hash(PASSWORD, 4), firstName: 'AC', lastName: tag, role, active: true, ...over },
  });
}
async function login(srv, email, password = PASSWORD) {
  const r = await srv.api('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
async function session(role, tag) {
  const u = await mkUser(role, tag);
  return { ...u, token: await login(S, u.email) };
}
const mkCustomer = (over = {}) => prisma.customer.create({
  data: { firstName: 'Lena', lastName: `Strand-${RUN}`, phone: '+16205550121', email: `lena-${RUN}@example.test`, address: '14 Elm St', city: 'Hutchinson', state: 'KS', zip: '67501', ...over },
});
const mkJob = async (over = {}) => prisma.job.create({ data: { title: `AC job ${RUN}`, customerId: (await mkCustomer()).id, ...over } });

function outbox() {
  if (!fs.existsSync(OUTBOX)) return [];
  return fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(OUTBOX, f), 'utf8')));
}
async function mailTo(to, { subject = /./, timeout = 4000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const m = outbox().filter((x) => x.to === to && subject.test(x.subject));
    if (m.length) return m[m.length - 1];
    await sleep(50);
  }
  return null;
}
const tokenFrom = (text) => { const m = /#token=([A-Za-z0-9_%-]+)/.exec(text || ''); return m ? decodeURIComponent(m[1]) : null; };

async function cleanup() {
  if (!prisma) return;
  const safe = (p) => p.catch(() => {});
  const users = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map((u) => u.id);
  const custs = (await prisma.customer.findMany({ where: { OR: [{ lastName: { contains: RUN } }, { company: { contains: RUN } }] }, select: { id: true } })).map((c) => c.id);
  const jobs = (await prisma.job.findMany({ where: { OR: [{ customerId: { in: custs } }, { title: { contains: RUN } }] }, select: { id: true } })).map((j) => j.id);
  await safe(prisma.jobActivity.deleteMany({ where: { OR: [{ jobRef: { in: jobs } }, { actorUserId: { in: users } }] } }));
  await safe(prisma.invoice.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.quote.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobs } } }));
  await safe(prisma.communication.deleteMany({ where: { customerId: { in: custs } } }));
  await safe(prisma.customer.deleteMany({ where: { id: { in: custs } } }));
  await safe(prisma.priceBookItem.deleteMany({ where: { OR: [{ name: { contains: RUN } }, { sku: { contains: RUN } }] } }));
  await safe(prisma.apiKey.deleteMany({ where: { createdById: { in: users } } }));
  await safe(prisma.user.deleteMany({ where: { id: { in: users } } }));
}

before(async () => {
  await ensureDatabase(TEST_DB);
  prisma = require('../helpers/prisma');
  const closed = await freePort(); // nothing listens here → ECONNREFUSED
  [S, LIM, BROKE] = await Promise.all([
    bootServer({}),
    bootServer({ LOGIN_MAX_PER_EMAIL: '3', LOGIN_MAX_PER_IP: '6', RESET_RATE_MAX: '4' }),
    bootServer({ MAIL_DRIVER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(closed), BRAND_COMPANY_SLOGAN: '' }),
  ]);
  for (const s of [S, LIM, BROKE]) assert.ok(s.alive(), s.output());
  for (const [k, role] of [['sa', 'super-admin'], ['admin', 'admin'], ['dispatcher', 'dispatcher'], ['tech', 'technician']]) {
    U[k] = await session(role, k);
  }
});

after(async () => {
  try { await cleanup(); } finally {
    for (const s of servers) await s.stop();
    if (prisma) await prisma.$disconnect().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Passwords
// ═════════════════════════════════════════════════════════════════════════════
test('password change: current + new, min length, revokes OTHER sessions, returns a fresh token', async () => {
  const u = await mkUser('technician', 'pw');
  const t1 = await login(S, u.email);
  const t2 = await login(S, u.email);
  const ch = (token, body) => S.api('PATCH', '/api/users/me/password', { token, body });

  let r = await ch(t1, { newPassword: 'Another!2345' });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'REQUIRED'); assert.equal(r.json.field, 'currentPassword');
  r = await ch(t1, { currentPassword: 'wrong-password', newPassword: 'Another!2345' });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'INVALID_CURRENT_PASSWORD');
  r = await ch(t1, { currentPassword: PASSWORD, newPassword: 'short' });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'WEAK_PASSWORD'); assert.equal(r.json.minLength, 10);
  r = await ch(t1, { currentPassword: PASSWORD, newPassword: PASSWORD });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'PASSWORD_UNCHANGED');

  r = await ch(t1, { currentPassword: PASSWORD, newPassword: 'Another!2345' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.token && r.json.user.id === u.id && r.json.user.mustChangePassword === false);
  assert.equal((await S.api('GET', '/api/users/me', { token: r.json.token })).status, 200, 'the fresh token works');
  assert.equal((await S.api('GET', '/api/users/me', { token: t2 })).status, 401, 'another session survived');
  assert.equal((await S.api('GET', '/api/users/me', { token: t1 })).status, 401, 'the old token of this session survived');
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).status, 401);
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email: u.email, password: 'Another!2345' } })).status, 200);
  const row = await prisma.user.findUnique({ where: { id: u.id } });
  assert.ok(row.passwordChangedAt && row.sessionVersion === 1);
});

test('password change: API keys are refused (a person must be signed in)', async () => {
  const k = await S.api('POST', '/api/api-keys', { token: U.admin.token, body: { name: `k-${RUN}`, scopes: ['read', 'write'] } });
  assert.equal(k.status, 201, k.text);
  const r = await S.api('PATCH', '/api/users/me/password', { headers: { 'X-API-Key': k.json.key }, body: { currentPassword: 'x', newPassword: 'Another!2345' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'SESSION_REQUIRED');
});

test('temporary password gate: admin-created users must change it first (server-side), logout still allowed', async () => {
  const email = `${RUN}-newhire@accounts.test`;
  const c = await S.api('POST', '/api/users', { token: U.admin.token, body: { email, password: 'TempPass!123', firstName: 'New', lastName: 'Hire', role: 'technician' } });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.mustChangePassword, true);
  const lr = await S.api('POST', '/api/auth/login', { body: { email, password: 'TempPass!123' } });
  assert.equal(lr.status, 200);
  assert.equal(lr.json.user.mustChangePassword, true);
  const t = lr.json.token;
  for (const [m, p] of [['GET', '/api/jobs'], ['GET', '/api/customers'], ['GET', '/api/users/technicians'], ['PATCH', `/api/users/${c.json.id}`], ['GET', '/api/presence']]) {
    const r = await S.api(m, p, { token: t, body: m === 'PATCH' ? { firstName: 'X' } : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.code, 'PASSWORD_CHANGE_REQUIRED', `${m} ${p}`);
  }
  assert.equal((await S.api('GET', '/api/users/me', { token: t })).json.mustChangePassword, true);
  assert.equal((await S.api('GET', '/api/auth/me', { token: t })).status, 200);
  assert.equal((await S.api('POST', '/api/auth/logout', { token: t })).status, 200);
  const ch = await S.api('PATCH', '/api/users/me/password', { token: t, body: { currentPassword: 'TempPass!123', newPassword: 'MyOwnPass!456' } });
  assert.equal(ch.status, 200, ch.text);
  assert.equal((await S.api('GET', '/api/jobs', { token: ch.json.token })).status, 200);
  assert.equal((await prisma.user.findUnique({ where: { email } })).mustChangePassword, false);

  // explicit opt-out by the admin
  const o = await S.api('POST', '/api/users', { token: U.admin.token, body: { email: `${RUN}-optout@accounts.test`, password: 'TempPass!123', firstName: 'Opt', lastName: 'Out', mustChangePassword: false } });
  assert.equal(o.status, 201);
  assert.equal(o.json.mustChangePassword, false);
});

test('seed_superadmin: a generated password is temporary (must change); an explicit ADMIN_PASSWORD is not', () => {
  const run = (env) => spawnSync(process.execPath, ['seed_superadmin.js'], {
    cwd: BACKEND, encoding: 'utf8', env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB, ...env },
  });
  const gen = `${RUN}-owner@accounts.test`;
  let r = run({ ADMIN_EMAIL: gen });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Temporary password .*: (\S+)/);
  const temp = /Temporary password .*: (\S+)/.exec(r.stdout)[1];
  const fixed = `${RUN}-owner2@accounts.test`;
  r = run({ ADMIN_EMAIL: fixed, ADMIN_PASSWORD: 'Explicit!2345' });
  assert.equal(r.status, 0);
  return (async () => {
    assert.equal((await prisma.user.findUnique({ where: { email: gen } })).mustChangePassword, true);
    assert.equal((await prisma.user.findUnique({ where: { email: fixed } })).mustChangePassword, false);
    const lr = await S.api('POST', '/api/auth/login', { body: { email: gen, password: temp } });
    assert.equal(lr.status, 200);
    assert.equal(lr.json.user.mustChangePassword, true);
    assert.equal((await S.api('GET', '/api/customers', { token: lr.json.token })).json.code, 'PASSWORD_CHANGE_REQUIRED');
  })();
});

test('admin reset: temporary password (shown once, forced change, sessions revoked); role matrix', async () => {
  const u = await mkUser('technician', 'reset');
  const old = await login(S, u.email);
  let r = await S.api('POST', `/api/users/${u.id}/reset-password`, { token: U.dispatcher.token, body: {} });
  assert.equal(r.status, 403, 'dispatcher reset a password');
  r = await S.api('POST', `/api/users/${u.id}/reset-password`, { token: U.admin.token, body: { mode: 'bogus' } });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'INVALID_ENUM');
  r = await S.api('POST', `/api/users/${u.id}/reset-password`, { token: U.admin.token, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.mode, 'temporary');
  assert.ok(typeof r.json.temporaryPassword === 'string' && r.json.temporaryPassword.length >= 16);
  assert.equal((await S.api('GET', '/api/users/me', { token: old })).status, 401, 'old session survived the reset');
  const lr = await S.api('POST', '/api/auth/login', { body: { email: u.email, password: r.json.temporaryPassword } });
  assert.equal(lr.json.user.mustChangePassword, true);
  const row = await prisma.user.findUnique({ where: { id: u.id } });
  assert.ok(!row.password.includes(r.json.temporaryPassword), 'stored in clear');

  const a = await mkUser('admin', 'reset-admin');
  assert.equal((await S.api('POST', `/api/users/${a.id}/reset-password`, { token: U.admin.token, body: {} })).status, 403, 'admin reset an admin');
  assert.equal((await S.api('POST', `/api/users/${a.id}/reset-password`, { token: U.sa.token, body: {} })).status, 200);
  assert.equal((await S.api('POST', `/api/users/${U.admin.id}/reset-password`, { token: U.admin.token, body: {} })).status, 400, 'self reset');
  const gone = await mkUser('technician', 'reset-inactive', { active: false });
  const ina = await S.api('POST', `/api/users/${gone.id}/reset-password`, { token: U.admin.token, body: {} });
  assert.equal(ina.status, 409); assert.equal(ina.json.code, 'USER_INACTIVE');
});

test('admin reset: link mode emails a single-use reset link and returns it for copying', async () => {
  const u = await mkUser('technician', 'resetlink');
  const r = await S.api('POST', `/api/users/${u.id}/reset-password`, { token: U.admin.token, body: { mode: 'link' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.emailed, true);
  assert.match(r.json.resetLink, /^http:\/\/localhost:\d+\/reset-password\.html#token=/);
  const mail = await mailTo(u.email, { subject: /password/i });
  assert.ok(mail && mail.text.includes(r.json.resetLink));
  const ok = await S.api('POST', '/api/auth/reset', { body: { token: tokenFrom(r.json.resetLink), newPassword: 'FromLink!2345' } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email: u.email, password: 'FromLink!2345' } })).status, 200);
  // mail down: still 200, emailed:false + mailError, link to copy (never a 500)
  const v = await mkUser('technician', 'resetlink-broke');
  const b = await BROKE.api('POST', `/api/users/${v.id}/reset-password`, { token: U.admin.token, body: { mode: 'link' } });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.json.emailed, false);
  assert.match(b.json.mailError, /ECONNREFUSED/);
  assert.ok(tokenFrom(b.json.resetLink));
});

test('forgot password: always 200 with the same answer (no enumeration); emails a hashed, single-use token', async () => {
  const u = await mkUser('technician', 'forgot');
  const t0 = await login(S, u.email);
  const known = await S.api('POST', '/api/auth/forgot', { body: { email: u.email.toUpperCase() } });
  const unknown = await S.api('POST', '/api/auth/forgot', { body: { email: `${RUN}-nobody@accounts.test` } });
  const malformed = await S.api('POST', '/api/auth/forgot', { body: { email: 'not-an-email' } });
  for (const r of [known, unknown, malformed]) assert.equal(r.status, 200, r.text);
  assert.deepEqual(known.json, unknown.json);
  assert.deepEqual(known.json, malformed.json);
  assert.equal((await S.api('POST', '/api/auth/forgot', { body: {} })).status, 400);
  const inactive = await mkUser('technician', 'forgot-inactive', { active: false });
  assert.equal((await S.api('POST', '/api/auth/forgot', { body: { email: inactive.email } })).status, 200);

  const mail = await mailTo(u.email, { subject: /reset/i });
  assert.ok(mail, 'no reset email in the outbox');
  assert.equal(await mailTo(inactive.email, { timeout: 300 }), null, 'a deactivated account was emailed');
  const token = tokenFrom(mail.text);
  assert.ok(token && token.length >= 40);
  assert.match(mail.text, /30 minutes/);
  const rows = await prisma.authToken.findMany({ where: { userId: u.id, kind: 'reset' } });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tokenHash, token, 'token stored in clear');
  assert.equal(rows[0].tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  const ttl = rows[0].expiresAt - rows[0].createdAt;
  assert.ok(ttl > 29 * 60000 && ttl <= 30 * 60000 + 1000, `ttl ${ttl}`);

  const val = await S.api('POST', '/api/auth/reset/validate', { body: { token } });
  assert.equal(val.status, 200); assert.equal(val.json.email, u.email);
  let r = await S.api('POST', '/api/auth/reset', { body: { token, newPassword: 'short' } });
  assert.equal(r.json.code, 'WEAK_PASSWORD');
  r = await S.api('POST', '/api/auth/reset', { body: { token, newPassword: 'ResetDone!2345' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await S.api('GET', '/api/users/me', { token: t0 })).status, 401, 'sessions not revoked by the reset');
  r = await S.api('POST', '/api/auth/reset', { body: { token, newPassword: 'Again!23456' } });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'INVALID_RESET_TOKEN', 'token reused');
  assert.equal((await S.api('POST', '/api/auth/reset/validate', { body: { token } })).status, 400);
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email: u.email, password: 'ResetDone!2345' } })).status, 200);

  // expired token
  await S.api('POST', '/api/auth/forgot', { body: { email: u.email } });
  const m2 = await mailTo(u.email, { subject: /reset/i });
  const tok2 = tokenFrom(m2.text);
  await prisma.authToken.updateMany({ where: { tokenHash: crypto.createHash('sha256').update(tok2).digest('hex') }, data: { expiresAt: new Date(Date.now() - 1000) } });
  r = await S.api('POST', '/api/auth/reset', { body: { token: tok2, newPassword: 'Expired!2345' } });
  assert.equal(r.json.code, 'INVALID_RESET_TOKEN');
  assert.equal((await S.api('POST', '/api/auth/reset', { body: { token: 'x'.repeat(43), newPassword: 'Whatever!2345' } })).json.code, 'INVALID_RESET_TOKEN');
});

test('forgot / reset are rate limited per IP; at most 3 reset mails per account per 15 min', async () => {
  const ip = '127.9.9.9';
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await LIM.api('POST', '/api/auth/forgot', { ip, body: { email: `${RUN}-rl${i}@accounts.test` } })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 429, 429]);
  assert.equal((await LIM.api('POST', '/api/auth/reset', { ip, body: { token: 'x', newPassword: 'y' } })).status, 429);
  assert.equal((await LIM.api('POST', '/api/auth/forgot', { ip: '127.9.9.10', body: { email: 'a@b.test' } })).status, 200, 'another IP is not limited');

  const u = await mkUser('technician', 'forgot-cap');
  for (let i = 0; i < 5; i++) await S.api('POST', '/api/auth/forgot', { body: { email: u.email } });
  await sleep(300);
  assert.equal(await prisma.authToken.count({ where: { userId: u.id, kind: 'reset' } }), 1, 'only the latest link stays valid');
  assert.equal(outbox().filter((m) => m.to === u.email).length, 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Leavers
// ═════════════════════════════════════════════════════════════════════════════
function liveSocket(base, token) {
  const frames = [];
  let closed = false;
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`);
  const ready = new Promise((resolve) => {
    ws.onmessage = (m) => {
      const d = String(m.data);
      frames.push(d);
      if (d.startsWith('0{')) ws.send(`40${JSON.stringify({ token })}`);
      else if (d.startsWith('40')) resolve(true);
      else if (d === '2') ws.send('3');
      else if (d.startsWith('44')) resolve(false);
    };
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 3000);
  });
  ws.onclose = () => { closed = true; };
  const dropped = async (ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (closed || frames.includes('41')) return true; await sleep(50); }
    return false;
  };
  return { ready, dropped, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

test('leavers: deactivate ends sessions and sockets at once; reactivate needs a new sign-in', async () => {
  const u = await mkUser('technician', 'leaver');
  const t = await login(S, u.email);
  const sock = liveSocket(S.base, t);
  assert.equal(await sock.ready, true);
  assert.equal((await S.api('POST', `/api/users/${u.id}/deactivate`, { token: U.dispatcher.token })).status, 403);
  const r = await S.api('POST', `/api/users/${u.id}/deactivate`, { token: U.admin.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.active, false);
  assert.equal(await sock.dropped(), true, 'socket survived the deactivation');
  sock.close();
  assert.equal((await S.api('GET', '/api/users/me', { token: t })).status, 401);
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).status, 401);
  assert.equal((await S.api('POST', `/api/users/${U.admin.id}/deactivate`, { token: U.admin.token })).status, 403, 'self-deactivation');

  const back = await S.api('POST', `/api/users/${u.id}/reactivate`, { token: U.admin.token });
  assert.equal(back.status, 200);
  assert.equal(back.json.active, true);
  assert.equal((await S.api('GET', '/api/users/me', { token: t })).status, 401, 'a pre-deactivation token came back to life');
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } })).status, 200);

  // pending reset / invite links die with the deactivation
  await S.api('POST', '/api/auth/forgot', { body: { email: u.email } });
  await sleep(100);
  assert.equal(await prisma.authToken.count({ where: { userId: u.id, usedAt: null } }), 1);
  await S.api('POST', `/api/users/${u.id}/deactivate`, { token: U.admin.token });
  assert.equal(await prisma.authToken.count({ where: { userId: u.id, usedAt: null } }), 0);
});

test('leavers: role change follows the matrix; admins / super-admins only by a super-admin', async () => {
  const tech = await mkUser('technician', 'role');
  let r = await S.api('PATCH', `/api/users/${tech.id}/role`, { token: U.admin.token, body: { role: 'dispatcher' } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.role, 'dispatcher');
  r = await S.api('PATCH', `/api/users/${tech.id}/role`, { token: U.admin.token, body: { role: 'chief' } });
  assert.equal(r.status, 400); assert.equal(r.json.code, 'INVALID_ROLE');
  assert.equal((await S.api('PATCH', `/api/users/${tech.id}/role`, { token: U.admin.token, body: { role: 'admin' } })).status, 403);
  assert.equal((await S.api('PATCH', `/api/users/${tech.id}/role`, { token: U.dispatcher.token, body: { role: 'technician' } })).status, 403);
  assert.equal((await S.api('PATCH', `/api/users/${tech.id}/role`, { token: U.sa.token, body: { role: 'admin' } })).json.role, 'admin');
  assert.equal((await S.api('PATCH', `/api/users/${tech.id}/role`, { token: U.admin.token, body: { role: 'technician' } })).status, 403, 'admin demoted an admin');
  assert.equal((await S.api('POST', `/api/users/${tech.id}/deactivate`, { token: U.admin.token })).status, 403, 'admin deactivated an admin');
  assert.equal((await S.api('PATCH', `/api/users/${U.admin.id}/role`, { token: U.admin.token, body: { role: 'super-admin' } })).status, 403, 'self promotion');
  const list = await S.api('GET', '/api/users', { token: U.admin.token });
  const me = list.json.find((x) => x.id === tech.id);
  for (const k of ['mustChangePassword', 'lastLoginAt', 'invitePending', 'active', 'role']) assert.ok(k in me, k);
});

test('leavers: the last active super-admin cannot be deactivated, demoted or deleted', async () => {
  // Park every other active super-admin of the shared test DB for the duration.
  const others = await prisma.user.findMany({ where: { role: 'super-admin', active: true, id: { not: U.sa.id } }, select: { id: true } });
  await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: false } });
  try {
    const { assertNotLastSuperAdmin } = require('../routes/users');
    // exactly one active super-admin (U.sa): the guard refuses to remove it
    await assert.rejects(prisma.$transaction((tx) => assertNotLastSuperAdmin(tx, U.sa.id)), (e) => e.status === 409 && e.extra.code === 'LAST_SUPER_ADMIN');
    // a super-admin acting on itself is refused before the guard (403)
    assert.equal((await S.api('POST', `/api/users/${U.sa.id}/deactivate`, { token: U.sa.token })).status, 403);

    // two active super-admins: one may remove the other (deactivate / demote / delete)…
    const sa2 = await session('super-admin', 'sa2');
    assert.equal((await S.api('PATCH', `/api/users/${sa2.id}/role`, { token: U.sa.token, body: { role: 'admin' } })).status, 200);
    await prisma.user.update({ where: { id: sa2.id }, data: { role: 'super-admin' } });
    assert.equal((await S.api('PATCH', `/api/users/${sa2.id}`, { token: U.sa.token, body: { active: false } })).status, 200);
    await prisma.user.update({ where: { id: sa2.id }, data: { active: true, sessionVersion: 0 } });

    // …but when both try to remove each other at once, exactly one wins and one stays (advisory lock)
    const [a, b] = await Promise.all([
      S.api('POST', `/api/users/${sa2.id}/deactivate`, { token: U.sa.token }),
      S.api('POST', `/api/users/${U.sa.id}/deactivate`, { token: sa2.token }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.equal(statuses[0], 200, `${a.text} | ${b.text}`);
    assert.ok([401, 409].includes(statuses[1]), `${a.text} | ${b.text}`);
    const loser = a.status === 200 ? b : a;
    if (loser.status === 409) assert.equal(loser.json.code, 'LAST_SUPER_ADMIN');
    assert.equal(await prisma.user.count({ where: { role: 'super-admin', active: true } }), 1, 'no active super-admin left');

    // DELETE of the last one is refused too (guard inside the delete transaction)
    const last = await prisma.user.findFirst({ where: { role: 'super-admin', active: true } });
    await assert.rejects(prisma.$transaction((tx) => assertNotLastSuperAdmin(tx, last.id)), (e) => e.extra.code === 'LAST_SUPER_ADMIN');
  } finally {
    await prisma.user.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: true } });
    await prisma.user.update({ where: { id: U.sa.id }, data: { active: true, role: 'super-admin' } });
    U.sa.token = await login(S, U.sa.email);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Login limiter
// ═════════════════════════════════════════════════════════════════════════════
test('login limiter: successful sign-ins never count (training room on one IP); failures per IP+email and per IP', async () => {
  const ip = '127.8.8.8';
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await mkUser('technician', `room${i}`));
  // 30 good logins from one office IP (limits: 3 failed per IP+email, 6 failed per IP)
  for (let i = 0; i < 30; i++) {
    const p = people[i % people.length];
    const r = await LIM.api('POST', '/api/auth/login', { ip, body: { email: p.email, password: PASSWORD } });
    assert.equal(r.status, 200, `login ${i}: ${r.text}`);
  }
  // one person mistypes: 3 failures, then 429 for THAT email on this IP
  const bad = (email, pw = 'wrong-password') => LIM.api('POST', '/api/auth/login', { ip, body: { email, password: pw } });
  for (let i = 0; i < 3; i++) assert.equal((await bad(people[0].email)).status, 401);
  const locked = await bad(people[0].email, PASSWORD);
  assert.equal(locked.status, 429);
  assert.equal(locked.json.code, 'RATE_LIMITED');
  // …while colleagues on the same IP still sign in
  assert.equal((await LIM.api('POST', '/api/auth/login', { ip, body: { email: people[1].email, password: PASSWORD } })).status, 200);
  // the same email from another IP is not locked
  assert.equal((await LIM.api('POST', '/api/auth/login', { ip: '127.8.8.9', body: { email: people[0].email, password: PASSWORD } })).status, 200);
  // spraying many emails from one IP: capped by the per-IP failure limit (6)
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await bad(`${RUN}-spray${i}@accounts.test`)).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]); // 3 earlier + 3 here = 6 failures
  assert.equal((await LIM.api('POST', '/api/auth/login', { ip, body: { email: people[2].email, password: PASSWORD } })).status, 429, 'IP block holds for everyone on it');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Invites
// ═════════════════════════════════════════════════════════════════════════════
test('invites: new user + link in one go (201); accept-invite sets a password and signs in; single use', async () => {
  const email = `${RUN}-invitee@accounts.test`;
  const r = await S.api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'Wes', lastName: 'Tanner', role: 'technician' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.created, true);
  assert.equal(r.json.emailed, true);
  assert.equal(r.json.passwordInvite, true);
  assert.match(r.json.inviteLink, /\/accept-invite\.html#token=/);
  assert.equal(r.json.googleSignIn, false);
  const mail = await mailTo(email, { subject: /invited/ });
  assert.ok(mail && mail.text.includes(r.json.inviteLink), 'invite email lacks the link');
  assert.doesNotMatch(mail.text, /Google/, 'Google offered when it is not configured');
  const token = tokenFrom(r.json.inviteLink);
  const row = await prisma.authToken.findFirst({ where: { user: { email }, kind: 'invite' } });
  assert.equal(row.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email, password: 'anything-at-all' } })).status, 401, 'invited user had a usable password');

  const info = await S.api('GET', `/api/invites/${encodeURIComponent(token)}`);
  assert.equal(info.status, 200, info.text);
  assert.equal(info.json.email, email);
  assert.equal(info.json.role, 'technician');
  assert.equal(info.json.firstName, 'Wes');
  const list = await S.api('GET', '/api/users', { token: U.admin.token });
  assert.equal(list.json.find((x) => x.email === email).invitePending, true);

  assert.equal((await S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { body: { password: 'short' } })).json.code, 'WEAK_PASSWORD');
  const acc = await S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { body: { password: 'Invited!2345', firstName: 'Wesley' } });
  assert.equal(acc.status, 200, acc.text);
  assert.ok(acc.json.token);
  assert.equal(acc.json.user.firstName, 'Wesley');
  assert.equal(acc.json.user.mustChangePassword, false);
  assert.equal((await S.api('GET', '/api/jobs', { token: acc.json.token })).status, 200);
  assert.equal((await S.api('POST', '/api/auth/login', { body: { email, password: 'Invited!2345' } })).status, 200);
  const again = await S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { body: { password: 'Another!2345' } });
  assert.equal(again.status, 404); assert.equal(again.json.code, 'INVALID_INVITE');
  assert.equal((await S.api('GET', `/api/invites/${encodeURIComponent(token)}`)).status, 404);
  assert.equal((await S.api('GET', '/api/invites/not-a-real-token-xxxxxxxxxxxxxxxx')).json.code, 'INVALID_INVITE');

  // re-inviting an account that already accepted: no password link, 200
  const re = await S.api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'Wes', lastName: 'Tanner' } });
  assert.equal(re.status, 200, re.text);
  assert.equal(re.json.created, false);
  assert.equal(re.json.passwordInvite, false);
  assert.equal(re.json.inviteLink, null);
});

test('invites: re-sending a pending invite replaces the link; privileged accounts need a super-admin', async () => {
  const email = `${RUN}-pending@accounts.test`;
  const first = await S.api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'Pat', lastName: 'Ending' } });
  assert.equal(first.status, 201);
  const second = await S.api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'Pat', lastName: 'Ending' } });
  assert.equal(second.status, 200);
  assert.equal(second.json.passwordInvite, true);
  assert.notEqual(second.json.inviteLink, first.json.inviteLink);
  assert.equal((await S.api('GET', `/api/invites/${encodeURIComponent(tokenFrom(first.json.inviteLink))}`)).status, 404, 'the old link still works');
  assert.equal((await S.api('GET', `/api/invites/${encodeURIComponent(tokenFrom(second.json.inviteLink))}`)).status, 200);

  // an admin must not obtain a password link for an existing admin / super-admin
  const adm = await mkUser('admin', 'inv-admin');
  assert.equal((await S.api('POST', '/api/invites', { token: U.admin.token, body: { email: adm.email, firstName: 'A', lastName: 'B' } })).status, 403);
  assert.equal((await S.api('POST', '/api/invites', { token: U.admin.token, body: { email: `${RUN}-x@accounts.test`, firstName: 'A', lastName: 'B', role: 'admin' } })).status, 403);
  // a deactivated pending invitee cannot accept
  const t = tokenFrom(second.json.inviteLink);
  await prisma.user.update({ where: { email }, data: { active: false } });
  assert.equal((await S.api('POST', `/api/invites/${encodeURIComponent(t)}/accept`, { body: { password: 'Invited!2345' } })).status, 404);
});

test('invites: SMTP down → 201 emailed:false + mailError + copyable link (no 500, no half-done state)', async () => {
  const email = `${RUN}-nomail@accounts.test`;
  const r = await BROKE.api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'No', lastName: 'Mail' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.emailed, false);
  assert.equal(r.json.mailDriver, 'smtp');
  assert.match(r.json.mailError, /ECONNREFUSED/);
  assert.match(r.json.message, /could not be sent/);
  const token = tokenFrom(r.json.inviteLink);
  assert.ok(token);
  const user = await prisma.user.findUnique({ where: { email } });
  assert.ok(user && user.active);
  assert.equal(await prisma.authToken.count({ where: { userId: user.id, kind: 'invite', usedAt: null } }), 1);
  // the copied link works on any instance of the same DB
  const acc = await S.api('POST', `/api/invites/${encodeURIComponent(token)}/accept`, { body: { password: 'Copied!23456' } });
  assert.equal(acc.status, 200, acc.text);
  // invalid input creates nothing
  const bad = await BROKE.api('POST', '/api/invites', { token: U.admin.token, body: { email: `${RUN}-bad@accounts.test`, firstName: 'No' } });
  assert.equal(bad.status, 400);
  assert.equal(await prisma.user.findUnique({ where: { email: `${RUN}-bad@accounts.test` } }), null);
});

test('invite accept / validate are rate limited per IP', async () => {
  const ip = '127.7.7.7';
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await LIM.api('GET', `/api/invites/${'z'.repeat(43)}${i}`, { ip })).status);
  assert.deepEqual(codes, [404, 404, 404, 404, 429, 429]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Several quotes / invoices per job
// ═════════════════════════════════════════════════════════════════════════════
test('documents: a job may have several quotes and invoices; one live invoice per quote; void → re-bill', async () => {
  const job = await mkJob();
  const q1 = await S.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, lines: [{ description: 'Water heater', quantity: 1, unitPrice: 1800 }] } });
  const q2 = await S.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, amount: 75 } });
  assert.equal(q1.status, 201, q1.text);
  assert.equal(q2.status, 201, q2.text);
  assert.equal(q2.json.subtotal, 75); assert.equal(q2.json.taxTotal, 0);
  for (const q of [q1, q2]) {
    const ok = await S.api('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { status: 'approved', version: q.json.version } });
    assert.equal(ok.status, 200, ok.text);
  }
  const i1 = await S.api('POST', `/api/invoices/from-quote/${q1.json.id}`, { token: U.admin.token, body: { dueDate: '2026-12-05' } });
  const i2 = await S.api('POST', `/api/invoices/from-quote/${q2.json.id}`, { token: U.admin.token, body: {} });
  assert.equal(i1.status, 201, i1.text);
  assert.equal(i2.status, 201, i2.text);
  assert.equal(i1.json.quoteId, q1.json.id);
  const dup = await S.api('POST', `/api/invoices/from-quote/${q1.json.id}`, { token: U.admin.token, body: {} });
  assert.equal(dup.status, 409); assert.equal(dup.json.code, 'DUPLICATE'); assert.equal(dup.json.invoiceId, i1.json.id);

  // a wrong sent invoice: void it and bill the same quote again on the same job
  const v = await S.api('PATCH', `/api/invoices/${i1.json.id}`, { token: U.admin.token, body: { status: 'void', version: i1.json.version } });
  assert.equal(v.status, 200, v.text);
  const i3 = await S.api('POST', `/api/invoices/from-quote/${q1.json.id}`, { token: U.admin.token, body: {} });
  assert.equal(i3.status, 201, i3.text);
  // un-voiding the first one now would make two live invoices for one quote → 409
  const back = await S.api('PATCH', `/api/invoices/${i1.json.id}`, { token: U.admin.token, body: { status: 'unpaid', version: v.json.version } });
  assert.equal(back.status, 409); assert.equal(back.json.code, 'DUPLICATE');

  const j = await S.api('GET', `/api/jobs/${job.id}`, { token: U.admin.token });
  assert.equal(j.json.quotes.length, 2);
  assert.equal(j.json.invoices.length, 3);
  assert.equal(j.json.quote.id, q2.json.id, 'quote = newest');
  assert.equal(j.json.invoice.id, i3.json.id, 'invoice = newest non-void');
  const list = (await S.api('GET', '/api/jobs?limit=1000', { token: U.admin.token })).json.find((x) => x.id === job.id);
  assert.equal(list.invoices.length, 3);
  const act = (await S.api('GET', `/api/jobs/${job.id}/activity`, { token: U.admin.token })).json;
  assert.equal(act.filter((e) => e.type === 'quote_created').length, 2);
  assert.equal(act.filter((e) => e.type === 'invoice_created').length, 3);
  const comm = await S.api('GET', `/api/communications?customerId=${job.customerId}`, { token: U.admin.token });
  assert.equal(comm.json.timeline.filter((t) => t.jobId === job.id).length, 5);
  const csv = await S.api('GET', '/api/exports/invoices', { token: U.admin.token });
  const header = csv.text.split('\n')[0];
  assert.match(header, /"?quoteId"?,"?company"?$/);
  const cust = await S.api('GET', `/api/customers/${job.customerId}`, { token: U.admin.token });
  assert.equal(cust.json.jobs[0].invoices.length, 3);
  // technicians on someone else's job see no billing (TECH_VISIBILITY own → 403 anyway)
  assert.equal((await S.api('GET', `/api/jobs/${job.id}`, { token: U.tech.token })).status, 403);
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Customer company
// ═════════════════════════════════════════════════════════════════════════════
test('customers: company on create / update / list / search / exports / print', async () => {
  const co = `Prairie Dental ${RUN}`;
  const c = await S.api('POST', '/api/customers', { token: U.dispatcher.token, body: { firstName: 'Ravi', lastName: `Mehta-${RUN}`, company: co, phone: '620-555-0122', address: '900 N Main St', city: 'Hutchinson', zip: '67501', type: 'commercial' } });
  assert.equal(c.status, 201, c.text);
  assert.equal(c.json.company, co);
  const found = await S.api('GET', `/api/customers?search=${encodeURIComponent('prairie dental')}`, { token: U.dispatcher.token });
  assert.ok(found.json.some((x) => x.id === c.json.id), 'search by company');
  const up = await S.api('PATCH', `/api/customers/${c.json.id}`, { token: U.dispatcher.token, body: { company: `${co} LLC`, version: c.json.version } });
  assert.equal(up.json.company, `${co} LLC`);
  const list = await S.api('GET', '/api/customers', { token: U.dispatcher.token });
  assert.equal(list.json.find((x) => x.id === c.json.id).company, `${co} LLC`);
  const cleared = await S.api('PATCH', `/api/customers/${c.json.id}`, { token: U.dispatcher.token, body: { company: '  ', version: up.json.version } });
  assert.equal(cleared.json.company, null);
  await S.api('PATCH', `/api/customers/${c.json.id}`, { token: U.dispatcher.token, body: { company: co, version: cleared.json.version } });

  const job = await prisma.job.create({ data: { title: `AC company job ${RUN}`, customerId: c.json.id } });
  const inv = await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 410 } });
  const view = await S.api('GET', `/api/invoices/${inv.json.id}`, { token: U.admin.token });
  assert.equal(view.json.print.customer.company, co);
  assert.equal(view.json.print.customer.name, `${co} (attn. Ravi Mehta-${RUN})`);
  const jobsList = await S.api('GET', '/api/jobs?limit=1000', { token: U.dispatcher.token });
  assert.equal(jobsList.json.find((x) => x.id === job.id).customer.company, co);
  for (const p of ['/api/exports/customers', '/api/exports/jobs', '/api/exports/invoices', '/api/exports/quotes']) {
    const r = await S.api('GET', p, { token: U.admin.token });
    assert.equal(r.status, 200);
    assert.match(r.text.split('\n')[0], /company/, `${p} has no company column`);
  }
  assert.ok((await S.api('GET', '/api/exports/customers', { token: U.admin.token })).text.includes(co));
  assert.ok((await S.api('GET', '/api/exports/invoices', { token: U.admin.token })).text.includes(co));
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Pricebook CSV import
// ═════════════════════════════════════════════════════════════════════════════
test('pricebook import: template, dry run writes nothing, commit, idempotent re-run, updates, errors', async () => {
  const tpl = await S.api('GET', '/api/pricebook/import/template.csv', { token: U.admin.token });
  assert.equal(tpl.status, 200);
  assert.match(tpl.headers['content-type'], /text\/csv/);
  assert.match(tpl.text, /^sku,name,category,/);
  assert.equal((await S.api('GET', '/api/pricebook/import/template.csv', { token: U.dispatcher.token })).status, 403);

  const csv = [
    'SKU,Name,Category,Description,Price,Cost,Unit,Taxable',
    `${RUN}-WH,Water Heater Install ${RUN},Water Heaters,Tank 50 gal,"$1,800.00",900,each,yes`,
    `,Service Call ${RUN},Labor,,95,0,each,no`,
    `${RUN}-BAD,Bad Price ${RUN},Labor,,abc,,,`,
    `${RUN}-TAX,Bad Tax ${RUN},Labor,,10,,,maybe`,
    `,,Labor,,10,,,`,
    `${RUN}-WH,Duplicate ${RUN},Water Heaters,,1,,,`,
    ',,,,,,,',
  ].join('\n');
  const dry = await S.api('POST', '/api/pricebook/import', { token: U.admin.token, raw: csv });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.mode, 'dry-run');
  assert.equal(dry.json.committed, false);
  assert.deepEqual(dry.json.counts, { rows: 7, created: 2, updated: 0, skipped: 1, errored: 4 });
  assert.equal(await prisma.priceBookItem.count({ where: { name: { contains: RUN } } }), 0, 'dry run wrote rows');
  const byRow = Object.fromEntries(dry.json.rows.map((r) => [r.row, r]));
  assert.equal(byRow[3].errors[0].field, 'price');
  assert.equal(byRow[4].errors[0].field, 'taxable');
  assert.equal(byRow[5].errors[0].code, 'REQUIRED');
  assert.equal(byRow[6].errors[0].code, 'DUPLICATE_IN_FILE');
  assert.equal(byRow[7].reason, 'blank row');

  const commit = await S.api('POST', '/api/pricebook/import?dryRun=false', { token: U.admin.token, ...multipart({ file: { filename: 'pb.csv', content: csv } }) });
  assert.equal(commit.status, 200, commit.text);
  assert.equal(commit.json.committed, true);
  assert.equal(commit.json.counts.created, 2);
  const wh = await prisma.priceBookItem.findUnique({ where: { sku: `${RUN}-WH` } });
  assert.equal(wh.price, 1800); assert.equal(wh.taxable, true); assert.equal(wh.category, 'Water Heaters');

  const again = await S.api('POST', '/api/pricebook/import?dryRun=false', { token: U.admin.token, raw: csv });
  assert.deepEqual(again.json.counts, { rows: 7, created: 0, updated: 0, skipped: 3, errored: 4 }, 'not idempotent');

  // price change by sku; name+category match adopts a sku
  const upd = [
    'sku,name,category,price',
    `${RUN}-WH,Water Heater Install ${RUN},Water Heaters,1850`,
    `${RUN}-SC,Service Call ${RUN},labor,`,
  ].join('\n');
  const u = await S.api('POST', '/api/pricebook/import?dryRun=false', { token: U.admin.token, raw: upd });
  assert.equal(u.json.counts.updated, 2, u.text);
  assert.deepEqual(u.json.rows[0].changes.price, { from: 1800, to: 1850 });
  const sc = await prisma.priceBookItem.findFirst({ where: { name: `Service Call ${RUN}` } });
  assert.equal(sc.sku, `${RUN}-SC`);
  assert.equal(sc.price, 95, 'a blank cell cleared the price');
  assert.equal(await prisma.priceBookItem.count({ where: { name: { contains: RUN } } }), 2);

  // permissions and bad input
  assert.equal((await S.api('POST', '/api/pricebook/import', { token: U.dispatcher.token, raw: csv })).status, 403);
  assert.equal((await S.api('POST', '/api/pricebook/import?dryRun=maybe', { token: U.admin.token, raw: csv })).json.code, 'INVALID_ENUM');
  assert.equal((await S.api('POST', '/api/pricebook/import', { token: U.admin.token, raw: 'foo,bar\n1,2' })).json.code, 'REQUIRED');
  assert.equal((await S.api('POST', '/api/pricebook/import', { token: U.admin.token, raw: '"name,category\n' })).json.code, 'INVALID_CSV');
  assert.equal((await S.api('POST', '/api/pricebook/import', { token: U.admin.token, body: {} })).json.code, 'REQUIRED');
  // sku is editable and unique through the normal API
  const dupSku = await S.api('PATCH', `/api/pricebook/${sc.id}`, { token: U.admin.token, body: { sku: `${RUN}-WH` } });
  assert.equal(dupSku.status, 409);
});

// ═════════════════════════════════════════════════════════════════════════════
// 8 + 9. Slogan, EMAIL_FAILED
// ═════════════════════════════════════════════════════════════════════════════
test('brand: a blank BRAND_COMPANY_SLOGAN renders empty; unset keeps the generic tagline', async () => {
  const bv = require('../helpers/brandValidate');
  assert.equal(bv.buildBrand({ BRAND_COMPANY_SLOGAN: '' }).companySlogan, '');
  assert.equal(bv.buildBrand({ BRAND_COMPANY_SLOGAN: '  ' }).companySlogan, '');
  assert.equal(bv.buildBrand({}).companySlogan, 'Field Service Management');
  assert.equal(bv.buildBrand({ BRAND_COMPANY_SLOGAN: 'Honest plumbing' }).companySlogan, 'Honest plumbing');
  assert.equal((await BROKE.api('GET', '/api/brand')).json.companySlogan, '');
  assert.equal((await S.api('GET', '/api/brand')).json.companySlogan, 'Field Service Management');
});

test('document email with a broken mail server → 502 EMAIL_FAILED with the reason; nothing marked sent', async () => {
  const job = await mkJob();
  const inv = await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 2028 } });
  const q = await S.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, amount: 100 } });
  for (const [kind, id] of [['invoices', inv.json.id], ['quotes', q.json.id]]) {
    const r = await BROKE.api('POST', `/api/${kind}/${id}/email`, { token: U.admin.token, body: {} });
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.code, 'EMAIL_FAILED');
    assert.match(r.json.reason, /ECONNREFUSED/);
    assert.equal(r.json.delivered, false);
  }
  assert.equal((await prisma.invoice.findUnique({ where: { id: inv.json.id } })).sentAt, null);
  assert.equal((await prisma.quote.findUnique({ where: { id: q.json.id } })).status, 'draft');
  assert.equal(await prisma.communication.count({ where: { customerId: job.customerId } }), 0);
  assert.match(BROKE.output(), /email failed: .*ECONNREFUSED/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 13 + 15. Due dates are calendar dates; the reverse-charge placeholder never reaches a customer
// ═════════════════════════════════════════════════════════════════════════════
test('due dates: a Dec 5 due date is Dec 5 in America/Chicago — print, email, storage', async () => {
  const job = await mkJob({ title: `AC due ${RUN}` });
  await prisma.customer.update({ where: { id: job.customerId }, data: { email: `due-${RUN}@example.test` } });
  const inv = await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 100, dueDate: '2026-12-05' } });
  assert.equal(inv.status, 201, inv.text);
  assert.equal(new Date(inv.json.dueDate).toISOString(), '2026-12-05T00:00:00.000Z');
  const v = await S.api('GET', `/api/invoices/${inv.json.id}`, { token: U.admin.token });
  assert.equal(v.json.print.dueDate, '2026-12-05');
  assert.equal(v.json.print.formatted.dueDate, '12/05/2026');
  const e = await S.api('POST', `/api/invoices/${inv.json.id}/email`, { token: U.admin.token, body: {} });
  assert.equal(e.status, 200, e.text);
  const mail = await mailTo(`due-${RUN}@example.test`);
  assert.match(mail.text, /Due: 12\/05\/2026/);
  // an instant is read as the calendar date in the brand time zone (03:00Z Dec 5 = Dec 4 in Chicago)
  const inv2 = await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 100, dueDate: '2026-12-05T03:00:00Z' } });
  assert.equal(new Date(inv2.json.dueDate).toISOString(), '2026-12-04T00:00:00.000Z');
  assert.equal((await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 1, dueDate: '2026-02-30' } })).json.code, 'INVALID_INPUT');
  // issuedAt given as a bare date is that day in the brand time zone
  const inv3 = await S.api('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 100, issuedAt: '2026-12-05' } });
  const v3 = await S.api('GET', `/api/invoices/${inv3.json.id}`, { token: U.admin.token });
  assert.equal(v3.json.print.formatted.issuedAt, '12/05/2026');
  // from-quote dueDate too
  const q = await S.api('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, amount: 50 } });
  const fq = await S.api('POST', `/api/invoices/from-quote/${q.json.id}`, { token: U.admin.token, body: { dueDate: '2026-12-31' } });
  assert.equal(new Date(fq.json.dueDate).toISOString(), '2026-12-31T00:00:00.000Z');
});

test('due dates: rows stored as instants are rewritten to calendar dates at boot (brand time zone)', async () => {
  const job = await mkJob({ title: `AC due-boot ${RUN}` });
  const inv = await prisma.invoice.create({ data: { jobId: job.id, amount: 10, subtotal: 10, dueDate: new Date('2026-11-11T23:00:00.000Z') } });
  const s = await bootServer({});
  try {
    let row;
    for (let i = 0; i < 40; i++) {
      row = await prisma.invoice.findUnique({ where: { id: inv.id } });
      if (row.dueDate.toISOString() === '2026-11-11T00:00:00.000Z') break;
      await sleep(100);
    }
    assert.equal(row.dueDate.toISOString(), '2026-11-11T00:00:00.000Z'); // 17:00 CST Nov 11
  } finally { await s.stop(); }
});

test('email: the reverse-charge placeholder wording is never sent to a customer; a configured note is', () => {
  const { printView, renderEmail } = require('../helpers/documents');
  const { buildLocale } = require('../helpers/locale');
  const bv = require('../helpers/brandValidate');
  const doc = {
    number: 'INV-0042', status: 'unpaid', currency: 'EUR', reverseCharge: true, amount: 1000, subtotal: 1000, taxTotal: 0,
    issuedAt: new Date('2026-11-20T12:00:00Z'), dueDate: new Date('2026-12-05T00:00:00Z'), notes: '', lines: [],
    job: { title: 'Boiler install', customer: { firstName: 'Aoife', lastName: 'Byrne', company: 'Byrne Builders Ltd', country: 'IE' } },
  };
  const env = { BRAND_COUNTRY: 'IE', BRAND_TIMEZONE: 'Europe/Dublin' };
  const brand = bv.buildBrand(env);
  const placeholder = buildLocale(env, brand);
  const view = printView('invoice', doc, brand, placeholder);
  assert.equal(view.reverseChargeNoteIsPlaceholder, true);
  assert.equal(view.dueDate, '2026-12-05');
  const mail = renderEmail(view);
  assert.ok(!mail.text.includes(view.reverseChargeNote), 'placeholder in the text email');
  assert.ok(!mail.html.includes(view.reverseChargeNote.slice(0, 30)), 'placeholder in the html email');
  const real = buildLocale({ ...env, BRAND_RCT_NOTE: 'VAT reverse charge applies (s.16 VATCA 2010)' }, brand);
  const v2 = printView('invoice', doc, brand, real);
  assert.equal(v2.reverseChargeNoteIsPlaceholder, false);
  assert.match(renderEmail(v2).text, /VAT reverse charge applies \(s\.16 VATCA 2010\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
// Migration 20261121180000 on a database seeded at the previous migration
// ═════════════════════════════════════════════════════════════════════════════
test('migration 20261121180000_accounts_multi_documents on seeded data (real WASM engine)', async () => {
  const dbName = `${decodeURIComponent(new URL(TEST_DB).pathname.slice(1))}_mig_${RUN}`.toLowerCase().slice(0, 63);
  const url = new URL(TEST_DB); url.pathname = `/${dbName}`;
  const MIG_DB = url.toString();
  await pgQuery(pgAdminUrl(TEST_DB), `CREATE DATABASE "${dbName}"`);
  const stage = fs.mkdtempSync(path.join(TMP, 'stage-'));
  try {
    for (const d of ['scripts', 'helpers', path.join('prisma', 'migrations')]) fs.mkdirSync(path.join(stage, d), { recursive: true });
    fs.copyFileSync(path.join(BACKEND, 'scripts', 'migrate-deploy.mjs'), path.join(stage, 'scripts', 'migrate-deploy.mjs'));
    for (const f of ['loadEnv.js', 'databaseUrl.js']) fs.copyFileSync(path.join(BACKEND, 'helpers', f), path.join(stage, 'helpers', f));
    fs.copyFileSync(path.join(BACKEND, 'prisma', 'schema.prisma'), path.join(stage, 'prisma', 'schema.prisma'));
    fs.copyFileSync(path.join(BACKEND, 'prisma', 'migrations', 'migration_lock.toml'), path.join(stage, 'prisma', 'migrations', 'migration_lock.toml'));
    for (const m of fs.readdirSync(path.join(BACKEND, 'prisma', 'migrations')).filter((m) => /^\d+_/.test(m) && m < '20261121180000')) {
      fs.cpSync(path.join(BACKEND, 'prisma', 'migrations', m), path.join(stage, 'prisma', 'migrations', m), { recursive: true });
    }
    fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(stage, 'node_modules'));
    let r = runMigrate(MIG_DB, path.join(stage, 'scripts', 'migrate-deploy.mjs'));
    assert.equal(r.status, 0, r.stdout + r.stderr);

    await pgQuery(MIG_DB, `
      INSERT INTO "User" ("email","password","firstName","lastName","role") VALUES ('o@x.test','h','O','W','super-admin');
      INSERT INTO "Customer" ("firstName","lastName","phone","address") VALUES ('Old','One','1','1 St');
      INSERT INTO "Job" ("title","customerId") VALUES ('j1',1),('j2',1);
      INSERT INTO "Quote" ("jobId","amount","subtotal","status") VALUES (1, 500, 0, 'approved'), (2, 80, 80, 'draft');
      INSERT INTO "Invoice" ("jobId","amount","subtotal","status") VALUES (1, 500, 0, 'unpaid'), (2, 70, 0, 'paid');
      INSERT INTO "InvoiceLine" ("invoiceId","position","description","quantity","unitPrice","lineTotal") VALUES (2, 1, 'x', 1, 0, 0);
      INSERT INTO "JobActivity" ("jobId","jobRef","type","to") VALUES (1, 1, 'invoice_created', '{"invoiceId": 1, "fromQuoteId": 1, "number": "INV-0001"}');
      INSERT INTO "PriceBookItem" ("category","name") VALUES ('c','p');`);
    // before: one quote per job
    await assert.rejects(pgQuery(MIG_DB, `INSERT INTO "Quote" ("jobId","amount") VALUES (1, 5)`), /unique|duplicate/i);

    r = runMigrate(MIG_DB);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /20261121180000_accounts_multi_documents/);

    const users = (await pgQuery(MIG_DB, 'SELECT "sessionVersion", "mustChangePassword", "passwordChangedAt", "lastLoginAt" FROM "User"')).rows;
    assert.deepEqual(users, [{ sessionVersion: 0, mustChangePassword: false, passwordChangedAt: null, lastLoginAt: null }]);
    const inv = (await pgQuery(MIG_DB, 'SELECT id, "quoteId", subtotal::text, "taxTotal"::text FROM "Invoice" ORDER BY id')).rows;
    assert.deepEqual(inv, [{ id: 1, quoteId: 1, subtotal: '500.00', taxTotal: '0.00' }, { id: 2, quoteId: null, subtotal: '0.00', taxTotal: '0.00' }], 'backfill / amount-only subtotal (a document with lines keeps its own)');
    const q = (await pgQuery(MIG_DB, 'SELECT subtotal::text FROM "Quote" ORDER BY id')).rows.map((x) => x.subtotal);
    assert.deepEqual(q, ['500.00', '80.00']);
    // after: several quotes / invoices per job, one live invoice per quote
    await pgQuery(MIG_DB, `INSERT INTO "Quote" ("jobId","amount") VALUES (1, 5)`);
    await pgQuery(MIG_DB, `INSERT INTO "Invoice" ("jobId","amount") VALUES (1, 5)`);
    await assert.rejects(pgQuery(MIG_DB, `INSERT INTO "Invoice" ("jobId","quoteId","amount") VALUES (1, 1, 5)`), /unique|duplicate/i);
    await pgQuery(MIG_DB, `INSERT INTO "Invoice" ("jobId","quoteId","amount","status") VALUES (1, 1, 5, 'void')`);
    await pgQuery(MIG_DB, `UPDATE "PriceBookItem" SET sku = 'A1'`);
    await assert.rejects(pgQuery(MIG_DB, `INSERT INTO "PriceBookItem" ("category","name","sku") VALUES ('c','q','A1')`), /unique|duplicate/i);
    await pgQuery(MIG_DB, `INSERT INTO "AuthToken" ("userId","kind","tokenHash","expiresAt") VALUES (1, 'reset', 'h1', now())`);
    await assert.rejects(pgQuery(MIG_DB, `INSERT INTO "AuthToken" ("userId","kind","tokenHash","expiresAt") VALUES (1, 'magic', 'h2', now())`), /check/i);
    await pgQuery(MIG_DB, 'DELETE FROM "User"'); // tokens cascade
    assert.equal((await pgQuery(MIG_DB, 'SELECT count(*)::int n FROM "AuthToken"')).rows[0].n, 0);
    r = runMigrate(MIG_DB);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No pending migrations/);
  } finally {
    await pgQuery(pgAdminUrl(TEST_DB), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
  }
});
