/**
 * helpers/databaseUrl.js
 * DATABASE_URL may carry Prisma-only query params from the Prisma 5 era
 * (`?schema=public`, `connection_limit`, `pool_timeout`, `pgbouncer`, ...).
 * Neither `pg` nor `pg_dump` understand them, so strip them and return the
 * schema separately. Used by helpers/prisma.js, backup.js and scripts/.
 */
const PRISMA_ONLY_PARAMS = ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size', 'socket_timeout'];

function parseDatabaseUrl(raw) {
  if (!raw) throw new Error('DATABASE_URL is not set (see backend/.env.sandbox.example)');
  const url = new URL(raw);
  const schema = url.searchParams.get('schema') || 'public';
  for (const p of PRISMA_ONLY_PARAMS) url.searchParams.delete(p);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return { connectionString: url.toString(), schema, database, url };
}

module.exports = { parseDatabaseUrl };
