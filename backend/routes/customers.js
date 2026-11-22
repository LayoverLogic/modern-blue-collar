/**
 * routes/customers.js
 * Customer CRUD. Address rules and the default state come from the locale
 * (helpers/locale.js: BRAND_COUNTRY, BRAND_DEFAULT_STATE). New customers get
 * country = BRAND_COUNTRY unless one is sent.
 *
 * Access (helpers/roles.js, helpers/access.js):
 *   read    office roles: all; technicians: customers on their assigned jobs
 *           (every customer with TECH_VISIBILITY=all; helpers/access.js)
 *   create / edit   office roles
 *   delete          admin / super-admin
 * PATCH/PUT require `version` (optimistic locking, atomic — RT-9).
 */

const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { optimisticUpdate } = require('../helpers/optimisticUpdate');
const { OFFICE, ADMIN, isOffice } = require('../helpers/roles');
const { customerReadScope, assertCustomerRead, redactJob } = require('../helpers/access');
const { parseId, notFound, badRequest } = require('../helpers/httpError');
const v = require('../helpers/validate');
const { getLocale, validateAddress } = require('../helpers/locale');
const { normalisePhone, digitsForSearch } = require('../helpers/phone');

const prisma = require('../helpers/prisma');
const { DOCS_INCLUDE, withDocs } = require('../helpers/jobDocs');

/**
 * Validate customer fields present in `body`. `create` makes required ones
 * required. Address rules come from the locale (helpers/locale.js): required
 * fields per country (none for US — today's behaviour; IE: address line 1,
 * town, county), ZIP / Eircode format when given. Blank city / zip / state are
 * stored as null (never a 500 — WL-11).
 */
function customerFields(body, { create = false } = {}) {
  const d = {};
  const has = (k) => create || body[k] !== undefined;
  if (has('firstName')) d.firstName = v.str(body.firstName, 'firstName', { required: true, max: 100 });
  if (has('lastName'))  d.lastName  = v.str(body.lastName, 'lastName', { required: true, max: 100 });
  // phone: validated here, normalised to E.164 by withPhone() once the country is known
  if (has('phone'))     d.phone     = v.str(body.phone, 'phone', { required: true, max: 40 });
  if (body.email !== undefined) d.email = v.email(body.email, 'email');
  // address is a NOT NULL column: blank → ''
  if (has('address')) d.address = v.str(body.address, 'address', { max: 200, allowNull: false });
  for (const [k, max] of [['addressLine2', 200], ['city', 200], ['state', 50], ['zip', 20], ['company', 200], ['taxNumber', 40]]) {
    if (body[k] !== undefined) d[k] = v.str(body[k], k, { max });
  }
  if (body.country !== undefined) {
    const c = v.str(body.country, 'country', { max: 2 });
    if (c != null && !/^[A-Za-z]{2}$/.test(c)) throw badRequest('country must be a 2-letter ISO country code (e.g. US, IE)', { code: 'INVALID_INPUT', field: 'country' });
    d.country = c ? c.toUpperCase() : null;
  }
  if (body.type !== undefined)  d.type  = v.oneOf(body.type, v.CUSTOMER_TYPES, 'type') || 'residential';
  if (body.notes !== undefined) d.notes = v.str(body.notes, 'notes', { max: 5000 });
  return d;
}

/**
 * WL-12: store the phone in E.164. National numbers are read with the rules of
 * the customer's country (US, IE; no country → the brand country). Customers in
 * a country without national rules (e.g. GB) need international format (+44 …).
 * 400 INVALID_PHONE when it cannot be normalised.
 */
function withPhone(d, currentCountry) {
  if (d.phone === undefined) return d;
  const country = (d.country || currentCountry || getLocale().country).toUpperCase();
  return { ...d, phone: normalisePhone(d.phone, 'phone', { required: true, country }) };
}

// GET /api/customers
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : '';
    const type   = typeof req.query.type === 'string' ? req.query.type : '';
    const where = { ...customerReadScope(req.user) }; // TECH_VISIBILITY=all: technicians read every customer
    if (type) where.type = type;
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName:  { contains: search, mode: 'insensitive' } },
        { phone:     { contains: search } },
        // phones are stored as E.164: "620-555" / "087 12" also match by digits
        ...digitsForSearch(search).map((d) => ({ phone: { contains: d } })),
        { email:     { contains: search, mode: 'insensitive' } },
        { company:   { contains: search, mode: 'insensitive' } },
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
    await assertCustomerRead(req.user, id);
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        jobs: { orderBy: { createdAt: 'desc' }, include: { ...DOCS_INCLUDE, technician: { select: { id: true, firstName: true, lastName: true } } } },
        communications: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!customer) throw notFound('Customer not found');
    customer.jobs = customer.jobs.map(withDocs);
    if (isOffice(req.user)) return res.json(customer);
    // Technicians: billing only on their own jobs; communications only for
    // customers on one of their jobs (matters with TECH_VISIBILITY=all).
    const mine = customer.jobs.some((j) => j.technicianId === req.user.id);
    res.json({ ...customer, jobs: customer.jobs.map((j) => redactJob(req.user, j)), communications: mine ? customer.communications : [] });
  } catch (err) { next(err); }
});

// POST /api/customers
router.post('/', requireAuth, requireRole(...OFFICE), async (req, res, next) => {
  try {
    const locale = getLocale();
    let data = customerFields(req.body || {}, { create: true });
    if (!data.country) data.country = locale.country;
    if (!data.state && data.country === locale.country && locale.defaultState) data.state = locale.defaultState;
    if (!data.type) data.type = 'residential';
    data = validateAddress(data, { create: true }, locale);
    data = withPhone(data);
    const customer = await prisma.customer.create({ data });
    res.status(201).json(customer);
  } catch (err) { next(err); }
});

// PATCH /api/customers/:id — optimistic locking (version required)
async function updateCustomer(req, res, next) {
  try {
    const id = parseId(req.params.id);
    const body = req.body || {};
    let data = customerFields(body);
    if (['address', 'city', 'state', 'zip', 'country', 'phone'].some((k) => k in data)) {
      const current = await prisma.customer.findUnique({ where: { id }, select: { address: true, city: true, state: true, zip: true, country: true } });
      if (!current) throw notFound('Customer not found');
      if (['address', 'city', 'state', 'zip', 'country'].some((k) => k in data)) data = validateAddress(data, { current }, getLocale());
      data = withPhone(data, current.country);
    }
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
