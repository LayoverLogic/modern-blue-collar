/**
 * tests/activity.test.js — job activity log (GTM-18), HTTP level.
 *
 * Setup / run:
 *   1. cd backend && npm install
 *   2. Have PostgreSQL running and a throwaway database URL (created + migrated
 *      here if missing), e.g.
 *        TEST_DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_activity_test?schema=public
 *   3. TEST_DATABASE_URL=... npm run test:activity
 *
 * Covers: every event type (created, status_changed, assigned, rescheduled,
 * note, updated, photo_added, photo_removed, quote_created, invoice_created via
 * helpers/activity.js, deleted), actor attribution (user / API key), atomicity
 * (a rejected change logs nothing; a rolled-back transaction leaves no entry),
 * technician scoping on GET /api/jobs/:id/activity, the office feed
 * GET /api/activity, paging, append-only (no write routes; DB CHECK on type)
 * and tombstones (the history and a "deleted" entry survive the job).
 *
 * Like the other HTTP suites it boots `node server.js` (SANDBOX_MODE, local
 * storage in a temp dir, ENV_FILE=/dev/null), creates run-tagged synthetic
 * rows only and deletes exactly those afterwards — safe on a shared
 * TEST_DATABASE_URL in any order with the other suites.
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
  console.error('[activity-test] TEST_DATABASE_URL is required (a throwaway database).');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
process.env.ENV_FILE = '/dev/null';

const RUN      = `ac${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const SECRET   = crypto.randomBytes(32).toString('hex');
const PASSWORD = 'Activity!2345';
const TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-activity-test-'));
const sleep    = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let prisma;
let activity;
let child;
let base;
const U = {};
let apiKey;

// ── HTTP ─────────────────────────────────────────────────────────────────────
let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `127.3.${1 + Math.floor(ipSeq / 250) % 250}.${1 + (ipSeq % 250)}`; };

function request(method, p, { token, key, body, multipart } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const h = {};
    let data;
    if (multipart) {
      const boundary = `----mbc${crypto.randomBytes(8).toString('hex')}`;
      data = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${multipart.filename}"\r\nContent-Type: image/png\r\n\r\n`),
        multipart.bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      h['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    } else if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body));
      h['Content-Type'] = 'application/json';
    }
    if (data) h['Content-Length'] = data.length;
    if (token) h.Authorization = `Bearer ${token}`;
    if (key) h['X-API-Key'] = key;
    const rq = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers: h, localAddress: nextIp() }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, text, json });
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

async function boot() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, ENV_FILE: '/dev/null', DATABASE_URL: TEST_DB,
    PORT: String(port), APP_URL: `http://localhost:${port}`, NODE_ENV: 'test', JWT_SECRET: SECRET,
    SANDBOX_MODE: 'true', DEMO_MODE: 'false', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: path.join(TMP, 'storage'),
    MAIL_DRIVER: 'none', BRAND_TRADE_TYPE: 'electrical',
  };
  child = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try { if ((await request('GET', '/api/health')).status === 200) return; } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error(`server did not start:\n${out}`);
}

// ── fixtures (run-tagged) ────────────────────────────────────────────────────
async function mkUser(role, tag) {
  const bcrypt = require('bcryptjs');
  const u = await prisma.user.create({
    data: { email: `${RUN}-${tag}@activity.test`, password: await bcrypt.hash(PASSWORD, 4), firstName: 'AT', lastName: tag, role, active: true },
  });
  const r = await request('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  return { ...u, token: r.json.token, name: `AT ${tag}` };
}
let customer;
async function mkJob(over = {}) {
  const r = await request('POST', '/api/jobs', { token: U.dispatcher.token, body: { title: `AT job ${RUN}`, customerId: customer.id, ...over } });
  assert.equal(r.status, 201, r.text);
  return r.json;
}
const patch = (job, body, token = U.dispatcher.token) => request('PATCH', `/api/jobs/${job.id}`, { token, body: { version: job.version, ...body } });
const feed = async (jobId, token = U.dispatcher.token, qs = '') => {
  const r = await request('GET', `/api/jobs/${jobId}/activity${qs}`, { token });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const newest = async (jobId, type) => (await feed(jobId)).find((e) => !type || e.type === type);

async function cleanup() {
  if (!prisma) return;
  const safe = (p) => p.catch(() => {});
  const users = (await prisma.user.findMany({ where: { email: { contains: RUN } }, select: { id: true } })).map((u) => u.id);
  const custs = (await prisma.customer.findMany({ where: { lastName: { contains: RUN } }, select: { id: true } })).map((c) => c.id);
  const jobs = (await prisma.job.findMany({ where: { OR: [{ customerId: { in: custs } }, { title: { contains: RUN } }] }, select: { id: true } })).map((j) => j.id);
  // activity of our jobs, including tombstones of jobs already deleted (jobRef)
  const refs = (await prisma.jobActivity.findMany({
    where: { OR: [{ jobRef: { in: jobs } }, { actorUserId: { in: users } }] }, select: { jobRef: true },
  })).map((a) => a.jobRef);
  await safe(prisma.jobActivity.deleteMany({ where: { jobRef: { in: [...new Set([...jobs, ...refs])] } } }));
  await safe(prisma.invoice.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.quote.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.jobPhoto.deleteMany({ where: { jobId: { in: jobs } } }));
  await safe(prisma.job.deleteMany({ where: { id: { in: jobs } } }));
  await safe(prisma.customer.deleteMany({ where: { id: { in: custs } } }));
  await safe(prisma.apiKey.deleteMany({ where: { createdById: { in: users } } }));
  await safe(prisma.user.deleteMany({ where: { id: { in: users } } }));
}

before(async () => {
  await ensureDatabase();
  prisma = require('../helpers/prisma');
  activity = require('../helpers/activity');
  await boot();
  for (const [k, role] of [['admin', 'admin'], ['dispatcher', 'dispatcher'], ['tech', 'technician'], ['tech2', 'technician']]) U[k] = await mkUser(role, k);
  customer = await prisma.customer.create({
    data: { firstName: 'Aoife', lastName: `Byrne-${RUN}`, phone: '620-555-0177', address: '9 Synthetic Ave', city: 'Hutchinson', state: 'KS', zip: '67501', email: `aoife.${RUN}@example.com` },
  });
  // API key owned by the dispatcher (acts as its creator)
  const bcrypt = require('bcryptjs');
  const key = `mbc_${crypto.randomBytes(20).toString('hex')}`;
  const rec = await prisma.apiKey.create({
    data: { name: `Zap ${RUN}`, prefix: key.slice(0, 16), hashedKey: await bcrypt.hash(key, 4), scopes: 'read,write', createdById: U.dispatcher.id },
  });
  apiKey = { key, id: rec.id, name: rec.name };
});

after(async () => {
  if (child && child.exitCode == null) child.kill('SIGTERM');
  await cleanup().catch((e) => console.error('[activity-test] cleanup failed:', e.message));
  if (prisma) {
    const left = await prisma.user.count({ where: { email: { contains: RUN } } });
    if (left) console.error(`[activity-test] ${left} users of this run left behind`);
    await prisma.$disconnect();
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// Event types
// ═════════════════════════════════════════════════════════════════════════════
test('created: POST /api/jobs logs a "created" entry with a snapshot and the actor', async () => {
  const job = await mkJob({ technicianId: U.tech.id, scheduledDate: '2026-12-01', scheduledTime: '09:00', priority: 'high' });
  const entries = await feed(job.id);
  assert.equal(entries.length, 1);
  const [e] = entries;
  assert.equal(e.type, 'created');
  assert.equal(e.jobId, job.id);
  assert.equal(e.jobRef, job.id);
  assert.equal(e.from, null);
  assert.deepEqual(
    { title: e.to.title, status: e.to.status, priority: e.to.priority, technicianId: e.to.technicianId, scheduledDate: e.to.scheduledDate, customerId: e.to.customerId },
    { title: job.title, status: 'pending', priority: 'high', technicianId: U.tech.id, scheduledDate: '2026-12-01', customerId: customer.id },
  );
  assert.deepEqual(e.actor, { kind: 'user', userId: U.dispatcher.id, apiKeyId: null, name: U.dispatcher.name });
  assert.ok(!('email' in e.actor), 'no emails in the feed');
  assert.ok(!Number.isNaN(Date.parse(e.createdAt)));
});

test('status_changed: technician moves own job; from/to and actor recorded', async () => {
  const job = await mkJob({ technicianId: U.tech.id });
  const r = await patch(job, { status: 'in-progress' }, U.tech.token);
  assert.equal(r.status, 200, r.text);
  const e = await newest(job.id);
  assert.equal(e.type, 'status_changed');
  assert.deepEqual(e.from, { status: 'pending' });
  assert.deepEqual(e.to, { status: 'in-progress' });
  assert.equal(e.actor.userId, U.tech.id);
  const r2 = await patch(r.json, { status: 'completed' }, U.tech.token);
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual((await newest(job.id)).to, { status: 'completed' });
});

test('assigned: assign, reassign and unassign carry technician ids and names', async () => {
  let job = await mkJob();
  for (const [tid, fromId] of [[U.tech.id, null], [U.tech2.id, U.tech.id], [null, U.tech2.id]]) {
    const r = await patch(job, { technicianId: tid });
    assert.equal(r.status, 200, r.text);
    job = r.json;
    const e = await newest(job.id);
    assert.equal(e.type, 'assigned');
    assert.equal(e.from.technicianId, fromId);
    assert.equal(e.to.technicianId, tid);
    const nameOf = (id) => (id === U.tech.id ? U.tech.name : id === U.tech2.id ? U.tech2.name : null);
    assert.equal(e.from.technicianName, nameOf(fromId));
    assert.equal(e.to.technicianName, nameOf(tid));
  }
  const types = (await feed(job.id)).map((e) => e.type);
  assert.deepEqual(types, ['assigned', 'assigned', 'assigned', 'created']);
});

test('rescheduled: only the changed schedule fields are recorded', async () => {
  const job = await mkJob({ scheduledDate: '2026-12-02', scheduledTime: '08:00', duration: 2 });
  const r = await patch(job, { scheduledDate: '2026-12-03', duration: 2 });
  assert.equal(r.status, 200, r.text);
  const e = await newest(job.id);
  assert.equal(e.type, 'rescheduled');
  assert.deepEqual(e.from, { scheduledDate: '2026-12-02' });
  assert.deepEqual(e.to, { scheduledDate: '2026-12-03' });
  const r2 = await patch(r.json, { scheduledTime: '13:30', duration: 3 });
  const e2 = await newest(job.id);
  assert.equal(r2.status, 200);
  assert.deepEqual(e2.from, { scheduledTime: '08:00', duration: 2 });
  assert.deepEqual(e2.to, { scheduledTime: '13:30', duration: 3 });
});

test('note: a technician editing notes on their job logs a "note" entry', async () => {
  const job = await mkJob({ technicianId: U.tech.id });
  const r = await patch(job, { notes: 'Breaker panel behind the boiler cupboard.' }, U.tech.token);
  assert.equal(r.status, 200, r.text);
  const e = await newest(job.id);
  assert.equal(e.type, 'note');
  assert.deepEqual(e.from, { notes: null });
  assert.deepEqual(e.to, { notes: 'Breaker panel behind the boiler cupboard.' });
  assert.equal(e.actor.userId, U.tech.id);
});

test('updated: other field edits; one PATCH with several changes logs one entry per kind; no-op logs nothing', async () => {
  const job = await mkJob({ technicianId: U.tech.id });
  const r = await patch(job, { title: `AT renamed ${RUN}`, priority: 'urgent', status: 'scheduled', notes: 'Bring the long ladder.' });
  assert.equal(r.status, 200, r.text);
  const entries = await feed(job.id);
  assert.deepEqual(entries.map((e) => e.type).sort(), ['created', 'note', 'status_changed', 'updated']);
  const upd = entries.find((e) => e.type === 'updated');
  assert.deepEqual(upd.from, { title: job.title, priority: 'normal' });
  assert.deepEqual(upd.to, { title: `AT renamed ${RUN}`, priority: 'urgent' });
  const r2 = await patch(r.json, { priority: 'urgent', notes: 'Bring the long ladder.' });
  assert.equal(r2.status, 200, r2.text);
  assert.equal((await feed(job.id)).length, 4, 'a PATCH that changes nothing adds no entry');
});

test('photo_added / photo_removed: upload and delete a photo', async () => {
  const job = await mkJob({ technicianId: U.tech.id });
  const up = await request('POST', `/api/jobs/${job.id}/photos`, { token: U.tech.token, multipart: { filename: 'meter.png', bytes: PNG } });
  assert.equal(up.status, 201, up.text);
  const added = await newest(job.id);
  assert.equal(added.type, 'photo_added');
  assert.deepEqual(added.to, { photoId: up.json.id, originalName: 'meter.png', contentType: 'image/png', size: PNG.length });
  assert.equal(added.actor.userId, U.tech.id);
  const del = await request('DELETE', `/api/jobs/${job.id}/photos/${up.json.id}`, { token: U.tech.token });
  assert.equal(del.status, 200, del.text);
  const removed = await newest(job.id);
  assert.equal(removed.type, 'photo_removed');
  assert.deepEqual(removed.from, { photoId: up.json.id, originalName: 'meter.png' });
  // a rejected upload (not an image) logs nothing
  const bad = await request('POST', `/api/jobs/${job.id}/photos`, { token: U.tech.token, multipart: { filename: 'x.png', bytes: Buffer.from('<svg/>') } });
  assert.equal(bad.status, 400);
  assert.equal((await feed(job.id)).length, 3);
});

test('quote_created / invoice_created: helpers/activity.js log() inside the creating transaction', async () => {
  const job = await mkJob();
  await prisma.$transaction(async (tx) => {
    const q = await tx.quote.create({ data: { jobId: job.id, amount: 1250, status: 'draft' } });
    await activity.log(tx, { userId: U.admin.id }, job.id, 'quote_created', { to: { quoteId: q.id, amount: q.amount, status: q.status } });
  });
  await prisma.$transaction(async (tx) => {
    const i = await tx.invoice.create({ data: { jobId: job.id, amount: 1250, dueDate: new Date('2026-12-31') } });
    await activity.log(tx, { userId: U.admin.id }, job.id, 'invoice_created', { to: { invoiceId: i.id, amount: i.amount, status: i.status } });
  });
  const [inv, quote] = await feed(job.id);
  assert.equal(quote.type, 'quote_created');
  assert.equal(quote.to.amount, 1250);
  assert.equal(inv.type, 'invoice_created');
  assert.equal(inv.to.status, 'unpaid');
  assert.equal(inv.actor.name, U.admin.name);
  // the express req form works too (user + API key)
  const row = await activity.log(prisma, { user: { id: U.dispatcher.id }, apiKey: { id: apiKey.id } }, job.id, 'note', { to: { notes: 'x' } });
  assert.equal(row.actorUserId, U.dispatcher.id);
  assert.equal(row.actorApiKeyId, apiKey.id);
  await prisma.jobActivity.deleteMany({ where: { id: row.id } });
  // unknown type: refused by the helper and by the DB CHECK constraint
  await assert.rejects(activity.log(prisma, null, job.id, 'teleported', {}), /unknown type/);
  await assert.rejects(prisma.jobActivity.create({ data: { jobId: job.id, jobRef: job.id, type: 'teleported' } }));
});

test('atomic: a rolled-back transaction leaves no entry; rejected PATCHes (409/400/403) log nothing', async () => {
  const job = await mkJob({ technicianId: U.tech.id, scheduledDate: '2026-12-08', scheduledTime: '09:00' });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await activity.log(tx, null, job.id, 'note', { to: { notes: 'never committed' } });
    throw new Error('boom');
  }), /boom/);
  // stale version → 409
  assert.equal((await patch({ ...job, version: job.version + 5 }, { status: 'scheduled' })).status, 409);
  // schedule conflict → 409 SCHEDULE_CONFLICT
  const other = await mkJob({ technicianId: U.tech2.id, scheduledDate: '2026-12-08', scheduledTime: '09:30' });
  const clash = await patch(other, { technicianId: U.tech.id });
  assert.equal(clash.status, 409, clash.text);
  assert.equal(clash.json.code, 'SCHEDULE_CONFLICT');
  // technician may not cancel → 403; bad status → 400
  assert.equal((await patch(job, { status: 'cancelled' }, U.tech.token)).status, 403);
  assert.equal((await patch(job, { status: 'teleported' })).status, 400);
  assert.deepEqual((await feed(job.id)).map((e) => e.type), ['created']);
  assert.deepEqual((await feed(other.id)).map((e) => e.type), ['created']);
});

test('API-key actor: changes made with X-API-Key name the key (and its owner)', async () => {
  const job = await mkJob();
  const r = await request('PATCH', `/api/jobs/${job.id}`, { key: apiKey.key, body: { version: job.version, status: 'scheduled' } });
  assert.equal(r.status, 200, r.text);
  const e = await newest(job.id);
  assert.deepEqual(e.actor, { kind: 'apiKey', userId: U.dispatcher.id, apiKeyId: apiKey.id, name: `${apiKey.name} (API key)` });
  // read with the key too
  const g = await request('GET', `/api/jobs/${job.id}/activity`, { key: apiKey.key });
  assert.equal(g.status, 200);
  assert.equal(g.json[0].id, e.id);
});

// ═════════════════════════════════════════════════════════════════════════════
// Scoping
// ═════════════════════════════════════════════════════════════════════════════
test('scoping: technicians read only their own jobs\' activity; office reads all; 401/404/400', async () => {
  const mine = await mkJob({ technicianId: U.tech.id });
  const unassigned = await mkJob();
  assert.equal((await request('GET', `/api/jobs/${mine.id}/activity`, { token: U.tech.token })).status, 200);
  const other = await request('GET', `/api/jobs/${mine.id}/activity`, { token: U.tech2.token });
  assert.equal(other.status, 403);
  assert.equal(other.json.code, 'OUT_OF_SCOPE');
  assert.equal((await request('GET', `/api/jobs/${unassigned.id}/activity`, { token: U.tech.token })).status, 403);
  assert.equal((await request('GET', `/api/jobs/${unassigned.id}/activity`, { token: U.dispatcher.token })).status, 200);
  assert.equal((await request('GET', `/api/jobs/${mine.id}/activity`)).status, 401);
  assert.equal((await request('GET', '/api/jobs/999999999/activity', { token: U.admin.token })).status, 404);
  const badId = await request('GET', '/api/jobs/abc/activity', { token: U.admin.token });
  assert.equal(badId.status, 400);
  assert.equal(badId.json.code, 'INVALID_ID');
  // the office feed: office roles only
  assert.equal((await request('GET', '/api/activity', { token: U.tech.token })).status, 403);
  const off = await request('GET', `/api/activity?jobRef=${mine.id}`, { token: U.dispatcher.token });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.json.map((e) => e.type), ['created']);
  const badType = await request('GET', '/api/activity?type=teleported', { token: U.admin.token });
  assert.equal(badType.status, 400);
  assert.equal(badType.json.code, 'INVALID_ENUM');
  assert.equal((await request('GET', '/api/activity?limit=0', { token: U.admin.token })).status, 400);
});

test('paging: newest first, ?limit and ?before=<id>', async () => {
  let job = await mkJob();
  for (const p of ['low', 'high', 'urgent', 'normal']) {
    const r = await patch(job, { priority: p });
    assert.equal(r.status, 200, r.text);
    job = r.json;
  }
  const all = await feed(job.id);
  assert.equal(all.length, 5);
  for (let i = 1; i < all.length; i++) assert.ok(new Date(all[i - 1].createdAt) >= new Date(all[i].createdAt));
  const p1 = await feed(job.id, U.dispatcher.token, '?limit=2');
  const p2 = await feed(job.id, U.dispatcher.token, `?limit=2&before=${p1[1].id}`);
  const p3 = await feed(job.id, U.dispatcher.token, `?limit=2&before=${p2[1].id}`);
  assert.deepEqual([...p1, ...p2, ...p3].map((e) => e.id), all.map((e) => e.id));
  const byType = await request('GET', `/api/activity?jobRef=${job.id}&type=updated`, { token: U.admin.token });
  assert.equal(byType.json.length, 4);
});

// ═════════════════════════════════════════════════════════════════════════════
// Append-only
// ═════════════════════════════════════════════════════════════════════════════
test('append-only: no route creates, edits or deletes activity entries', async () => {
  const job = await mkJob();
  const [e] = await feed(job.id);
  const attempts = [
    ['POST', `/api/jobs/${job.id}/activity`], ['PUT', `/api/jobs/${job.id}/activity`], ['PATCH', `/api/jobs/${job.id}/activity`],
    ['DELETE', `/api/jobs/${job.id}/activity`], ['PATCH', `/api/jobs/${job.id}/activity/${e.id}`], ['DELETE', `/api/jobs/${job.id}/activity/${e.id}`],
    ['POST', '/api/activity'], ['PUT', `/api/activity/${e.id}`], ['PATCH', `/api/activity/${e.id}`], ['DELETE', `/api/activity/${e.id}`], ['DELETE', '/api/activity'],
  ];
  for (const [m, p] of attempts) {
    const r = await request(m, p, { token: U.admin.token, body: { type: 'deleted', to: { forged: true } } });
    assert.equal(r.status, 404, `${m} ${p} → ${r.status}`);
  }
  // writing through the jobs API with an activity-ish body does not inject entries
  const r = await patch(job, { type: 'Panel Upgrade', activity: [{ type: 'deleted' }] });
  assert.equal(r.status, 200, r.text);
  const after = await feed(job.id);
  assert.equal(after.find((x) => x.id === e.id).type, 'created', 'entry unchanged');
  assert.ok(!after.some((x) => x.type === 'deleted'));
  // the helper module exposes no update/delete
  assert.deepEqual(Object.keys(activity).filter((k) => /update|delete|remove|edit/i.test(k)), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// Tombstones
// ═════════════════════════════════════════════════════════════════════════════
test('tombstone: deleting a job keeps its history plus a "deleted" entry (jobId null, jobRef kept)', async () => {
  let job = await mkJob({ technicianId: U.tech.id });
  job = (await patch(job, { status: 'scheduled' })).json;
  const up = await request('POST', `/api/jobs/${job.id}/photos`, { token: U.tech.token, multipart: { filename: 'before.png', bytes: PNG } });
  assert.equal(up.status, 201);
  // dispatchers cannot delete; nothing logged
  assert.equal((await request('DELETE', `/api/jobs/${job.id}`, { token: U.dispatcher.token })).status, 403);
  const del = await request('DELETE', `/api/jobs/${job.id}`, { token: U.admin.token });
  assert.equal(del.status, 200, del.text);

  assert.equal((await request('GET', `/api/jobs/${job.id}/activity`, { token: U.admin.token })).status, 404, 'the job is gone');
  const r = await request('GET', `/api/activity?jobRef=${job.id}`, { token: U.admin.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.map((e) => e.type), ['deleted', 'photo_added', 'status_changed', 'created']);
  assert.ok(r.json.every((e) => e.jobId === null && e.jobRef === job.id));
  const [tomb] = r.json;
  assert.equal(tomb.actor.userId, U.admin.id);
  assert.equal(tomb.to, null);
  assert.equal(tomb.from.title, job.title);
  assert.equal(tomb.from.status, 'scheduled');
  assert.equal(tomb.from.technicianId, U.tech.id);
  assert.equal(tomb.from.photos, 1);
  const rows = await prisma.jobActivity.count({ where: { jobRef: job.id } });
  assert.equal(rows, 4, 'rows survive in the database');
  const typed = await request('GET', '/api/activity?type=deleted&limit=500', { token: U.admin.token });
  assert.ok(typed.json.some((e) => e.id === tomb.id));
});

test('tombstone: a delete that is refused (job still has an invoice) leaves no tombstone', async () => {
  const job = await mkJob();
  await prisma.invoice.create({ data: { jobId: job.id, amount: 90, dueDate: new Date('2026-12-31') } });
  const r = await request('DELETE', `/api/jobs/${job.id}`, { token: U.admin.token });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual((await feed(job.id)).map((e) => e.type), ['created']);
  assert.equal(await prisma.jobActivity.count({ where: { jobRef: job.id, type: 'deleted' } }), 0);
  assert.equal((await request('DELETE', '/api/jobs/999999999', { token: U.admin.token })).status, 404);
});

test('actor names survive: a deleted user shows as "Deleted user", the id is kept', async () => {
  const temp = await mkUser('dispatcher', 'temp');
  const r = await request('POST', '/api/jobs', { token: temp.token, body: { title: `AT job ${RUN}`, customerId: customer.id } });
  assert.equal(r.status, 201, r.text);
  await prisma.user.delete({ where: { id: temp.id } });
  const [e] = await feed(r.json.id);
  assert.deepEqual(e.actor, { kind: 'user', userId: temp.id, apiKeyId: null, name: 'Deleted user' });
});

// ═════════════════════════════════════════════════════════════════════════════
// Phase 2c (B2): quotes / invoices write their own entries (helpers/documentRoutes.js)
// ═════════════════════════════════════════════════════════════════════════════
test('documents: POST /api/quotes logs quote_created; status changes log "updated"; from-quote logs invoice_created', async () => {
  const job = await mkJob();
  const q = await request('POST', '/api/quotes', {
    token: U.admin.token,
    body: { jobId: job.id, lines: [{ description: 'Panel upgrade', quantity: 1, unitPrice: 1200 }, { description: 'Permit', quantity: 2, unitPrice: 25.5 }] },
  });
  assert.equal(q.status, 201, q.text);
  const created = await newest(job.id, 'quote_created');
  assert.ok(created, 'no quote_created entry');
  assert.deepEqual(created.to, { quoteId: q.json.id, number: q.json.number, amount: 1251, currency: q.json.currency, status: 'draft' });
  assert.equal(created.actor.name, U.admin.name);

  // a duplicate quote for the job is refused (409) → no second entry
  const dup = await request('POST', '/api/quotes', { token: U.admin.token, body: { jobId: job.id, amount: 10 } });
  assert.equal(dup.status, 409);
  assert.equal((await feed(job.id)).filter((e) => e.type === 'quote_created').length, 1);

  // a PATCH that does not change status logs nothing
  const before = (await feed(job.id)).length;
  const n = await request('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { notes: 'call first', version: q.json.version } });
  assert.equal(n.status, 200, n.text);
  assert.equal((await feed(job.id)).length, before);

  const sent = await request('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { status: 'sent', version: n.json.version } });
  assert.equal(sent.status, 200, sent.text);
  const upd = await newest(job.id, 'updated');
  assert.deepEqual(upd.from, { quoteId: q.json.id, number: q.json.number, status: 'draft' });
  assert.deepEqual(upd.to, { quoteId: q.json.id, number: q.json.number, status: 'sent' });

  // a stale version (409) rolls the entry back with the change
  const stale = await request('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { status: 'approved', version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal((await feed(job.id)).filter((e) => e.type === 'updated').length, 1);
  const ok = await request('PATCH', `/api/quotes/${q.json.id}`, { token: U.admin.token, body: { status: 'approved', version: sent.json.version } });
  assert.equal(ok.status, 200, ok.text);

  const inv = await request('POST', `/api/invoices/from-quote/${q.json.id}`, { token: U.admin.token, body: { dueDate: '2031-01-31' } });
  assert.equal(inv.status, 201, inv.text);
  const ic = await newest(job.id, 'invoice_created');
  assert.deepEqual(ic.to, {
    invoiceId: inv.json.id, number: inv.json.number, amount: 1251, currency: inv.json.currency, status: 'unpaid',
    fromQuoteId: q.json.id, fromQuoteNumber: q.json.number,
  });
  const paid = await request('PATCH', `/api/invoices/${inv.json.id}`, { token: U.admin.token, body: { status: 'paid', version: inv.json.version } });
  assert.equal(paid.status, 200, paid.text);
  const pu = await newest(job.id, 'updated');
  assert.deepEqual([pu.from, pu.to], [
    { invoiceId: inv.json.id, number: inv.json.number, status: 'unpaid' },
    { invoiceId: inv.json.id, number: inv.json.number, status: 'paid' },
  ]);
  assert.deepEqual((await feed(job.id)).map((e) => e.type), ['updated', 'invoice_created', 'updated', 'updated', 'quote_created', 'created']);
});

test('documents: POST /api/invoices logs invoice_created; a refused create or email logs nothing', async () => {
  const job = await mkJob();
  const bad = await request('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 0 } });
  assert.equal(bad.status, 400);
  const tech = await request('POST', '/api/invoices', { token: U.tech.token, body: { jobId: job.id, amount: 50 } });
  assert.equal(tech.status, 403);
  assert.deepEqual((await feed(job.id)).map((e) => e.type), ['created']);
  const inv = await request('POST', '/api/invoices', { token: U.admin.token, body: { jobId: job.id, amount: 99.95, dueDate: '2031-02-01' } });
  assert.equal(inv.status, 201, inv.text);
  const e = await newest(job.id, 'invoice_created');
  assert.deepEqual(e.to, { invoiceId: inv.json.id, number: inv.json.number, amount: 99.95, currency: inv.json.currency, status: 'unpaid' });
  // MAIL_DRIVER=none → 503 EMAIL_DISABLED and no entry
  const mail = await request('POST', `/api/invoices/${inv.json.id}/email`, { token: U.admin.token, body: {} });
  assert.equal(mail.status, 503, mail.text);
  assert.equal(mail.json.code, 'EMAIL_DISABLED');
  assert.deepEqual((await feed(job.id)).map((x) => x.type), ['invoice_created', 'created']);
});
