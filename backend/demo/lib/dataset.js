/**
 * demo/lib/dataset.js — build a complete, deterministic demo dataset in memory.
 *
 *   buildDataset({ brand, prospect, locale, now, seed })
 *
 * Pure: no database, no process.env. Same inputs (incl. `now`) → same output.
 * Dates are relative to "today" in brand.timezone, so a demo never goes stale:
 * finished work in the past weeks (paid / unpaid / overdue invoices, one job
 * still to invoice), three jobs today, the next ten days booked, two pending.
 *
 * Every job's type comes from the trade fixture and is checked against
 * brand.jobTypes; quote/invoice amounts are the sum of the pricebook lines the
 * job template names, so they are > 0 and match the pricebook on screen.
 *
 * Each job also gets an activity trail (job.activity, GTM-18) that tells the
 * same story as its final state: created by the dispatcher, quote, assigned +
 * scheduled, sometimes moved, started / finished by the technician, invoiced.
 * Actors are team emails and times are ISO strings (never after `now`);
 * demo/lib/seed.js turns them into JobActivity rows with real ids.
 */
'use strict';

const { localDate, addDays, zonedToUtc } = require('./dates');
const { loadTrade } = require('./fixtures');
const { JOB_TYPES_BY_COUNTRY, resolveJobType } = require('../../helpers/brandValidate');

// ── deterministic RNG ───────────────────────────────────────────────────────
function hash32(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed) {
  const r = mulberry32(hash32(seed));
  return {
    next: r,
    int: (lo, hi) => lo + Math.floor(r() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    shuffle: (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    },
  };
}

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

/**
 * The activity trail of one job, oldest first:
 * [{ type, actor (team email), at (ISO), ...symbolic payload }].
 * Payload keys: `from`/`to` for status, `tech` for assigned (an email),
 * `fromTime` for rescheduled (the time it was first booked for).
 */
function activityTrail(job, { office, dispatcher, nowMs, index }) {
  const t0 = Date.parse(job.createdAt);
  const ev = [];
  const add = (ms, e) => ev.push({ ms: Math.max(t0, Math.min(ms, nowMs)), ...e });
  add(t0, { type: 'created', actor: dispatcher });
  if (job.notes) add(t0 + 15 * MIN, { type: 'note', actor: dispatcher });
  if (job.quote) add(Date.parse(job.quote.createdAt), { type: 'quote_created', actor: office });
  const booked = ['scheduled', 'in-progress', 'completed'].includes(job.status);
  if (job.techEmail) add(t0 + 2 * HOUR, { type: 'assigned', actor: dispatcher, tech: job.techEmail });
  if (booked) add(t0 + 2 * HOUR + MIN, { type: 'status_changed', actor: dispatcher, from: 'pending', to: 'scheduled' });
  const startMs = job.scheduledAt ? Date.parse(job.scheduledAt) : null;
  // every fourth booked job was moved once — "customer asked for another time"
  if (booked && job.scheduledTime && index % 4 === 1 && startMs && t0 + DAY < Math.min(startMs, nowMs)) {
    add(t0 + DAY, { type: 'rescheduled', actor: dispatcher, fromTime: job.scheduledTime === '08:00' ? '13:00' : '08:00' });
  }
  if (job.status === 'in-progress' || job.status === 'completed') {
    add(startMs, { type: 'status_changed', actor: job.techEmail || dispatcher, from: 'scheduled', to: 'in-progress' });
  }
  if (job.status === 'completed') {
    add(Date.parse(job.completedAt), { type: 'status_changed', actor: job.techEmail || dispatcher, from: 'in-progress', to: 'completed' });
  }
  if (job.invoice) add(Date.parse(job.invoice.createdAt), { type: 'invoice_created', actor: office });
  // stable by time (ties keep the story order above)
  return ev.map((e, i) => ({ e, i })).sort((a, b) => a.e.ms - b.e.ms || a.i - b.i)
    .map(({ e: { ms, ...rest } }) => ({ ...rest, at: new Date(ms).toISOString() }));
}

const ascii = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
const round2 = (n) => Math.round(n * 100) / 100;

// ── schedule plan (offset in days from today, wall time, statuses) ───────────
// `due` invoices: 'overdue' | 'paid' | 'unpaid' | null (completed, not invoiced yet)
function schedulePlan(termsDays) {
  return [
    { day: -(termsDays + 10), time: '09:00', status: 'completed', invoice: 'overdue' },
    { day: -16, time: '08:00', status: 'completed', invoice: 'paid' },
    { day: -9,  time: '13:00', status: 'completed', invoice: 'paid' },
    { day: -5,  time: '10:30', status: 'completed', invoice: 'unpaid' },
    { day: -2,  time: '08:00', status: 'completed', invoice: 'unpaid' },
    { day: -1,  time: '13:00', status: 'completed', invoice: null },
    { day: 0,   time: '08:00', status: 'in-progress' },
    { day: 0,   time: '10:30', status: 'scheduled' },
    { day: 0,   time: '13:30', status: 'scheduled' },
    { day: 1,   time: '09:00', status: 'scheduled', quote: 'approved' },
    { day: 2,   time: '08:00', status: 'scheduled' },
    { day: 3,   time: '13:00', status: 'scheduled', quote: 'approved' },
    { day: 6,   time: '10:00', status: 'pending', quote: 'sent', unassigned: true },
    { day: null, time: null,   status: 'pending', quote: 'draft', unassigned: true },
  ];
}

function extendPlan(plan, n) {
  const out = plan.slice(0, n);
  for (let i = plan.length; i < n; i++) {
    out.push({ day: 7 + (i - plan.length) * 2, time: ['08:00', '10:30', '13:00'][i % 3], status: 'scheduled' });
  }
  return out;
}

/** Move a non-today date off the weekend (past → Friday, future → Monday). */
function weekday(ymd, direction) {
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  if (dow === 6) return addDays(ymd, direction < 0 ? -1 : 2);
  if (dow === 0) return addDays(ymd, direction < 0 ? -2 : 1);
  return ymd;
}

function phoneFactory(locale, prospect) {
  let nn = 0;
  const area = (prospect.area && prospect.area.phoneAreaCode) || '555';
  return (kind = 'mobile') => {
    nn += 1;
    if (nn > 99) nn = 1;
    const tpl = locale.phone[kind] || locale.phone.mobile;
    return tpl.replace('{area}', area).replace('{nn}', String(nn).padStart(2, '0'));
  };
}

function postcodeFor(town, locale, rng) {
  if (town.routingKey) {
    const chars = (locale.postcode && locale.postcode.uniqueChars) || 'ACDEFHKNPRTVWXY0123456789';
    let id = '';
    for (let i = 0; i < 4; i++) id += chars[rng.int(0, chars.length - 1)];
    return `${town.routingKey} ${id}`;
  }
  return rng.pick(town.postcodes || ['00000']);
}

function buildDataset({ brand, prospect, locale, now = new Date(), seed } = {}) {
  if (!brand || !prospect || !locale) throw new Error('buildDataset needs { brand, prospect, locale }');
  const tz = brand.timezone;
  const trade = loadTrade(brand.tradeType, locale);
  const seedStr = seed || prospect.seed || `${prospect.slug}:${brand.tradeType}:${locale.code}`;
  const rng = makeRng(seedStr);
  const nextPhone = phoneFactory(locale, prospect);
  const today = localDate(now, tz);
  const state = (prospect.area && prospect.area.state) || brand.defaultState;
  const termsDays = locale.invoiceTermsDays || 14;
  const nowMs = now.getTime();
  const iso = (ms) => new Date(Math.min(ms, nowMs)).toISOString();
  nextPhone('landline'); // nn=01 is the company's own number

  // ── pricebook / inventory ─────────────────────────────────────────────────
  const pricebook = trade.pricebook.map((p) => ({
    industry: brand.industryLabel,
    category: p.category,
    name: p.name,
    description: p.description || null,
    price: p.price,
    cost: p.cost || 0,
    unit: p.unit || 'ea',
    taxable: !!p.taxable,
    baseName: p.baseName,
  }));
  const priceByBase = new Map(pricebook.map((p) => [p.baseName, p]));
  const inventory = trade.inventory.map((i) => ({
    name: i.name, sku: i.sku || null, description: i.description || null,
    unitCost: i.unitCost, quantity: i.quantity ?? 10, minQuantity: i.minQuantity ?? 2,
    category: i.category || 'general', location: 'Van stock', baseName: i.baseName,
  }));
  const invByBase = new Map(inventory.map((i) => [i.baseName, i]));

  // ── team ──────────────────────────────────────────────────────────────────
  const usedNames = new Set();
  const personName = () => {
    for (let i = 0; i < 200; i++) {
      const f = rng.pick(locale.firstNames); const l = rng.pick(locale.lastNames);
      if (!usedNames.has(f) && !usedNames.has(l)) { usedNames.add(f); usedNames.add(l); return [f, l]; }
    }
    return [rng.pick(locale.firstNames), rng.pick(locale.lastNames)];
  };
  const teamSpec = prospect.team || [
    { role: 'admin', local: 'office' }, { role: 'dispatcher', local: 'dispatch' },
    { role: 'technician', local: 'tech1' }, { role: 'technician', local: 'tech2' }, { role: 'technician', local: 'tech3' },
  ];
  const team = teamSpec.map((m) => {
    let { firstName, lastName } = m;
    if (firstName) { usedNames.add(firstName); usedNames.add(lastName); } else [firstName, lastName] = personName();
    return { email: `${m.local}@${prospect.emailDomain}`, firstName, lastName, role: m.role, phone: nextPhone('mobile') };
  });
  const techs = team.filter((t) => t.role === 'technician');
  if (!techs.length) throw new Error(`Prospect ${prospect.slug}: team needs at least one technician`);

  // ── customers ─────────────────────────────────────────────────────────────
  const nCust = Math.max(4, (prospect.counts && prospect.counts.customers) || 10);
  const nCommercial = Math.max(1, Math.round(nCust / 5));
  const commercialNames = rng.shuffle(locale.commercial);
  const custNotes = ['Prefers a text before arrival.', 'Side gate code 4512; friendly dog.', null, 'Elderly homeowner — call the day before.', null, 'Park on the street, not the drive.', null];
  const customers = [];
  for (let i = 0; i < nCust; i++) {
    const commercial = i >= nCust - nCommercial;
    const town = prospect.area.towns[i % prospect.area.towns.length];
    const [lo, hi] = locale.houseNumber || [1, 999];
    let firstName; let lastName; let email;
    if (commercial) {
      [firstName, lastName] = commercialNames[(i - (nCust - nCommercial)) % commercialNames.length];
      email = `accounts@${ascii(firstName + lastName)}.example`;
    } else {
      [firstName, lastName] = personName();
      email = `${ascii(firstName)}.${ascii(lastName)}@${locale.customerEmailDomain || 'example.com'}`;
    }
    customers.push({
      key: `c${i + 1}`,
      firstName, lastName, email,
      phone: nextPhone(commercial ? 'landline' : 'mobile'),
      address: `${rng.int(lo, hi)} ${rng.pick(locale.streets)}`,
      city: town.name,
      state,
      zip: postcodeFor(town, locale, rng),
      type: commercial ? 'commercial' : 'residential',
      notes: commercial ? 'Net 30. PO number required on invoices.' : custNotes[i % custNotes.length],
      createdAt: iso(nowMs - rng.int(30, 400) * 86400000),
    });
  }
  const resCust = customers.filter((c) => c.type === 'residential');
  const comCust = customers.filter((c) => c.type === 'commercial');

  // ── jobs ──────────────────────────────────────────────────────────────────
  const nJobs = Math.min(30, Math.max(6, (prospect.counts && prospect.counts.jobs) || 14));
  const plan = extendPlan(schedulePlan(termsDays), nJobs);
  // every trade fixture has >= 30 templates (the most a prospect may ask for), so
  // titles never repeat; tests/whitelabel.test.js checks that for each trade × country
  const templates = rng.shuffle(trade.jobs);
  const jobs = [];
  let resI = 0; let comI = 0; let techI = 0;
  plan.forEach((slot, i) => {
    const t = templates[i % templates.length];
    // The fixture's type (US wording, or loc.<CC>.type) mapped onto the brand's list
    // (country wording or BRAND_JOB_TYPES) — stored job types always match /api/brand.
    const known = [...(JOB_TYPES_BY_COUNTRY.US[brand.tradeType] || []), ...(JOB_TYPES_BY_COUNTRY.IE[brand.tradeType] || [])];
    if (!known.includes(t.type)) {
      throw new Error(`Trade fixture ${brand.tradeType}: job "${t.title}" has type "${t.type}", not a ${brand.tradeType} job type`);
    }
    const jobType = resolveJobType(t.type, brand.jobTypes, { tradeType: brand.tradeType, country: brand.jobTypesCountry || locale.code });
    const lines = (t.items || []).map(([ref, qty]) => {
      const p = priceByBase.get(ref);
      if (!p) throw new Error(`Trade fixture ${brand.tradeType}: job "${t.baseName}" refers to unknown pricebook item "${ref}"`);
      return { name: p.name, qty, price: p.price };
    });
    const amount = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
    if (!(amount > 0)) throw new Error(`Trade fixture ${brand.tradeType}: job "${t.baseName}" totals ${amount}`);

    const customer = t.customer === 'commercial' && comCust.length
      ? comCust[comI++ % comCust.length] : resCust[resI++ % resCust.length];
    const tech = slot.unassigned ? null : techs[techI++ % techs.length];

    let scheduledDate = null; let scheduledAt = null;
    if (slot.day !== null) {
      scheduledDate = addDays(today, slot.day);
      if (slot.day !== 0) scheduledDate = weekday(scheduledDate, slot.day);
      scheduledAt = zonedToUtc(scheduledDate, slot.time, tz);
    }
    const durationH = t.durationH || 2;
    const completedAt = slot.status === 'completed' ? new Date(scheduledAt.getTime() + Math.min(durationH, 10) * 3600000) : null;
    const created = scheduledAt && scheduledAt.getTime() <= nowMs
      ? scheduledAt.getTime() - rng.int(2, 9) * 86400000 - i * 7 * 60000
      : nowMs - rng.int(1, 4) * 86400000 - i * 7 * 60000; // distinct times: "Recent Jobs" has one true order

    let quote = null;
    if (slot.quote || amount >= 750) {
      const status = slot.quote || 'approved';
      quote = { amount, status, notes: lines.map((l) => `${l.qty} × ${l.name}`).join('; '), createdAt: iso(created + 3600000) };
    }

    let invoice = null;
    if (slot.status === 'completed' && slot.invoice) {
      const completedYmd = localDate(completedAt, tz);
      // calendar date, canonical UTC midnight (helpers/calendarDate.js)
      const due = new Date(`${addDays(completedYmd, termsDays)}T00:00:00.000Z`);
      const paid = slot.invoice === 'paid' ? new Date(completedAt.getTime() + 4 * 86400000) : null;
      invoice = {
        amount,
        status: slot.invoice,
        dueDate: due.toISOString(),
        paidAt: paid ? iso(paid.getTime()) : null,
        notes: lines.map((l) => `${l.qty} × ${l.name}`).join('; '),
        createdAt: iso(completedAt.getTime() + 2 * 3600000),
      };
    }

    const parts = (slot.status === 'completed' || slot.status === 'in-progress')
      ? (t.parts || []).map(([ref, quantity]) => {
        const inv = invByBase.get(ref);
        if (!inv) throw new Error(`Trade fixture ${brand.tradeType}: job "${t.baseName}" refers to unknown inventory item "${ref}"`);
        return { inventoryName: inv.name, quantity, unitCost: inv.unitCost };
      })
      : [];

    const urgent = /not igniting|not firing|dead|warm air|not heating|leak/i.test(t.baseName);
    jobs.push({
      key: `j${i + 1}`,
      title: t.title,
      type: jobType,
      status: slot.status,
      priority: t.priority || (urgent && slot.status !== 'completed' ? 'high' : slot.status === 'pending' ? 'low' : 'normal'),
      tradeType: brand.tradeType,
      scheduledDate,
      scheduledTime: slot.time,
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      duration: durationH,
      completedAt: completedAt ? iso(completedAt.getTime()) : null,
      createdAt: iso(created),
      notes: t.notes || null,
      customerKey: customer.key,
      techEmail: tech ? tech.email : null,
      amount,
      quote,
      invoice,
      parts,
    });
  });

  // ── activity trails (GTM-18) ──────────────────────────────────────────────
  const officeEmail = (team.find((m) => m.role === 'admin') || team[0]).email;
  const dispatchEmail = (team.find((m) => m.role === 'dispatcher' || m.role === 'office') || team.find((m) => m.role === 'admin') || team[0]).email;
  jobs.forEach((j, index) => { j.activity = activityTrail(j, { office: officeEmail, dispatcher: dispatchEmail, nowMs, index }); });

  // ── communications (a few, so customer pages are not empty) ───────────────
  const office = brand.companyEmail || `office@${prospect.emailDomain}`;
  const custByKey = new Map(customers.map((c) => [c.key, c]));
  const communications = [];
  for (const j of jobs) {
    const c = custByKey.get(j.customerKey);
    if (j.invoice) {
      communications.push({ customerKey: c.key, type: 'email', direction: 'outbound', subject: `Invoice: ${j.title}`,
        body: `Thanks for choosing ${brand.companyName}. Your invoice for "${j.title}" is attached.`, from: office, to: c.email, createdAt: j.invoice.createdAt });
    } else if (j.quote && (j.quote.status === 'sent' || j.quote.status === 'approved') && j.status !== 'completed') {
      communications.push({ customerKey: c.key, type: 'email', direction: 'outbound', subject: `Your quote: ${j.title}`,
        body: `Hi ${c.firstName}, please find your quote for "${j.title}" attached. Reply to this email with any questions.`, from: office, to: c.email, createdAt: j.quote.createdAt });
    }
    if (j.status === 'in-progress') {
      communications.push({ customerKey: c.key, type: 'call', direction: 'inbound', subject: 'Arrival check',
        body: `${c.firstName} called to check the ${brand.technicianLabel.toLowerCase()} was on the way. Confirmed.`, from: c.phone, to: brand.companyPhone || office, createdAt: iso(nowMs - 3600000) });
    }
  }
  communications.push({ customerKey: customers[0].key, type: 'note', direction: 'outbound', subject: 'Access',
    body: 'Side gate code 4512. Friendly dog in the back yard.', from: office, to: null, createdAt: iso(nowMs - 20 * 86400000) });

  return {
    meta: {
      prospect: prospect.slug, trade: brand.tradeType, industry: brand.industryLabel, locale: locale.code,
      timezone: tz, today, seed: seedStr, generatedAt: now.toISOString(),
    },
    team, customers, pricebook, inventory, jobs, communications,
  };
}

module.exports = { buildDataset, makeRng, hash32, schedulePlan, activityTrail };
