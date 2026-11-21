/**
 * prisma.config.js — Prisma 7 configuration (replaces `url` in schema.prisma).
 *
 * Prisma 7 no longer reads `.env` itself, so load it here. `helpers/loadEnv`
 * loads ENV_FILE if set, else `.env`, else `.env.sandbox`.
 *
 * DATABASE_URL is only needed by commands that talk to the database
 * (migrate / studio). `prisma generate` works without it.
 */
require('./helpers/loadEnv');
const { defineConfig } = require('prisma/config');

module.exports = defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
});
