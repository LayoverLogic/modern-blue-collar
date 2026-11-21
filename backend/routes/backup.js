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
const { requireAuth, requireRole } = require('./auth');
const backup  = require('../backup');

router.post('/run', requireAuth, requireRole('super-admin', 'admin'), async (_req, res, next) => {
  try {
    const result = await backup.runBackup();
    res.json({
      success: true,
      message: 'Backup completed successfully.',
      driver: result.driver,
      local: result.localPath,
      filename: result.filename,
      size: result.size,
      wasabi: result.wasabi,
    });
  } catch (err) { next(err); }
});

router.get('/list', requireAuth, requireRole('super-admin', 'admin'), (_req, res, next) => {
  try {
    res.json({
      driver: backup.getBackupDriver(),
      backups: backup.listBackups(),
      wasabiConfigured: backup.wasabiConfigured(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
