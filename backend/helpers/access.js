/**
 * helpers/access.js — record-level read/write scoping (RT-21).
 *
 * Office roles (super-admin, admin, dispatcher, office) see everything.
 * Technicians see only:
 *   - jobs assigned to them (job.technicianId = me)
 *   - customers that have at least one job assigned to them
 *   - quotes / invoices / photos / comms that belong to those jobs / customers
 *
 * Out-of-scope single records answer 403 (code OUT_OF_SCOPE).
 *
 * TECH_VISIBILITY (env, default "own"):
 *   own   as above — technicians read only their own jobs / customers.
 *   all   technicians may READ the whole schedule: every job (list, detail,
 *         photos, activity) and every customer (list, detail). Writes are
 *         unchanged: status / notes / photos only on their OWN jobs. Quotes,
 *         invoices and communications stay limited to their own jobs /
 *         customers; on jobs that are not theirs the quote / invoice is
 *         returned as null (and customer detail omits communications unless
 *         the customer is on one of their jobs).
 *   The *Read* helpers below honour TECH_VISIBILITY; jobScope /
 *   customerScope / assertJobAccess / assertCustomerAccess are the strict
 *   (own-work) checks used for writes and for billing / comms reads.
 */
const prisma = require('./prisma');
const { isOffice } = require('./roles');
const { HttpError, notFound } = require('./httpError');

const outOfScope = (what) => new HttpError(403, `Forbidden — this ${what} is not assigned to you`, { code: 'OUT_OF_SCOPE' });

const VISIBILITY = ['own', 'all'];
/** 'own' | 'all' — anything else (or unset) is 'own' (fail closed). */
function techVisibility() {
  const v = String(process.env.TECH_VISIBILITY || '').trim().toLowerCase();
  return VISIBILITY.includes(v) ? v : 'own';
}

/** True when this user may read everything (office role, or TECH_VISIBILITY=all). */
function readsAll(user) {
  return isOffice(user) || (!!user && techVisibility() === 'all');
}

/** Prisma `where` for jobs the user may see (strict: own work). */
function jobScope(user) {
  return isOffice(user) ? {} : { technicianId: user.id };
}

/** Prisma `where` for customers the user may see. */
function customerScope(user) {
  return isOffice(user) ? {} : { jobs: { some: { technicianId: user.id } } };
}

/** Load a job (minimal fields) and check the user may access it. */
async function assertJobAccess(user, jobId, client = prisma) {
  const job = await client.job.findUnique({ where: { id: jobId }, select: { id: true, technicianId: true, customerId: true, status: true } });
  if (!job) throw notFound('Job not found');
  if (!isOffice(user) && job.technicianId !== user.id) throw outOfScope('job');
  return job;
}

/** Check the user may access a customer (exists + in scope). */
async function assertCustomerAccess(user, customerId, client = prisma) {
  const c = await client.customer.findUnique({ where: { id: customerId }, select: { id: true, phone: true } });
  if (!c) throw notFound('Customer not found');
  if (!isOffice(user)) {
    const assigned = await client.job.count({ where: { customerId, technicianId: user.id } });
    if (!assigned) throw outOfScope('customer');
  }
  return c;
}

// ── Read scope (TECH_VISIBILITY-aware) ───────────────────────────────────────
function jobReadScope(user) {
  return readsAll(user) ? {} : jobScope(user);
}

function customerReadScope(user) {
  return readsAll(user) ? {} : customerScope(user);
}

/** Like assertJobAccess, for reads: TECH_VISIBILITY=all lets technicians read any job. */
async function assertJobRead(user, jobId, client = prisma) {
  if (!readsAll(user)) return assertJobAccess(user, jobId, client);
  const job = await client.job.findUnique({ where: { id: jobId }, select: { id: true, technicianId: true, customerId: true, status: true } });
  if (!job) throw notFound('Job not found');
  return job;
}

/** Like assertCustomerAccess, for reads. */
async function assertCustomerRead(user, customerId, client = prisma) {
  if (!readsAll(user)) return assertCustomerAccess(user, customerId, client);
  const c = await client.customer.findUnique({ where: { id: customerId }, select: { id: true, phone: true } });
  if (!c) throw notFound('Customer not found');
  return c;
}

/**
 * Billing data on a job the user can read but does not own (TECH_VISIBILITY=all):
 * quote / invoice → null. Office roles and own jobs are returned unchanged.
 */
function redactJob(user, job) {
  if (!job || isOffice(user) || job.technicianId === user.id) return job;
  const out = { ...job };
  if ('quote' in out) out.quote = null;
  if ('invoice' in out) out.invoice = null;
  if ('quotes' in out) out.quotes = [];
  if ('invoices' in out) out.invoices = [];
  return out;
}

module.exports = {
  jobScope, customerScope, assertJobAccess, assertCustomerAccess, outOfScope,
  techVisibility, readsAll, jobReadScope, customerReadScope, assertJobRead, assertCustomerRead, redactJob,
};
