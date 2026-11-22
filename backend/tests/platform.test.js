/**
 * tests/platform.test.js — sandbox/platform plumbing (no server needed).
 *
 *   npm run test:platform
 *
 * Covers: local storage driver (incl. path traversal), mail outbox sink,
 * integration kill-switches, DATABASE_URL normalisation, local backups, and
 * backup → restore round trips (plain, encrypted, uploads, heartbeat, S3 via a
 * local S3 stub). The backup tests need DATABASE_URL + pg_dump (+ psql + tar
 * for restore) and are skipped without them. Restore tests create scratch
 * databases named <DATABASE_URL db>_rt_<pid>_<n> and drop them afterwards.
 */
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// Never read backend/.env or .env.sandbox: the only database these tests touch
// comes from TEST_DATABASE_URL (a throwaway server/db whose name contains
// "test"). Child processes (restore.mjs, migrate-deploy.mjs) inherit this.
process.env.ENV_FILE = '/dev/null';
delete process.env.DATABASE_URL;
require('../helpers/loadEnv');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-platform-test-'));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(restore);
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}

async function readStream(s) {
  const chunks = [];
  for await (const c of s) chunks.push(c);
  return Buffer.concat(chunks);
}

// ── Storage ─────────────────────────────────────────────────────────────────
test('storage: local driver round-trips put/get/delete', () => withEnv(
  { STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: path.join(tmp, 'storage') },
  async () => {
    const storage = require('../helpers/storage');
    assert.equal(storage.getDriver(), 'local');
    assert.equal(storage.isConfigured(), true);
    const key = 'jobs/42/123-abcd-photo.png';
    await storage.putObject(key, Buffer.from('hello'), 'image/png');
    assert.ok(fs.existsSync(path.join(tmp, 'storage', 'jobs', '42', '123-abcd-photo.png')));
    const obj = await storage.getObject(key);
    assert.equal((await readStream(obj.Body)).toString(), 'hello');
    await storage.deleteObject(key);
    await assert.rejects(storage.getObject(key), (e) => e.status === 404);
    await storage.deleteObject(key); // idempotent
  },
));

test('storage: local driver rejects path-traversal keys', () => withEnv(
  { STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: path.join(tmp, 'storage') },
  async () => {
    const storage = require('../helpers/storage');
    const bad = ['../escape.txt', 'jobs/../../escape.txt', '/etc/passwd', 'jobs/1/..', 'jobs//x', 'jobs\\..\\x', 'a/\0b', '', './x'];
    for (const key of bad) {
      assert.throws(() => storage.localPathForKey(key), /Invalid storage key/, `key ${JSON.stringify(key)} must be rejected`);
      await assert.rejects(storage.putObject(key, Buffer.from('x')), /Invalid storage key/);
    }
    assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
  },
));

test('storage: unknown STORAGE_DRIVER is an error, default is s3', () => {
  const storage = require('../helpers/storage');
  withEnv({ STORAGE_DRIVER: 'ftp' }, () => assert.throws(() => storage.getDriver(), /Unknown STORAGE_DRIVER/));
  withEnv({ STORAGE_DRIVER: null }, () => assert.equal(storage.getDriver(), 's3'));
});

// ── Mail ────────────────────────────────────────────────────────────────────
test('mail: outbox driver writes .eml + .json and sends nothing', () => withEnv(
  { MAIL_DRIVER: 'outbox', MAIL_OUTBOX_DIR: path.join(tmp, 'outbox'), SMTP_FROM: 'no-reply@demo.test' },
  async () => {
    const { sendMail } = require('../helpers/mailer');
    const r = await sendMail({ to: 'someone@example.test', subject: 'Invite', text: 'link: http://x' }, { fromName: 'MBC' });
    assert.equal(r.delivered, true);
    assert.equal(r.driver, 'outbox');
    const eml = fs.readFileSync(r.file, 'utf8');
    assert.match(eml, /^To: someone@example\.test$/m);
    assert.match(eml, /^Subject: Invite$/m);
    const json = JSON.parse(fs.readFileSync(r.file.replace(/\.eml$/, '.json'), 'utf8'));
    assert.equal(json.to, 'someone@example.test');
  },
));

test('mail: no SMTP_HOST and no MAIL_DRIVER → disabled, not delivered', () => withEnv(
  { MAIL_DRIVER: null, SMTP_HOST: null },
  async () => {
    const { sendMail, getDriver } = require('../helpers/mailer');
    assert.equal(getDriver(), 'none');
    const r = await sendMail({ to: 'a@example.test', subject: 's', text: 't' });
    assert.equal(r.delivered, false);
  },
));

test('mail: SMTP_HOST set → smtp driver (Mailpit path unchanged)', () => withEnv(
  { MAIL_DRIVER: null, SMTP_HOST: 'mailpit' },
  () => assert.equal(require('../helpers/mailer').getDriver(), 'smtp'),
));

// ── Integrations ────────────────────────────────────────────────────────────
const REAL_LOOKING = {
  TWILIO_ACCOUNT_SID: 'AC0123456789abcdef', TWILIO_AUTH_TOKEN: 'abcdef0123456789', TWILIO_PHONE_NUMBER: '+15555550100',
  QB_CLIENT_ID: 'ABcd1234', QB_CLIENT_SECRET: 'secret1234', QB_REDIRECT_URI: 'https://example.test/cb',
  GOOGLE_CLIENT_ID: '123.apps.example', GOOGLE_CLIENT_SECRET: 'gsecret', GOOGLE_CALLBACK_URL: 'https://example.test/g',
};

test('integrations: SANDBOX_MODE disables everything even with real-looking creds', () => withEnv(
  { ...REAL_LOOKING, SANDBOX_MODE: 'true', DEMO_MODE: 'false' },
  () => {
    const { integrationStatus } = require('../helpers/integrations');
    for (const n of ['twilio', 'quickbooks', 'google']) {
      assert.deepEqual([integrationStatus(n).enabled, integrationStatus(n).reason], [false, 'sandbox'], n);
    }
  },
));

test('integrations: DEMO_MODE disables Twilio + QuickBooks but not Google (previous semantics)', () => withEnv(
  { ...REAL_LOOKING, SANDBOX_MODE: null, DEMO_MODE: 'true' },
  () => {
    const { integrationStatus } = require('../helpers/integrations');
    assert.equal(integrationStatus('twilio').reason, 'demo');
    assert.equal(integrationStatus('quickbooks').reason, 'demo');
    assert.equal(integrationStatus('google').enabled, true);
  },
));

test('integrations: placeholder creds → not-configured; real-looking → enabled', () => withEnv(
  { ...REAL_LOOKING, SANDBOX_MODE: 'false', DEMO_MODE: 'false', TWILIO_AUTH_TOKEN: 'placeholder', QB_CLIENT_ID: '' },
  () => {
    const { integrationStatus } = require('../helpers/integrations');
    assert.equal(integrationStatus('twilio').reason, 'not-configured');
    assert.deepEqual(integrationStatus('twilio').missing, ['TWILIO_AUTH_TOKEN']);
    assert.equal(integrationStatus('quickbooks').reason, 'not-configured');
    assert.equal(integrationStatus('google').enabled, true);
  },
));

// ── DATABASE_URL ────────────────────────────────────────────────────────────
test('databaseUrl: strips Prisma-only params, keeps libpq ones', () => {
  const { parseDatabaseUrl } = require('../helpers/databaseUrl');
  const r = parseDatabaseUrl('postgresql://u:p%40ss@db:5432/mbc?schema=tenant1&sslmode=require&connection_limit=5');
  assert.equal(r.schema, 'tenant1');
  assert.equal(r.database, 'mbc');
  assert.equal(r.connectionString, 'postgresql://u:p%40ss@db:5432/mbc?sslmode=require');
  assert.equal(parseDatabaseUrl('postgresql://u@h/d').schema, 'public');
});

// ── Backups (need TEST_DATABASE_URL + pg_dump) ──────────────────────────────
// A fresh source database <test db>_rt_<pid>_src is created on the
// TEST_DATABASE_URL server, migrated, and filled with probe rows; DATABASE_URL
// points at it for the backup/restore tests. Every scratch DB is dropped after.
const TEST_DB = process.env.TEST_DATABASE_URL || '';
const hasDb = /^postgres/.test(TEST_DB);
const { spawnSync, spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const MIGRATE = path.join(__dirname, '..', 'scripts', 'migrate-deploy.mjs');
const scratchDbs = [];
let scratchN = 0;

function testDbName() { return require('../helpers/databaseUrl').parseDatabaseUrl(TEST_DB).database; }
function serverUrl(dbName) {
  const { url } = require('../helpers/databaseUrl').parseDatabaseUrl(TEST_DB);
  url.pathname = `/${dbName}`;
  return url.toString();
}
async function adminQuery(sql, params) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: serverUrl('postgres') });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}
async function createScratch(name) {
  scratchDbs.push(name);
  await adminQuery(`DROP DATABASE IF EXISTS "${name}"`);
  await adminQuery(`CREATE DATABASE "${name}"`);
  return serverUrl(name);
}
function migrate(url, extraArgs = []) {
  return spawnSync(process.execPath, [MIGRATE, '--quiet', ...extraArgs], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 120000 });
}

const PROBE_SQL = `
  CREATE TABLE "PlatformRtProbe" (id serial PRIMARY KEY, txt text, raw bytea, doc jsonb, at timestamptz);
  INSERT INTO "PlatformRtProbe" (txt, raw, doc, at)
  SELECT CASE WHEN g % 7 = 0 THEN NULL ELSE 'row ' || g || E': it''s; a "test"\\ \n\t\u00e9 \U0001F527 ' || repeat('x', g % 50) END,
         decode(md5(g::text), 'hex'), jsonb_build_object('g', g, 'semi', 'a;b', 'quote', 'O''Brien'),
         timestamptz '2026-11-21 03:00:00+00' + (g || ' minutes')::interval
  FROM generate_series(1, 500) g;`;

async function probeDigest(url) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(`SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS d FROM "PlatformRtProbe" t`);
    return r.rows[0].d;
  } finally { await c.end(); }
}

if (hasDb) {
  test.before(async () => {
    assert.match(testDbName(), /test/, 'TEST_DATABASE_URL must name a throwaway database containing "test"');
    const src = await createScratch(`${testDbName()}_rt_${process.pid}_src`);
    const m = migrate(src);
    assert.equal(m.status, 0, `migrate-deploy failed: ${m.stderr}`);
    const { Client } = require('pg');
    const c = new Client({ connectionString: src });
    await c.connect();
    await c.query(PROBE_SQL);
    await c.end();
    process.env.DATABASE_URL = `${src}?schema=public`;
  });
}

test('backup: local driver writes a gzipped pg_dump and lists it', { skip: !hasDb && 'DATABASE_URL not set' }, () => withEnv(
  { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'backups') },
  async () => {
    const backup = require('../backup');
    const r = await backup.runBackup();
    assert.equal(r.driver, 'local');
    assert.equal(r.wasabi, null);
    assert.match(r.filename, /^backup_.*\.sql\.gz$/);
    const sql = require('zlib').gunzipSync(fs.readFileSync(r.localPath)).toString();
    assert.match(sql, /CREATE TABLE public\."Job"/);
    assert.ok(backup.listBackups().some((b) => b.filename === r.filename), 'list must include .sql.gz backups');
  },
));

test('backup: a failing pg_dump fails the backup (no fake success marker)', { skip: !hasDb && 'DATABASE_URL not set' }, () => withEnv(
  { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'backups-fail'), PG_DUMP_PATH: path.join(tmp, 'no-such-pg_dump') },
  async () => {
    const backup = require('../backup');
    await assert.rejects(backup.runBackup(), /pg_dump is not installed/);
    assert.deepEqual(backup.listBackups(), []);
  },
));

// ── Backup → restore round trips (need TEST_DATABASE_URL + pg_dump + psql + tar) ─
const http = require('http');
const zlibM = require('zlib');

function onPath(bin) { try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } }
const canRestore = hasDb && onPath('pg_dump') && onPath('psql') && onPath('tar');
const skipRestore = !canRestore && 'TEST_DATABASE_URL, pg_dump, psql and tar are required';
const RESTORE = path.join(__dirname, '..', 'scripts', 'restore.mjs');

function scratchDb() {
  const name = `${testDbName()}_rt_${process.pid}_${(scratchN += 1)}`;
  scratchDbs.push(name);
  return name;
}
const scratchUrl = serverUrl;

/** Run scripts/restore.mjs with --json; returns { status, json, stderr }. */
function restore(args, env = {}) {
  const r = spawnSync(process.execPath, [RESTORE, ...args, '--json'], {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { status: r.status, json, stderr: r.stderr, stdout: r.stdout };
}

/** Same, without blocking the event loop (needed when the S3 stub runs in this process). */
function restoreAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RESTORE, ...args, '--json'], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (status) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not JSON */ }
      resolve({ status, json, stderr, stdout });
    });
  });
}

async function dbExists(name) {
  return (await adminQuery('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount === 1;
}

async function sourceCounts() {
  const { parseDatabaseUrl } = require('../helpers/databaseUrl');
  const { connectionString, schema } = parseDatabaseUrl(process.env.DATABASE_URL);
  return require('../backup').tableRowCounts(connectionString, schema);
}

function writeUploads(root) {
  const files = {
    'jobs/1/1718000000000-ab12cd34-kitchen.jpg': crypto.randomBytes(4096),
    'jobs/1/1718000000001-ef56ab78-meter.png': crypto.randomBytes(1500),
    'jobs/27/1718000000002-0011aabb-notes with space.pdf': Buffer.from('%PDF-1.4 synthetic'),
  };
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, k)), { recursive: true });
    fs.writeFileSync(path.join(root, k), v);
  }
  return files;
}

function assertSameFiles(files, root) {
  for (const [k, v] of Object.entries(files)) {
    assert.ok(fs.existsSync(path.join(root, k)), `restored ${k}`);
    assert.ok(fs.readFileSync(path.join(root, k)).equals(v), `${k} identical`);
  }
}

test('restore: plain backup → scratch DB has identical row counts; refuses non-empty without --force', { skip: skipRestore }, () => withEnv(
  { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'rt-plain'), BACKUP_ENCRYPTION_KEY: null, STORAGE_DRIVER: 's3', BACKUP_HEARTBEAT_URL: null },
  async () => {
    const backup = require('../backup');
    const r = await backup.runBackup();
    assert.equal(r.encrypted, false);
    assert.equal(r.uploads, null, 'no uploads archive when STORAGE_DRIVER=s3');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'rt-plain', r.manifest), 'utf8'));
    assert.equal(manifest.database.file, r.filename);
    const src = await sourceCounts();
    assert.deepEqual(manifest.rowCounts, src);
    assert.equal(src.PlatformRtProbe, 500);
    assert.ok('Job' in src && '_prisma_migrations' in src, 'migrated schema expected');

    const db = scratchDb();
    const ok = restore([r.localPath, '--database', db]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.json.rowCounts, src);
    assert.deepEqual(ok.json.manifestMismatches, []);
    assert.deepEqual(await backup.tableRowCounts(scratchUrl(db)), src);
    assert.equal(await probeDigest(scratchUrl(db)), await probeDigest(require('../helpers/databaseUrl').parseDatabaseUrl(process.env.DATABASE_URL).connectionString), 'row contents identical (quotes, ;, NULLs, unicode, bytea, jsonb)');

    const refused = restore([r.localPath, '--database', db]);
    assert.equal(refused.status, 2);
    assert.match(refused.json.error, /not empty/);

    const forced = restore(['latest', '--database', db, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(forced.json.rowCounts, src);
  },
));

test('restore: encrypted round trip (AES-256-GCM); wrong key and tampering are refused before anything is written', { skip: skipRestore }, () => withEnv(
  { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'rt-enc'), BACKUP_ENCRYPTION_KEY: 'test-only-key-7f3a9c', STORAGE_DRIVER: 's3', BACKUP_HEARTBEAT_URL: null },
  async () => {
    const backup = require('../backup');
    const r = await backup.runBackup();
    assert.equal(r.encrypted, true);
    assert.match(r.filename, /\.sql\.gz\.enc$/);
    const raw = fs.readFileSync(r.localPath);
    assert.equal(raw.subarray(0, 8).toString('latin1'), 'MBCBAK1\n');
    assert.throws(() => zlibM.gunzipSync(raw), 'ciphertext must not be gzip');
    assert.equal(raw.includes(Buffer.from('CREATE TABLE')), false);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'rt-enc')).filter((f) => /\.sql(\.gz)?$/.test(f)), [], 'no plaintext dump left on disk');

    const src = await sourceCounts();
    const db = scratchDb();
    const ok = restore([r.localPath, '--database', db], { BACKUP_ENCRYPTION_KEY: 'test-only-key-7f3a9c' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(ok.json.rowCounts, src);

    // key from a file works too
    const keyFile = path.join(tmp, 'key.txt');
    fs.writeFileSync(keyFile, 'test-only-key-7f3a9c\n');
    const viaFile = restore([r.localPath, '--database', db, '--force', '--key-file', keyFile], { BACKUP_ENCRYPTION_KEY: '' });
    assert.equal(viaFile.status, 0, viaFile.stderr);

    const wrongDb = scratchDb();
    const wrong = restore([r.localPath, '--database', wrongDb], { BACKUP_ENCRYPTION_KEY: 'not-the-key' });
    assert.equal(wrong.status, 1);
    assert.match(wrong.json.error, /Decryption failed/);
    assert.equal(await dbExists(wrongDb), false, 'nothing created on a wrong key');

    const noKey = restore([r.localPath, '--database', wrongDb], { BACKUP_ENCRYPTION_KEY: '' });
    assert.equal(noKey.status, 1);
    assert.match(noKey.json.error, /encrypted/);

    // Tamper with one ciphertext byte: the manifest hash catches it; without
    // the manifest, the GCM tag does.
    const tampered = Buffer.from(raw);
    tampered[100] ^= 0xff;
    fs.writeFileSync(r.localPath, tampered);
    const bad = restore([r.localPath, '--database', wrongDb], { BACKUP_ENCRYPTION_KEY: 'test-only-key-7f3a9c' });
    assert.equal(bad.status, 1);
    assert.match(bad.json.error, /sha256 does not match/);
    fs.unlinkSync(path.join(tmp, 'rt-enc', r.manifest));
    const bad2 = restore([r.localPath, '--database', wrongDb], { BACKUP_ENCRYPTION_KEY: 'test-only-key-7f3a9c' });
    assert.equal(bad2.status, 1);
    assert.match(bad2.json.error, /Decryption failed/);
    assert.equal(await dbExists(wrongDb), false);
  },
));

test('backup: uploads (STORAGE_DRIVER=local) are archived and restored byte-identical', { skip: skipRestore }, () => {
  const root = path.join(tmp, 'rt-photos-src');
  const files = writeUploads(root);
  return withEnv(
    { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'rt-photos'), BACKUP_ENCRYPTION_KEY: 'photo-key-1234', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: root, BACKUP_HEARTBEAT_URL: null },
    async () => {
      const backup = require('../backup');
      const r = await backup.runBackup();
      assert.ok(r.uploads, 'uploads archive expected');
      assert.match(r.uploads.filename, /\.uploads\.tar\.gz\.enc$/);
      assert.equal(r.uploads.files, 3);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'rt-photos', r.manifest), 'utf8'));
      assert.equal(manifest.uploads.files, 3);

      const db = scratchDb();
      const dest = path.join(tmp, 'rt-photos-restored');
      const ok = restore([r.localPath, '--database', db, '--uploads-dir', dest]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(ok.json.uploads.files, 3);
      assertSameFiles(files, dest);

      // Default target = LOCAL_STORAGE_DIR, which is not empty → refused, DB untouched.
      const db2 = scratchDb();
      const refused = restore([r.localPath, '--database', db2]);
      assert.equal(refused.status, 2);
      assert.match(refused.json.error, /Uploads directory .* is not empty/);
      const { Client } = require('pg');
      const c = new Client({ connectionString: scratchUrl(db2) });
      await c.connect();
      const n = (await c.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n;
      await c.end();
      assert.equal(n, 0, 'database not restored when the uploads check refuses');

      // --no-uploads restores the DB only.
      const dbOnly = restore([r.localPath, '--database', db2, '--no-uploads']);
      assert.equal(dbOnly.status, 0, dbOnly.stderr);
      assert.equal(dbOnly.json.uploads, null);

      // Pruning: uploads archives are kept for BACKUP_KEEP_UPLOADS sets only.
      await withEnv({ BACKUP_KEEP_UPLOADS: '1' }, async () => {
        await new Promise((res) => setTimeout(res, 1100)); // new stamp
        await backup.runBackup();
        const kinds = backup.listBackups().filter((b) => b.kind === 'uploads');
        assert.equal(kinds.length, 1);
        assert.equal(backup.listBackups().filter((b) => b.kind === 'database').length, 2);
      });
    },
  );
});

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

test('backup: heartbeat pinged on success; /fail ping with the error on failure', { skip: !hasDb && 'DATABASE_URL not set' }, async () => {
  const hits = [];
  const { server, base } = await startStub(async (req, res) => {
    hits.push({ method: req.method, url: req.url, body: (await readBody(req)).toString() });
    res.end('OK');
  });
  try {
    await withEnv(
      { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'rt-hb'), BACKUP_ENCRYPTION_KEY: null, STORAGE_DRIVER: 's3',
        BACKUP_HEARTBEAT_URL: `${base}/ping/abc-123`, BACKUP_HEARTBEAT_FAIL_URL: `${base}/ping/abc-123/fail` },
      async () => {
        const backup = require('../backup');
        const r = await backup.runBackup();
        assert.equal(r.heartbeat, 'ok');
        assert.deepEqual(hits.map((h) => `${h.method} ${h.url}`), ['GET /ping/abc-123']);
        await withEnv({ PG_DUMP_PATH: path.join(tmp, 'no-such-pg_dump') }, async () => {
          await assert.rejects(backup.runBackup(), /pg_dump is not installed/);
        });
        assert.equal(hits.length, 2);
        assert.equal(`${hits[1].method} ${hits[1].url}`, 'POST /ping/abc-123/fail');
        assert.match(hits[1].body, /pg_dump is not installed/);
      },
    );
    // A heartbeat endpoint that is down never fails the backup itself.
    await withEnv(
      { BACKUP_DRIVER: 'local', BACKUP_DIR: path.join(tmp, 'rt-hb2'), STORAGE_DRIVER: 's3', BACKUP_HEARTBEAT_URL: 'http://127.0.0.1:9/down', BACKUP_HEARTBEAT_FAIL_URL: null },
      async () => assert.equal((await require('../backup').runBackup()).heartbeat, 'failed'),
    );
  } finally { server.close(); }
});

test('backup: Healthchecks.io URLs get a derived /fail URL; others need BACKUP_HEARTBEAT_FAIL_URL', () => {
  const { heartbeatFailUrl } = require('../backup');
  withEnv({ BACKUP_HEARTBEAT_URL: 'https://hc-ping.com/0b1c-uuid', BACKUP_HEARTBEAT_FAIL_URL: null },
    () => assert.equal(heartbeatFailUrl(), 'https://hc-ping.com/0b1c-uuid/fail'));
  withEnv({ BACKUP_HEARTBEAT_URL: 'https://hc-ping.com/pingkey/mbc-acme-backup/', BACKUP_HEARTBEAT_FAIL_URL: null },
    () => assert.equal(heartbeatFailUrl(), 'https://hc-ping.com/pingkey/mbc-acme-backup/fail'));
  withEnv({ BACKUP_HEARTBEAT_URL: 'https://heartbeat.example.test/x', BACKUP_HEARTBEAT_FAIL_URL: null },
    () => assert.equal(heartbeatFailUrl(), null));
  withEnv({ BACKUP_HEARTBEAT_URL: null, BACKUP_HEARTBEAT_FAIL_URL: 'https://e.test/f' },
    () => assert.equal(heartbeatFailUrl(), 'https://e.test/f'));
});

test('backup: generic BACKUP_S3_* names win, WASABI_* is the per-variable fallback', () => {
  const backup = require('../backup');
  const clear = { BACKUP_S3_ENDPOINT: null, BACKUP_S3_REGION: null, BACKUP_S3_BUCKET: null, BACKUP_S3_ACCESS_KEY: null, BACKUP_S3_SECRET_KEY: null, BACKUP_S3_PREFIX: null,
    WASABI_ENDPOINT: null, WASABI_REGION: null, WASABI_BUCKET: null, WASABI_ACCESS_KEY: null, WASABI_SECRET_KEY: null, BACKUP_DRIVER: null };
  withEnv({ ...clear, WASABI_BUCKET: 'old', WASABI_ACCESS_KEY: 'k', WASABI_SECRET_KEY: 's', WASABI_ENDPOINT: 'http://minio:9000' }, () => {
    const c = backup.getS3Config();
    assert.deepEqual([c.bucket, c.endpoint, c.prefix], ['old', 'http://minio:9000', 'backups/']);
    assert.equal(backup.getBackupDriver(), 's3');
  });
  withEnv({ ...clear, WASABI_BUCKET: 'old', WASABI_ACCESS_KEY: 'k', WASABI_SECRET_KEY: 's',
    BACKUP_S3_BUCKET: 'mbc-acme-backups', BACKUP_S3_ENDPOINT: 'https://acct.eu.r2.cloudflarestorage.com', BACKUP_S3_REGION: 'auto', BACKUP_S3_PREFIX: 'nightly' }, () => {
    const c = backup.getS3Config();
    assert.deepEqual([c.bucket, c.endpoint, c.region, c.accessKeyId, c.prefix], ['mbc-acme-backups', 'https://acct.eu.r2.cloudflarestorage.com', 'auto', 'k', 'nightly/']);
  });
  withEnv(clear, () => {
    assert.equal(backup.s3Configured(), false);
    assert.equal(backup.getBackupDriver(), 'local');
  });
});

/** Minimal path-style S3 stub: PUT/GET/HEAD object, ListObjectsV2, multipart. */
function s3Stub() {
  const objects = new Map(); // "bucket/key" → Buffer
  const uploads = new Map(); // uploadId → { key, parts: Map }
  const state = { objects, failPuts: false, multipartCompletes: 0 };
  const xml = (res, body) => { res.setHeader('Content-Type', 'application/xml'); res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`); };
  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://stub');
    const [bucket, ...rest] = u.pathname.slice(1).split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const id = `${bucket}/${key}`;
    const body = await readBody(req);
    if (req.method === 'PUT') {
      if (state.failPuts) { res.statusCode = 500; return xml(res, '<Error><Code>InternalError</Code><Message>stub failure</Message></Error>'); }
      if (u.searchParams.has('uploadId')) { uploads.get(u.searchParams.get('uploadId')).parts.set(Number(u.searchParams.get('partNumber')), body); }
      else objects.set(id, body);
      res.setHeader('ETag', `"${crypto.createHash('md5').update(body).digest('hex')}"`);
      return res.end();
    }
    if (req.method === 'POST' && u.searchParams.has('uploads')) {
      const uploadId = crypto.randomBytes(6).toString('hex');
      uploads.set(uploadId, { key: id, parts: new Map() });
      return xml(res, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (req.method === 'POST' && u.searchParams.has('uploadId')) {
      const up = uploads.get(u.searchParams.get('uploadId'));
      objects.set(up.key, Buffer.concat([...up.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])));
      state.multipartCompletes += 1;
      return xml(res, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`);
    }
    if (req.method === 'DELETE') { uploads.delete(u.searchParams.get('uploadId')); res.statusCode = 204; return res.end(); }
    if (req.method === 'GET' && !key && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const items = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).sort()
        .map((k) => `<Contents><Key>${k.slice(bucket.length + 1)}</Key><Size>${objects.get(k).length}</Size></Contents>`).join('');
      return xml(res, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && objects.has(id)) {
      res.setHeader('Content-Length', objects.get(id).length);
      return res.end(req.method === 'GET' ? objects.get(id) : undefined);
    }
    res.statusCode = 404;
    if (req.method === 'HEAD') return res.end();
    return xml(res, '<Error><Code>NoSuchKey</Code><Message>not found</Message></Error>');
  };
  return { state, handler };
}

test('backup: S3 driver uploads the whole set (multipart path too); restore latest-remote round-trips it', { skip: skipRestore }, async () => {
  const stub = s3Stub();
  const { server, base } = await startStub(stub.handler);
  const root = path.join(tmp, 'rt-s3-photos');
  const files = writeUploads(root);
  const s3env = {
    BACKUP_DRIVER: 's3', BACKUP_DIR: path.join(tmp, 'rt-s3'), BACKUP_ENCRYPTION_KEY: 's3-key-abcdef', STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: root,
    BACKUP_S3_ENDPOINT: base, BACKUP_S3_REGION: 'auto', BACKUP_S3_BUCKET: 'mbc-test-backups', BACKUP_S3_ACCESS_KEY: 'test', BACKUP_S3_SECRET_KEY: 'test',
    BACKUP_S3_PREFIX: 'backups/', BACKUP_S3_MULTIPART_MB: '0', BACKUP_HEARTBEAT_URL: null, WASABI_BUCKET: null,
  };
  try {
    await withEnv(s3env, async () => {
      const backup = require('../backup');
      const r = await backup.runBackup();
      assert.equal(r.driver, 's3');
      assert.deepEqual(r.remote.keys, [`backups/${r.filename}`, `backups/${r.uploads.filename}`, `backups/${r.manifest}`], 'manifest uploaded last');
      assert.equal(stub.state.multipartCompletes, 3);
      assert.ok(stub.state.objects.get(`mbc-test-backups/backups/${r.filename}`).equals(fs.readFileSync(r.localPath)));

      // Restore from the bucket with the local copies gone.
      fs.rmSync(path.join(tmp, 'rt-s3'), { recursive: true, force: true });
      const db = scratchDb();
      const dest = path.join(tmp, 'rt-s3-restored');
      const listed = await restoreAsync(['--list', '--remote']);
      assert.equal(listed.json[0].stamp, r.manifest.replace(/^backup_|\.manifest\.json$/g, ''));
      const ok = await restoreAsync(['latest-remote', '--database', db, '--uploads-dir', dest]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(ok.json.rowCounts, await sourceCounts());
      assertSameFiles(files, dest);

      // A failed upload is a failed backup (local copy kept).
      stub.state.failPuts = true;
      await withEnv({ BACKUP_S3_MULTIPART_MB: null }, async () => {
        await assert.rejects(backup.runBackup(), /upload to s3:\/\/mbc-test-backups\/backups\/ failed.*local copy kept/);
      });
      assert.ok(backup.listBackups().some((b) => b.kind === 'database'), 'local copy kept after upload failure');
    });
  } finally { server.close(); }
});

test('backup: BACKUP_DRIVER=s3 without a bucket fails loudly', { skip: !hasDb && 'DATABASE_URL not set' }, () => withEnv(
  { BACKUP_DRIVER: 's3', BACKUP_DIR: path.join(tmp, 'rt-nos3'), STORAGE_DRIVER: 's3', BACKUP_HEARTBEAT_URL: null,
    BACKUP_S3_BUCKET: null, BACKUP_S3_ACCESS_KEY: null, BACKUP_S3_SECRET_KEY: null, WASABI_BUCKET: null, WASABI_ACCESS_KEY: null, WASABI_SECRET_KEY: null },
  async () => {
    await assert.rejects(require('../backup').runBackup(), /BACKUP_S3_BUCKET .* not set/);
  },
));

// ── PLAT-15: migration statement splitting ─────────────────────────────────
test('sql-split: splits on top-level ; only (quotes, E-strings, identifiers, $$, $tag$, comments)', () => {
  const splitDir = fs.mkdtempSync(path.join(tmp, 'split-'));
  let nSplit = 0;
  const splitSqlStatements = (text) => {
    const f = path.join(splitDir, `${(nSplit += 1)}.sql`);
    fs.writeFileSync(f, text);
    const r = spawnSync(process.execPath, [MIGRATE, '--split-only', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const sql = `
-- comment with ; in it
CREATE TABLE "a;b" (id int, note text DEFAULT 'x;y', e text DEFAULT E'it\\'s;');
/* block ; /* nested ; */ still comment ; */
INSERT INTO "a;b" VALUES (1, 'it''s; fine', E'\\\;');
CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'semi; colon';
  RETURN 1;
END;
$$;
CREATE FUNCTION g() RETURNS text LANGUAGE sql AS $body$ SELECT 'a;b' $q$ inner; $q$ $body$;
SELECT $1::int; -- parameter, not a dollar quote
-- trailing comment only ;
`;
  const parts = splitSqlStatements(sql);
  assert.equal(parts.length, 5, JSON.stringify(parts, null, 1));
  assert.match(parts[0], /^-- comment with ; in it\nCREATE TABLE "a;b"/);
  assert.match(parts[0], /E'it\\'s;'\)$/);
  assert.match(parts[1], /INSERT INTO "a;b" VALUES \(1, 'it''s; fine', E'\\\;'\)$/);
  assert.match(parts[2], /RETURN 1;\nEND;\n\$\$$/);
  assert.match(parts[3], /\$body\$ SELECT 'a;b' \$q\$ inner; \$q\$ \$body\$$/);
  assert.equal(parts[4], 'SELECT $1::int');
  assert.deepEqual(splitSqlStatements('  ;; -- nothing\n/* x */ ; '), []);
  assert.deepEqual(splitSqlStatements('SELECT 1'), ['SELECT 1']);
  // Every existing migration splits the same as before (they have no tricky ;)
  const dir = path.join(__dirname, '..', 'prisma', 'migrations');
  for (const m of fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())) {
    const text = fs.readFileSync(path.join(dir, m, 'migration.sql'), 'utf8');
    const naive = text.split(';').map((x) => x.trim()).filter(Boolean).filter((x) => x.split('\n').some((l) => l.trim() && !l.trim().startsWith('--')));
    assert.equal(splitSqlStatements(text).length, naive.length, `${m}: statement count changed`);
  }
});

test('migrate-deploy: applies a migration with a PL/pgSQL body and ; in strings/comments (PLAT-15)', { skip: !hasDb && 'TEST_DATABASE_URL not set' }, async () => {
  const dir = path.join(tmp, 'migrations-plat15');
  fs.cpSync(path.join(__dirname, '..', 'prisma', 'migrations'), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '29990101000000_plat15_probe'));
  fs.writeFileSync(path.join(dir, '29990101000000_plat15_probe', 'migration.sql'), `
-- PLAT-15 probe; comment with a semicolon
CREATE TABLE "Plat15Probe" ("id" SERIAL PRIMARY KEY, "note" TEXT NOT NULL DEFAULT 'a;b', "updatedAt" TIMESTAMP(3));
CREATE OR REPLACE FUNCTION plat15_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now(); -- ; inside the body
  RETURN NEW;
END;
$$;
CREATE TRIGGER plat15_touch BEFORE INSERT ON "Plat15Probe" FOR EACH ROW EXECUTE FUNCTION plat15_touch();
INSERT INTO "Plat15Probe" ("note") VALUES ('it''s; ok');
`);
  const url = await createScratch(`${testDbName()}_rt_${process.pid}_mig`);
  const r = migrate(url, ['--migrations-dir', dir]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const rows = (await c.query('SELECT note, "updatedAt" FROM "Plat15Probe"')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, "it's; ok");
    assert.ok(rows[0].updatedAt, 'trigger function body ran');
    const applied = (await c.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1')).rows.map((x) => x.migration_name);
    assert.ok(applied.includes('29990101000000_plat15_probe'));
  } finally { await c.end(); }
  // Re-running is a no-op
  assert.equal(migrate(url, ['--migrations-dir', dir]).status, 0);
});

test.after(async () => {
  if (!scratchDbs.length) return;
  for (const d of scratchDbs) await adminQuery(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`).catch(() => {});
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
