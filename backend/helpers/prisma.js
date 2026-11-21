/**
 * helpers/prisma.js — the ONE shared PrismaClient for the whole backend.
 *
 * Prisma 7 is Rust-free: the client runs a WASM query compiler and talks to
 * Postgres through the `pg` driver via @prisma/adapter-pg. No engine binary is
 * downloaded at install or run time.
 *
 * Every route, seed, backup and test uses `require('<path>/helpers/prisma')`
 * instead of `new PrismaClient()` (one connection pool per process).
 */
require('./loadEnv');
const { PrismaClient }      = require('@prisma/client');
const { PrismaPg }          = require('@prisma/adapter-pg');
const { parseDatabaseUrl }  = require('./databaseUrl');

if (!global.__mbcPrisma) {
  const { connectionString, schema } = parseDatabaseUrl(process.env.DATABASE_URL);
  const adapter = new PrismaPg({ connectionString }, schema !== 'public' ? { schema } : undefined);
  global.__mbcPrisma = new PrismaClient({ adapter });
}

module.exports = global.__mbcPrisma;
