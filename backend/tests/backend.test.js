/**
 * tests/backend.test.js — Backend contract / regression suite (HTTP level).
 *
 *   TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_backend_test?schema=public \
 *     npm run test:backend
 *
 * Covers the fixes whose behaviour the red-team suite (tests/redteam.test.js)
 * does not pin down: the Google one-time-code hand-off and fail-closed gate
 * (PLAT-3), QuickBooks state + token persistence (PLAT-4), version-required
 * PATCH (RT-9), technician read scoping (RT-21), authenticated presence and
 * sockets (RT-14), CORS (RT-27), query coercion (RT-28), TRUST_PROXY (RT-24),
 * the Gmail webhook secret (RT-26), backup response (RT-30), demo hint
 * (RT-23), API-key prefixes (RT-22), error mapping (RT-17), role matrix.
 *
 * Like the red-team suite: needs a throwaway TEST_DATABASE_URL (created and
 * migrated if missing), never reads .env, boots `node server.js` children in
 * SANDBOX_MODE, creates run-tagged synthetic rows and deletes them afterwards.
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
  console.error('[backend-test] TEST_DATABASE_URL is required (a throwaway database).');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
process.env.ENV_FILE = '/dev/null';
const SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = 'test';

const RUN      = `bt${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const PASSWORD = 'Backend!2345';
const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-backend-test-'));
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));

let prisma;
let srv;
const U = {};
const servers = [];

let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `127.1.${1 + Math.floor(ipSeq / 250) % 250}.${1 + (ipSeq % 250)}`; };

function request(base, method, p, { token, apiKey, body, headers = {}, ip, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const h = { ...headers };
    let data;
    if (raw !== undefined) { data = Buffer.from(raw); h['Content-Length'] = data.length; }
    else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    if (token)  h.Authorization = `Bearer ${token}`;
    if (apiKey) h['X-API-Key'] = apiKey;
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
const api = (method, p, opts) => request(srv.base, method, p, opts);

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
    MAIL_DRIVER: 'none', BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(TMP, 'backups'), BRAND_TRADE_TYPE: 'plumbing-hvac',
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

/** In-process mini app around one router (for flows that need its in-memory state). */
async function miniApp(mount, router) {
  const express = require('express');
  const { errorHandler } = require('../helpers/errorHandler');
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

async function ensureDatabase() {
  const { Client } = require('pg');
  const url = new URL(TEST_DB);
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres'; url.search = '';
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

async function mkUser(role, tag = role, extra = {}) {
  const bcrypt = require('bcryptjs');
  return prisma.user.create({
    data: { email: `${RUN}-${tag}@backend.test`, password: await bcrypt.hash(PASSWORD, 4), firstName: 'BT', lastName: tag, role, active: true, ...extra },
  });
}
async function login(email) {
  const r = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
const mkCustomer = (over = {}) => prisma.customer.create({
  data: { firstName: 'Niamh', lastName: `Kelly-${RUN}`, phone: '620-555-0142', address: '2 Synthetic Rd', city: 'Hutchinson', state: 'KS', zip: '67501', ...over },
});
const mkJob = (customerId, over = {}) => prisma.job.create({ data: { title: `BT job ${RUN}`, customerId, ...over } });

async function cleanup() {
  if (!prisma) return;
  const safe = (p) => p.catch(() => {});
  const users = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map((u) => u.id);
  const custs = (await prisma.customer.findMany({ where: { lastName: { contains: RUN } }, select: { id: true } })).map((c) => c.id);
  const jobs = (await prisma.job.findMany({ where: { OR: [{ customerId: { in: custs } }, { technicianId: { in: users } }, { title: { contains: RUN } }] }, select: { id: true } })).map((j) => j.id);
  await safe(prisma.invoice.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.quote.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.jobPhoto.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobs } } }));
  await safe(prisma.communication.deleteMany({ where: { customerId: { in: custs } } }));
  await safe(prisma.customer.deleteMany({ where: { id: { in: custs } } }));
  await safe(prisma.apiKey.deleteMany({ where: { createdById: { in: users } } }));
  await safe(prisma.user.deleteMany({ where: { id: { in: users } } }));
}

before(async () => {
  await ensureDatabase();
  prisma = require('../helpers/prisma');
  srv = await bootServer();
  assert.ok(srv.alive(), srv.output());
  for (const [k, role] of [['sa', 'super-admin'], ['admin', 'admin'], ['dispatcher', 'dispatcher'], ['tech', 'technician'], ['tech2', 'technician']]) {
    const u = await mkUser(role, k);
    U[k] = { id: u.id, email: u.email, token: await login(u.email) };
  }
});

after(async () => {
  try { await cleanup(); } finally {
    for (const s of servers) await s.stop();
    if (prisma) await prisma.$disconnect().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }
});

// ── PLAT-3 Google sign-in ───────────────────────────────────────────────────
const GOOGLE_ENV = { SANDBOX_MODE: null, DEMO_MODE: null, GOOGLE_CLIENT_ID: 'bt-client.apps.example', GOOGLE_CLIENT_SECRET: 'bt-client-secret-value', GOOGLE_CALLBACK_URL: 'http://localhost/api/auth/google/callback' };
const profile = (email, extra = {}) => ({ emails: [{ value: email }], name: { givenName: 'G', familyName: 'User' }, _json: { email_verified: true }, ...extra });

test('PLAT-3 Google gate: existing user signs in; unknown email is refused unless its domain is allow-listed', () => withEnv({ GOOGLE_ALLOWED_DOMAINS: null }, async () => {
  const { resolveGoogleUser } = require('../routes/googleAuth');
  const ok = await resolveGoogleUser(profile(U.tech.email));
  assert.equal(ok.user && ok.user.id, U.tech.id);

  const stranger = `${RUN}-stranger@gmail.example`;
  const no = await resolveGoogleUser(profile(stranger));
  assert.match(no.error, /not been invited/);
  assert.equal(await prisma.user.findUnique({ where: { email: stranger } }), null, 'uninvited Google user was provisioned');

  process.env.GOOGLE_ALLOWED_DOMAINS = 'backend-allowed.example, other.example';
  const insider = `${RUN}-new@backend-allowed.example`;
  const yes = await resolveGoogleUser(profile(insider));
  assert.equal(yes.user.role, 'technician');
  assert.equal(yes.user.active, true);
  assert.match((await resolveGoogleUser(profile(`${RUN}-x@evil.example`))).error, /not been invited/);
}));

test('PLAT-3 Google gate: deactivated users and unverified emails are refused', async () => {
  const { resolveGoogleUser } = require('../routes/googleAuth');
  const u = await mkUser('technician', 'g-deact', { active: false });
  assert.match((await resolveGoogleUser(profile(u.email))).error, /deactivated/);
  assert.match((await resolveGoogleUser(profile(U.tech.email, { _json: { email_verified: false } }))).error, /not verified/);
});

test('PLAT-3 one-time code: exchanged once via POST for {token,user}; token honours JWT_EXPIRES; no JWT in URLs', () => withEnv({ ...GOOGLE_ENV, JWT_EXPIRES: '15m' }, async () => {
  const router = require('../routes/googleAuth');
  const app = await miniApp('/api/auth', router);
  try {
    const code = router.issueLoginCode(U.tech.id);
    const r = await request(app.base, 'POST', '/api/auth/google/exchange', { body: { code } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.id, U.tech.id);
    const payload = require('jsonwebtoken').verify(r.json.token, SECRET);
    assert.ok(Math.abs(payload.exp - payload.iat - 15 * 60) <= 1, `token lifetime ${payload.exp - payload.iat}s, expected 900s`);
    const again = await request(app.base, 'POST', '/api/auth/google/exchange', { body: { code } });
    assert.equal(again.status, 401, 'code reusable');
    assert.equal((await request(app.base, 'POST', '/api/auth/google/exchange', { body: { code: 'nope' } })).status, 401);

    // start: redirect to Google carrying a state that matches an HttpOnly cookie
    const start = await request(app.base, 'GET', '/api/auth/google');
    assert.equal(start.status, 302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const cookie = [].concat(start.headers['set-cookie'] || []).find((c) => c.startsWith('mbc_google_state='));
    assert.ok(state && cookie && cookie.includes(`=${state};`) && /HttpOnly/i.test(cookie));
    // callback with a forged state never reaches Google and never mints a token
    const cb = await request(app.base, 'GET', '/api/auth/google/callback?code=x&state=forged', { headers: { Cookie: `mbc_google_state=${state}` } });
    assert.equal(cb.status, 302);
    assert.match(cb.headers.location, /^\/\?auth_error=/);
    assert.doesNotMatch(cb.headers.location, /token=/);
  } finally { await app.close(); }
}));

// ── PLAT-4 QuickBooks ───────────────────────────────────────────────────────
test('PLAT-4 QuickBooks state is random, cookie-bound and single-use; tokens persist encrypted', () => withEnv({ SANDBOX_MODE: null, DEMO_MODE: null, QB_CLIENT_ID: 'bt-qb-client', QB_CLIENT_SECRET: 'bt-qb-secret-value', QB_REDIRECT_URI: 'http://localhost/api/quickbooks/callback' }, async () => {
  const router = require('../routes/quickbooks');
  const { consumeState, newState, saveTokens, loadTokens } = router._test;
  const s1 = newState(U.admin.id);
  const s2 = newState(U.admin.id);
  assert.notEqual(s1, s2);
  assert.ok(s1.length >= 40);
  assert.equal(consumeState(s1, s2), null, 'state accepted without the matching cookie');
  assert.deepEqual(consumeState(s1, s1), { userId: U.admin.id });
  assert.equal(consumeState(s1, s1), null, 'state reusable');

  const app = await miniApp('/api/quickbooks', router);
  try {
    assert.equal((await request(app.base, 'GET', '/api/quickbooks/status')).status, 401);
    // Through the real server (auth) the connect endpoint is admin-only
    assert.equal((await request(app.base, 'GET', '/api/quickbooks/callback?code=x&state=forged&realmId=1')).headers.location, '/?qbo=error&reason=state');
  } finally { await app.close(); }

  await prisma.integrationToken.deleteMany({ where: { provider: 'quickbooks' } });
  await saveTokens({ access_token: 'bt-access', refresh_token: 'bt-refresh', expires_in: 3600, x_refresh_token_expires_in: 86400 }, { realmId: '4620816365', userId: U.admin.id });
  const row = await prisma.integrationToken.findUnique({ where: { provider: 'quickbooks' } });
  assert.ok(row.accessToken.startsWith('v1:') && !row.accessToken.includes('bt-access'), 'token stored in clear');
  const t = await loadTokens();
  assert.equal(t.accessToken, 'bt-access');
  assert.equal(t.refreshToken, 'bt-refresh');
  const st = await api('GET', '/api/quickbooks/status', { token: U.tech.token });
  assert.equal(st.status, 200);
  assert.equal(st.json.connected, true);
  assert.ok(!JSON.stringify(st.json).includes('bt-access'));
  assert.equal((await api('POST', '/api/quickbooks/connect', { token: U.tech.token })).status, 403);
  await prisma.integrationToken.deleteMany({ where: { provider: 'quickbooks' } });
}));

// ── RT-9 version required ───────────────────────────────────────────────────
test('RT-9 PATCH without version is 400 VERSION_REQUIRED; a stale version is 409 with currentVersion', async () => {
  const c = await mkCustomer();
  const r = await api('PATCH', `/api/customers/${c.id}`, { token: U.admin.token, body: { notes: 'x' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'VERSION_REQUIRED');
  const ok = await api('PUT', `/api/customers/${c.id}`, { token: U.admin.token, body: { notes: 'y', version: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.version, 2);
  const stale = await api('PATCH', `/api/customers/${c.id}`, { token: U.admin.token, body: { notes: 'z', version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'VERSION_CONFLICT');
  assert.equal(stale.json.currentVersion, 2);
});

// ── RT-21 technician scoping, RT-8 technician job edits ─────────────────────
test('RT-21 technicians list only their own jobs, customers, invoices and comms', async () => {
  const mine = await mkCustomer();
  const theirs = await mkCustomer();
  const j1 = await mkJob(mine.id, { technicianId: U.tech.id });
  const j2 = await mkJob(theirs.id, { technicianId: U.tech2.id });
  await prisma.invoice.create({ data: { jobId: j1.id, amount: 100 } });
  await prisma.invoice.create({ data: { jobId: j2.id, amount: 200 } });
  await prisma.communication.create({ data: { customerId: theirs.id, type: 'note', subject: 'private' } });

  const jobs = (await api('GET', '/api/jobs', { token: U.tech.token })).json;
  assert.ok(jobs.every((j) => j.technicianId === U.tech.id) && jobs.some((j) => j.id === j1.id));
  const custs = (await api('GET', '/api/customers', { token: U.tech.token })).json;
  assert.ok(custs.some((c) => c.id === mine.id) && !custs.some((c) => c.id === theirs.id));
  const invs = (await api('GET', '/api/invoices', { token: U.tech.token })).json;
  assert.ok(invs.some((i) => i.jobId === j1.id) && !invs.some((i) => i.jobId === j2.id));
  assert.equal((await api('GET', `/api/jobs/${j2.id}`, { token: U.tech.token })).status, 403);
  assert.equal((await api('GET', `/api/customers/${theirs.id}`, { token: U.tech.token })).status, 403);
  assert.equal((await api('GET', `/api/communications?customerId=${theirs.id}`, { token: U.tech.token })).status, 403);
  // office roles still see everything
  const all = (await api('GET', '/api/jobs', { token: U.dispatcher.token })).json;
  assert.ok(all.some((j) => j.id === j2.id));
});

test('RT-8 technician may update status/notes on their own job only, never schedule or cancel', async () => {
  const c = await mkCustomer();
  const own = await mkJob(c.id, { technicianId: U.tech.id, status: 'scheduled' });
  const other = await mkJob(c.id, { technicianId: U.tech2.id });
  const ok = await api('PATCH', `/api/jobs/${own.id}`, { token: U.tech.token, body: { status: 'in-progress', notes: 'on site', version: own.version } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'in-progress');
  assert.equal((await api('PATCH', `/api/jobs/${other.id}`, { token: U.tech.token, body: { notes: 'x', version: 1 } })).status, 403);
  assert.equal((await api('PATCH', `/api/jobs/${own.id}`, { token: U.tech.token, body: { scheduledDate: '2031-02-02', version: 2 } })).status, 403);
  assert.equal((await api('PATCH', `/api/jobs/${own.id}`, { token: U.tech.token, body: { status: 'cancelled', version: 2 } })).status, 403);
  assert.equal((await api('POST', '/api/jobs', { token: U.tech.token, body: { title: `t ${RUN}`, customerId: c.id } })).status, 403);
});

test('role matrix: admins cannot edit or invite admins; super-admin can promote', async () => {
  const other = await mkUser('admin', 'admin2');
  assert.equal((await api('PATCH', `/api/users/${other.id}`, { token: U.admin.token, body: { firstName: 'X' } })).status, 403);
  assert.equal((await api('POST', '/api/invites', { token: U.admin.token, body: { email: `${RUN}-inv-a@backend.test`, role: 'admin' } })).status, 403);
  const t = await mkUser('technician', 'promote');
  const p = await api('PATCH', `/api/users/${t.id}`, { token: U.sa.token, body: { role: 'dispatcher' } });
  assert.equal(p.status, 200);
  assert.equal(p.json.role, 'dispatcher');
  const self = await api('PATCH', `/api/users/${U.tech.id}`, { token: U.tech.token, body: { phone: '620-555-0100' } });
  assert.equal(self.status, 200, 'users can edit their own phone');
  assert.equal((await api('PATCH', `/api/users/${U.sa.id}`, { token: U.sa.token, body: { active: false } })).status, 403, 'self-deactivation');
});

test('invites: POST /api/invites pre-creates the invited user (Google gate) — RT-29: no /api/auth/send', async () => {
  const email = `${RUN}-invitee@backend.test`;
  const r = await api('POST', '/api/invites', { token: U.admin.token, body: { email, role: 'technician', firstName: 'In', lastName: 'Vitee' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.created, true);
  const row = await prisma.user.findUnique({ where: { email } });
  assert.equal(row.role, 'technician');
  assert.equal((await api('POST', '/api/auth/send', { token: U.admin.token, body: { email } })).status, 404);
  assert.equal((await api('POST', '/api/invites/send', { token: U.tech.token, body: { email: `${RUN}-z@backend.test` } })).status, 403);
});

// ── RT-14 presence / sockets (positive path) ────────────────────────────────
function socketSession(base, { token, frames = [] } = {}) {
  return new Promise((resolve) => {
    const got = [];
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`);
    const done = () => { try { ws.close(); } catch { /* ignore */ } resolve(got); };
    ws.onmessage = (m) => {
      const d = String(m.data);
      got.push(d);
      if (d.startsWith('0{')) ws.send(token ? `40${JSON.stringify({ token })}` : '40');
      else if (d.startsWith('40')) { for (const f of frames) ws.send(f); setTimeout(done, 500); }
      else if (d.startsWith('44')) setTimeout(done, 50);
    };
    ws.onerror = () => setTimeout(done, 50);
    setTimeout(done, 3000);
  });
}

test('RT-14 an authenticated socket joins presence as its token user (payload user ignored)', async () => {
  const got = await socketSession(srv.base, { token: U.dispatcher.token, frames: ['42["viewing-job",{"jobId":4242,"user":{"id":1,"firstName":"Spoof"}}]'] });
  assert.ok(got.some((f) => f.startsWith('40')), `not connected: ${got}`);
  const upd = got.find((f) => f.startsWith('42["presence-update"'));
  assert.ok(upd, 'no presence-update');
  assert.ok(upd.includes(`"userId":${U.dispatcher.id}`) && !upd.includes('Spoof'));
  assert.equal((await api('GET', '/api/presence', { token: U.tech.token })).status, 200);
  assert.equal((await api('GET', '/api/presence', { token: 'garbage' })).status, 401);
  const bad = await socketSession(srv.base, { token: 'not-a-jwt' });
  assert.ok(!bad.some((f) => f.startsWith('40')), 'bad token connected');
});

// ── RT-15 / RT-27 / RT-28 / RT-17 ───────────────────────────────────────────
test('RT-15 CSP allows the inline pages but blocks plugins, framing and base hijack', async () => {
  const csp = (await api('GET', '/index.html')).headers['content-security-policy'];
  for (const d of ["script-src 'self' 'unsafe-inline'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"]) assert.ok(csp.includes(d), `${d} missing in ${csp}`);
});

test('RT-27 CORS: only APP_URL / CORS_ORIGINS get Access-Control-Allow-Origin', async () => {
  const evil = await api('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const own = await api('GET', '/api/health', { headers: { Origin: new URL(srv.base).origin.replace('127.0.0.1', 'localhost') } });
  assert.equal(own.headers['access-control-allow-origin'], new URL(srv.base).origin.replace('127.0.0.1', 'localhost'));
});

test('RT-28 nested / repeated query params are coerced to strings (no Prisma operators, no 500)', async () => {
  for (const q of ['/api/pricebook?industry[not]=x', '/api/customers?search[x]=1', '/api/customers?search=a&search=b', '/api/jobs?status[in]=pending']) {
    const r = await api('GET', q, { token: U.admin.token });
    assert.equal(r.status, 200, `${q} → ${r.status} ${r.text.slice(0, 80)}`);
  }
  const pb = await api('GET', '/api/pricebook?industry[not]=x', { token: U.admin.token });
  assert.notEqual(pb.json.industry, undefined);
  assert.equal(typeof pb.json.industry, 'string');
});

test('RT-17 FK conflicts are 409, malformed JSON is 400, unknown API routes are JSON 404', async () => {
  const c = await mkCustomer();
  await mkJob(c.id);
  const del = await api('DELETE', `/api/customers/${c.id}`, { token: U.admin.token });
  assert.equal(del.status, 409);
  assert.equal(del.json.code, 'IN_USE_OR_MISSING_REFERENCE');
  const bad = await api('POST', '/api/customers', { token: U.admin.token, raw: '{"firstName":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_JSON');
  const nf = await api('GET', '/api/nope', { token: U.admin.token });
  assert.equal(nf.status, 404);
  assert.equal(nf.json.code, 'NOT_FOUND');
});

// ── RT-16 SMS (positive path) ───────────────────────────────────────────────
test('RT-16 office roles can SMS a customer number on record (sandbox: not sent)', async () => {
  const c = await mkCustomer({ phone: '(620) 555-0177' });
  const r = await api('POST', '/api/sms/send', { token: U.dispatcher.token, body: { to: '+1 620 555 0177', body: 'Running 10 min late' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.sent, false);
  const byId = await api('POST', `/api/sms/customer/${c.id}`, { token: U.admin.token, body: {} });
  assert.equal(byId.status, 200, byId.text);
  assert.equal(byId.json.sentTo, '(620) 555-0177');
  assert.equal((await api('POST', `/api/sms/customer/${c.id}`, { token: U.tech.token, body: {} })).status, 403);
});

// ── RT-22 API keys ──────────────────────────────────────────────────────────
test('RT-22 new API keys use a 16-char prefix; legacy 8-char-prefix keys still authenticate', async () => {
  const r = await api('POST', '/api/api-keys', { token: U.admin.token, body: { name: `${RUN} key`, scopes: 'read' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.prefix.length, 16);
  assert.equal((await api('GET', '/api/customers', { apiKey: r.json.key })).status, 200);
  assert.equal((await api('POST', '/api/api-keys', { token: U.admin.token, body: { name: 'x', scopes: 'root' } })).status, 400);
  assert.equal((await api('POST', '/api/api-keys', { apiKey: r.json.key, body: { name: 'x' } })).status, 403);

  const bcrypt = require('bcryptjs');
  const legacy = `mbc_${crypto.randomBytes(20).toString('hex')}`;
  await prisma.apiKey.create({ data: { name: `${RUN} legacy`, prefix: legacy.slice(0, 8), hashedKey: await bcrypt.hash(legacy, 4), scopes: 'read', createdById: U.admin.id } });
  assert.equal((await api('GET', '/api/customers', { apiKey: legacy })).status, 200);
});

// ── RT-30 backups ───────────────────────────────────────────────────────────
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;
test('RT-30 backup run never returns a server path and cannot be spammed', { skip: !hasPgDump && 'pg_dump not on PATH' }, async () => {
  const s = await bootServer({ BACKUP_COOLDOWN_SECONDS: '600' });
  const r = await request(s.base, 'POST', '/api/backup/run', { token: U.admin.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.local, undefined);
  assert.ok(!r.text.includes(TMP), 'response leaks a filesystem path');
  assert.equal((await request(s.base, 'POST', '/api/backup/run', { token: U.admin.token })).status, 429);
  await s.stop();
});

// ── RT-26 Gmail webhook with a secret ───────────────────────────────────────
test('RT-26 Gmail webhook: 503 without a secret; with one, wrong → 401, right → 200', () => withEnv({ GMAIL_WEBHOOK_SECRET: null }, async () => {
  const app = await miniApp('/api/communications', require('../routes/communications'));
  try {
    assert.equal((await request(app.base, 'POST', '/api/communications/gmail/webhook', { body: {} })).status, 503);
    process.env.GMAIL_WEBHOOK_SECRET = 'bt-webhook-secret-0123456789';
    assert.equal((await request(app.base, 'POST', '/api/communications/gmail/webhook', { body: {}, headers: { 'X-Webhook-Secret': 'wrong' } })).status, 401);
    assert.equal((await request(app.base, 'POST', '/api/communications/gmail/webhook?token=bt-webhook-secret-0123456789', { body: {} })).status, 200);
  } finally { await app.close(); }
}));

// ── RT-23 demo hint, RT-6 dev boot, RT-24 TRUST_PROXY ───────────────────────
test('RT-23 /api/brand exposes demoLogin only in demo mode', async () => {
  assert.equal((await api('GET', '/api/brand')).json.demoLogin, null);
  const s = await bootServer({ DEMO_MODE: 'true', ADMIN_EMAIL: 'admin@demo.test', ADMIN_PASSWORD: 'demo-pass-1234' });
  const b = (await request(s.base, 'GET', '/api/brand')).json;
  assert.equal(b.demoMode, true);
  assert.deepEqual(b.demoLogin, { email: 'admin@demo.test', password: 'demo-pass-1234' });
  await s.stop();
});

test('RT-6 outside production a missing JWT_SECRET boots with a warning and a random secret', async () => {
  const s = await bootServer({ JWT_SECRET: null, NODE_ENV: 'development' });
  assert.ok(s.alive());
  assert.match(s.output(), /JWT_SECRET is not set/);
  assert.equal((await request(s.base, 'GET', '/api/users', { token: U.sa.token })).status, 401, 'token signed with another secret accepted');
  await s.stop();
});

test('RT-24 with TRUST_PROXY=1 the limiter keys on the forwarded client IP; without it XFF is ignored', async () => {
  const fire = async (base, xff) => {
    let last;
    for (let i = 0; i < 21; i++) {
      last = await request(base, 'POST', '/api/auth/login', { ip: '127.0.200.200', headers: { 'X-Forwarded-For': xff(i) }, body: { email: `${RUN}-nobody@backend.test`, password: 'x' } });
    }
    return last.status;
  };
  const proxied = await bootServer({ TRUST_PROXY: '1' });
  assert.notEqual(await fire(proxied.base, (i) => `203.0.113.${i + 1}`), 429, 'distinct clients behind the proxy share one bucket');
  assert.equal(await fire(proxied.base, () => '198.51.100.7'), 429);
  await proxied.stop();
  const direct = await bootServer({});
  assert.equal(await fire(direct.base, (i) => `203.0.113.${i + 1}`), 429, 'spoofed X-Forwarded-For bypassed the limiter');
  await direct.stop();
});
