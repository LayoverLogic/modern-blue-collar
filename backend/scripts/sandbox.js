#!/usr/bin/env node
/**
 * scripts/sandbox.js — one command for the zero-paid-services local sandbox.
 *
 * How to run:
 *   1. cd backend && npm install
 *   2. npm run sandbox                      (backend/.env.sandbox, created on first run)
 *      or, for a demo prospect:
 *        node scripts/seed-demo.js --prospect ks-plumbing-example --print-env
 *        ENV_FILE=.env.demo.ks-plumbing-example npm run sandbox
 *   3. Open http://localhost:<PORT> (the server listens on 127.0.0.1 only;
 *      HOST=0.0.0.0 npm run sandbox to reach it from other machines — only on a
 *      network you trust: demo mode advertises the demo login).
 *
 * Steps:
 *   1. Use backend/.env.sandbox (copied from .env.sandbox.example on first run).
 *      Real environment variables override it; ENV_FILE=<file> picks another file.
 *      Whichever file is in use: a JWT_SECRET that is empty, a placeholder
 *      (__GENERATE_ON_FIRST_RUN__) or a value published in this repo is
 *      replaced IN THAT FILE by a fresh random secret (so sessions survive
 *      restarts and nobody can forge tokens with a public value). A known value
 *      set in the real process environment is refused.
 *      The env file is kept private (mode 0600, L8): created that way, and an
 *      existing one that group / others can read is tightened.
 *      APP_URL (links in emails) follows PORT (D1): unless APP_URL is set in the
 *      shell, a localhost APP_URL whose port differs from PORT (or none at all)
 *      becomes http://localhost:<PORT>. A non-local APP_URL (a tunnel) is kept.
 *   2. Create the database named in DATABASE_URL if it does not exist.
 *   3. Apply migrations (scripts/migrate-deploy.mjs — WASM schema engine).
 *   4. If DEMO_MODE=true, seed demo data (idempotent) for DEMO_PROSPECT: a slug
 *      (backend/demo/prospects/<slug>.json, default "default" = generic
 *      Anytown) or an ABSOLUTE path to a prospect .json kept outside the repo
 *      (real prospect data never goes in the public repo; a path inside the
 *      repo is refused — helpers/prospectPath.js).
 *   5. Start the server on HOST (default 127.0.0.1) : PORT
 *      (skip with --no-start, i.e. `npm run sandbox:setup`).
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

// ── 1. Environment file + JWT secret ────────────────────────────────────────
const { isKnownSecret } = require('../helpers/publishedSecrets'); // no side effects (env not loaded yet)
const realEnvSecret = process.env.JWT_SECRET; // set by the real environment (wins over the file)
if (realEnvSecret !== undefined && (realEnvSecret.trim() === '' || isKnownSecret(realEnvSecret))) {
  fail('JWT_SECRET in your shell environment is empty or a published / placeholder value. Unset it (the sandbox generates one in its env file) or set a random one:\n  export JWT_SECRET=$(node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))")');
}
const realEnvAppUrl = process.env.APP_URL; // set in the shell → never rewritten (D1)

/** chmod 0600 when group / others may read the file (it holds JWT_SECRET) — L8. */
function keepPrivate(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || (st.mode & 0o077) === 0) return;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return; // not ours to change
    fs.chmodSync(file, 0o600);
    console.log(`[sandbox] ${path.relative(backendDir, file) || file} holds secrets — made it private (mode 0600)`);
  } catch (e) {
    console.warn(`[sandbox] could not restrict ${file}: ${e.message}`);
  }
}

let envFile;
if (process.env.ENV_FILE) {
  envFile = path.resolve(backendDir, process.env.ENV_FILE);
  if (!fs.existsSync(envFile)) fail(`ENV_FILE=${process.env.ENV_FILE} does not exist (${envFile}).`);
} else {
  envFile = path.join(backendDir, '.env.sandbox');
  if (!fs.existsSync(envFile)) {
    // created 0600 from the start: it gets a JWT_SECRET right below (L8)
    fs.writeFileSync(envFile, fs.readFileSync(path.join(backendDir, '.env.sandbox.example')), { mode: 0o600, flag: 'wx' });
    console.log('[sandbox] Created backend/.env.sandbox from .env.sandbox.example (mode 0600)');
  }
  process.env.ENV_FILE = '.env.sandbox';
}
if (realEnvSecret === undefined && fs.statSync(envFile).isFile()) fillGeneratedSecrets(envFile);
keepPrivate(envFile);

/**
 * Make the env file carry a usable JWT_SECRET: an empty, placeholder or
 * published value (or no JWT_SECRET line at all) becomes a fresh random secret,
 * written back to the same file. A real secret is left alone.
 */
function fillGeneratedSecrets(file) {
  const text = fs.readFileSync(file, 'utf8');
  const fresh = () => `JWT_SECRET=${require('crypto').randomBytes(48).toString('hex')}`;
  let changed = false;
  let seen = false;
  let out = text.replace(/^[ \t]*(?:export[ \t]+)?JWT_SECRET[ \t]*=(.*)$/gm, (line, value) => {
    seen = true;
    const v = value.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (v && !isKnownSecret(v)) return line;
    changed = true;
    return fresh();
  });
  if (!seen) { out = `${out.replace(/\n*$/, '\n')}${fresh()}\n`; changed = true; }
  if (changed) {
    fs.writeFileSync(file, out, { mode: 0o600 });
    console.log(`[sandbox] Generated a random JWT_SECRET in ${path.relative(backendDir, file) || file}`);
  }
}
require('../helpers/loadEnv');
const { parseDatabaseUrl } = require('../helpers/databaseUrl');
console.log(`[sandbox] env file: ${process.env.MBC_ENV_FILE || '(none — process env only)'}`);

if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.');
if (!process.env.JWT_SECRET || isKnownSecret(process.env.JWT_SECRET)) fail('JWT_SECRET is not set or is a published / placeholder value.');

// Listen on loopback unless HOST says otherwise (demo mode advertises a login).
if (!process.env.HOST) process.env.HOST = '127.0.0.1';

// D1: APP_URL follows PORT (PORT=3150 npm run sandbox used to keep emailing
// links to :3101). Only a localhost APP_URL that was not set in the shell.
{
  const port = String(process.env.PORT || 3001);
  const derived = `http://localhost:${port}`;
  if (realEnvAppUrl === undefined) {
    let local = !process.env.APP_URL;
    let samePort = false;
    try {
      const u = new URL(process.env.APP_URL);
      local = local || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      samePort = (u.port || (u.protocol === 'https:' ? '443' : '80')) === port;
    } catch { local = true; }
    if (local && !samePort) {
      if (process.env.APP_URL) console.log(`[sandbox] APP_URL ${process.env.APP_URL} → ${derived} (follows PORT=${port}; set APP_URL in the shell to override)`);
      process.env.APP_URL = derived;
    }
  }
}

// DEMO_PROSPECT: slug, or an absolute path outside the repo
if (process.env.DEMO_PROSPECT) {
  try { require('../helpers/prospectPath').resolveProspectRef(process.env.DEMO_PROSPECT); } catch (e) { fail(e.message); }
}

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

  step(`Starting server on ${process.env.HOST}:${process.env.PORT || 3001}${process.env.HOST === '127.0.0.1' ? ' (this machine only — HOST=0.0.0.0 to share on your network)' : ''}, APP_URL ${process.env.APP_URL}...`);
  const child = spawn(process.execPath, [path.join(backendDir, 'server.js')], {
    cwd: backendDir, env: process.env, stdio: 'inherit',
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child.kill(sig));
  }
  child.on('exit', (code, signal) => process.exit(code == null ? (signal ? 0 : 1) : code));
})().catch((e) => fail(e.stack || e.message));
