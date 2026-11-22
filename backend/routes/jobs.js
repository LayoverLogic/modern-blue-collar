/**
 * routes/jobs.js
 * CRUD for Jobs. Trade type is derived from brand.config.js.
 *
 * Endpoints:
 *   GET    /api/jobs               — list jobs (with customer & technician); ?status ?technicianId ?date ?limit
 *   GET    /api/jobs/:id           — single job detail
 *   POST   /api/jobs               — create job                       (office roles)
 *   PATCH  /api/jobs/:id           — update job (version required)    (office roles; technician: own job, status/notes only)
 *   PUT    /api/jobs/:id           — alias for PATCH
 *   DELETE /api/jobs/:id           — delete job + its photo files     (admin+)
 *   GET    /api/jobs/types         — trade-specific job type list
 *   GET/POST/DELETE /api/jobs/:id/photos[...]                         (anyone who can see the job)
 *   GET    /api/jobs/:id/activity  — activity log, newest first        (anyone who can see the job; routes/activity.js)
 *
 * Activity log (GTM-18): every create / update / delete / photo change writes
 * JobActivity entries (helpers/activity.js) in the same transaction as the
 * change — created, status_changed, assigned, rescheduled, note, updated,
 * photo_added, photo_removed, deleted (a tombstone that survives the job).
 *
 * Rules: status ∈ pending|scheduled|in-progress|completed|cancelled (RT-12);
 * completedAt is set on → completed and cleared when a job leaves completed;
 * a technician cannot hold two overlapping active jobs (RT-13, 409
 * SCHEDULE_CONFLICT); technicians only see their own jobs (RT-21).
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const crypto  = require('crypto');
const { requireAuth, requireRole } = require('./auth');
const { optimisticUpdate } = require('../helpers/optimisticUpdate');
const { OFFICE, ADMIN, isOffice } = require('../helpers/roles');
const { jobScope, assertJobAccess } = require('../helpers/access');
const { parseId, badRequest, forbidden, notFound, conflict } = require('../helpers/httpError');
const { sniffImage, isServableImage } = require('../helpers/imageSniff');
const v = require('../helpers/validate');
const storage = require('../helpers/storage');
const brand   = require('../../brand.config');
const activity = require('../helpers/activity');
const { jobActivity } = require('./activity');

const prisma = require('../helpers/prisma');

// In-memory upload; photo bytes are streamed straight to object storage.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 10 },
});

const ACTIVE_STATUSES = ['pending', 'scheduled', 'in-progress'];
const TECH_EDITABLE   = ['status', 'notes', 'version'];
const LIST_INCLUDE = {
  customer:   { select: { id: true, firstName: true, lastName: true, phone: true, address: true, city: true, state: true } },
  technician: { select: { id: true, firstName: true, lastName: true, phone: true } },
  quote:      true,
  invoice:    true,
};
const WRITE_INCLUDE = { customer: true, technician: { select: { id: true, firstName: true, lastName: true } } };

// ── Validation ────────────────────────────────────────────────────────────────
function jobFields(body, { create = false } = {}) {
  const d = {};
  if (create || body.title !== undefined) d.title = v.str(body.title, 'title', { required: true, max: 200 });
  if (body.description !== undefined) d.description = v.str(body.description, 'description', { max: 5000 });
  if (create || body.customerId !== undefined) d.customerId = v.optionalId(body.customerId, 'customerId');
  if (body.technicianId !== undefined) d.technicianId = v.optionalId(body.technicianId, 'technicianId');
  if (body.status !== undefined)   d.status   = v.oneOf(body.status, v.JOB_STATUSES, 'status');
  if (body.priority !== undefined) d.priority = v.oneOf(body.priority, v.JOB_PRIORITIES, 'priority');
  if (body.type !== undefined)     d.type     = v.str(body.type, 'type', { max: 100 }) || undefined;
  if (body.scheduledDate !== undefined) d.scheduledDate = v.ymd(body.scheduledDate);
  if (body.scheduledTime !== undefined) d.scheduledTime = v.hhmm(body.scheduledTime);
  if (body.duration !== undefined) {
    const n = v.number(body.duration, 'duration', { min: 0.25, max: 24 });
    if (n !== undefined) d.duration = n;
  }
  if (body.notes !== undefined) d.notes = v.str(body.notes, 'notes', { max: 10000 });
  if (create && d.customerId == null) throw badRequest('customerId is required', { code: 'REQUIRED', field: 'customerId' });
  if (body.customerId !== undefined && d.customerId === null) throw badRequest('customerId cannot be cleared', { field: 'customerId' });
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

async function assertReferences(tx, d) {
  if (d.customerId != null) {
    const c = await tx.customer.findUnique({ where: { id: d.customerId }, select: { id: true } });
    if (!c) throw badRequest('customerId does not match a customer', { code: 'UNKNOWN_CUSTOMER', field: 'customerId' });
  }
  if (d.technicianId != null) {
    const t = await tx.user.findUnique({ where: { id: d.technicianId }, select: { id: true, active: true } });
    if (!t || !t.active) throw badRequest('technicianId does not match an active user', { code: 'UNKNOWN_TECHNICIAN', field: 'technicianId' });
  }
}

const toMinutes = (t) => {
  const m = /^(\d{2}):(\d{2})/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * RT-13: reject a schedule that overlaps another active job of the same
 * technician on the same day. Serialised per technician with a transaction-
 * scoped advisory lock so two concurrent bookings cannot both pass.
 */
async function assertNoOverlap(tx, job) {
  const { id, technicianId, scheduledDate, scheduledTime, status } = job;
  if (!technicianId || !scheduledDate || !ACTIVE_STATUSES.includes(status)) return;
  const start = toMinutes(scheduledTime);
  if (start == null) return;
  const end = start + Math.round((job.duration || 1.5) * 60);

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4242, ${technicianId}::int)`;
  const others = await tx.job.findMany({
    where: {
      technicianId, scheduledDate, status: { in: ACTIVE_STATUSES },
      ...(id ? { id: { not: id } } : {}),
    },
    select: { id: true, title: true, scheduledTime: true, duration: true },
  });
  for (const o of others) {
    const s = toMinutes(o.scheduledTime);
    if (s == null) continue;
    const e = s + Math.round((o.duration || 1.5) * 60);
    if (start < e && s < end) {
      throw conflict(`Technician is already booked from ${o.scheduledTime} on ${scheduledDate} (job #${o.id})`, {
        code: 'SCHEDULE_CONFLICT', conflictJobId: o.id,
      });
    }
  }
}

// ── GET /api/jobs/types — trade-specific job types ─────────────────────────────
router.get('/types', requireAuth, (_req, res) => {
  res.json({ tradeType: brand.tradeType, jobTypes: brand.jobTypes });
});

// ── GET /api/jobs ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = req.query;
    const where = { ...jobScope(req.user) };
    if (typeof q.status === 'string' && q.status) where.status = q.status;
    if (typeof q.technicianId === 'string' && q.technicianId) {
      const tid = parseId(q.technicianId, 'technicianId');
      if (where.technicianId !== undefined && where.technicianId !== tid) return res.json([]);
      where.technicianId = tid;
    }
    if (typeof q.date === 'string' && q.date) where.scheduledDate = q.date;
    let take;
    if (typeof q.limit === 'string' && q.limit) take = Math.min(parseId(q.limit, 'limit'), 1000);

    const jobs = await prisma.job.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: [{ scheduledDate: 'asc' }, { scheduledTime: 'asc' }, { createdAt: 'desc' }],
      ...(take ? { take } : {}),
    });
    res.json(jobs);
  } catch (err) { next(err); }
});

// ── GET /api/jobs/:id ──────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    await assertJobAccess(req.user, id);
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        customer:   true,
        technician: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        quote:      true,
        invoice:    true,
        jobParts:   { include: { inventoryItem: true } },
      },
    });
    if (!job) throw notFound('Job not found');
    res.json(job);
  } catch (err) { next(err); }
});

// ── POST /api/jobs ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, requireRole(...OFFICE), async (req, res, next) => {
  try {
    const d = jobFields(req.body || {}, { create: true });
    const data = {
      ...d,
      status:    d.status   || 'pending',
      priority:  d.priority || 'normal',
      type:      d.type     || brand.jobTypes[0],
      tradeType: brand.tradeType,
      duration:  d.duration != null ? d.duration : 1.5,
    };
    if (data.status === 'completed') data.completedAt = new Date();

    const job = await prisma.$transaction(async (tx) => {
      await assertReferences(tx, data);
      await assertNoOverlap(tx, data);
      const created = await tx.job.create({ data, include: WRITE_INCLUDE });
      await activity.log(tx, req, created.id, 'created', { to: activity.snapshot(created) });
      return created;
    });
    res.status(201).json(job);
  } catch (err) { next(err); }
});

// ── PATCH /api/jobs/:id — optimistic locking (version required) ───────────────
async function updateJob(req, res, next) {
  try {
    const id   = parseId(req.params.id);
    const body = req.body || {};

    if (!isOffice(req.user)) {
      // Technicians: own jobs only, status/notes only, cannot cancel.
      const extra = Object.keys(body).filter((k) => !TECH_EDITABLE.includes(k));
      if (extra.length) throw forbidden(`Technicians can only update status and notes (not: ${extra.join(', ')})`);
      if (body.status === 'cancelled') throw forbidden('Only the office can cancel a job');
    }

    const d = jobFields(body);
    const job = await prisma.$transaction(async (tx) => {
      const current = await assertJobAccess(req.user, id, tx);
      const full = await tx.job.findUnique({ where: { id } });
      await assertReferences(tx, d);

      // completedAt follows status (RT-12b)
      if (d.status && d.status !== full.status) {
        if (d.status === 'completed') d.completedAt = new Date();
        else if (full.status === 'completed') d.completedAt = null;
      }

      const merged = { ...full, ...d, id: current.id };
      const scheduleTouched = ['technicianId', 'scheduledDate', 'scheduledTime', 'duration', 'status'].some((k) => k in d);
      if (scheduleTouched) await assertNoOverlap(tx, merged);

      const updated = await optimisticUpdate('job', id, { ...d, version: body.version }, { include: WRITE_INCLUDE, client: tx });
      const names = await activity.userNames([full.technicianId, updated.technicianId], tx);
      await activity.logMany(tx, req, id, activity.diffEvents(full, updated, names));
      return updated;
    });
    res.json(job);
  } catch (err) { next(err); }
}
router.patch('/:id', requireAuth, updateJob);
router.put('/:id', requireAuth, updateJob);

// ── DELETE /api/jobs/:id — admin+; removes photo objects too (RT-19) ──────────
router.delete('/:id', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const photos = await prisma.jobPhoto.findMany({ where: { jobId: id }, select: { key: true } });
    // Deleting the row first: if it is still referenced (invoice, quote, parts)
    // this throws P2003 → 409, the transaction (and its tombstone) rolls back
    // and the photos stay intact.
    await prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id } });
      if (!job) throw notFound('Job not found');
      // Tombstone first (jobId still valid); the FK then detaches every entry
      // of this job (jobId → NULL, jobRef keeps the id).
      await activity.log(tx, req, id, 'deleted', { from: { ...activity.snapshot(job), photos: photos.length } });
      await tx.job.delete({ where: { id } }); // JobPhoto rows cascade
    });
    const failed = [];
    for (const p of photos) {
      // eslint-disable-next-line no-await-in-loop
      await storage.deleteObject(p.key).catch((e) => failed.push(`${p.key}: ${e.message}`));
    }
    if (failed.length) console.warn(`[JOBS] job #${id} deleted; could not remove ${failed.length} photo object(s):`, failed);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Job photos ────────────────────────────────────────────────────────────────
// Stored in object storage (local disk in the sandbox, S3-compatible in
// production). Only metadata + the object key live in the DB. The raw bytes
// are proxied back through the API so they stay behind auth.

function photoView(p) {
  return {
    id: p.id, jobId: p.jobId, originalName: p.originalName,
    contentType: p.contentType, size: p.size, createdAt: p.createdAt,
    url: `/api/jobs/${p.jobId}/photos/${p.id}/raw`,
  };
}

// GET /api/jobs/:id/photos — list photo metadata for a job
router.get('/:id/photos', requireAuth, async (req, res, next) => {
  try {
    const jobId = parseId(req.params.id);
    await assertJobAccess(req.user, jobId);
    const photos = await prisma.jobPhoto.findMany({ where: { jobId }, orderBy: { createdAt: 'desc' } });
    res.json(photos.map(photoView));
  } catch (err) { next(err); }
});

// POST /api/jobs/:id/photos — upload a photo (multipart/form-data, field "photo")
// The file is checked by its BYTES (RT-20): JPEG, PNG, GIF, WebP, HEIC/HEIF/AVIF
// only; SVG/HTML/anything else → 400. The stored content type is the sniffed one.
router.post('/:id/photos', requireAuth, upload.single('photo'), async (req, res, next) => {
  try {
    const jobId = parseId(req.params.id);
    if (!req.file) throw badRequest('No file uploaded (field name must be "photo")', { code: 'NO_FILE' });
    const sniffed = sniffImage(req.file.buffer);
    if (!sniffed) throw badRequest('Only JPEG, PNG, GIF, WebP or HEIC/AVIF images are allowed', { code: 'UNSUPPORTED_FILE_TYPE' });

    await assertJobAccess(req.user, jobId);

    const base = (req.file.originalname || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(-60) || 'photo';
    const safeName = base.replace(/\.[a-zA-Z0-9]{1,5}$/, '') + '.' + sniffed.ext;
    const key = `jobs/${jobId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safeName}`;

    await storage.putObject(key, req.file.buffer, sniffed.mime);

    let photo;
    try {
      photo = await prisma.$transaction(async (tx) => {
        const p = await tx.jobPhoto.create({
          data: {
            jobId,
            key,
            originalName: String(req.file.originalname || '').slice(0, 200),
            contentType:  sniffed.mime,
            size:         req.file.size,
            uploadedById: req.user.id,
          },
        });
        await activity.log(tx, req, jobId, 'photo_added', {
          to: { photoId: p.id, originalName: p.originalName, contentType: p.contentType, size: p.size },
        });
        return p;
      });
    } catch (e) {
      await storage.deleteObject(key).catch(() => {}); // no orphan object without a row
      throw e;
    }
    res.status(201).json(photoView(photo));
  } catch (err) {
    // Surface object-storage connectivity problems as 503 instead of a generic 500.
    if (!err.status && /credential|endpoint|ECONNREFUSED|NoSuchBucket|getaddrinfo|resolve/i.test(err.message || '')) {
      return res.status(503).json({ error: 'Object storage unavailable', code: 'STORAGE_UNAVAILABLE' });
    }
    next(err);
  }
});

// GET /api/jobs/:id/photos/:photoId/raw — stream the image bytes from object storage
router.get('/:id/photos/:photoId/raw', requireAuth, async (req, res, next) => {
  try {
    const jobId = parseId(req.params.id);
    const photoId = parseId(req.params.photoId, 'photoId');
    await assertJobAccess(req.user, jobId);
    const photo = await prisma.jobPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.jobId !== jobId) throw notFound('Photo not found');
    const obj = await storage.getObject(photo.key);
    // Never let a stored file run script on the app origin (RT-20b): only
    // known raster types are served inline; everything else is an attachment.
    const inline = isServableImage(photo.contentType);
    res.setHeader('Content-Type', inline ? photo.contentType : 'application/octet-stream');
    res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    obj.Body.on('error', () => res.destroy());
    obj.Body.pipe(res);
  } catch (err) { next(err); }
});

// DELETE /api/jobs/:id/photos/:photoId — remove a photo (DB row + stored object)
router.delete('/:id/photos/:photoId', requireAuth, async (req, res, next) => {
  try {
    const jobId = parseId(req.params.id);
    const photoId = parseId(req.params.photoId, 'photoId');
    await assertJobAccess(req.user, jobId);
    const photo = await prisma.jobPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.jobId !== jobId) throw notFound('Photo not found');
    await prisma.$transaction(async (tx) => {
      await tx.jobPhoto.delete({ where: { id: photo.id } });
      await activity.log(tx, req, jobId, 'photo_removed', { from: { photoId: photo.id, originalName: photo.originalName } });
    });
    await storage.deleteObject(photo.key).catch((e) => console.warn(`[JOBS] could not remove ${photo.key}: ${e.message}`));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/jobs/:id/activity — append-only log (no write routes) ───────────
router.get('/:id/activity', requireAuth, jobActivity);

module.exports = router;
