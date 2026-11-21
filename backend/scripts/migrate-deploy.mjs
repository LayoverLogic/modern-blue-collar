#!/usr/bin/env node
/**
 * scripts/migrate-deploy.mjs — `prisma migrate deploy` without a native binary.
 *
 *   npm run migrate:deploy          (also run by `npm start`, `npm run sandbox`
 *                                    and the Docker entrypoint)
 *   npm run migrate:deploy:native   (the stock CLI; needs binaries.prisma.sh)
 *
 * WHY: Prisma 7's client is Rust-free, but the Prisma 7.10 CLI still downloads
 * the native `schema-engine` binary from binaries.prisma.sh for `migrate`.
 * Where that host is blocked the stock `prisma migrate deploy` cannot run.
 *
 * HOW: this runs Prisma's own schema engine, compiled to WebAssembly
 * (@prisma/schema-engine-wasm, pinned to the exact engine commit that
 * prisma@7.10.1 ships with), through the same `pg` driver adapter the app uses.
 * It calls the engine's `applyMigrations` — the command behind
 * `prisma migrate deploy` — so the `_prisma_migrations` table, checksums,
 * ordering and failed-migration protection are Prisma's own, and a database
 * migrated here is fully compatible with the native CLI (and vice versa).
 *
 * When upgrading `prisma`, bump @prisma/schema-engine-wasm to the version in
 * node_modules/@prisma/engines-version/package.json ("enginesVersion" prefix
 * `8.1.0-1.` for 7.10.x). The script refuses to run on a mismatch.
 *
 * Options: --quiet  only print the summary line
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require   = createRequire(import.meta.url);
const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet     = process.argv.includes('--quiet');

require(path.join(backendDir, 'helpers', 'loadEnv.js'));
const { parseDatabaseUrl } = require(path.join(backendDir, 'helpers', 'databaseUrl.js'));

function log(...a) { if (!quiet) console.log('[migrate]', ...a); }

// ── Version guard: the WASM engine must match the CLI's engine commit ─────────
const bgPath = require.resolve('@prisma/schema-engine-wasm/schema_engine_bg');
const wasmPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(bgPath), 'package.json'), 'utf8'));
let cliEngineHash = '';
try {
  const enginesPkgPath = require.resolve('@prisma/engines-version/package.json', {
    paths: [path.dirname(require.resolve('prisma/package.json'))],
  });
  const enginesPkg = JSON.parse(fs.readFileSync(enginesPkgPath, 'utf8'));
  cliEngineHash = (enginesPkg.prisma && enginesPkg.prisma.enginesVersion) || '';
} catch { /* layout changed; skip the guard rather than block migrations */ }
if (cliEngineHash && !wasmPkg.version.endsWith(cliEngineHash)) {
  console.error(`[migrate] @prisma/schema-engine-wasm ${wasmPkg.version} does not match the Prisma CLI engine ${cliEngineHash}.`);
  console.error('[migrate] Pin @prisma/schema-engine-wasm to the matching version in backend/package.json.');
  process.exit(1);
}

// ── Load the WASM schema engine (ESM glue + .wasm, instantiated manually so no
//    --experimental-wasm-modules flag is needed) ───────────────────────────────
const bg     = await import(bgPath);
const wasmBytes = fs.readFileSync(path.join(path.dirname(bgPath), 'schema_engine_bg.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBytes, { './schema_engine_bg.js': bg });
bg.__wbg_set_wasm(instance.exports);
if (instance.exports.__wbindgen_start) instance.exports.__wbindgen_start();

// ── Driver adapter (same as the app) ──────────────────────────────────────────
const { PrismaPg } = require('@prisma/adapter-pg');
const { bindMigrationAwareSqlAdapterFactory } = require('@prisma/driver-adapter-utils');
const { connectionString, schema: dbSchema } = parseDatabaseUrl(process.env.DATABASE_URL);
const adapter = bindMigrationAwareSqlAdapterFactory(
  new PrismaPg({ connectionString }, dbSchema !== 'public' ? { schema: dbSchema } : undefined),
);

// ── Read schema + migrations from disk ────────────────────────────────────────
const schemaPath = path.join(backendDir, 'prisma', 'schema.prisma');
const schemaText = fs.readFileSync(schemaPath, 'utf8');
const baseDir    = path.join(backendDir, 'prisma', 'migrations');
const lockPath   = path.join(baseDir, 'migration_lock.toml');
const migrationDirectories = fs.readdirSync(baseDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .map((name) => {
    const file = path.join(baseDir, name, 'migration.sql');
    let content;
    try { content = { tag: 'ok', value: fs.readFileSync(file, 'utf8') }; }
    catch (e) { content = { tag: 'error', value: e.message }; }
    return { path: name, migrationFile: { path: 'migration.sql', content } };
  });

const migrationsList = {
  baseDir,
  lockfile: {
    path: 'migration_lock.toml',
    content: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
  },
  shadowDbInitScript: '',
  migrationDirectories,
};

// Engine log lines are JSON; surface only the useful ones.
function onEngineLog(line) {
  try {
    const msg = JSON.parse(line);
    const text = msg.fields && msg.fields.message;
    if (msg.level === 'ERROR' || msg.level === 'WARN') console.error('[migrate:engine]', text || line);
    else if (text && /^Applying/.test(text)) log(text);
  } catch { if (process.env.DEBUG) console.error(line); }
}

let engine;
try {
  engine = await bg.SchemaEngine.new(
    { datamodels: [[path.relative(backendDir, schemaPath), schemaText]] },
    onEngineLog,
    adapter,
  );
  log(`${migrationDirectories.length} migration(s) found in prisma/migrations (database "${parseDatabaseUrl(process.env.DATABASE_URL).database}", schema "${dbSchema}")`);
  const out = await engine.applyMigrations({
    migrationsList,
    filters: { externalTables: [], externalEnums: [] },
  });
  const applied = out.appliedMigrationNames || [];
  console.log(applied.length
    ? `[migrate] Applied ${applied.length} migration(s): ${applied.join(', ')}`
    : '[migrate] No pending migrations to apply.');
  process.exit(0);
} catch (err) {
  const firstLine = String(err && err.message || err).split('\n')[0];
  console.error(`[migrate] migrate deploy FAILED: ${firstLine}`);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
}
