/**
 * helpers/activity.js — the job activity log (GTM-18): write and read
 * JobActivity rows. Append-only: this module only ever INSERTs, and there is
 * no update/delete route.
 *
 * WRITE — always inside the transaction that makes the change, so an entry
 * exists if and only if the change committed:
 *
 *   const activity = require('../helpers/activity');
 *
 *   const quote = await prisma.$transaction(async (tx) => {
 *     const q = await tx.quote.create({ data });
 *     await activity.log(tx, req, q.jobId, 'quote_created', {
 *       to: { quoteId: q.id, amount: q.amount, status: q.status },
 *     });
 *     return q;
 *   });
 *
 *   - client: the transaction client (`tx`); `prisma` works too but is then
 *     not atomic with the change.
 *   - actor: the Express `req` (uses req.user.id and, for API-key calls,
 *     req.apiKey.id), or { userId, apiKeyId } explicitly, or null (system).
 *   - type: one of TYPES (the DB has a CHECK constraint on the same list).
 *   - from / to: small plain-JSON objects (what it was / what it became).
 *     Omit or pass null for "none". Values are passed through JSON once, so
 *     Dates become ISO strings and undefined keys are dropped.
 *   - at: optional Date (seeding/backfill only — routes let the DB stamp it).
 *
 *   Backend, for quotes/invoices later: call log(tx, req, jobId,
 *   'quote_created' | 'invoice_created', { to: { quoteId|invoiceId, amount,
 *   status } }) in the same $transaction as the create. Nothing to import from
 *   routes/jobs.js or routes/activity.js.
 *
 * READ — list(where, opts) / present(rows): newest first, with the actor
 *   resolved to { kind: 'user' | 'apiKey' | 'system', userId, apiKeyId, name }.
 *
 * Job-level helpers used by routes/jobs.js: snapshot(job), diffEvents(before, after, names).
 */
'use strict';

// Loaded on first use, so pure callers (demo dataset/seed code) can require
// this module before DATABASE_URL is set.
const db = () => require('./prisma');

const TYPES = Object.freeze([
  'created',          // to: snapshot of the new job
  'updated',          // other fields (title, description, priority, type, customerId): from/to of the changed keys
  'status_changed',   // from/to: { status }
  'assigned',         // from/to: { technicianId, technicianName } (null id = unassigned)
  'rescheduled',      // from/to: { scheduledDate, scheduledTime, duration } (changed keys only)
  'note',             // from/to: { notes }
  'photo_added',      // to: { photoId, originalName, contentType, size }
  'photo_removed',    // from: { photoId, originalName }
  'quote_created',    // to: { quoteId, amount, status }
  'invoice_created',  // to: { invoiceId, amount, status }
  'deleted',          // tombstone, from: snapshot of the job as it was
]);

const SNAPSHOT_FIELDS = ['title', 'status', 'priority', 'type', 'customerId', 'technicianId', 'scheduledDate', 'scheduledTime', 'duration'];
const SCHEDULE_FIELDS = ['scheduledDate', 'scheduledTime', 'duration'];
const UPDATE_FIELDS = ['title', 'description', 'priority', 'type', 'customerId'];

const json = (v) => (v == null ? undefined : JSON.parse(JSON.stringify(v)));

function actorOf(actor) {
  if (!actor) return { actorUserId: null, actorApiKeyId: null };
  if (actor.user !== undefined || actor.apiKey !== undefined) { // an Express req
    return {
      actorUserId: (actor.user && Number.isInteger(actor.user.id)) ? actor.user.id : null,
      actorApiKeyId: (actor.apiKey && Number.isInteger(actor.apiKey.id)) ? actor.apiKey.id : null,
    };
  }
  return { actorUserId: actor.userId ?? null, actorApiKeyId: actor.apiKeyId ?? null };
}

/** Append one entry. Returns the created row. */
async function log(client, actor, jobId, type, { from, to, at } = {}) {
  if (!TYPES.includes(type)) throw new Error(`activity.log: unknown type "${type}"`);
  if (!Number.isInteger(jobId) || jobId < 1) throw new Error(`activity.log: jobId must be a job id (got ${jobId})`);
  const data = { jobId, jobRef: jobId, type, ...actorOf(actor) };
  const f = json(from); const t = json(to);
  if (f !== undefined) data.from = f;
  if (t !== undefined) data.to = t;
  if (at) data.createdAt = at;
  return (client || db()).jobActivity.create({ data });
}

/** Append several entries for one job: events = [{ type, from, to, at }]. */
async function logMany(client, actor, jobId, events) {
  const out = [];
  // eslint-disable-next-line no-await-in-loop
  for (const e of events) out.push(await log(client, actor, jobId, e.type, e));
  return out;
}

/** The fields of a job that an activity entry records. */
function snapshot(job) {
  const s = {};
  for (const k of SNAPSHOT_FIELDS) s[k] = job[k] === undefined ? null : job[k];
  return s;
}

const same = (a, b) => (a ?? null) === (b ?? null);
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));

/**
 * Events for a job update: compare the row before and after.
 * names: { [userId]: "First Last" } for technician names.
 */
function diffEvents(before, after, names = {}) {
  const events = [];
  if (!same(before.status, after.status)) {
    events.push({ type: 'status_changed', from: { status: before.status }, to: { status: after.status } });
  }
  if (!same(before.technicianId, after.technicianId)) {
    const t = (id) => ({ technicianId: id ?? null, technicianName: id != null ? (names[id] || null) : null });
    events.push({ type: 'assigned', from: t(before.technicianId), to: t(after.technicianId) });
  }
  const sched = SCHEDULE_FIELDS.filter((k) => !same(before[k], after[k]));
  if (sched.length) events.push({ type: 'rescheduled', from: pick(before, sched), to: pick(after, sched) });
  if (!same(before.notes, after.notes)) events.push({ type: 'note', from: { notes: before.notes ?? null }, to: { notes: after.notes ?? null } });
  const upd = UPDATE_FIELDS.filter((k) => !same(before[k], after[k]));
  if (upd.length) events.push({ type: 'updated', from: pick(before, upd), to: pick(after, upd) });
  return events;
}

/** "First Last" for a set of user ids (any client). */
async function userNames(ids, client = db()) {
  const list = [...new Set(ids.filter((x) => Number.isInteger(x)))];
  if (!list.length) return {};
  const users = await client.user.findMany({ where: { id: { in: list } }, select: { id: true, firstName: true, lastName: true } });
  return Object.fromEntries(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
}

/** API view of rows: actor resolved to a display name (no emails). */
async function present(rows, client = db()) {
  const names = await userNames(rows.map((r) => r.actorUserId), client);
  const keyIds = [...new Set(rows.map((r) => r.actorApiKeyId).filter((x) => Number.isInteger(x)))];
  const keys = keyIds.length
    ? Object.fromEntries((await client.apiKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, name: true } })).map((k) => [k.id, k.name]))
    : {};
  return rows.map((r) => {
    let actor;
    if (r.actorApiKeyId != null) {
      actor = { kind: 'apiKey', userId: r.actorUserId, apiKeyId: r.actorApiKeyId, name: keys[r.actorApiKeyId] ? `${keys[r.actorApiKeyId]} (API key)` : 'Deleted API key' };
    } else if (r.actorUserId != null) {
      actor = { kind: 'user', userId: r.actorUserId, apiKeyId: null, name: names[r.actorUserId] || 'Deleted user' };
    } else {
      actor = { kind: 'system', userId: null, apiKeyId: null, name: 'System' };
    }
    return {
      id: r.id, jobId: r.jobId, jobRef: r.jobRef, type: r.type,
      from: r.from ?? null, to: r.to ?? null, createdAt: r.createdAt, actor,
    };
  });
}

/**
 * Newest first (createdAt, then id). `before` = the id of the last entry of
 * the previous page: the next page holds the entries that sort after it.
 */
async function list(where, { limit = 100, before } = {}, client = db()) {
  let cursor = {};
  if (before) {
    const b = await client.jobActivity.findUnique({ where: { id: before }, select: { id: true, createdAt: true } });
    if (b) cursor = { OR: [{ createdAt: { lt: b.createdAt } }, { createdAt: b.createdAt, id: { lt: b.id } }] };
  }
  const rows = await client.jobActivity.findMany({
    where: { AND: [where, cursor] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  return present(rows, client);
}

module.exports = { TYPES, SNAPSHOT_FIELDS, log, logMany, snapshot, diffEvents, userNames, present, list };
