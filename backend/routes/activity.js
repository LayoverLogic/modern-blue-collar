/**
 * routes/activity.js — read the job activity log (GTM-18). Append-only: there
 * is no POST/PATCH/PUT/DELETE here or anywhere else; entries are written by
 * helpers/activity.js inside the transaction of the change itself.
 *
 *   GET /api/jobs/:id/activity   anyone who may see the job (technicians: their
 *                                own jobs, else 403 OUT_OF_SCOPE; 404 unknown /
 *                                deleted job). Mounted from routes/jobs.js.
 *   GET /api/activity            office roles: the feed across all jobs,
 *                                including tombstones of deleted jobs.
 *                                Filters: ?jobRef=<job id, also deleted jobs>
 *                                ?type=<one of TYPES>. Mounted in server.js.
 *
 * Both: ?limit (default 100, max 500), ?before=<activity id> for the next page.
 * Response: array, newest first, of
 *   { id, jobId, jobRef, type, from, to, createdAt,
 *     actor: { kind: 'user'|'apiKey'|'system', userId, apiKeyId, name } }
 * (jobId is null once the job is deleted; jobRef always holds the job id).
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('./auth');
const { OFFICE } = require('../helpers/roles');
const { assertJobAccess } = require('../helpers/access');
const { parseId } = require('../helpers/httpError');
const v = require('../helpers/validate');
const activity = require('../helpers/activity');

const MAX_LIMIT = 500;

function paging(q) {
  const limit = typeof q.limit === 'string' && q.limit ? Math.min(parseId(q.limit, 'limit'), MAX_LIMIT) : 100;
  const before = typeof q.before === 'string' && q.before ? parseId(q.before, 'before') : undefined;
  return { limit, before };
}

/** GET /api/jobs/:id/activity — technician scoping as for the job itself. */
async function jobActivity(req, res, next) {
  try {
    const id = parseId(req.params.id);
    await assertJobAccess(req.user, id);
    res.json(await activity.list({ jobId: id }, paging(req.query)));
  } catch (err) { next(err); }
}

const router = express.Router();

/** GET /api/activity — office feed across jobs (incl. deleted jobs). */
router.get('/', requireAuth, requireRole(...OFFICE), async (req, res, next) => {
  try {
    const q = req.query;
    const where = {};
    if (typeof q.jobRef === 'string' && q.jobRef) where.jobRef = parseId(q.jobRef, 'jobRef');
    if (q.type !== undefined) {
      const type = v.oneOf(typeof q.type === 'string' ? q.type : undefined, activity.TYPES, 'type', { required: true });
      where.type = type;
    }
    res.json(await activity.list(where, paging(q)));
  } catch (err) { next(err); }
});

module.exports = { router, jobActivity };
