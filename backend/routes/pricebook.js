/**
 * routes/pricebook.js
 * PriceBook CRUD. One database = one company, so GET lists every active item
 * (WL-4: switching BRAND_TRADE_TYPE / BRAND_INDUSTRY_LABEL no longer hides the
 * book). ?industry=<label> filters explicitly. POST stamps brand.industryLabel.
 * taxRateKey (Phase 2b) must be one of the BRAND_TAX_RATES keys (or blank).
 *
 * Reads: anyone signed in. Writes: PRICING roles (admin / super-admin) only —
 * technicians and dispatchers cannot change prices (RT-8). Fields are
 * whitelisted (no id / createdAt rewrite) and price / cost must be finite
 * amounts >= 0 (RT-11).
 */

const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('./auth');
const { PRICING } = require('../helpers/roles');
const { parseId, notFound } = require('../helpers/httpError');
const v = require('../helpers/validate');
const brand = require('../../brand.config');
const { getLocale } = require('../helpers/locale');

const prisma = require('../helpers/prisma');

function itemFields(body, { create = false } = {}) {
  const d = {};
  if (create || body.category !== undefined) d.category = v.str(body.category, 'category', { required: true, max: 100 });
  if (create || body.name !== undefined)     d.name     = v.str(body.name, 'name', { required: true, max: 200 });
  if (body.industry !== undefined)    d.industry    = v.str(body.industry, 'industry', { max: 100 }) || brand.industryLabel;
  if (body.subcategory !== undefined) d.subcategory = v.str(body.subcategory, 'subcategory', { max: 100 });
  if (body.description !== undefined) d.description = v.str(body.description, 'description', { max: 2000 });
  if (body.unit !== undefined)        d.unit        = v.str(body.unit, 'unit', { max: 40 });
  if (body.taskCode !== undefined)    d.taskCode    = v.str(body.taskCode, 'taskCode', { max: 60 });
  if (body.price !== undefined)       d.price       = v.money(body.price, 'price', { required: false, min: 0 });
  if (body.cost !== undefined)        d.cost        = v.money(body.cost, 'cost', { required: false, min: 0 });
  if (body.taxable !== undefined)     d.taxable     = v.bool(body.taxable, 'taxable');
  if (body.active !== undefined)      d.active      = v.bool(body.active, 'active');
  if (body.taxRateKey !== undefined) {
    const keys = getLocale().taxRates.map((r) => r.key);
    const k = v.str(body.taxRateKey, 'taxRateKey', { max: 30 });
    d.taxRateKey = k == null ? null : v.oneOf(k.toLowerCase(), keys, 'taxRateKey');
  }
  for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
  return d;
}

// GET /api/pricebook — every item of this company; ?industry= filters explicitly
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const q = req.query;
    const s = (x) => (typeof x === 'string' ? x : '');
    const where = { active: s(q.active) === 'false' ? false : true };
    if (s(q.industry)) where.industry = s(q.industry);
    if (s(q.category)) where.category = s(q.category);
    if (s(q.search))   where.name = { contains: s(q.search).slice(0, 100), mode: 'insensitive' };

    const items = await prisma.priceBookItem.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    // `industry` keeps its old meaning for the UI: the label being shown
    res.json({ industry: where.industry || brand.industryLabel, tradeType: brand.tradeType, items });
  } catch (err) { next(err); }
});

// GET /api/pricebook/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const item = await prisma.priceBookItem.findUnique({ where: { id: parseId(req.params.id) } });
    if (!item) throw notFound('PriceBook item not found');
    res.json(item);
  } catch (err) { next(err); }
});

// POST /api/pricebook
router.post('/', requireAuth, requireRole(...PRICING), async (req, res, next) => {
  try {
    const d = itemFields(req.body || {}, { create: true });
    const item = await prisma.priceBookItem.create({
      data: { industry: brand.industryLabel, price: 0, cost: 0, taxable: false, ...d },
    });
    res.status(201).json(item);
  } catch (err) { next(err); }
});

// PATCH /api/pricebook/:id (PUT is an alias — both are partial updates)
async function updateItem(req, res, next) {
  try {
    const item = await prisma.priceBookItem.update({ where: { id: parseId(req.params.id) }, data: itemFields(req.body || {}) });
    res.json(item);
  } catch (err) { next(err); }
}
router.patch('/:id', requireAuth, requireRole(...PRICING), updateItem);
router.put('/:id', requireAuth, requireRole(...PRICING), updateItem);

// DELETE /api/pricebook/:id — soft delete
router.delete('/:id', requireAuth, requireRole(...PRICING), async (req, res, next) => {
  try {
    await prisma.priceBookItem.update({ where: { id: parseId(req.params.id) }, data: { active: false } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
