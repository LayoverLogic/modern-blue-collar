/**
 * routes/customers.js
 * Customer CRUD. Default state is driven by brand.config.js (BRAND_DEFAULT_STATE).
 *
 * Access (helpers/roles.js, helpers/access.js):
 *   read    office roles: all; technicians: customers on their assigned jobs
 *   create / edit   office roles
 *   delete          admin / super-admin
 * PATCH/PUT require `version` (optimistic locking, atomic — RT-9).
 */

const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { optimisticUpdate } = require('../helpers/optimisticUpdate');
const { OFFICE, ADMIN } = require('../helpers/roles');
const { customerScope, assertCustomerAccess } = require('../helpers/access');
const { parseId, notFound } = require('../helpers/httpError');
const v = require('../helpers/validate');
const brand = require('../../brand.config');

const prisma = require('../helpers/prisma');

/** Validate customer fields present in `body`. `create` makes required ones required. */
function customerFields(body, { create = false } = {}) {
  const d = {};
  const has = (k) => create || body[k] !== undefined;
  if (has('firstName')) d.firstName = v.str(body.firstName, 'firstName', { required: true, max: 100 });
  if (has('lastName'))  d.lastName  = v.str(body.lastName, 'lastName', { required: true, max: 100 });
  if (has('phone'))     d.phone     = v.str(body.phone, 'phone', { required: true, max: 40 });
  if (body.email !== undefined) d.email = v.email(body.email, 'email');
  // address/city/zip are NOT NULL columns: blank → '' rather than null
  for (const k of ['address', 'city', 'zip']) {
    if (has(k)) d[k] = v.str(body[k], k, { max: k === 'zip' ? 20 : 200, allowNull: false });
  }
  if (body.state !== undefined) d.state = v.str(body.state, 'state', { max: 50, allowNull: false }) || brand.defaultState;
  if (body.type !== undefined)  d.type  = v.oneOf(body.type, v.CUSTOMER_TYPES, 'type') || 'residential';
  if (body.notes !== undefined) d.notes = v.str(body.notes, 'notes', { max: 5000 });
  return d;
}

// GET /api/customers
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';
    const type   = typeof req.query.type === 'string' ? req.query.type : '';
    const where = { ...customerScope(req.user) };
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName:  { contains: search, mode: 'insensitive' } },
        { phone:     { contains: search } },
        { email:     { contains: search, mode: 'insensitive' } },
      ];
    }
    const customers = await prisma.customer.findMany({
      where,
      include: { _count: { select: { jobs: true } } },
      orderBy: { lastName: 'asc' },
    });
    res.json(customers);
  } catch (err) { next(err); }
});

// GET /api/customers/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    await assertCustomerAccess(req.user, id);
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        jobs: { orderBy: { createdAt: 'desc' }, include: { quote: true, invoice: true, technician: { select: { id: true, firstName: true, lastName: true } } } },
        communications: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!customer) throw notFound('Customer not found');
    res.json(customer);
  } catch (err) { next(err); }
});

// POST /api/customers
router.post('/', requireAuth, requireRole(...OFFICE), async (req, res, next) => {
  try {
    const data = customerFields(req.body || {}, { create: true });
    if (!data.state) data.state = brand.defaultState;
    if (!data.type) data.type = 'residential';
    const customer = await prisma.customer.create({ data });
    res.status(201).json(customer);
  } catch (err) { next(err); }
});

// PATCH /api/customers/:id — optimistic locking (version required)
async function updateCustomer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const body = req.body || {};
    const data = customerFields(body);
    const customer = await optimisticUpdate('customer', id, { ...data, version: body.version });
    res.json(customer);
  } catch (err) { next(err); }
}
router.patch('/:id', requireAuth, requireRole(...OFFICE), updateCustomer);
// PUT /api/customers/:id — alias for PATCH (partial update, version required)
router.put('/:id', requireAuth, requireRole(...OFFICE), updateCustomer);

// DELETE /api/customers/:id — admin+; 409 while jobs/comms reference it
router.delete('/:id', requireAuth, requireRole(...ADMIN), async (req, res, next) => {
  try {
    await prisma.customer.delete({ where: { id: parseId(req.params.id) } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
