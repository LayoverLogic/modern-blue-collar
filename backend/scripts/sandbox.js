#!/usr/bin/env node
/**
 * scripts/sandbox.js — one command for the zero-paid-services local sandbox.
 *
 *   cd backend && npm install && npm run sandbox
 *
 * Steps:
 *   1. Use backend/.env.sandbox (copied from .env.sandbox.example on first run).
 *      Real environment variables override it; ENV_FILE=<file> picks another file.
 *   2. Create the database named in DATABASE_URL if it does not exist.
 *   3. Apply migrations (scripts/migrate-deploy.mjs — WASM schema engine).
 *   4. If DEMO_MODE=true, seed demo data (idempotent) for DEMO_PROSPECT
 *      (backend/demo/prospects/<slug>.json, default "default" = generic Anytown).
 *      Per-prospect env files: node scripts/seed-demo.js --prospect <slug> --print-env
 *   5. Start the server (skip with --no-start, i.e. `npm run sandbox:setup`).
 *
 * Needs a reachable PostgreSQL; no Docker, no S3, no SMTP, no internet.
 */
const fs   = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const backendDir = path.join(__dirname, '..');
const noStart = process.argv.includes('--no-start');

function step(msg) { console.log(`\n[sandbox] ${msg}`); }
function fail(msg) { console.error(`\n[sandbox] ERROR: ${msg}`); process.exit(1); }

// ── 0. Node version (Prisma 7 needs ^20.19 || ^22.12 || >=24) ────────────────
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 20 || (maj === 20 && min < 19) || (maj === 22 && min < 12) || maj === 21 || maj === 23) {
  fail(`Node ${process.versions.node} is too old for Prisma 7 — use Node 20.19+, 22.12+ or 24+.`);
}

// ── 1. Environment file ─────────────────────────────────────────────────────
if (!process.env.ENV_FILE) {
  const envFile = path.join(backendDir, '.env.sandbox');
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(path.join(backendDir, '.env.sandbox.example'), envFile);
    console.log('[sandbox] Created backend/.env.sandbox from .env.sandbox.example');
  }
  fillGeneratedSecrets(envFile);
  process.env.ENV_FILE = '.env.sandbox';
}

// Replace placeholder / previously-published secrets in the local env file with
// fresh random values (the example file never carries a usable secret).
function fillGeneratedSecrets(file) {
  const { PUBLISHED_SECRETS } = require('../helpers/publishedSecrets');
  const text = fs.readFileSync(file, 'utf8');
  let changed = false;
  const out = text.replace(/^JWT_SECRET=(.*)$/m, (line, value) => {
    const v = value.trim().replace(/^["']|["']$/g, '');
    if (v && !PUBLISHED_SECRETS.has(v.toLowerCase())) return line;
    changed = true;
    return `JWT_SECRET=${require('crypto').randomBytes(48).toString('hex')}`;
  });
  if (changed) {
    fs.writeFileSync(file, out);
    console.log(`[sandbox] Generated a random JWT_SECRET in ${path.relative(backendDir, file)}`);
  }
}
require('../helpers/loadEnv');
const { parseDatabaseUrl } = require('../helpers/databaseUrl');
console.log(`[sandbox] env file: ${process.env.MBC_ENV_FILE || '(none — process env only)'}`);

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.');
if (!process.env.JWT_SECRET)   fail('JWT_SECRET is not set.');

function runNode(args, label) {
  const r = spawnSync(process.execPath, args, { cwd: backendDir, env: process.env, stdio: 'inherit' });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status}).`);
}

async function ensureDatabase() {
  const { Client } = require('pg');
  const { connectionString, database } = parseDatabaseUrl(process.env.DATABASE_URL);
  if (!database) fail('DATABASE_URL has no database name.');

  const adminUrl = new URL(connectionString);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
  } catch (e) {
    fail(`Cannot connect to PostgreSQL at ${adminUrl.host}: ${e.message}`);
  }
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (rowCount) {
      console.log(`[sandbox] Database "${database}" exists.`);
    } else {
      await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`[sandbox] Created database "${database}".`);
    }
  } catch (e) {
    fail(`Could not create database "${database}": ${e.message} (create it manually or grant CREATEDB)`);
  } finally {
    await client.end().catch(() => {});
  }
}

(async () => {
  // Prisma client must be generated (postinstall normally does this).
  if (!fs.existsSync(path.join(backendDir, 'node_modules', '.prisma', 'client', 'index.js'))) {
    step('Generating Prisma client...');
    runNode([path.join(__dirname, 'prisma-generate.js')], 'prisma generate');
  }

  step('Ensuring database exists...');
  await ensureDatabase();

  step('Applying migrations...');
  runNode([path.join(__dirname, 'migrate-deploy.mjs')], 'migrate deploy');

  if (process.env.DEMO_MODE === 'true') {
    step(`DEMO_MODE=true → seeding demo data (idempotent), prospect "${process.env.DEMO_PROSPECT || 'default'}"...`);
    for (const seed of ['seed_superadmin.js', 'seed_pricebook.js', 'seed_jobs.js']) {
      runNode([path.join(backendDir, seed)], seed);
    }
  }

  if (noStart) {
    step('Setup complete (--no-start).');
    return;
  }

  step(`Starting server on port ${process.env.PORT || 3001}...`);
  const child = spawn(process.execPath, [path.join(backendDir, 'server.js')], {
    cwd: backendDir, env: process.env, stdio: 'inherit',
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 0 : 1) : code));
})().catch((e) => fail(e.stack || e.message));
