/**
 * tests/platform.test.js — sandbox/platform plumbing (no server needed).
 *
 *   npm run test:platform
 *
 * Covers: local storage driver (incl. path traversal), mail outbox sink,
 * integration kill-switches, DATABASE_URL normalisation, local backups.
 * The backup tests need DATABASE_URL + pg_dump and are skipped without them.
 */
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

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

// ── Backups (need a real DB + pg_dump) ──────────────────────────────────────
const hasDb = /^postgres/.test(process.env.DATABASE_URL || '');

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

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
