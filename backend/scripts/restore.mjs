#!/usr/bin/env node
/**
 * scripts/restore.mjs — restore an MBC backup set into a named database.
 *
 * Setup / run (from backend/, or inside the app container: `docker compose exec app ...`):
 *   1. Make sure `psql` and `tar` are on PATH (the Docker image has both; on a
 *      Mac: `brew install libpq && brew link --force libpq`). PSQL_PATH / TAR_PATH
 *      override the binaries.
 *   2. DATABASE_URL must point at the Postgres SERVER to restore into (the
 *      database name in it is replaced by --database). Or pass --target-url.
 *   3. For encrypted sets (*.enc), set BACKUP_ENCRYPTION_KEY or pass
 *      --key-file <file containing the key>.
 *   4. For a backup in the bucket, the BACKUP_S3_* (or legacy WASABI_*) vars
 *      must be set, exactly as for backups.
 *   5. See what is available:
 *        npm run restore -- --list              local sets in BACKUP_DIR
 *        npm run restore -- --list --remote     sets in the backup bucket
 *   6. Restore (drill: always into a scratch database first):
 *        npm run restore -- latest --database restore_drill
 *        npm run restore -- backups/backup_2026-11-21T03-00-00.sql.gz.enc --database restore_drill   (local file)
 *        npm run restore -- s3:backups/backup_2026-11-21T03-00-00.sql.gz.enc --database restore_drill (bucket key)
 *        npm run restore -- latest-remote --database restore_drill
 *   7. Read the per-table row counts it prints (compared with the manifest).
 *   8. Drop the scratch DB afterwards: `dropdb restore_drill` (or psql DROP DATABASE).
 *
 * Arguments:
 *   <backup>              a local backup_*.sql.gz[.enc] / .manifest.json path,
 *                         `s3:<key>` (or --s3-key <key>), `latest`, `latest-remote`
 *   --database <name>     target database on the DATABASE_URL server (created if missing)
 *   --target-url <url>    full target connection URL instead of --database
 *   --force               allow restoring over a NON-EMPTY database (its schema is
 *                         dropped and recreated first) and into a non-empty uploads dir
 *   --uploads-dir <dir>   where to restore photos (default: LOCAL_STORAGE_DIR when
 *                         STORAGE_DRIVER=local; otherwise uploads are skipped)
 *   --no-uploads          restore the database only
 *   --key-file <file>     read the encryption key from a file
 *   --json                print the final summary as JSON (row counts included)
 *
 * Safety: every check (download, sha256 against the manifest, decryption tag,
 * target emptiness) happens before anything is written. Exit codes: 0 ok,
 * 1 error, 2 refused (non-empty target without --force).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
require(path.join(backendDir, 'helpers', 'loadEnv.js'));
const backup = require(path.join(backendDir, 'backup.js'));
const { parseDatabaseUrl } = require(path.join(backendDir, 'helpers', 'databaseUrl.js'));
const { Client } = require('pg');

class Refused extends Error {}

// ── Args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { _: [] };
  const takes = new Set(['--database', '--target-url', '--uploads-dir', '--key-file', '--s3-key']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (takes.has(a)) { o[a.slice(2)] = argv[i + 1]; i += 1; } else if (a.startsWith('--')) o[a.slice(2)] = true;
    else o._.push(a);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const log = (...a) => { if (!args.json) console.log('[restore]', ...a); };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc-restore-'));
process.on('exit', () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── Backup set resolution ───────────────────────────────────────────────────
const SET_RE = /^backup_([0-9A-Za-z_-]+)\.(sql\.gz\.enc|sql\.gz|uploads\.tar\.gz\.enc|uploads\.tar\.gz|manifest\.json)$/;

function groupSets(names) {
  const sets = new Map();
  for (const n of names) {
    const m = SET_RE.exec(path.basename(n));
    if (!m) continue;
    const s = sets.get(m[1]) || { stamp: m[1] };
    if (m[2].startsWith('sql')) s.database = n; else if (m[2].startsWith('uploads')) s.uploads = n; else s.manifest = n;
    sets.set(m[1], s);
  }
  return [...sets.values()].filter((s) => s.database).sort((a, b) => b.stamp.localeCompare(a.stamp));
}

async function listRemote() {
  if (!backup.s3Configured()) throw new Error('No backup bucket configured (BACKUP_S3_BUCKET / _ACCESS_KEY / _SECRET_KEY)');
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const cfg = backup.getS3Config();
  const client = backup.makeS3Client(cfg);
  const keys = [];
  let ContinuationToken;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: cfg.prefix, ContinuationToken }));
    for (const o of r.Contents || []) keys.push(o.Key);
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return groupSets(keys);
}

async function download(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cfg = backup.getS3Config();
  const client = backup.makeS3Client(cfg);
  const dest = path.join(tmpDir, path.basename(key));
  const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  await pipeline(r.Body, fs.createWriteStream(dest, { mode: 0o600 }));
  return dest;
}

async function remoteExists(key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  const cfg = backup.getS3Config();
  try { await backup.makeS3Client(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key })); return true; } catch { return false; }
}

/** → { stamp, database, uploads?, manifest? } as LOCAL file paths. */
async function resolveSet(spec) {
  if (spec === 'latest') {
    const set = groupSets(fs.existsSync(backup.getBackupDir()) ? fs.readdirSync(backup.getBackupDir()).map((f) => path.join(backup.getBackupDir(), f)) : [])[0];
    if (!set) throw new Error(`No backups found in ${backup.getBackupDir()}`);
    return set;
  }
  let remoteKey = args['s3-key'] || null;
  if (!remoteKey && spec === 'latest-remote') {
    const set = (await listRemote())[0];
    if (!set) throw new Error('No backups found in the bucket');
    remoteKey = set.database;
  }
  if (!remoteKey && /^s3:/.test(spec)) remoteKey = spec.replace(/^s3:(\/\/[^/]+\/)?/, '');
  if (remoteKey) {
    const m = SET_RE.exec(path.basename(remoteKey));
    if (!m) throw new Error(`Not a backup file name: ${remoteKey}`);
    const dirKey = remoteKey.slice(0, remoteKey.length - path.basename(remoteKey).length);
    const base = `${dirKey}backup_${m[1]}`;
    const set = { stamp: m[1] };
    log(`downloading set ${m[1]} from s3://${backup.getS3Config().bucket}/${dirKey}`);
    if (await remoteExists(`${base}.manifest.json`)) set.manifest = await download(`${base}.manifest.json`);
    const manifest = set.manifest ? JSON.parse(fs.readFileSync(set.manifest, 'utf8')) : null;
    const dbName = manifest ? manifest.database.file : (m[2].startsWith('sql') ? path.basename(remoteKey) : null);
    if (!dbName) throw new Error('Cannot find the database dump for this set (no manifest)');
    set.database = await download(`${dirKey}${dbName}`);
    const upName = manifest && manifest.uploads ? manifest.uploads.file : null;
    if (upName) set.uploads = await download(`${dirKey}${upName}`);
    else if (!manifest) {
      for (const ext of ['uploads.tar.gz.enc', 'uploads.tar.gz']) {
        if (await remoteExists(`${base}.${ext}`)) { set.uploads = await download(`${base}.${ext}`); break; }
      }
    }
    return set;
  }
  // Local path
  const file = path.resolve(spec);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const m = SET_RE.exec(path.basename(file));
  if (!m) throw new Error(`Not a backup file name (expected backup_<stamp>.sql.gz[.enc] or .manifest.json): ${file}`);
  const dir = path.dirname(file);
  const set = groupSets(fs.readdirSync(dir).map((f) => path.join(dir, f))).find((s) => s.stamp === m[1]);
  if (!set) throw new Error(`No database dump found next to ${file}`);
  return set;
}

// ── Integrity + decryption ──────────────────────────────────────────────────
async function verify(set, manifest) {
  if (!manifest) { log('no manifest for this set — sha256 not verified'); return; }
  for (const [part, file] of [['database', set.database], ['uploads', set.uploads]]) {
    if (!file || !manifest[part]) continue;
    const got = await backup.sha256File(file);
    if (got !== manifest[part].sha256) throw new Error(`${path.basename(file)}: sha256 does not match the manifest (corrupt or modified)`);
  }
  log('sha256 verified against the manifest');
}

function encryptionKey() {
  if (args['key-file']) return fs.readFileSync(path.resolve(args['key-file']), 'utf8').trim();
  return backup.getEncryptionKey();
}

async function plaintext(file) {
  if (!file || !(await backup.isEncryptedFile(file))) return file;
  const out = path.join(tmpDir, `${path.basename(file).replace(/\.enc$/, '')}`);
  await backup.decryptFile(file, out, encryptionKey());
  log(`decrypted ${path.basename(file)} (authentication tag OK)`);
  return out;
}

// ── Target database ─────────────────────────────────────────────────────────
function targetUrl() {
  if (args['target-url']) return parseDatabaseUrl(args['target-url']);
  if (!args.database) throw new Error('Pass --database <name> (or --target-url <url>)');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(args.database)) throw new Error(`Invalid database name: ${args.database}`);
  const { url } = parseDatabaseUrl(process.env.DATABASE_URL);
  url.pathname = `/${args.database}`;
  return parseDatabaseUrl(url.toString());
}

const qi = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function ensureDatabase(target) {
  const admin = new URL(target.connectionString);
  admin.pathname = '/postgres';
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [target.database]);
    if (!r.rowCount) { await c.query(`CREATE DATABASE ${qi(target.database)}`); log(`created database ${target.database}`); return true; }
    return false;
  } finally { await c.end().catch(() => {}); }
}

async function userTableCount(target) {
  const c = new Client({ connectionString: target.connectionString });
  await c.connect();
  try {
    const r = await c.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_toast%'");
    return r.rows[0].n;
  } finally { await c.end().catch(() => {}); }
}

async function resetSchema(target, schema) {
  const c = new Client({ connectionString: target.connectionString });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
    // A plain pg_dump of `public` assumes the schema exists; others are created by the dump.
    if (schema === 'public') await c.query('CREATE SCHEMA public');
  } finally { await c.end().catch(() => {}); }
}

function run(cmd, cmdArgs, { input, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 16384) stderr += d.toString(); });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${label} is not installed / not on PATH` : e.message)));
    child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`${label} failed (exit ${code}): ${stderr.trim().split('\n').slice(0, 5).join(' | ')}`))));
    pipeline(input, child.stdin).catch(() => { /* surfaced via exit code */ });
  });
}

async function restoreDatabase(dumpGz, target) {
  const psqlArgs = [target.connectionString, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction'];
  await run(process.env.PSQL_PATH || 'psql', psqlArgs, { input: fs.createReadStream(dumpGz).pipe(zlib.createGunzip()), label: 'psql' });
}

// ── Uploads ─────────────────────────────────────────────────────────────────
function uploadsTarget() {
  if (args['no-uploads']) return null;
  if (args['uploads-dir']) return path.resolve(args['uploads-dir']);
  try { return backup.uploadsRoot(); } catch { return null; }
}

function dirNonEmpty(d) { return fs.existsSync(d) && fs.readdirSync(d).length > 0; }

function tarList(tarGz, flags) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.TAR_PATH || 'tar', [flags, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'tar is not installed / not on PATH' : e.message)));
    child.on('close', (code) => (code === 0 ? resolve(out.split('\n').filter(Boolean)) : reject(new Error(`tar ${flags} failed: ${err.trim()}`))));
    pipeline(fs.createReadStream(tarGz), zlib.createGunzip(), child.stdin).catch(() => {});
  });
}

/** Refuse archives with absolute paths, `..`, or links (backup.js never creates those). */
async function checkArchive(tarGz) {
  const names = await tarList(tarGz, '-tf');   // one name per line (GNU tar and bsdtar)
  const long = await tarList(tarGz, '-tvf');   // same order; first char = entry type
  if (names.length !== long.length) throw new Error('Uploads archive listing is inconsistent, refusing');
  let files = 0;
  names.forEach((name, i) => {
    const type = long[i][0];
    if (type !== '-' && type !== 'd') throw new Error(`Uploads archive contains a link or special file, refusing: ${name}`);
    if (name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name)) throw new Error(`Uploads archive contains an unsafe path, refusing: ${name}`);
    if (type === '-') files += 1;
  });
  return files;
}

async function restoreUploads(tarGz, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await run(process.env.TAR_PATH || 'tar', ['-xf', '-', '-C', dir, '--no-same-owner'], {
    input: fs.createReadStream(tarGz).pipe(zlib.createGunzip()), label: 'tar',
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (args.list) {
    const sets = args.remote
      ? await listRemote()
      : groupSets(fs.existsSync(backup.getBackupDir()) ? fs.readdirSync(backup.getBackupDir()) : []);
    if (args.json) { console.log(JSON.stringify(sets, null, 2)); return; }
    if (!sets.length) { console.log('No backup sets found.'); return; }
    for (const s of sets) console.log(`${s.stamp}  ${s.database}${s.uploads ? `  + ${path.basename(s.uploads)}` : ''}${s.manifest ? '' : '  (no manifest)'}`);
    return;
  }

  const spec = args._[0] || (args['s3-key'] ? 's3' : null);
  if (!spec) throw new Error('Usage: restore.mjs <backup|latest|latest-remote|s3:<key>> --database <name> [--force] (see the header of this script)');

  // 1. Fetch + verify + decrypt (nothing written to the target yet)
  const set = await resolveSet(spec);
  log(`backup set ${set.stamp}: ${path.basename(set.database)}${set.uploads ? ` + ${path.basename(set.uploads)}` : ''}`);
  const manifest = set.manifest ? JSON.parse(fs.readFileSync(set.manifest, 'utf8')) : null;
  await verify(set, manifest);
  const dumpGz = await plaintext(set.database);
  const schema = (manifest && manifest.database && manifest.database.schema) || 'public';

  const upDir = set.uploads ? uploadsTarget() : null;
  let uploadsTarGz = null;
  let uploadFiles = 0;
  if (set.uploads && !upDir) log('this set includes an uploads archive, but no target dir (set --uploads-dir, or STORAGE_DRIVER=local) — skipping uploads');
  if (set.uploads && upDir) {
    uploadsTarGz = await plaintext(set.uploads);
    uploadFiles = await checkArchive(uploadsTarGz);
  }

  // 2. Target checks
  const target = targetUrl();
  const live = process.env.DATABASE_URL ? parseDatabaseUrl(process.env.DATABASE_URL) : null;
  const isLive = live && new URL(live.connectionString).host === new URL(target.connectionString).host && live.database === target.database;
  await ensureDatabase(target);
  const tables = await userTableCount(target);
  if (tables > 0 && !args.force) {
    throw new Refused(`Database "${target.database}" is not empty (${tables} table(s)). Refusing to overwrite it; re-run with --force to DROP schema "${schema}" and restore over it.`);
  }
  if (uploadsTarGz && dirNonEmpty(upDir) && !args.force) {
    throw new Refused(`Uploads directory ${upDir} is not empty. Refusing; re-run with --force to extract over it (existing files with the same names are replaced), or use --uploads-dir / --no-uploads.`);
  }
  if (isLive) log(`WARNING: "${target.database}" is the database in DATABASE_URL (the live app database).`);

  // 3. Restore
  const t0 = Date.now();
  if (tables > 0) { log(`--force: dropping schema "${schema}" in ${target.database}`); await resetSchema(target, schema); }
  log(`restoring database into ${target.database} ...`);
  await restoreDatabase(dumpGz, target);
  if (uploadsTarGz) {
    log(`restoring ${uploadFiles} upload file(s) into ${upDir} ...`);
    await restoreUploads(uploadsTarGz, upDir);
  }

  // 4. Report
  const counts = await backup.tableRowCounts(target.connectionString, schema);
  const expected = (manifest && manifest.rowCounts) || null;
  const rows = Object.keys({ ...counts, ...(expected || {}) }).sort().map((t) => ({
    table: t, restored: counts[t] ?? null, manifest: expected ? (expected[t] ?? null) : undefined,
  }));
  const mismatches = expected ? rows.filter((r) => r.restored !== r.manifest) : [];
  const summary = {
    ok: true, stamp: set.stamp, database: target.database, schema, seconds: Math.round((Date.now() - t0) / 100) / 10,
    uploads: uploadsTarGz ? { dir: upDir, files: uploadFiles } : null, rowCounts: counts, manifestMismatches: mismatches.map((r) => r.table),
  };
  if (args.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  const w = Math.max(5, ...rows.map((r) => r.table.length));
  console.log(`\n${'table'.padEnd(w)}  ${'rows'.padStart(8)}${expected ? `  ${'manifest'.padStart(8)}` : ''}`);
  for (const r of rows) {
    const flag = expected && r.restored !== r.manifest ? '  <- differs' : '';
    console.log(`${r.table.padEnd(w)}  ${String(r.restored ?? '-').padStart(8)}${expected ? `  ${String(r.manifest ?? '-').padStart(8)}` : ''}${flag}`);
  }
  console.log(`\nRestored set ${set.stamp} into "${target.database}" in ${summary.seconds}s${uploadsTarGz ? `, ${uploadFiles} upload file(s) into ${upDir}` : ''}.`);
  if (mismatches.length) console.log('Note: row counts that differ from the manifest are expected only if the database was being written to during the backup.');
}

main().catch((err) => {
  if (args.json) console.log(JSON.stringify({ ok: false, refused: err instanceof Refused, error: err.message }));
  console.error(`[restore] ${err instanceof Refused ? 'REFUSED' : 'ERROR'}: ${err.message}`);
  process.exit(err instanceof Refused ? 2 : 1);
});
