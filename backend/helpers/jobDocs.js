/**
 * helpers/jobDocs.js — quotes / invoices on a job (B3, GAP-8).
 *
 * Since migration 20261121180000 a job may have several quotes and invoices.
 * Job responses carry both shapes:
 *   quotes[] / invoices[]   every document of the job, newest first
 *   quote / invoice         the "current" one (kept for existing pages):
 *                           quote   = newest quote
 *                           invoice = newest invoice that is not void, else the newest
 * Use DOCS_INCLUDE in a Prisma `include` and withDocs(job) on the row.
 */
'use strict';

const NEWEST = { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] };
const DOCS_INCLUDE = { quotes: NEWEST, invoices: NEWEST };

function withDocs(job) {
  if (!job || typeof job !== 'object') return job;
  const out = { ...job };
  if (Array.isArray(job.quotes)) out.quote = job.quotes[0] || null;
  if (Array.isArray(job.invoices)) out.invoice = job.invoices.find((i) => i.status !== 'void') || job.invoices[0] || null;
  return out;
}

module.exports = { DOCS_INCLUDE, withDocs, NEWEST };
