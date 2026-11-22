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
 */
const prisma = require('./prisma');
const { isOffice } = require('./roles');
const { HttpError, notFound } = require('./httpError');

const outOfScope = (what) => new HttpError(403, `Forbidden — this ${what} is not assigned to you`, { code: 'OUT_OF_SCOPE' });

/** Prisma `where` for jobs the user may see. */
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

module.exports = { jobScope, customerScope, assertJobAccess, assertCustomerAccess, outOfScope };
