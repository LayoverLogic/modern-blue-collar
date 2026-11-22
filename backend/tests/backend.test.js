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
  // Activity rows: by jobRef (also covers tombstones of jobs deleted through
  // the API, whose jobId is NULL) and by actor (entries this run's users wrote).
  const refs = [...new Set([...jobs, ...(await prisma.jobActivity.findMany({ where: { actorUserId: { in: users } }, select: { jobRef: true } })).map((a) => a.jobRef)])];
  await safe(prisma.invoiceLine.deleteMany({ where: { invoice: { jobId: { in: jobs } } } }));
  await safe(prisma.quoteLine.deleteMany({ where: { quote: { jobId: { in: jobs } } } }));
  await safe(prisma.invoice.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.quote.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.jobPhoto.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobs } } }));
  await safe(prisma.jobActivity.deleteMany({ where: { OR: [{ jobRef: { in: refs } }, { actorUserId: { in: users } }] } }));
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
  assert.equal(r.status, 201, r.text); // B3: 201 for a new user (+ password invite link)
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
test('RT-15 CSP: scripts and styles from self only; blocks plugins, framing and base hijack', async () => {
  const csp = (await api('GET', '/index.html')).headers['content-security-policy'];
  for (const d of ["script-src 'self';", "script-src-attr 'none'", "style-src 'self';", "img-src 'self' data: blob:", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"]) {
    assert.ok(csp.includes(d), `${d} missing in ${csp}`);
  }
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), csp);
  assert.match(csp, /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+ wss:\/\/127\.0\.0\.1:\d+/);
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
  assert.equal(byId.json.sentTo, '+16205550177', 'SMS goes out in E.164 (WL-12), even for a legacy-formatted number on record');
  assert.equal(r.json.sentTo, '+16205550177');
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

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2c (B2): contract gaps, hardening, configurability
// ═════════════════════════════════════════════════════════════════════════════

test('2c /api/brand: googleAuth only when Google OAuth is configured and not sandboxed; country, currency, weekStart', async () => {
  const sandbox = (await api('GET', '/api/brand')).json;
  assert.equal(sandbox.googleAuth, false, 'sandbox must not offer Google sign-in');
  assert.equal(sandbox.country, 'US');
  assert.equal(sandbox.currency, 'USD');
  assert.equal(sandbox.weekStart, 'sunday');
  assert.equal(sandbox.locale.weekStart, 'sunday');
  for (const k of ['companyName', 'tradeType', 'colors', 'jobTypes', 'demoMode', 'demoLogin', 'locale', 'logoUrl', 'faviconUrl', 'timezone']) assert.ok(k in sandbox, `${k} missing`);

  const ie = await bootServer({ ...GOOGLE_ENV, BRAND_COUNTRY: 'IE' });
  try {
    const b = (await request(ie.base, 'GET', '/api/brand')).json;
    assert.equal(b.googleAuth, true, ie.output());
    assert.equal(b.country, 'IE');
    assert.equal(b.currency, 'EUR');
    assert.equal(b.weekStart, 'monday');
  } finally { await ie.stop(); }

  const placeholder = await bootServer({ ...GOOGLE_ENV, GOOGLE_CLIENT_SECRET: 'your_google_secret' });
  try {
    assert.equal((await request(placeholder.base, 'GET', '/api/brand')).json.googleAuth, false, 'placeholder secret counted as configured');
  } finally { await placeholder.stop(); }
});

// ── CSP: every page loads without a violation ───────────────────────────────
const PUBLIC = path.join(BACKEND, 'public');
const listFiles = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? listFiles(p, ext) : (p.endsWith(ext) ? [p] : []);
});

test('2c CSP static check: no inline <script>, on* handler, style attribute or <style> in public/', () => {
  const problems = [];
  for (const f of listFiles(PUBLIC, '.html')) {
    const html = fs.readFileSync(f, 'utf8');
    const rel = path.relative(PUBLIC, f);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc\s*=/.test(m[1]) || m[2].trim()) problems.push(`${rel}: inline <script>`);
    }
    for (const m of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) problems.push(`${rel}: inline handler ${m[1]}`);
    if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) problems.push(`${rel}: style="" attribute`);
    if (/<style\b/i.test(html)) problems.push(`${rel}: <style> block`);
    if (/javascript:/i.test(html)) problems.push(`${rel}: javascript: URL`);
  }
  for (const f of listFiles(path.join(PUBLIC, 'js'), '.js')) {
    const js = fs.readFileSync(f, 'utf8');
    const rel = path.relative(PUBLIC, f);
    // markup built in JS lands in the DOM too: same rules
    if (/\sstyle\s*=\s*\\?["']/.test(js)) problems.push(`${rel}: style="" in generated markup`);
    if (/setAttribute\(\s*['"]style['"]|setAttribute\(\s*['"]on[a-z]+['"]/.test(js)) problems.push(`${rel}: setAttribute(style|on*)`);
    if (/\son[a-z]+\s*=\s*\\?["']/.test(js)) problems.push(`${rel}: on* handler in generated markup`);
    if (/<style\b/i.test(js)) problems.push(`${rel}: <style> in generated markup`);
    if (/\beval\s*\(|new Function\s*\(/.test(js)) problems.push(`${rel}: eval / new Function`);
  }
  assert.deepEqual(problems, []);
});

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch { /* devDependency not installed */ }
const browserSkip = !puppeteer ? 'puppeteer-core not installed' : (!fs.existsSync(CHROME) ? `no Chrome at ${CHROME} (set CHROME_PATH)` : false);

test('2c CSP in a real browser: every page in public/ loads with zero violations (signed out, admin, technician)', { skip: browserSkip, timeout: 180000 }, async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id, { technicianId: U.tech.id, scheduledDate: '2031-03-03', scheduledTime: '09:00' });
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).sort();
  const query = { 'job.html': `?id=${j.id}`, 'customer-detail.html': `?id=${c.id}`, 'quote-invoice.html': `?jobId=${j.id}`, 'communications.html': `?customerId=${c.id}` };
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const violations = [];
  let visited = 0;
  try {
    for (const who of [null, 'admin', 'tech']) {
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || ''}:${e.lineNumber || ''}`);
        });
      });
      const consoleCsp = [];
      page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) consoleCsp.push(m.text()); });
      await page.goto(`${srv.base}/api/health`);
      if (who) await page.evaluate((tk) => localStorage.setItem('token', tk), U[who].token);
      for (const p of pages) {
        consoleCsp.length = 0;
        const url = `${srv.base}/${p}${query[p] || ''}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        await sleep(300);
        const found = await page.evaluate(() => window.__csp || []).catch(() => ['(page did not evaluate)']);
        for (const v of [...found, ...consoleCsp]) violations.push(`${who || 'signed-out'} ${p}: ${v}`);
        visited += 1;
      }
      await page.close();
    }
  } finally { await browser.close(); }
  assert.equal(visited, pages.length * 3);
  assert.deepEqual(violations, []);
});

// ── Photos: uploadedById; technicians delete only their own uploads ─────────
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
function photoUpload(base, jobId, token, name = 'meter.png') {
  const boundary = `----bt${crypto.randomBytes(6).toString('hex')}`;
  const raw = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
    PNG_1PX, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return request(base, 'POST', `/api/jobs/${jobId}/photos`, { token, raw, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
}

test('2c photos: list includes uploadedById; a technician may delete only photos they uploaded', async () => {
  const c = await mkCustomer();
  const j = await mkJob(c.id, { technicianId: U.tech.id });
  const byOffice = await photoUpload(srv.base, j.id, U.dispatcher.token, 'office.png');
  assert.equal(byOffice.status, 201, byOffice.text);
  assert.equal(byOffice.json.uploadedById, U.dispatcher.id);
  const byTech = await photoUpload(srv.base, j.id, U.tech.token, 'tech.png');
  assert.equal(byTech.status, 201, byTech.text);

  const list = (await api('GET', `/api/jobs/${j.id}/photos`, { token: U.tech.token })).json;
  assert.deepEqual(Object.fromEntries(list.map((p) => [p.id, p.uploadedById])), { [byOffice.json.id]: U.dispatcher.id, [byTech.json.id]: U.tech.id });

  const denied = await api('DELETE', `/api/jobs/${j.id}/photos/${byOffice.json.id}`, { token: U.tech.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'NOT_OWNER');
  assert.equal((await api('DELETE', `/api/jobs/${j.id}/photos/${byTech.json.id}`, { token: U.tech.token })).status, 200);
  assert.equal((await api('DELETE', `/api/jobs/${j.id}/photos/${byOffice.json.id}`, { token: U.dispatcher.token })).status, 200, 'office roles delete any photo');
  assert.equal((await api('GET', `/api/jobs/${j.id}/photos`, { token: U.admin.token })).json.length, 0);
});

// ── Invites / technicians list ──────────────────────────────────────────────
test('2c invites require firstName and lastName (400 REQUIRED); /api/users/technicians returns email', async () => {
  const email = `${RUN}-named@backend.test`;
  const noFirst = await api('POST', '/api/invites', { token: U.admin.token, body: { email, lastName: 'Only' } });
  assert.equal(noFirst.status, 400);
  assert.equal(noFirst.json.code, 'REQUIRED');
  assert.equal(noFirst.json.field, 'firstName');
  const noLast = await api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'Only', lastName: '  ' } });
  assert.equal(noLast.status, 400);
  assert.equal(noLast.json.field, 'lastName');
  assert.equal(await prisma.user.findUnique({ where: { email } }), null, 'a rejected invite created a user');
  const ok = await api('POST', '/api/invites', { token: U.admin.token, body: { email, firstName: 'Saoirse', lastName: 'Nolan', phone: '(620) 555-0123' } });
  assert.equal(ok.status, 201, ok.text);
  const row = await prisma.user.findUnique({ where: { email } });
  assert.equal(`${row.firstName} ${row.lastName}`, 'Saoirse Nolan');
  assert.equal(row.phone, '+16205550123');

  const t = (await api('GET', '/api/users/technicians', { token: U.tech.token })).json;
  const me = t.technicians.find((x) => x.id === U.tech.id);
  assert.equal(me.email, U.tech.email);
  assert.ok(!('password' in me));
});

// ── TECH_VISIBILITY ─────────────────────────────────────────────────────────
let visSeq = 0;
async function visibilityFixture() {
  visSeq += 1;
  const at = `${String(6 + visSeq * 2).padStart(2, '0')}:00`; // no SCHEDULE_CONFLICT between fixtures
  const mine = await mkCustomer();
  const theirs = await mkCustomer();
  const own = await mkJob(mine.id, { technicianId: U.tech.id, scheduledDate: '2031-04-01', scheduledTime: at });
  const other = await mkJob(theirs.id, { technicianId: U.tech2.id, scheduledDate: '2031-04-01', scheduledTime: at });
  await prisma.quote.create({ data: { jobId: other.id, amount: 450 } });
  await prisma.invoice.create({ data: { jobId: other.id, amount: 450 } });
  await prisma.communication.create({ data: { customerId: theirs.id, type: 'note', subject: `private ${RUN}` } });
  return { mine, theirs, own, other };
}

test('2c TECH_VISIBILITY=own (default): technicians cannot read other jobs, their photos, activity or customers', async () => {
  const f = await visibilityFixture();
  const t = U.tech.token;
  assert.ok(!(await api('GET', '/api/jobs', { token: t })).json.some((j) => j.id === f.other.id));
  for (const p of [`/api/jobs/${f.other.id}`, `/api/jobs/${f.other.id}/photos`, `/api/jobs/${f.other.id}/activity`, `/api/customers/${f.theirs.id}`]) {
    const r = await api('GET', p, { token: t });
    assert.equal(r.status, 403, p);
    assert.equal(r.json.code, 'OUT_OF_SCOPE', p);
  }
  // own customer detail: billing of jobs that are not theirs is hidden
  const mineDetail = (await api('GET', `/api/customers/${f.mine.id}`, { token: t })).json;
  assert.ok(mineDetail.jobs.every((j) => j.technicianId === U.tech.id || (j.quote === null && j.invoice === null)));
});

test('2c TECH_VISIBILITY=all: technicians READ every job / customer, still WRITE only their own; billing and comms stay own', async () => {
  const f = await visibilityFixture();
  const s = await bootServer({ TECH_VISIBILITY: 'all' });
  const call = (method, p, opts) => request(s.base, method, p, opts);
  const t = U.tech.token;
  try {
    const jobs = (await call('GET', '/api/jobs', { token: t })).json;
    const otherInList = jobs.find((j) => j.id === f.other.id);
    assert.ok(otherInList && jobs.some((j) => j.id === f.own.id), 'whole schedule not visible');
    assert.equal(otherInList.quote, null, 'quote of another technician\'s job leaked');
    assert.equal(otherInList.invoice, null);
    assert.ok((await call('GET', '/api/jobs?date=2031-04-01', { token: t })).json.some((j) => j.id === f.other.id));

    const detail = await call('GET', `/api/jobs/${f.other.id}`, { token: t });
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.quote, null);
    assert.equal(detail.json.invoice, null);
    assert.equal((await call('GET', `/api/jobs/${f.other.id}/photos`, { token: t })).status, 200);
    assert.equal((await call('GET', `/api/jobs/${f.other.id}/activity`, { token: t })).status, 200);

    const custs = (await call('GET', '/api/customers', { token: t })).json;
    assert.ok(custs.some((c) => c.id === f.theirs.id));
    const cd = await call('GET', `/api/customers/${f.theirs.id}`, { token: t });
    assert.equal(cd.status, 200);
    assert.deepEqual(cd.json.communications, [], 'communications of a customer not on my jobs leaked');
    assert.ok(cd.json.jobs.every((j) => j.quote === null && j.invoice === null));

    // writes: unchanged
    assert.equal((await call('PATCH', `/api/jobs/${f.other.id}`, { token: t, body: { notes: 'mine now', version: 1 } })).status, 403);
    assert.equal((await call('PATCH', `/api/jobs/${f.other.id}`, { token: t, body: { status: 'in-progress', version: 1 } })).status, 403);
    assert.equal((await photoUpload(s.base, f.other.id, t)).status, 403);
    assert.equal((await call('POST', '/api/communications', { token: t, body: { customerId: f.theirs.id, type: 'note', subject: 'x' } })).status, 403);
    const ownPatch = await call('PATCH', `/api/jobs/${f.own.id}`, { token: t, body: { status: 'in-progress', version: f.own.version } });
    assert.equal(ownPatch.status, 200, ownPatch.text);

    // billing + comms reads stay own-work
    assert.ok(!(await call('GET', '/api/invoices', { token: t })).json.some((i) => i.jobId === f.other.id));
    assert.ok(!(await call('GET', '/api/quotes', { token: t })).json.some((q) => q.jobId === f.other.id));
    assert.equal((await call('GET', `/api/communications?customerId=${f.theirs.id}`, { token: t })).status, 403);
    // office roles unaffected
    const office = await call('GET', `/api/jobs/${f.other.id}`, { token: U.dispatcher.token });
    assert.ok(office.json.quote && office.json.invoice);
  } finally { await s.stop(); }

  const typo = await bootServer({ TECH_VISIBILITY: 'everyone' });
  try {
    assert.equal((await request(typo.base, 'GET', `/api/jobs/${f.other.id}`, { token: t })).status, 403, 'unknown TECH_VISIBILITY must fail closed');
    assert.match(typo.output(), /TECH_VISIBILITY="everyone" is not own\|all/);
  } finally { await typo.stop(); }
});

// ── WL-12 phone numbers ─────────────────────────────────────────────────────
test('2c WL-12 helpers/phone: US and IE numbers to E.164', () => {
  const { toE164, normalisePhone, matchVariants } = require('../helpers/phone');
  const us = {
    '(620) 555-0142': '+16205550142', '620.555.0142': '+16205550142', '620 555 0142': '+16205550142',
    '1-620-555-0142': '+16205550142', '+1 620 555 0142': '+16205550142', '011 353 87 123 4567': '+353871234567',
    '+353 (0)87 123 4567': '+353871234567',
  };
  for (const [raw, want] of Object.entries(us)) assert.equal(toE164(raw, 'US'), want, raw);
  const ie = {
    '087 123 4567': '+353871234567', '(01) 234 5678': '+35312345678', '020 910 0142': '+353209100142',
    '089 011 0101': '+353890110101', '045 897 123': '+35345897123', '00353 87 123 4567': '+353871234567',
    '+353 87 123 4567': '+353871234567', '+1 (620) 555-0142': '+16205550142', '0044 20 7946 0958': '+442079460958',
  };
  for (const [raw, want] of Object.entries(ie)) assert.equal(toE164(raw, 'IE'), want, raw);
  for (const bad of ['555-0142', '123-555-0142', '620-055-0142', 'call me', '620-555-0142 x12', '+1 =cmd|/c calc!A0', '', '87 123 4567', '+353 12', '+0123456789']) {
    assert.equal(toE164(bad, bad === '87 123 4567' ? 'IE' : 'US'), null, bad);
  }
  assert.equal(normalisePhone('', 'phone'), null);
  assert.throws(() => normalisePhone('', 'phone', { required: true }), (e) => e.status === 400 && e.extra.code === 'REQUIRED');
  assert.throws(() => normalisePhone('nope', 'phone', { country: 'IE' }), (e) => e.status === 400 && e.extra.code === 'INVALID_PHONE' && e.extra.field === 'phone');
  assert.deepEqual(matchVariants('+16205550142').sort(), ['16205550142', '6205550142']);
  assert.ok(matchVariants('+353871234567').includes('0871234567'));
});

test('2c WL-12 customers and users store E.164; search matches typed digits; SMS goes to E.164', async () => {
  const mk = (body) => api('POST', '/api/customers', { token: U.dispatcher.token, body: { firstName: 'Cara', lastName: `Phone-${RUN}`, address: '9 Test Rd', ...body } });
  const us = await mk({ phone: '(620) 555-0161' });
  assert.equal(us.status, 201, us.text);
  assert.equal(us.json.phone, '+16205550161');
  // an Irish customer on a US-brand instance: read with the customer's country
  const ie = await mk({ phone: '087 123 4567', country: 'IE', city: 'Naas', state: 'Co. Kildare' });
  assert.equal(ie.status, 201, ie.text);
  assert.equal(ie.json.phone, '+353871234567');
  const bad = await mk({ phone: '555-0161' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_PHONE');
  assert.equal(bad.json.field, 'phone');

  const patched = await api('PATCH', `/api/customers/${us.json.id}`, { token: U.dispatcher.token, body: { phone: '620.555.0162', version: us.json.version } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.json.phone, '+16205550162');
  const ieEdit = await api('PATCH', `/api/customers/${ie.json.id}`, { token: U.dispatcher.token, body: { phone: '(01) 234 5678', version: ie.json.version } });
  assert.equal(ieEdit.json.phone, '+35312345678', 'PATCH keeps reading with the customer\'s country');

  const found = (await api('GET', '/api/customers?search=620-555-0162', { token: U.dispatcher.token })).json;
  assert.ok(found.some((c) => c.id === us.json.id), 'digits search did not match the E.164 number');
  assert.ok((await api('GET', '/api/customers?search=01%20234', { token: U.dispatcher.token })).json.some((c) => c.id === ie.json.id));

  const sms = await api('POST', `/api/sms/customer/${ie.json.id}`, { token: U.admin.token, body: {} });
  assert.equal(sms.status, 200, sms.text);
  assert.equal(sms.json.sentTo, '+35312345678');
  const byNumber = await api('POST', '/api/sms/send', { token: U.admin.token, body: { to: '01 234 5678', body: 'x' } });
  assert.equal(byNumber.status, 400, 'a national IE number on a US brand is read as US → not on record');
  const intl = await api('POST', '/api/sms/send', { token: U.admin.token, body: { to: '+353 1 234 5678', body: 'x' } });
  assert.equal(intl.status, 200, intl.text);
  assert.equal(intl.json.sentTo, '+35312345678');
  // a legacy row that cannot be normalised is refused, not sent raw
  const legacy = await mkCustomer({ phone: '555-0100' });
  const ref = await api('POST', `/api/sms/customer/${legacy.id}`, { token: U.admin.token, body: {} });
  assert.equal(ref.status, 400);
  assert.equal(ref.json.code, 'INVALID_PHONE');
  assert.equal(ref.json.sent, false);

  const u = await mkUser('technician', 'phone');
  const up = await api('PATCH', `/api/users/${u.id}`, { token: U.admin.token, body: { phone: '620 555 0177' } });
  assert.equal(up.json.phone, '+16205550177');
  assert.equal((await api('PATCH', `/api/users/${u.id}`, { token: U.admin.token, body: { phone: 'ring me' } })).json.code, 'INVALID_PHONE');
  const created = await api('POST', '/api/users', { token: U.admin.token, body: { email: `${RUN}-phone2@backend.test`, password: 'Long-enough-1', firstName: 'P', lastName: 'Two', phone: '+1 620 555 0178' } });
  assert.equal(created.status, 201, created.text);
  assert.equal((await prisma.user.findUnique({ where: { id: created.json.id } })).phone, '+16205550178');
});

test('2c WL-12 on an IE brand: national Irish numbers, Irish SMS', async () => {
  const s = await bootServer({ BRAND_COUNTRY: 'IE' });
  try {
    const r = await request(s.base, 'POST', '/api/customers', {
      token: U.dispatcher.token,
      body: { firstName: 'Aoife', lastName: `IE-${RUN}`, phone: '089 011 0101', address: '1 Main St', city: 'Naas', state: 'Co. Kildare', zip: 'w91x2y4' },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.phone, '+353890110101');
    const sms = await request(s.base, 'POST', '/api/sms/send', { token: U.admin.token, body: { to: '089 011 0101', body: 'On my way' } });
    assert.equal(sms.status, 200, sms.text);
    assert.equal(sms.json.sentTo, '+353890110101');
    assert.equal((await request(s.base, 'POST', '/api/customers', { token: U.dispatcher.token, body: { firstName: 'A', lastName: `IE-${RUN}`, phone: '(620) 555-0142', address: '1 Main St', city: 'Naas', state: 'Co. Kildare' } })).json.code, 'INVALID_PHONE', 'a US national number on an IE brand');
  } finally { await s.stop(); }
});

// ── Sockets of deactivated / demoted / deleted users are dropped ────────────
function liveSocket(base, token) {
  const frames = [];
  let closed = false;
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`);
  const ready = new Promise((resolve) => {
    ws.onmessage = (m) => {
      const d = String(m.data);
      frames.push(d);
      if (d.startsWith('0{')) ws.send(`40${JSON.stringify({ token })}`);
      else if (d.startsWith('40')) { ws.send('42["viewing-job",{"jobId":7777}]'); resolve(true); }
      else if (d === '2') ws.send('3'); // engine.io ping → pong
      else if (d.startsWith('44')) resolve(false);
    };
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 3000);
  });
  ws.onclose = () => { closed = true; };
  const dropped = async (ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (closed || frames.includes('41')) return true;
      await sleep(50);
    }
    return false;
  };
  return { ready, dropped, frames, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

test('2c sockets: deactivating, demoting or deleting a user disconnects their live sockets', async () => {
  const run = async (role, change) => {
    const u = await mkUser(role, `sock-${crypto.randomBytes(3).toString('hex')}`);
    const token = await login(u.email);
    const bystander = liveSocket(srv.base, U.dispatcher.token);
    const sock = liveSocket(srv.base, token);
    assert.equal(await sock.ready, true, `socket did not connect: ${sock.frames}`);
    assert.equal(await bystander.ready, true);
    const presence = (await api('GET', '/api/presence/7777', { token: U.admin.token })).json.viewers;
    assert.ok(Object.values(presence).some((v) => v.userId === u.id), 'not in presence');
    const r = await change(u);
    assert.equal(r.status, 200, r.text);
    assert.equal(await sock.dropped(), true, `socket of ${role} survived the change`);
    await sleep(100);
    const after = (await api('GET', '/api/presence/7777', { token: U.admin.token })).json.viewers;
    assert.ok(!Object.values(after).some((v) => v.userId === u.id), 'presence entry left behind');
    assert.equal(await bystander.dropped(300), false, 'other users were disconnected too');
    bystander.close(); sock.close();
    // and the old token cannot reconnect
    const again = liveSocket(srv.base, token);
    const ok = await again.ready;
    again.close();
    return ok;
  };
  assert.equal(await run('technician', (u) => api('PATCH', `/api/users/${u.id}`, { token: U.admin.token, body: { active: false } })), false, 'deactivated user reconnected');
  assert.equal(await run('dispatcher', (u) => api('PATCH', `/api/users/${u.id}`, { token: U.admin.token, body: { role: 'technician' } })), true, 'demoted user may reconnect with the new role');
  assert.equal(await run('technician', (u) => api('DELETE', `/api/users/${u.id}`, { token: U.sa.token })), false, 'deleted user reconnected');
  // a profile edit does not drop the socket
  const u = await mkUser('technician', 'sock-keep');
  const sock = liveSocket(srv.base, await login(u.email));
  assert.equal(await sock.ready, true);
  await api('PATCH', `/api/users/${u.id}`, { token: U.admin.token, body: { firstName: 'Renamed' } });
  assert.equal(await sock.dropped(500), false, 'a name change dropped the socket');
  sock.close();
});

// ── Published JWT secrets, sandbox env files, loopback binding (2c security) ──
const jwtLib = require('jsonwebtoken');

test('2c non-production refuses a published / placeholder JWT_SECRET unless SANDBOX_MODE generates one', async () => {
  const placeholder = '__GENERATE_ON_FIRST_RUN__';
  const r = spawnSync(process.execPath, ['server.js'], {
    cwd: BACKEND, encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', NODE_ENV: 'development', JWT_SECRET: placeholder, DATABASE_URL: TEST_DB, PORT: '0', SANDBOX_MODE: 'false' },
  });
  assert.equal(r.status, 1, `booted with a published secret:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /published example value — refused outside production too/);
  for (const known of ['test-secret-key', 'change_this_to_a_random_secret_string_min_32_chars', 'your_jwt_secret_here_please']) {
    const k = spawnSync(process.execPath, ['server.js'], { cwd: BACKEND, encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, ENV_FILE: '/dev/null', NODE_ENV: 'development', JWT_SECRET: known, DATABASE_URL: TEST_DB, PORT: '0' } });
    assert.equal(k.status, 1, `${known} accepted`);
  }

  // SANDBOX_MODE=true: boots on a generated per-process secret — a token forged with the public value is refused
  const s = await bootServer({ JWT_SECRET: placeholder, NODE_ENV: 'development', SANDBOX_MODE: 'true' });
  try {
    assert.ok(s.alive(), s.output());
    assert.match(s.output(), /replaced by a random per-process secret/);
    const forged = jwtLib.sign({ id: U.sa.id, email: U.sa.email, role: 'super-admin' }, placeholder, { expiresIn: '1h' });
    assert.equal((await request(s.base, 'GET', '/api/users', { token: forged })).status, 401, 'token forged with the published secret accepted');
    const login2 = await request(s.base, 'POST', '/api/auth/login', { body: { email: U.admin.email, password: PASSWORD } });
    assert.equal(login2.status, 200);
    assert.equal((await request(s.base, 'GET', '/api/users/me', { token: login2.json.token })).status, 200, 'own tokens still work');
  } finally { await s.stop(); }
});

function runScript(args, env, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: opts.cwd || BACKEND, encoding: 'utf8', timeout: opts.timeout || 120000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}
const secretIn = (file) => (/^JWT_SECRET=(.*)$/m.exec(fs.readFileSync(file, 'utf8')) || [])[1];

test('2c sandbox.js writes a random JWT_SECRET into whatever ENV_FILE is used; refuses a known secret from the shell', { timeout: 300000 }, async () => {
  const envFile = path.join(TMP, '.env.demo.sectest');
  const example = fs.readFileSync(path.join(BACKEND, '.env.sandbox.example'), 'utf8');
  assert.match(example, /^JWT_SECRET=__GENERATE_ON_FIRST_RUN__$/m, 'example no longer carries the placeholder (update this test)');
  fs.writeFileSync(envFile, example.replace(/^DEMO_MODE=true$/m, 'DEMO_MODE=false'));
  const base = { ENV_FILE: envFile, DATABASE_URL: TEST_DB };

  const r1 = runScript(['scripts/sandbox.js', '--no-start'], base);
  assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`);
  const s1 = secretIn(envFile);
  assert.match(s1, /^[0-9a-f]{96}$/, `secret not generated: ${s1}`);
  assert.match(r1.stdout, /Generated a random JWT_SECRET/);
  const r2 = runScript(['scripts/sandbox.js', '--no-start'], base);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(secretIn(envFile), s1, 'a real secret was replaced on the second run');

  // a published value in the file is replaced too; a missing line is added
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^JWT_SECRET=.*$/m, 'JWT_SECRET="change_this_to_a_random_secret_string_min_32_chars"'));
  assert.equal(runScript(['scripts/sandbox.js', '--no-start'], base).status, 0);
  assert.match(secretIn(envFile), /^[0-9a-f]{96}$/);
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8').replace(/^JWT_SECRET=.*\n/m, ''));
  assert.equal(runScript(['scripts/sandbox.js', '--no-start'], base).status, 0);
  assert.match(secretIn(envFile), /^[0-9a-f]{96}$/);

  // a known secret in the real environment wins over the file → refused
  const bad = runScript(['scripts/sandbox.js', '--no-start'], { ...base, JWT_SECRET: '__GENERATE_ON_FIRST_RUN__' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /JWT_SECRET in your shell environment/);
  // DEMO_PROSPECT must be a slug or an absolute path outside the repo
  const rel = runScript(['scripts/sandbox.js', '--no-start'], { ...base, DEMO_PROSPECT: 'prospects/acme.json' });
  assert.equal(rel.status, 1);
  assert.match(rel.stderr, /must be an absolute path/);
  const inRepo = runScript(['scripts/sandbox.js', '--no-start'], { ...base, DEMO_PROSPECT: path.join(BACKEND, 'acme-real.json') });
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /inside the repository/);
});

test('2c sandbox.js serves on 127.0.0.1 by default (HOST env to override)', { timeout: 120000 }, async () => {
  const envFile = path.join(TMP, '.env.demo.hosttest');
  fs.writeFileSync(envFile, fs.readFileSync(path.join(BACKEND, '.env.sandbox.example'), 'utf8').replace(/^DEMO_MODE=true$/m, 'DEMO_MODE=false'));
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/sandbox.js'], {
    cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: envFile, DATABASE_URL: TEST_DB, PORT: String(port), STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: path.join(TMP, 'storage') },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try { up = (await request(`http://127.0.0.1:${port}`, 'GET', '/api/health', { ip: '127.0.0.1' })).status === 200; } catch { await sleep(250); }
    }
    assert.ok(up, out);
    assert.match(out, new RegExp(`Server running on 127\\.0\\.0\\.1:${port}`));
    const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (ext) {
      const reach = await new Promise((resolve) => {
        const sock = net.connect({ host: ext.address, port }, () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
      });
      assert.equal(reach, false, `sandbox reachable on ${ext.address}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { if (child.exitCode != null) r(); else child.once('exit', r); setTimeout(r, 4000); });
  }
});

test('2c seed-demo --print-env: fresh random JWT_SECRET each time; external prospect file by absolute path', () => {
  const env = { ENV_FILE: '/dev/null', BRAND_TRADE_TYPE: 'plumbing', DATABASE_URL: TEST_DB };
  const a = path.join(TMP, 'env-a'); const b = path.join(TMP, 'env-b');
  for (const out of [a, b]) {
    const r = runScript(['scripts/seed-demo.js', '--prospect', 'ks-plumbing-example', '--print-env', '--out', out], env);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.match(secretIn(a), /^[0-9a-f]{96}$/);
  assert.notEqual(secretIn(a), secretIn(b));
  assert.equal(fs.statSync(a).mode & 0o077, 0, 'env file readable by others');
  assert.match(fs.readFileSync(a, 'utf8'), /^DEMO_PROSPECT=ks-plumbing-example$/m);
  const parsed = require('dotenv').parse(fs.readFileSync(a, 'utf8'));
  assert.equal(require('../helpers/publishedSecrets').isKnownSecret(parsed.JWT_SECRET), false);

  // a real prospect lives OUTSIDE the repo and is referenced by absolute path
  const ext = path.join(TMP, 'prospects', 'acme-real.json');
  fs.mkdirSync(path.dirname(ext), { recursive: true });
  const p = JSON.parse(fs.readFileSync(path.join(BACKEND, 'demo', 'prospects', 'ks-plumbing-example.json'), 'utf8'));
  fs.writeFileSync(ext, JSON.stringify({ ...p, slug: 'acme-real' }));
  const c = path.join(TMP, 'env-c');
  const r = runScript(['scripts/seed-demo.js', '--prospect', ext, '--print-env', '--out', c], env);
  assert.equal(r.status, 0, r.stderr);
  const pc = require('dotenv').parse(fs.readFileSync(c, 'utf8'));
  assert.equal(pc.DEMO_PROSPECT, ext);
  // DEMO_PROSPECT=<absolute path> is accepted by the seeders (dry run: no DB)
  const dry = runScript(['scripts/seed-demo.js', '--dry-run'], { ...env, DEMO_PROSPECT: ext });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /acme-real|Prairie Line/);
  // ...but not a file inside the repository
  const inside = runScript(['scripts/seed-demo.js', '--prospect', path.join(BACKEND, 'tests', 'acme-real.json'), '--print-env', '--out', path.join(TMP, 'env-d')], env);
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /inside the repository/);
  assert.equal(fs.existsSync(path.join(TMP, 'env-d')), false);
});

// ── B4 (Verifier #1) ─────────────────────────────────────────────────────────

/**
 * JWT-secret-like literals in a piece of text: env lines (JWT_SECRET=<value>),
 * quoted object / assignment values (JWT_SECRET: '…'), `|| '…'` fallbacks,
 * literal jwt.sign keys and `const …SECRET… = '…'`. Shell / JS expressions
 * ($…, process.env…, identifiers) and regex fragments are not literals.
 */
function jwtSecretLiterals(text) {
  const out = new Set();
  const take = (v) => {
    const s = String(v || '').trim().replace(/\.\*\$?$/, '');
    if (/^[\w.~+-]{4,}$/.test(s) && !/^\d+$/.test(s)) out.add(s);
  };
  const quoted = /(['"`])((?:(?!\1)[^\\\n])+)\1/.source;
  for (const line of String(text).split('\n')) {
    let m;
    // env / shell style: JWT_SECRET=<value> (no spaces around =)
    const env = /(?:^|[\s'"`;(])(?:export\s+)?(?<![A-Za-z0-9_])JWT_SECRET=(?!\$)(["']?)([^\s"'`,;)}#/]+)\1/g;
    while ((m = env.exec(line))) take(m[2]);
    const obj = new RegExp(`(?<![A-Za-z0-9_])JWT_SECRET['"]?\\s*[:=]\\s*${quoted}`, 'g');
    while ((m = obj.exec(line))) take(m[2]);
    const fallback = new RegExp(`(?<![A-Za-z0-9_])JWT_SECRET\\s*(?:\\|\\||\\?\\?)\\s*${quoted}`, 'g');
    while ((m = fallback.exec(line))) take(m[2]);
    const sign = new RegExp(`jwt\\.(?:sign|verify)\\([^,]+,\\s*${quoted}`, 'g');
    while ((m = sign.exec(line))) take(m[2]);
    const decl = new RegExp(`(?:const|let|var)\\s+\\w*SECRET\\w*\\s*=\\s*(?:[^;]*\\|\\|\\s*)?${quoted}`, 'g');
    while ((m = decl.exec(line))) take(m[2]);
  }
  return out;
}

test('M1 every JWT-secret literal in the repo (tree + git history) is rejected as published', (t) => {
  const { isKnownSecret, PUBLISHED_SECRETS } = require('../helpers/publishedSecrets');
  const { jwtSecretProblem } = require('../helpers/security');
  const root = path.join(BACKEND, '..');
  // the extractor finds what it should and skips expressions
  const PROBES = ['abc_published_value_0123', 'fallback-value', 'quoted_value_0123456789', 'signing_key_literal'];
  const probe = jwtSecretLiterals([
    "JWT_SECRET=abc_published_value_0123", "  JWT_SECRET: 'quoted_value_0123456789',", "const JWT_SECRET = process.env.JWT_SECRET || 'fallback-value';",
    'JWT_SECRET=$(node -e x)', 'JWT_SECRET=${jwt}', 'JWT_SECRET: SECRET,', "replace(/^JWT_SECRET=.*$/m, '')", "jwt.sign(user, 'signing_key_literal')",
  ].join('\n'));
  assert.deepEqual([...probe].sort(), PROBES);

  const found = new Map(); // literal → where
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(ls.status, 0, 'git ls-files failed (this check needs the git checkout)');
  for (const f of ls.stdout.split('\0').filter(Boolean)) {
    if (/(^|\/)package-lock\.json$|\.(png|jpe?g|gif|ico|pdf|woff2?|zip|gz)$/i.test(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    if (!text.includes('SECRET') && !text.includes('jwt.')) continue;
    for (const s of jwtSecretLiterals(text)) if (!found.has(s) && !PROBES.includes(s)) found.set(s, f);
  }
  // committed history too: a literal removed from the tree is still public
  const hist = spawnSync('git', ['log', '--all', '-p', '--no-color', '-G', 'JWT_SECRET|jwt\\.sign|SECRET\\s*='], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (hist.status === 0) {
    const changed = hist.stdout.split('\n').filter((l) => /^[+-][^+-]/.test(l)).map((l) => l.slice(1)).join('\n');
    for (const s of jwtSecretLiterals(changed)) if (!found.has(s) && !PROBES.includes(s)) found.set(s, 'git history');
  }
  for (const known of ['change_this_to_a_random_secret_string_min_32_chars', '__GENERATE_ON_FIRST_RUN__', 'test-secret-key', 'whitelabel_test_secret_0123456789abcdef0123456789']) {
    assert.ok(found.has(known), `scanner did not find "${known}" — the extractor is broken`);
  }
  const accepted = [...found].filter(([s]) => !isKnownSecret(s)).map(([s, f]) => `${s} (${f})`);
  assert.deepEqual(accepted, [], 'JWT secret literals in the repo that production would accept — add them to helpers/publishedSecrets.js');
  for (const [s] of found) assert.ok(jwtSecretProblem(s), `jwtSecretProblem("${s}") must refuse it`);
  assert.ok(PUBLISHED_SECRETS.size >= 10);
  t.diagnostic(`${found.size} JWT secret literals checked: ${[...found.keys()].join(', ')}`);
});

test('M1 the B4 whitelabel literal is refused in production and a token forged with it is useless', async () => {
  const lit = 'whitelabel_test_secret_0123456789abcdef0123456789';
  const prod = await bootServer({ NODE_ENV: 'production', JWT_SECRET: lit, SANDBOX_MODE: null });
  await sleep(300);
  assert.equal(prod.alive(), false, 'production must refuse a published secret');
  assert.match(prod.output(), /published example value/);
  // outside production with SANDBOX_MODE it is replaced: a forged token is rejected
  const dev = await bootServer({ JWT_SECRET: lit });
  const forged = require('jsonwebtoken').sign({ id: U.sa.id, role: 'super-admin', sv: 0 }, lit, { expiresIn: '1h' });
  assert.equal((await request(dev.base, 'GET', '/api/users', { token: forged })).status, 401);
  await dev.stop();
});

test('M2 a busy office IP: 320 page loads (GET /api/brand) + 40 sign-ins never block a correct sign-in', async () => {
  const ip = '127.77.0.9';
  for (let i = 0; i < 320; i += 20) {
    const batch = await Promise.all(Array.from({ length: 20 }, () => api('GET', '/api/brand', { ip })));
    for (const r of batch) assert.equal(r.status, 200, `GET /api/brand → ${r.status}`);
  }
  for (let i = 0; i < 40; i += 1) {
    const r = await api('POST', '/api/auth/login', { ip, body: { email: U.dispatcher.email, password: PASSWORD } });
    assert.equal(r.status, 200, `login #${i + 1} → ${r.status} ${r.text}`);
  }
  const last = await api('POST', '/api/auth/login', { ip, body: { email: U.admin.email, password: PASSWORD } });
  assert.equal(last.status, 200, last.text);
  assert.ok(last.json.token);
});

test('M2 the anonymous limiter still counts other anonymous /api calls; brand + sign-in stay exempt', async () => {
  const s = await bootServer({ RATE_LIMIT_IP_MAX: '3' });
  const ip = '127.77.0.10';
  // bootServer polled /api/health from other addresses; this IP starts at 0
  for (let i = 0; i < 3; i += 1) assert.equal((await request(s.base, 'GET', '/api/health', { ip })).status, 200);
  assert.equal((await request(s.base, 'GET', '/api/health', { ip })).status, 429);
  assert.equal((await request(s.base, 'GET', '/api/jobs', { ip })).status, 429, 'anonymous API calls are still limited');
  for (let i = 0; i < 10; i += 1) assert.equal((await request(s.base, 'GET', '/api/brand', { ip })).status, 200);
  const r = await request(s.base, 'POST', '/api/auth/login', { ip, body: { email: U.tech.email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  // failed sign-ins are still capped by their own limiter (LOGIN_MAX_PER_EMAIL, default 10)
  let limited = false;
  for (let i = 0; i < 12 && !limited; i += 1) {
    limited = (await request(s.base, 'POST', '/api/auth/login', { ip, body: { email: U.tech.email, password: 'wrong-password' } })).status === 429;
  }
  assert.ok(limited, 'the sign-in limiter still stops guessing');
  await s.stop();
});

test('L7 NODE_ENV is case-insensitive: "Production" / " PRODUCTION " get every production check', async () => {
  for (const spelling of ['Production', ' PRODUCTION ']) {
    const s = await bootServer({ NODE_ENV: spelling, JWT_SECRET: 'short', SANDBOX_MODE: null });
    await sleep(300);
    assert.equal(s.alive(), false, `NODE_ENV="${spelling}" booted with a weak JWT_SECRET`);
    assert.match(s.output(), /read as "production"/);
    assert.match(s.output(), /\[CONFIG\] FATAL/);
  }
  const demo = await bootServer({ NODE_ENV: 'PRODUCTION', DEMO_MODE: 'true', SANDBOX_MODE: null });
  await sleep(300);
  assert.equal(demo.alive(), false);
  assert.match(demo.output(), /DEMO_MODE=true is not allowed/);
  await withEnv({ NODE_ENV: 'Production' }, () => assert.equal(require('../helpers/security').isProduction(), true));
  const { assertDemoDatabase } = require('../demo/lib/guard');
  assert.throws(() => assertDemoDatabase('postgresql://u:p@localhost/mbc_demo_x', { nodeEnv: 'Production', allowDb: null }), /NODE_ENV=production/);
});
