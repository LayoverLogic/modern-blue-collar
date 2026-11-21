/**
 * backup.js
 * Database backup utility for PostgreSQL (and legacy SQLite local dev).
 * Called automatically by node-cron at 03:00 (brand.timezone)
 * and manually via POST /api/backup/run.
 *
 * Every backup is first written to the local backup directory:
 *   BACKUP_DIR   default backend/backups/ (gitignored, dockerignored)
 *
 * BACKUP_DRIVER selects where it goes next:
 *   local   keep it on local disk only (sandbox; no network).
 *   s3      also upload to an S3-compatible bucket — Wasabi in production,
 *           MinIO in the Docker demo (WASABI_* vars). Alias: `wasabi`.
 *   (unset) `s3` when WASABI_BUCKET + keys are set, otherwise `local`
 *           — i.e. the previous behaviour.
 *
 * PostgreSQL backups use `pg_dump` (must be on PATH: the Docker image installs
 * postgresql-client; on a Mac `brew install libpq`). The dump is gzipped in
 * Node (no `gzip` binary needed). If pg_dump is missing or fails the backup
 * FAILS loudly — it no longer reports success with a marker file.
 * Keeps the MAX_BACKUPS most recent local backups.
 */

const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseDatabaseUrl } = require('./helpers/databaseUrl');

const execFileAsync = promisify(execFile);
const MAX_BACKUPS = Number(process.env.BACKUP_KEEP) || 30;
const BACKUP_FILE_RE = /^backup_[0-9A-Za-z_-]+\.(sql\.gz|sql|db)$/;

function getBackupDir() {
  return path.resolve(process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
}

function wasabiConfigured() {
  return Boolean(process.env.WASABI_BUCKET && process.env.WASABI_ACCESS_KEY && process.env.WASABI_SECRET_KEY);
}

function getBackupDriver() {
  const d = (process.env.BACKUP_DRIVER || '').trim().toLowerCase();
  if (!d) return wasabiConfigured() ? 's3' : 'local';
  if (d === 'wasabi') return 's3';
  if (d !== 's3' && d !== 'local') throw new Error(`Unknown BACKUP_DRIVER "${d}" (expected local | s3)`);
  return d;
}

async function runBackup() {
  const dbUrl = process.env.DATABASE_URL || '';
  const isPostgres = /^postgres(ql)?:/.test(dbUrl);
  const driver = getBackupDriver();
  const dir = getBackupDir();

  await fs.promises.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const destPath = isPostgres
    ? await backupPostgres(stamp, dbUrl, dir)
    : backupSqlite(stamp, dbUrl, dir);

  let remote = null;
  if (driver === 's3') remote = await uploadToWasabi(destPath, path.basename(destPath));

  pruneOldBackups(dir);

  const size = fs.statSync(destPath).size;
  return { driver, localPath: destPath, filename: path.basename(destPath), size, wasabi: remote };
}

/**
 * PostgreSQL backup via pg_dump → gzip. Arguments are passed without a shell,
 * and Prisma-only URL params (`?schema=`) are stripped because libpq rejects them.
 */
async function backupPostgres(stamp, dbUrl, dir) {
  const { connectionString, schema } = parseDatabaseUrl(dbUrl);
  const sqlPath = path.join(dir, `backup_${stamp}.sql`);
  const gzPath  = `${sqlPath}.gz`;
  const args = [connectionString, '--no-owner', '--no-acl', '--file', sqlPath];
  if (schema && schema !== 'public') args.push('--schema', schema);

  try {
    await execFileAsync(process.env.PG_DUMP_PATH || 'pg_dump', args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    try { fs.unlinkSync(sqlPath); } catch { /* nothing written */ }
    const why = err.code === 'ENOENT'
      ? 'pg_dump is not installed / not on PATH (install postgresql-client, or set PG_DUMP_PATH)'
      : (err.stderr || err.message || '').toString().trim().split('\n')[0];
    const e = new Error(`Backup failed: ${why}`);
    e.status = 500;
    throw e;
  }

  await pipeline(fs.createReadStream(sqlPath), zlib.createGzip(), fs.createWriteStream(gzPath));
  fs.unlinkSync(sqlPath);
  console.log(`[BACKUP] PostgreSQL dump saved: ${gzPath}`);
  return gzPath;
}

/**
 * SQLite backup via file copy (legacy local development only).
 */
function backupSqlite(stamp, dbUrl, dir) {
  const DB_PATH = path.join(__dirname, 'prisma', 'dev.db');
  const dbPath = dbUrl
    ? dbUrl.replace('file:', '').replace('./', path.join(__dirname, 'prisma/'))
    : DB_PATH;

  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite database file not found: ${dbPath}`);
  }

  const destPath = path.join(dir, `backup_${stamp}.db`);
  fs.copyFileSync(dbPath, destPath);
  console.log(`[BACKUP] SQLite saved: ${destPath}`);
  return destPath;
}

/**
 * Upload backup file to Wasabi / any S3-compatible bucket (MinIO in the demo).
 */
async function uploadToWasabi(filePath, filename) {
  if (!wasabiConfigured()) {
    console.log('[BACKUP] BACKUP_DRIVER=s3 but WASABI_BUCKET/ACCESS_KEY/SECRET_KEY are not set — skipping upload.');
    return { error: 'Wasabi/S3 backup target not configured' };
  }
  const bucket    = process.env.WASABI_BUCKET;

  try {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

    const region   = process.env.WASABI_REGION   || 'us-east-1';
    const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;

    const client = new S3Client({
      region,
      endpoint,
      credentials: {
        accessKeyId:     process.env.WASABI_ACCESS_KEY,
        secretAccessKey: process.env.WASABI_SECRET_KEY,
      },
      forcePathStyle: true,
    });

    const key = `backups/${filename}`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key:    key,
      Body:   fs.createReadStream(filePath),
      ContentLength: fs.statSync(filePath).size,
      ContentType: 'application/octet-stream',
    }));
    console.log(`[BACKUP] Wasabi uploaded: s3://${bucket}/${key}`);
    return { bucket, key, endpoint };
  } catch (err) {
    console.error(`[BACKUP] Wasabi upload failed: ${err.message}`);
    return { error: err.message };
  }
}

/** Backups in the local backup directory, newest first. */
function listBackups(dir = getBackupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => BACKUP_FILE_RE.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { filename: f, size: stat.size, created: stat.mtime };
    })
    .sort((a, b) => b.created - a.created);
}

/**
 * Remove old backups, keep only MAX_BACKUPS most recent.
 */
function pruneOldBackups(dir = getBackupDir()) {
  try {
    for (const { filename } of listBackups(dir).slice(MAX_BACKUPS)) {
      fs.unlinkSync(path.join(dir, filename));
      console.log(`[BACKUP] Pruned: ${filename}`);
    }
  } catch (err) {
    console.warn(`[BACKUP] Prune error: ${err.message}`);
  }
}

module.exports = { runBackup, listBackups, getBackupDir, getBackupDriver, wasabiConfigured };
