#!/usr/bin/env node
/**
 * scripts/prisma-generate.js — `prisma generate` that never needs binaries.prisma.sh
 *
 * Run automatically by `npm install` (postinstall) and by `npm run generate`.
 *
 * Why: the Prisma 7 client itself is Rust-free (WASM query compiler + pg driver
 * adapter), and `generate` only uses the bundled WASM schema parser. But the
 * Prisma 7.10 CLI still tries to download the native `schema-engine` binary
 * from binaries.prisma.sh on EVERY command, and fails when that host is
 * blocked (offline / locked-down sandbox) even though `generate` never runs it.
 *
 * Fix: if PRISMA_SCHEMA_ENGINE_BINARY is not already set, point it at a stub
 * that exits with a clear message. `generate` succeeds without network access.
 * Plain `npx prisma <cmd>` is untouched and still uses the native engine where
 * downloads work (e.g. on a Mac). Migrations use scripts/migrate-deploy.mjs,
 * which runs Prisma's official schema engine compiled to WASM.
 */
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const env  = { ...process.env };

if (!env.PRISMA_SCHEMA_ENGINE_BINARY) {
  const stub = path.join(__dirname, 'schema-engine-unavailable.sh');
  try { fs.chmodSync(stub, 0o755); } catch { /* read-only fs: git keeps the exec bit anyway */ }
  env.PRISMA_SCHEMA_ENGINE_BINARY = stub;
}

const prismaCli = require.resolve('prisma/build/index.js', { paths: [root] });
const r = spawnSync(process.execPath, [prismaCli, 'generate'], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
