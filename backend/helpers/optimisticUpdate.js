/**
 * helpers/optimisticUpdate.js
 * Optimistic locking for PATCH/PUT on job, customer, quote, invoice (RT-9).
 *
 * The client MUST send the `version` it last read. The write is a single
 * atomic `UPDATE ... WHERE id = $1 AND version = $2` (updateMany), so of N
 * concurrent writers holding the same version exactly one wins; the rest get
 * 409. A missing version is a 400 (code VERSION_REQUIRED).
 *
 *   409 body: { error, code: 'VERSION_CONFLICT', currentVersion }
 */
const prisma = require('./prisma');
const { HttpError } = require('./httpError');
const v = require('./validate');

const LABEL = { job: 'Job', customer: 'Customer', quote: 'Quote', invoice: 'Invoice' };

/**
 * @param {string} model   Prisma model ('job' | 'customer' | 'quote' | 'invoice')
 * @param {number} id      record id
 * @param {object} data    validated update fields; `data.version` is the client's version
 * @param {object} [options] { include, select, client } — client: a transaction client
 * @returns updated record (with include/select applied)
 */
async function optimisticUpdate(model, id, data, options = {}) {
  const { include, select, client = prisma } = options;
  const { version: clientVersion, ...fields } = data;
  const expected = v.version(clientVersion);

  const { count } = await client[model].updateMany({
    where: { id, version: expected },
    data:  { ...fields, version: { increment: 1 } },
  });

  if (count === 0) {
    const current = await client[model].findUnique({ where: { id }, select: { version: true } });
    if (!current) throw new HttpError(404, `${LABEL[model] || model} not found`, { code: 'NOT_FOUND' });
    throw new HttpError(409,
      `Conflict: This ${model} has been modified by another user. Please refresh and try again.`,
      { code: 'VERSION_CONFLICT', currentVersion: current.version });
  }

  const args = { where: { id } };
  if (include) args.include = include;
  if (select) args.select = select;
  return client[model].findUnique(args);
}

module.exports = { optimisticUpdate, prisma };
