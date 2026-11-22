/**
 * routes/backup.js  — Manual backup trigger endpoint
 * POST /api/backup/run   — trigger backup now (admin+)
 * GET  /api/backup/list  — list existing local backup files (admin+)
 *
 * Target is chosen by BACKUP_DRIVER (local | s3) — see backup.js.
 * There is no download/restore endpoint (restore = `gunzip -c file | psql`).
 */
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole, requireSession } = require('./auth');
const { ADMIN } = require('../helpers/roles');
const backup  = require('../backup');

// One backup at a time, and at most one manual run per BACKUP_COOLDOWN_SECONDS
// (default 300) — pg_dump is expensive (RT-30).
let running = false;
let lastRunAt = 0;
const cooldownMs = () => Math.max(0, Number(process.env.BACKUP_COOLDOWN_SECONDS || 300)) * 1000;

router.post('/run', requireAuth, requireSession, requireRole(...ADMIN), async (_req, res, next) => {
  if (running) return res.status(409).json({ error: 'A backup is already running', code: 'BACKUP_RUNNING' });
  const wait = lastRunAt + cooldownMs() - Date.now();
  if (wait > 0) {
    res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
    return res.status(429).json({ error: `A backup ran recently — try again in ${Math.ceil(wait / 1000)}s`, code: 'BACKUP_COOLDOWN' });
  }
  running = true;
  try {
    const result = await backup.runBackup();
    lastRunAt = Date.now();
    // Never return server filesystem paths (RT-30): filename only.
    res.json({
      success: true,
      message: 'Backup completed successfully.',
      driver: result.driver,
      filename: result.filename,
      size: result.size,
      wasabi: result.wasabi,
    });
  } catch (err) {
    console.error('[BACKUP] manual run failed:', err.message);
    res.status(500).json({ error: 'Backup failed — see server logs', code: 'BACKUP_FAILED' });
  } finally { running = false; }
});

router.get('/list', requireAuth, requireRole(...ADMIN), (_req, res, next) => {
  try {
    res.json({
      driver: backup.getBackupDriver(),
      backups: backup.listBackups(),
      wasabiConfigured: backup.wasabiConfigured(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
