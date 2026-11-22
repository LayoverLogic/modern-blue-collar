/**
 * demo/lib/seed.js — write a demo dataset to the database.
 *
 *   inspectDemoState(prisma, brand, dataset)  → { jobs, otherTrades, seeded, pricebookOtherIndustries }
 *   resetDemoData(prisma, { keepEmails })     → wipes business data (demo DBs only — callers guard)
 *   seedPricebook(prisma, dataset)            → idempotent per (industry, category, name)
 *   seedInventory(prisma, dataset)            → idempotent per name
 *   seedPeopleAndJobs(prisma, dataset, opts)  → team, customers, jobs, quotes, invoices, parts, comms,
 *                                               activity trails (GTM-18)
 *   writeActivityTrail(prisma, job, spec, ctx)  → JobActivity rows for one seeded job
 *
 * Trade switching (WL-4): the database does not know which trade it was seeded
 * for, so inspectDemoState looks at Job.tradeType. If the DB holds jobs for a
 * different trade, seeding stops and asks for --reset rather than mixing a
 * plumbing demo into an electrical one.
 */
'use strict';

const bcrypt = require('bcryptjs');
const activity = require('../../helpers/activity');

/**
 * Turn a dataset job's symbolic trail (demo/lib/dataset.js activityTrail) into
 * JobActivity rows with real ids. `job` is the DB row; quote/invoice the DB
 * rows (or null); userByEmail maps team emails to users.
 */
async function writeActivityTrail(prisma, job, spec, { userByEmail, quote = null, invoice = null }) {
  const uid = (email) => { const u = email && userByEmail.get(email); return u ? u.id : null; };
  const uname = (email) => { const u = email && userByEmail.get(email); return u ? `${u.firstName} ${u.lastName}` : null; };
  const moved = spec.activity.find((e) => e.type === 'rescheduled');
  let n = 0;
  for (const e of spec.activity) {
    const p = {};
    switch (e.type) {
      case 'created':
        p.to = activity.snapshot({ ...job, status: 'pending', technicianId: null, scheduledTime: moved ? moved.fromTime : job.scheduledTime });
        break;
      case 'note': p.from = { notes: null }; p.to = { notes: job.notes }; break;
      case 'quote_created':
        if (!quote) continue;
        p.to = { quoteId: quote.id, amount: quote.amount, status: 'draft' };
        break;
      case 'assigned':
        p.from = { technicianId: null, technicianName: null };
        p.to = { technicianId: uid(e.tech), technicianName: uname(e.tech) };
        break;
      case 'status_changed': p.from = { status: e.from }; p.to = { status: e.to }; break;
      case 'rescheduled': p.from = { scheduledTime: e.fromTime }; p.to = { scheduledTime: job.scheduledTime }; break;
      case 'invoice_created':
        if (!invoice) continue;
        p.to = { invoiceId: invoice.id, amount: invoice.amount, status: 'unpaid' };
        break;
      default: break;
    }
    await activity.log(prisma, { userId: uid(e.actor) }, job.id, e.type, { ...p, at: new Date(e.at) });
    n++;
  }
  return n;
}

async function inspectDemoState(prisma, brand, dataset) {
  const jobs = await prisma.job.count();
  const trades = await prisma.job.groupBy({ by: ['tradeType'], _count: { _all: true } });
  const otherTrades = trades.filter((t) => t.tradeType && t.tradeType !== brand.tradeType)
    .map((t) => ({ tradeType: t.tradeType, jobs: t._count._all }));
  const officeEmail = dataset.team[0] && dataset.team[0].email;
  const seeded = officeEmail ? !!(await prisma.user.findUnique({ where: { email: officeEmail } })) : false;
  const industries = await prisma.priceBookItem.groupBy({ by: ['industry'], _count: { _all: true } });
  const pricebookOtherIndustries = industries.filter((i) => i.industry !== brand.industryLabel)
    .map((i) => ({ industry: i.industry, items: i._count._all }));
  return { jobs, otherTrades, seeded, pricebookOtherIndustries };
}

/**
 * Delete all business data: photos, parts, quotes, invoices, jobs, communications,
 * customers, pricebook, inventory and every user except super-admins, users in
 * keepEmails (ADMIN_EMAIL) and users that own API keys. Only ever call this on a
 * database that passed assertDemoDatabase().
 */
async function resetDemoData(prisma, { keepEmails = [] } = {}) {
  const counts = {};
  await prisma.$transaction(async (tx) => {
    counts.activity = (await tx.jobActivity.deleteMany({})).count;
    counts.photos = (await tx.jobPhoto.deleteMany({})).count;
    counts.parts = (await tx.jobPart.deleteMany({})).count;
    counts.quotes = (await tx.quote.deleteMany({})).count;
    counts.invoices = (await tx.invoice.deleteMany({})).count;
    counts.jobs = (await tx.job.deleteMany({})).count;
    counts.communications = (await tx.communication.deleteMany({})).count;
    counts.customers = (await tx.customer.deleteMany({})).count;
    counts.pricebook = (await tx.priceBookItem.deleteMany({})).count;
    counts.inventory = (await tx.inventoryItem.deleteMany({})).count;
    counts.users = (await tx.user.deleteMany({
      where: { role: { not: 'super-admin' }, email: { notIn: keepEmails.filter(Boolean) }, apiKeys: { none: {} } },
    })).count;
  });
  return counts;
}

async function seedPricebook(prisma, dataset) {
  let created = 0; let skipped = 0;
  for (const { baseName, ...item } of dataset.pricebook) {
    const exists = await prisma.priceBookItem.findFirst({
      where: { industry: item.industry, category: item.category, name: item.name },
      select: { id: true },
    });
    if (exists) { skipped++; continue; }
    await prisma.priceBookItem.create({ data: item });
    created++;
  }
  return { created, skipped };
}

async function seedInventory(prisma, dataset) {
  let created = 0; let skipped = 0;
  for (const { baseName, ...item } of dataset.inventory) {
    const exists = await prisma.inventoryItem.findFirst({
      where: { OR: [{ name: item.name }, ...(item.sku ? [{ sku: item.sku }] : [])] }, select: { id: true },
    });
    if (exists) { skipped++; continue; }
    await prisma.inventoryItem.create({ data: item });
    created++;
  }
  return { created, skipped };
}

async function seedPeopleAndJobs(prisma, dataset, { password }) {
  if (!password) {
    throw new Error('DEFAULT_PASSWORD is not set — it is the password for the seeded demo team (e.g. DEFAULT_PASSWORD=demo1234 in .env.sandbox).');
  }
  const hash = await bcrypt.hash(password, 10);
  const out = { users: 0, customers: 0, jobs: 0, quotes: 0, invoices: 0, parts: 0, communications: 0, activity: 0 };

  // Seeded documents carry the instance currency (BRAND_COUNTRY / BRAND_CURRENCY),
  // not the column default USD — an Irish demo shows EUR.
  const currency = require('../../helpers/locale').getLocale().currency;

  const userByEmail = new Map();
  for (const t of dataset.team) {
    let u = await prisma.user.findUnique({ where: { email: t.email } });
    if (!u) { u = await prisma.user.create({ data: { ...t, password: hash } }); out.users++; }
    userByEmail.set(t.email, u);
  }

  const custByKey = new Map();
  for (const { key, ...c } of dataset.customers) {
    let row = await prisma.customer.findFirst({ where: { email: c.email } });
    if (!row) { row = await prisma.customer.create({ data: { ...c, createdAt: new Date(c.createdAt) } }); out.customers++; }
    custByKey.set(key, row);
  }

  const invByName = new Map((await prisma.inventoryItem.findMany()).map((i) => [i.name, i]));

  for (const j of dataset.jobs) {
    const customer = custByKey.get(j.customerKey);
    const exists = await prisma.job.findFirst({ where: { title: j.title, customerId: customer.id }, include: { quotes: { orderBy: { createdAt: 'desc' }, take: 1 }, invoices: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (exists) {
      // Backfill: a job seeded before the activity log existed gets its trail
      // once (never on top of real activity).
      if (!(await prisma.jobActivity.count({ where: { jobId: exists.id } }))) {
        out.activity += await writeActivityTrail(prisma, exists, j, { userByEmail, quote: exists.quotes[0] || null, invoice: exists.invoices[0] || null });
      }
      continue;
    }
    const tech = j.techEmail ? userByEmail.get(j.techEmail) : null;
    const job = await prisma.job.create({
      data: {
        title: j.title,
        type: j.type,
        status: j.status,
        priority: j.priority,
        tradeType: j.tradeType,
        scheduledDate: j.scheduledDate,
        scheduledTime: j.scheduledTime,
        scheduledAt: j.scheduledAt ? new Date(j.scheduledAt) : null,
        duration: j.duration,
        completedAt: j.completedAt ? new Date(j.completedAt) : null,
        createdAt: new Date(j.createdAt),
        notes: j.notes,
        customerId: customer.id,
        technicianId: tech ? tech.id : null,
      },
    });
    out.jobs++;
    let quote = null; let invoice = null;
    if (j.quote) {
      // amount-only document: subtotal = amount, taxTotal = 0 (contract 2b §2)
      quote = await prisma.quote.create({ data: { jobId: job.id, amount: j.quote.amount, subtotal: j.quote.amount, taxTotal: 0, currency, status: j.quote.status, notes: j.quote.notes, createdAt: new Date(j.quote.createdAt), issuedAt: new Date(j.quote.createdAt) } });
      out.quotes++;
    }
    if (j.invoice) {
      invoice = await prisma.invoice.create({
        data: {
          jobId: job.id, amount: j.invoice.amount, subtotal: j.invoice.amount, taxTotal: 0, currency, status: j.invoice.status, notes: j.invoice.notes,
          issuedAt: new Date(j.invoice.createdAt),
          dueDate: new Date(j.invoice.dueDate), paidAt: j.invoice.paidAt ? new Date(j.invoice.paidAt) : null,
          createdAt: new Date(j.invoice.createdAt),
        },
      });
      out.invoices++;
    }
    for (const p of j.parts) {
      const inv = invByName.get(p.inventoryName);
      if (!inv) continue;
      await prisma.jobPart.create({ data: { jobId: job.id, inventoryItemId: inv.id, quantity: Math.ceil(p.quantity), unitCost: p.unitCost } });
      out.parts++;
    }
    out.activity += await writeActivityTrail(prisma, job, j, { userByEmail, quote, invoice });
  }

  if (out.customers) {
    for (const { customerKey, ...c } of dataset.communications) {
      const customer = custByKey.get(customerKey);
      await prisma.communication.create({ data: { ...c, customerId: customer.id, createdAt: new Date(c.createdAt) } });
      out.communications++;
    }
  }
  return out;
}

module.exports = { inspectDemoState, resetDemoData, seedPricebook, seedInventory, seedPeopleAndJobs, writeActivityTrail };
