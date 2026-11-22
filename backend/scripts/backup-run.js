#!/usr/bin/env node
/**
 * scripts/backup-run.js — run one backup now (the same job the 03:00 cron runs).
 *
 * Setup / run:
 *   1. From backend/:   npm run backup:run
 *      In production:   docker compose exec app npm run backup:run
 *   2. It reads the same env as the server (DATABASE_URL, BACKUP_DRIVER,
 *      BACKUP_DIR, BACKUP_S3_*, BACKUP_ENCRYPTION_KEY, BACKUP_HEARTBEAT_URL,
 *      STORAGE_DRIVER / LOCAL_STORAGE_DIR) — see the header of backup.js.
 *   3. Prints a JSON summary. Exit code 0 = the set was written (and uploaded,
 *      for BACKUP_DRIVER=s3); 1 = it failed (the heartbeat /fail ping is sent).
 *   4. No API cooldown applies here (that is only for POST /api/backup/run).
 *   5. The first line (on stderr, apart from the JSON summary) names the database
 *      it backs up and where DATABASE_URL came from — the shell, or an env file
 *      such as backend/.env.sandbox (D5).
 */
const dbUrlFromShell = process.env.DATABASE_URL !== undefined; // before the env file is read
require('../helpers/loadEnv');
const { runBackup } = require('../backup');

try {
  const { parseDatabaseUrl } = require('../helpers/databaseUrl');
  const { database, connectionString } = parseDatabaseUrl(process.env.DATABASE_URL);
  const file = process.env.MBC_ENV_FILE ? require('path').relative(process.cwd(), process.env.MBC_ENV_FILE) || process.env.MBC_ENV_FILE : null;
  console.error(`[backup:run] database "${database}" on ${new URL(connectionString).host} (DATABASE_URL from ${dbUrlFromShell ? 'the shell environment' : file || 'nowhere'})`);
} catch (e) {
  console.error(`[backup:run] FAILED: DATABASE_URL is missing or invalid (${e.message})`);
  process.exit(1);
}

runBackup()
  .then((r) => {
    const { localPath, wasabi, ...summary } = r; // no legacy alias / full path in the summary
    console.log(JSON.stringify({ ok: true, ...summary, localDir: require('path').dirname(localPath) }, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[backup:run] FAILED: ${err.message}`);
    process.exit(1);
  });
