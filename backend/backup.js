/**
 * backup.js
 * Backups for PostgreSQL (and legacy SQLite local dev), plus the photo/upload
 * directory when STORAGE_DRIVER=local.
 * Called automatically by node-cron at 03:00 (brand.timezone), manually via
 * POST /api/backup/run, and from the command line with `npm run backup:run`.
 * Restore with `npm run restore` (scripts/restore.mjs).
 *
 * ── One backup run = one "backup set", all sharing a timestamp <stamp> ──────
 *   backup_<stamp>.sql.gz[.enc]          pg_dump (plain SQL), gzipped in Node
 *   backup_<stamp>.uploads.tar.gz[.enc]  the LOCAL_STORAGE_DIR tree (only when
 *                                        STORAGE_DRIVER=local and it exists)
 *   backup_<stamp>.manifest.json         sizes, sha256s, row counts, versions;
 *                                        written (and uploaded) LAST, so a set
 *                                        with a manifest is complete
 * Everything is written to BACKUP_DIR first (default backend/backups/).
 *
 * ── Where it goes next: BACKUP_DRIVER ───────────────────────────────────────
 *   local   keep it on local disk only (sandbox; no network).
 *   s3      also upload to an S3-compatible bucket (Cloudflare R2, Backblaze
 *           B2, AWS S3, MinIO in the Docker demo). Alias: `wasabi` (legacy).
 *   (unset) `s3` when a bucket + keys are configured, otherwise `local`.
 *
 * S3 settings (generic names; the legacy WASABI_* names are the fallback, per
 * variable):
 *   BACKUP_S3_ENDPOINT         e.g. https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *                              or   https://s3.eu-central-003.backblazeb2.com
 *   BACKUP_S3_REGION           `auto` for R2, the B2/AWS region otherwise
 *   BACKUP_S3_BUCKET           a bucket used ONLY for backups
 *   BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY   token scoped to that bucket
 *   BACKUP_S3_PREFIX           key prefix, default `backups/`
 *   BACKUP_S3_FORCE_PATH_STYLE default true
 *   BACKUP_S3_MULTIPART_MB     files above this size use multipart upload
 *                              (default 100; a single PUT is capped at 5 GB)
 * A failed upload FAILS the backup (the local copy is kept).
 *
 * ── Encryption: BACKUP_ENCRYPTION_KEY (optional) ────────────────────────────
 * When set, the dump and the uploads archive are encrypted before they touch
 * disk with AES-256-GCM (Node crypto, no extra binaries). The key is derived
 * from BACKUP_ENCRYPTION_KEY with scrypt and a random per-file salt. File
 * layout: "MBCBAK1\n" | salt(16) | iv(12) | ciphertext | tag(16); the header is
 * authenticated as AAD. KEEP A COPY OF THE KEY OFF THE SERVER — without it the
 * backups cannot be restored. The manifest is never encrypted (it holds only
 * table names, row counts, sizes and hashes).
 *
 * ── Monitoring: BACKUP_HEARTBEAT_URL (optional) ─────────────────────────────
 * On success: GET BACKUP_HEARTBEAT_URL. On failure: POST the error to
 * BACKUP_HEARTBEAT_FAIL_URL, or to BACKUP_HEARTBEAT_URL + "/fail" when the URL
 * is a Healthchecks.io ping URL (hc-ping.com). A ping that cannot be delivered
 * is logged, never fatal.
 *
 * ── Local retention ─────────────────────────────────────────────────────────
 *   BACKUP_KEEP          backup sets kept locally (default 30)
 *   BACKUP_KEEP_UPLOADS  of those, how many keep their uploads archive locally
 *                        (default 3; photo archives are large). Off-site
 *                        retention is a bucket lifecycle rule (DEPLOYMENT.md).
 *
 * pg_dump must be on PATH (PG_DUMP_PATH overrides) and its major version must
 * be >= the server's (the Docker image installs postgresql-client-16). If
 * pg_dump is missing or fails, the backup FAILS loudly.
 */

const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { parseDatabaseUrl } = require('./helpers/databaseUrl');

const execFileAsync = promisify(execFile);

const BACKUP_FILE_RE = /^backup_([0-9A-Za-z_-]+)\.(sql\.gz\.enc|sql\.gz|uploads\.tar\.gz\.enc|uploads\.tar\.gz|manifest\.json|sql|db)$/;
const PG_DUMP_TIMEOUT_MS = 60 * 60 * 1000;

function getBackupDir() {
  return path.resolve(process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
}

// ── S3 target (generic BACKUP_S3_* with WASABI_* fallback) ──────────────────
function envPick(generic, legacy) {
  const g = process.env[generic];
  if (g != null && String(g).trim() !== '') return String(g).trim();
  const l = process.env[legacy];
  if (l != null && String(l).trim() !== '') return String(l).trim();
  return undefined;
}

function getS3Config() {
  const bucket          = envPick('BACKUP_S3_BUCKET', 'WASABI_BUCKET');
  const accessKeyId     = envPick('BACKUP_S3_ACCESS_KEY', 'WASABI_ACCESS_KEY');
  const secretAccessKey = envPick('BACKUP_S3_SECRET_KEY', 'WASABI_SECRET_KEY');
  const region          = envPick('BACKUP_S3_REGION', 'WASABI_REGION') || 'us-east-1';
  let endpoint          = envPick('BACKUP_S3_ENDPOINT', 'WASABI_ENDPOINT');
  // Legacy behaviour: WASABI_* without an endpoint meant Wasabi's own endpoint.
  if (!endpoint && !process.env.BACKUP_S3_BUCKET && process.env.WASABI_BUCKET) endpoint = `https://s3.${region}.wasabisys.com`;
  let prefix = process.env.BACKUP_S3_PREFIX != null ? String(process.env.BACKUP_S3_PREFIX).trim() : 'backups/';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const forcePathStyle = String(process.env.BACKUP_S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false';
  return { bucket, accessKeyId, secretAccessKey, region, endpoint, prefix, forcePathStyle };
}

function s3Configured() {
  const c = getS3Config();
  return Boolean(c.bucket && c.accessKeyId && c.secretAccessKey);
}

function getBackupDriver() {
  const d = (process.env.BACKUP_DRIVER || '').trim().toLowerCase();
  if (!d) return s3Configured() ? 's3' : 'local';
  if (d === 'wasabi') return 's3';
  if (d !== 's3' && d !== 'local') throw new Error(`Unknown BACKUP_DRIVER "${d}" (expected local | s3)`);
  return d;
}

function makeS3Client(cfg = getS3Config()) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint || undefined,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
    // R2 / B2 / MinIO: only send checksums the operation requires (the SDK's
    // newer default adds trailing CRC32 checksums some S3-compatibles reject).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

// ── Encryption (AES-256-GCM, scrypt-derived key) ────────────────────────────
const ENC_MAGIC = Buffer.from('MBCBAK1\n', 'latin1');
const ENC_SALT = 16;
const ENC_IV = 12;
const ENC_TAG = 16;
const ENC_HEADER = ENC_MAGIC.length + ENC_SALT + ENC_IV;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function getEncryptionKey() {
  const k = process.env.BACKUP_ENCRYPTION_KEY;
  return k != null && String(k).trim() !== '' ? String(k).trim() : null;
}

function deriveKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(passphrase), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Transform stream: plaintext in → MBCBAK1 header + ciphertext + tag out. */
async function createEncryptStream(passphrase) {
  const salt = crypto.randomBytes(ENC_SALT);
  const iv = crypto.randomBytes(ENC_IV);
  const key = await deriveKey(passphrase, salt);
  const header = Buffer.concat([ENC_MAGIC, salt, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let wroteHeader = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!wroteHeader) { this.push(header); wroteHeader = true; }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!wroteHeader) this.push(header);
      const last = cipher.final();
      if (last.length) this.push(last);
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

async function isEncryptedFile(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(ENC_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length && buf.equals(ENC_MAGIC);
  } finally { await fh.close(); }
}

/**
 * Decrypt an MBCBAK1 file to `dest`. The tag is checked before this resolves;
 * on a wrong key or a tampered file `dest` is removed and this rejects — so a
 * caller never consumes unauthenticated plaintext.
 */
async function decryptFile(src, dest, passphrase) {
  if (!passphrase) throw new Error('This backup is encrypted: set BACKUP_ENCRYPTION_KEY (or pass --key-file)');
  const { size } = await fs.promises.stat(src);
  if (size < ENC_HEADER + ENC_TAG) throw new Error(`${path.basename(src)} is too short to be an encrypted backup`);
  const fh = await fs.promises.open(src, 'r');
  let header; let tag;
  try {
    header = Buffer.alloc(ENC_HEADER);
    await fh.read(header, 0, ENC_HEADER, 0);
    tag = Buffer.alloc(ENC_TAG);
    await fh.read(tag, 0, ENC_TAG, size - ENC_TAG);
  } finally { await fh.close(); }
  if (!header.subarray(0, ENC_MAGIC.length).equals(ENC_MAGIC)) throw new Error(`${path.basename(src)} is not an MBC encrypted backup`);
  const salt = header.subarray(ENC_MAGIC.length, ENC_MAGIC.length + ENC_SALT);
  const iv = header.subarray(ENC_MAGIC.length + ENC_SALT);
  const key = await deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    if (size - ENC_TAG > ENC_HEADER) {
      await pipeline(fs.createReadStream(src, { start: ENC_HEADER, end: size - ENC_TAG - 1 }), decipher, fs.createWriteStream(dest, { mode: 0o600 }));
    } else {
      decipher.final();
      await fs.promises.writeFile(dest, Buffer.alloc(0), { mode: 0o600 });
    }
  } catch (err) {
    await fs.promises.rm(dest, { force: true });
    if (/unable to authenticate|auth/i.test(err.message)) {
      throw new Error(`Decryption failed for ${path.basename(src)}: wrong BACKUP_ENCRYPTION_KEY or the file was modified`);
    }
    throw err;
  }
  return dest;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function sha256File(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Run `cmd args`, stream its stdout through `transforms` into `outPath`. */
async function spawnToFile(cmd, args, transforms, outPath, { timeoutMs = PG_DUMP_TIMEOUT_MS, label = cmd } = {}) {
  const partial = `${outPath}.partial`;
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ err }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const piped = pipeline(child.stdout, ...transforms, fs.createWriteStream(partial, { mode: 0o600 }));
  const [pipeRes, exit] = await Promise.all([piped.then(() => null, (e) => e), exited]);
  clearTimeout(timer);
  const fail = (why) => {
    try { fs.unlinkSync(partial); } catch { /* nothing written */ }
    const e = new Error(`Backup failed: ${why}`);
    e.status = 500;
    return e;
  };
  if (exit.err) {
    throw fail(exit.err.code === 'ENOENT' ? `${label} is not installed / not on PATH` : exit.err.message);
  }
  if (exit.code !== 0) {
    const first = stderr.trim().split('\n')[0] || `exit code ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}`;
    throw fail(`${label} failed: ${first}`);
  }
  if (pipeRes) throw fail(`writing ${path.basename(outPath)}: ${pipeRes.message}`);
  fs.renameSync(partial, outPath);
  return outPath;
}

async function versionOf(bin) {
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10000 });
    return stdout.trim();
  } catch { return null; }
}

/** Row count per base table in `schema`, sorted by table name. */
async function tableRowCounts(connectionString, schema = 'public') {
  const { Client } = require('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      [schema],
    );
    const counts = {};
    for (const { table_name: t } of rows) {
      const ident = `"${schema.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}"`;
      const r = await client.query(`SELECT count(*)::bigint AS n FROM ${ident}`);
      counts[t] = Number(r.rows[0].n);
    }
    return counts;
  } finally { await client.end().catch(() => {}); }
}

function countFiles(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countFiles(path.join(dir, ent.name));
    else if (ent.isFile()) n += 1;
  }
  return n;
}

/** Local upload root when STORAGE_DRIVER=local, else null. */
function uploadsRoot() {
  const storage = require('./helpers/storage');
  return storage.getDriver() === 'local' ? storage.getLocalRoot() : null;
}

// ── Backup steps ────────────────────────────────────────────────────────────
async function backupPostgres(stamp, dbUrl, dir, key) {
  const { connectionString, schema } = parseDatabaseUrl(dbUrl);
  const file = path.join(dir, `backup_${stamp}.sql.gz${key ? '.enc' : ''}`);
  const args = [connectionString, '--no-owner', '--no-acl'];
  if (schema && schema !== 'public') args.push('--schema', schema);
  const transforms = [zlib.createGzip()];
  if (key) transforms.push(await createEncryptStream(key));
  await spawnToFile(process.env.PG_DUMP_PATH || 'pg_dump', args, transforms, file, { label: 'pg_dump' });
  console.log(`[BACKUP] PostgreSQL dump saved: ${file}`);
  return { file, connectionString, schema };
}

async function backupUploads(stamp, dir, key) {
  const root = uploadsRoot();
  if (!root) return null;
  if (!fs.existsSync(root)) {
    console.log(`[BACKUP] STORAGE_DRIVER=local but ${root} does not exist yet — no uploads to archive.`);
    return null;
  }
  const file = path.join(dir, `backup_${stamp}.uploads.tar.gz${key ? '.enc' : ''}`);
  const transforms = [zlib.createGzip()];
  if (key) transforms.push(await createEncryptStream(key));
  // Plain `tar` (GNU on Linux, bsdtar on macOS); gzip + encryption happen in Node.
  await spawnToFile(process.env.TAR_PATH || 'tar', ['-cf', '-', '-C', root, '.'], transforms, file, { label: 'tar' });
  const files = countFiles(root);
  console.log(`[BACKUP] Uploads archive saved: ${file} (${files} file(s))`);
  return { file, files };
}

/**
 * SQLite backup via file copy (legacy local development only).
 */
function backupSqlite(stamp, dbUrl, dir) {
  const DB_PATH = path.join(__dirname, 'prisma', 'dev.db');
  const dbPath = dbUrl
    ? dbUrl.replace('file:', '').replace('./', path.join(__dirname, 'prisma/'))
    : DB_PATH;
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database file not found: ${dbPath}`);
  const destPath = path.join(dir, `backup_${stamp}.db`);
  fs.copyFileSync(dbPath, destPath);
  console.log(`[BACKUP] SQLite saved: ${destPath}`);
  return destPath;
}

// ── S3 upload (single PUT, or multipart above BACKUP_S3_MULTIPART_MB) ───────
const PART_SIZE = 64 * 1024 * 1024;

async function putFile(client, bucket, key, file, contentType) {
  const {
    PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand,
    CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  } = require('@aws-sdk/client-s3');
  const size = fs.statSync(file).size;
  const thresholdMb = process.env.BACKUP_S3_MULTIPART_MB != null && process.env.BACKUP_S3_MULTIPART_MB !== ''
    ? Number(process.env.BACKUP_S3_MULTIPART_MB) : 100;
  if (!(size > thresholdMb * 1024 * 1024)) {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: fs.createReadStream(file), ContentLength: size, ContentType: contentType,
    }));
    return;
  }
  const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
  try {
    const parts = [];
    for (let start = 0, n = 1; start < size || n === 1; start += PART_SIZE, n += 1) {
      const end = Math.min(start + PART_SIZE, size);
      const r = await client.send(new UploadPartCommand({
        Bucket: bucket, Key: key, UploadId, PartNumber: n,
        Body: end > start ? fs.createReadStream(file, { start, end: end - 1 }) : Buffer.alloc(0),
        ContentLength: end - start,
      }));
      parts.push({ ETag: r.ETag, PartNumber: n });
      if (end >= size) break;
    }
    await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } }));
  } catch (err) {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId })).catch(() => {});
    throw err;
  }
}

/** Upload the set's files (manifest last). Throws on any failure. */
async function uploadSet(files) {
  const cfg = getS3Config();
  if (!s3Configured()) {
    const e = new Error('Backup failed: BACKUP_DRIVER=s3 but BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY are not set (local copy kept)');
    e.status = 500;
    throw e;
  }
  const client = makeS3Client(cfg);
  const keys = [];
  try {
    for (const f of files) {
      const key = `${cfg.prefix}${path.basename(f)}`;
      await putFile(client, cfg.bucket, key, f, f.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      keys.push(key);
      console.log(`[BACKUP] Uploaded s3://${cfg.bucket}/${key}`);
    }
  } catch (err) {
    const e = new Error(`Backup failed: upload to s3://${cfg.bucket}/${cfg.prefix} failed: ${err.message} (local copy kept)`);
    e.status = 500;
    throw e;
  }
  return { bucket: cfg.bucket, key: keys[0], keys, endpoint: cfg.endpoint || null };
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
function heartbeatFailUrl() {
  if (process.env.BACKUP_HEARTBEAT_FAIL_URL) return process.env.BACKUP_HEARTBEAT_FAIL_URL;
  const ok = process.env.BACKUP_HEARTBEAT_URL;
  if (!ok) return null;
  try {
    const u = new URL(ok);
    if (u.hostname === 'hc-ping.com' || u.hostname.endsWith('.hc-ping.com')) {
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/fail`;
      return u.toString();
    }
  } catch { /* bad URL: reported by ping() */ }
  return null;
}

async function ping(url, { method = 'GET', body } = {}) {
  if (!url) return 'skipped';
  let host = '?';
  try { host = new URL(url).host; } catch { console.warn('[BACKUP] heartbeat URL is not a valid URL'); return 'failed'; }
  try {
    const res = await fetch(url, {
      method,
      body,
      headers: body ? { 'Content-Type': 'text/plain; charset=utf-8' } : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.warn(`[BACKUP] heartbeat ${method} ${host} → HTTP ${res.status}`); return 'failed'; }
    return 'ok';
  } catch (err) {
    console.warn(`[BACKUP] heartbeat ${method} ${host} failed: ${err.message}`);
    return 'failed';
  }
}

// ── Main entry ──────────────────────────────────────────────────────────────
async function runBackup() {
  try {
    const result = await runBackupInner();
    result.heartbeat = await ping(process.env.BACKUP_HEARTBEAT_URL);
    return result;
  } catch (err) {
    console.error(`[BACKUP] FAILED: ${err.message}`);
    const failUrl = heartbeatFailUrl();
    if (failUrl) await ping(failUrl, { method: 'POST', body: String(err.message).slice(0, 1000) });
    throw err;
  }
}

async function runBackupInner() {
  const dbUrl = process.env.DATABASE_URL || '';
  const isPostgres = /^postgres(ql)?:/.test(dbUrl);
  const driver = getBackupDriver();
  const dir = getBackupDir();
  const key = getEncryptionKey();

  await fs.promises.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (!isPostgres) {
    const destPath = backupSqlite(stamp, dbUrl, dir);
    const remote = driver === 's3' ? await uploadSet([destPath]) : null;
    pruneOldBackups(dir);
    return { driver, localPath: destPath, filename: path.basename(destPath), size: fs.statSync(destPath).size, encrypted: false, uploads: null, manifest: null, remote, wasabi: remote };
  }

  const created = [];
  try {
    const db = await backupPostgres(stamp, dbUrl, dir, key);
    created.push(db.file);
    const up = await backupUploads(stamp, dir, key);
    if (up) created.push(up.file);

    let rowCounts = null;
    try { rowCounts = await tableRowCounts(db.connectionString, db.schema); } catch (e) {
      console.warn(`[BACKUP] row counts unavailable: ${e.message}`);
    }
    const describe = async (f) => ({ file: path.basename(f), bytes: fs.statSync(f).size, sha256: await sha256File(f), encrypted: Boolean(key) });
    const manifest = {
      format: 'mbc-backup/1',
      createdAt: new Date().toISOString(),
      stamp,
      database: { ...(await describe(db.file)), name: parseDatabaseUrl(dbUrl).database, schema: db.schema },
      uploads: up ? { ...(await describe(up.file)), files: up.files } : null,
      rowCounts,
      pgDump: await versionOf(process.env.PG_DUMP_PATH || 'pg_dump'),
      encryption: key ? 'aes-256-gcm+scrypt' : null,
    };
    const manifestPath = path.join(dir, `backup_${stamp}.manifest.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    created.push(manifestPath);

    const remote = driver === 's3' ? await uploadSet(created) : null;
    pruneOldBackups(dir);

    return {
      driver,
      localPath: db.file,
      filename: path.basename(db.file),
      size: manifest.database.bytes,
      encrypted: Boolean(key),
      uploads: up ? { filename: path.basename(up.file), size: manifest.uploads.bytes, files: up.files } : null,
      manifest: path.basename(manifestPath),
      remote,
      wasabi: remote, // legacy field name (API contract)
    };
  } catch (err) {
    // A failed upload keeps the local set (still useful); anything earlier
    // removes the partial set so nothing half-made looks like a backup.
    if (!/local copy kept/.test(err.message)) for (const f of created) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    throw err;
  }
}

// ── Listing / pruning ───────────────────────────────────────────────────────
function backupKind(ext) {
  if (ext.startsWith('sql') || ext === 'db') return 'database';
  if (ext.startsWith('uploads')) return 'uploads';
  return 'manifest';
}

/** Backup files in the local backup directory, newest first. */
function listBackups(dir = getBackupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => ({ f, m: BACKUP_FILE_RE.exec(f) }))
    .filter(({ m }) => m)
    .map(({ f, m }) => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, created: stat.mtime, stamp: m[1], kind: backupKind(m[2]), encrypted: f.endsWith('.enc') };
    })
    .sort((a, b) => (b.stamp === a.stamp ? a.filename.localeCompare(b.filename) : b.stamp.localeCompare(a.stamp)));
}

/** Keep the BACKUP_KEEP newest sets; uploads archives only for BACKUP_KEEP_UPLOADS. */
function pruneOldBackups(dir = getBackupDir()) {
  const keep = Number(process.env.BACKUP_KEEP) || 30;
  const keepUploads = process.env.BACKUP_KEEP_UPLOADS != null && process.env.BACKUP_KEEP_UPLOADS !== ''
    ? Math.max(1, Number(process.env.BACKUP_KEEP_UPLOADS) || 1) : 3;
  try {
    const files = listBackups(dir);
    const stamps = [...new Set(files.map((b) => b.stamp))]; // newest first
    const drop = new Set(stamps.slice(keep));
    const dropUploads = new Set(stamps.slice(keepUploads));
    for (const b of files) {
      if (drop.has(b.stamp) || (b.kind === 'uploads' && dropUploads.has(b.stamp))) {
        fs.unlinkSync(path.join(dir, b.filename));
        console.log(`[BACKUP] Pruned: ${b.filename}`);
      }
    }
  } catch (err) {
    console.warn(`[BACKUP] Prune error: ${err.message}`);
  }
}

module.exports = {
  runBackup,
  listBackups,
  pruneOldBackups,
  getBackupDir,
  getBackupDriver,
  getS3Config,
  s3Configured,
  wasabiConfigured: s3Configured, // legacy name
  makeS3Client,
  getEncryptionKey,
  createEncryptStream,
  decryptFile,
  isEncryptedFile,
  sha256File,
  tableRowCounts,
  uploadsRoot,
  heartbeatFailUrl,
  BACKUP_FILE_RE,
};
