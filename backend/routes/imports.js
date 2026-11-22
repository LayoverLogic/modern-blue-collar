/**
 * routes/imports.js — CSV customer import (admin / super-admin). Mounted at /api/imports.
 *
 *   GET  /api/imports/presets                  column presets (housecallpro | jobber | generic), options
 *   GET  /api/imports/templates/customers.csv  the generic template CSV (header + 2 synthetic rows)
 *   POST /api/imports/customers?dryRun=true|false&source=generic|housecallpro|jobber[&format=json|zip][&expectSha256=…]
 *        multipart/form-data: file (CSV, required), mapping (JSON file or text, optional),
 *        decisions (merge-candidates.csv filled in, or JSON, optional),
 *        options (JSON text, optional: undecided, missingPhone, excludeArchived, batchSize…)
 *        → 200 report JSON (+ `markdown`), or with format=zip a zip of
 *          report.json, report.md, exceptions.csv, merge-candidates.csv, spot-check.csv
 *        dryRun defaults to TRUE: nothing is written unless dryRun=false is sent explicitly.
 *        A real run needs a signed-in user (not an API key) and, when expectSha256 is given,
 *        the file must be byte-identical to the dry run's (409 FILE_CHANGED otherwise).
 *   POST /api/imports/customers/undo           multipart field report (or JSON body) = a committed
 *        report.json → { runId, deleted, restored, unlinked, skipped[] } (signed-in admin)
 *
 * Errors: 400 {code: REQUIRED | INVALID_INPUT | INVALID_ENUM | INVALID_CSV | INVALID_JSON | TOO_MANY_ROWS},
 *         413 FILE_TOO_LARGE, 409 IMPORT_RUNNING | FILE_CHANGED.
 * The playbook (gtm/implementation/data-migration-playbook.md) applies: client files are
 * processed in memory and never stored by this route.
 */
'use strict';

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { requireAuth, requireRole, requireSession } = require('./auth');
const { ADMIN } = require('../helpers/roles');
const { badRequest, conflict } = require('../helpers/httpError');
const { contentDisposition } = require('../helpers/csv');
const { zipToBuffer } = require('../helpers/zip');
const imp = require('../helpers/importer');

const MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES) || 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 3, fields: 10 } });
let running = false;

function parseJsonField(value, field) {
  if (value == null || value === '') return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  if (!text.trim()) return undefined;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (e) {
    throw badRequest(`${field} must be a JSON object (${e.message})`, { code: 'INVALID_JSON', field });
  }
}

function bool(v, field, dflt) {
  if (v === undefined || v === '') return dflt;
  if (v === 'true' || v === true || v === '1') return true;
  if (v === 'false' || v === false || v === '0') return false;
  throw badRequest(`${field} must be true or false`, { code: 'INVALID_INPUT', field });
}

const asHttp = (e) => {
  if (e instanceof imp.ImportError) {
    const err = badRequest(e.message, { code: e.code, ...e.extra });
    return err;
  }
  return e;
};

function uploadFields(req, res, next) {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'mapping', maxCount: 1 }, { name: 'decisions', maxCount: 1 }])(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_BYTES} bytes)`, code: 'FILE_TOO_LARGE' });
    return res.status(400).json({ error: `Upload failed: ${err.message}`, code: 'INVALID_INPUT' });
  });
}

router.get('/presets', requireAuth, requireRole(...ADMIN), (_req, res) => {
  res.json({
    presets: Object.fromEntries(Object.entries(imp.PRESETS).map(([k, p]) => [k, { label: p.label, sourceSystem: p.sourceSystem, dateFormat: p.dateFormat, fields: p.fields }])),
    targetFields: imp.TARGET_FIELDS,
    defaultOptions: imp.DEFAULT_OPTIONS,
    decisions: ['merge', 'create', 'exclude'],
    dateFormats: ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY'],
  });
});

router.get('/templates/customers.csv', requireAuth, requireRole(...ADMIN), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition('mbc_customers_import_template.csv'));
  res.send(imp.templateCsv());
});

async function reportZip(report) {
  return zipToBuffer(async (zip) => {
    await zip.addText('report.json', JSON.stringify(report, null, 2));
    await zip.addText('report.md', imp.renderMarkdown(report));
    await zip.addText('exceptions.csv', imp.exceptionsCsv(report));
    await zip.addText('merge-candidates.csv', imp.mergeCsv(report));
    await zip.addText('spot-check.csv', imp.spotCheckCsv(report));
  });
}

router.post('/customers', requireAuth, requireRole(...ADMIN), uploadFields, async (req, res, next) => {
  let claimed = false;
  try {
    const q = { ...req.query, ...(req.body || {}) };
    const dryRun = bool(q.dryRun, 'dryRun', true);
    if (!dryRun && req.apiKey) return res.status(403).json({ error: 'A real import needs a signed-in user, not an API key', code: 'SESSION_REQUIRED' });
    const format = q.format || 'json';
    if (!['json', 'zip'].includes(format)) throw badRequest('format must be json or zip', { code: 'INVALID_ENUM', field: 'format', allowed: ['json', 'zip'] });
    const source = q.source || 'generic';
    const file = req.files && req.files.file && req.files.file[0];
    if (!file) throw badRequest('file (CSV) is required as multipart field "file"', { code: 'REQUIRED', field: 'file' });
    const mappingFile = req.files.mapping && req.files.mapping[0];
    const mapping = parseJsonField(mappingFile ? mappingFile.buffer : q.mapping, 'mapping') || {};
    const options = parseJsonField(q.options, 'options') || {};
    const decisionsFile = req.files.decisions && req.files.decisions[0];
    const decisions = imp.parseDecisions(decisionsFile ? decisionsFile.buffer : q.decisions);

    if (!dryRun) {
      if (running) throw conflict('Another import is running — try again when it finishes', { code: 'IMPORT_RUNNING' });
      running = true; claimed = true;
    }
    const plan = await imp.planCustomerImport({
      files: [{ name: String(file.originalname || 'upload.csv').slice(0, 200), content: file.buffer }],
      source, mapping, decisions, options,
      actor: { userId: req.user.id, email: req.user.email, apiKeyId: req.apiKey ? req.apiKey.id : null },
    });
    if (q.expectSha256 && q.expectSha256 !== plan.report.files[0].sha256) {
      throw conflict('The file differs from the one the dry run checked (sha256 mismatch) — run a new dry run', { code: 'FILE_CHANGED', sha256: plan.report.files[0].sha256 });
    }
    const report = dryRun ? plan.report : await imp.commitCustomerImport(plan);
    if (format === 'zip') {
      const buf = await reportZip(report);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', contentDisposition(`${report.runId}_${report.mode}.zip`));
      return res.send(buf);
    }
    res.json({ ...report, markdown: imp.renderMarkdown(report) });
  } catch (e) {
    next(asHttp(e));
  } finally {
    if (claimed) running = false;
  }
});

// Body: multipart field "report" (the report.json of a committed run — large runs exceed the
// 1 MB JSON body limit) or a JSON body for small reports.
router.post('/customers/undo', requireAuth, requireSession, requireRole(...ADMIN), (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  upload.single('report')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_BYTES} bytes)`, code: 'FILE_TOO_LARGE' });
    return res.status(400).json({ error: `Upload failed: ${err.message}`, code: 'INVALID_INPUT' });
  });
}, async (req, res, next) => {
  let claimed = false;
  try {
    const report = req.file ? parseJsonField(req.file.buffer, 'report') : req.body;
    if (!report || typeof report !== 'object') throw badRequest('report (a committed report.json) is required', { code: 'REQUIRED', field: 'report' });
    if (running) throw conflict('Another import is running — try again when it finishes', { code: 'IMPORT_RUNNING' });
    running = true; claimed = true;
    const result = await imp.undoCustomerImport(report);
    res.json(result);
  } catch (e) { next(asHttp(e)); } finally { if (claimed) running = false; }
});

module.exports = router;
