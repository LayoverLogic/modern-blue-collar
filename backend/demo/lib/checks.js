/**
 * demo/lib/checks.js — the checks behind `npm run demo:check`.
 *
 *   runDbChecks({ prisma, brand, denylist, now, adminEmail })          → results[]
 *   runApiChecks({ base, brand, denylist, email, password })           → results[]
 *   runHeadlessChecks({ port, brand, denylist, email, password, ... }) → results[]
 *
 * A result is { level: 'PASS' | 'WARN' | 'FAIL', id, msg }. FAIL means a
 * prospect would see something wrong (client names, "undefined", $0 amounts,
 * plumbing jobs in an electrical demo, a stale calendar, a job activity feed
 * that contradicts the job); WARN is worth a look.
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { localDate } = require('./dates');
const { isReservedEmailDomain, emailDomain, denylistHits } = require('./guard');
const { loadTrade, loadLocale } = require('./fixtures');
const { TRADES } = require('../../helpers/brandValidate');

/** name (lower-case) → Set of trades whose starter pricebook has it (US + IE names). */
function starterNames() {
  const map = new Map();
  for (const cc of ['US', 'IE']) {
    const loc = loadLocale(cc);
    for (const t of TRADES) {
      for (const p of loadTrade(t, loc).pricebook) {
        const k = p.name.toLowerCase();
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(t);
      }
    }
  }
  return map;
}
const sameFamily = (a, b) => a === b || [a, b].sort().join() === 'hvac,plumbing-hvac' || [a, b].sort().join() === 'plumbing,plumbing-hvac';

const GARBAGE = /(^|[^A-Za-z])(undefined|NaN|\[object Object\])([^A-Za-z]|$)|^null$/;
const FICTIONAL_PHONES = [/555-01\d{2}$/, /^(\+353\s?|0)20 ?91\d ?\d{4}$/, /^(\+353\s?|0)89 ?011 ?0\d{3}$/];

function results() {
  const list = [];
  const add = (level, id, msg) => list.push({ level, id, msg });
  return { list, pass: (id, m) => add('PASS', id, m), warn: (id, m) => add('WARN', id, m), fail: (id, m) => add('FAIL', id, m) };
}

const sample = (arr, n = 3) => arr.slice(0, n).join('; ') + (arr.length > n ? ` (+${arr.length - n} more)` : '');

/** Flatten every string field of a set of rows into [{ where, value }]. */
function textFields(table, rows, fields) {
  const out = [];
  for (const r of rows) for (const f of fields) if (typeof r[f] === 'string' && r[f]) out.push({ where: `${table}#${r.id}.${f}`, value: r[f] });
  return out;
}

async function runDbChecks({ prisma, brand, denylist = [], now = new Date(), adminEmail = process.env.ADMIN_EMAIL }) {
  const R = results();
  const [users, customers, jobs, quotes, invoices, pricebook, inventory, comms, acts] = await Promise.all([
    prisma.user.findMany(), prisma.customer.findMany(), prisma.job.findMany(), prisma.quote.findMany(),
    prisma.invoice.findMany(), prisma.priceBookItem.findMany(), prisma.inventoryItem.findMany(), prisma.communication.findMany(),
    prisma.jobActivity.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);

  if (!customers.length || !jobs.length) {
    R.fail('db.empty', `no demo data (${customers.length} customers, ${jobs.length} jobs) — run: npm run seed:demo`);
  } else {
    R.pass('db.counts', `${users.length} users, ${customers.length} customers, ${jobs.length} jobs, ${quotes.length} quotes, ${invoices.length} invoices, ${pricebook.length} pricebook items`);
  }

  // ── client names / garbage text ─────────────────────────────────────────
  const texts = [
    ...textFields('user', users, ['email', 'firstName', 'lastName', 'phone']),
    ...textFields('customer', customers, ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'state', 'zip', 'notes']),
    ...textFields('job', jobs, ['title', 'description', 'type', 'notes']),
    ...textFields('quote', quotes, ['notes']),
    ...textFields('invoice', invoices, ['notes']),
    ...textFields('pricebook', pricebook, ['industry', 'category', 'subcategory', 'name', 'description']),
    ...textFields('inventory', inventory, ['name', 'description', 'sku', 'location']),
    ...textFields('communication', comms, ['subject', 'body', 'from', 'to']),
    ...acts.flatMap((a) => ['from', 'to'].filter((f) => a[f] != null).map((f) => ({ where: `activity#${a.id}.${f}`, value: JSON.stringify(a[f]) }))),
    ...Object.entries(brand).filter(([, v]) => typeof v === 'string').map(([k, v]) => ({ where: `brand.${k}`, value: v })),
  ];
  const deny = texts.flatMap((t) => denylistHits(t.value, denylist).map((h) => `${t.where} contains "${h}"`));
  if (!denylist.length) R.warn('db.denylist', 'no denylist loaded — client names not checked (create backend/demo/denylist.local.txt, see denylist.example.txt)');
  else if (deny.length) R.fail('db.denylist', `client names in demo data: ${sample(deny)}`);
  else R.pass('db.denylist', `no denylisted names in ${texts.length} text fields (${denylist.length} terms)`);

  const garbage = texts.filter((t) => GARBAGE.test(t.value.trim())).map((t) => `${t.where}=${JSON.stringify(t.value.slice(0, 40))}`);
  if (garbage.length) R.fail('db.garbage-text', `"undefined"/"NaN"/"null" stored as text: ${sample(garbage)}`);
  else R.pass('db.garbage-text', 'no "undefined"/"NaN"/"null" strings stored');

  // ── trade correctness ───────────────────────────────────────────────────
  const badType = jobs.filter((j) => !brand.jobTypes.includes(j.type)).map((j) => `job#${j.id} "${j.title}" type "${j.type}"`);
  if (badType.length) R.fail('db.job-types', `job types not offered for ${brand.tradeType}: ${sample(badType)}`);
  else if (jobs.length) R.pass('db.job-types', `all ${jobs.length} job types are ${brand.tradeType} job types`);
  const otherTrade = jobs.filter((j) => j.tradeType && j.tradeType !== brand.tradeType);
  if (otherTrade.length) {
    R.fail('db.job-trade', `${otherTrade.length} jobs were seeded for another trade (${[...new Set(otherTrade.map((j) => j.tradeType))].join(', ')}) — npm run seed:demo -- --reset`);
  }
  const noTrade = jobs.filter((j) => !j.tradeType);
  if (noTrade.length) R.warn('db.job-trade', `${noTrade.length} jobs have no tradeType`);

  // ── money ───────────────────────────────────────────────────────────────
  const badMoney = [
    ...quotes.filter((q) => !(Number.isFinite(q.amount) && q.amount > 0)).map((q) => `quote#${q.id}=${q.amount}`),
    ...invoices.filter((i) => !(Number.isFinite(i.amount) && i.amount > 0)).map((i) => `invoice#${i.id}=${i.amount}`),
  ];
  if (badMoney.length) R.fail('db.amounts', `zero/negative amounts: ${sample(badMoney)}`);
  else if (quotes.length + invoices.length) R.pass('db.amounts', `all ${quotes.length} quotes and ${invoices.length} invoices > 0`);
  else R.warn('db.amounts', 'no quotes or invoices — quotes/invoices pages will be empty');

  const today = localDate(now, brand.timezone);
  const overdueWrong = invoices.filter((i) => i.status === 'unpaid' && i.dueDate && localDate(i.dueDate, brand.timezone) < today);
  if (overdueWrong.length) R.warn('db.invoice-status', `${overdueWrong.length} unpaid invoices are past due but not marked overdue (demo dates are getting old — re-seed with --reset)`);

  // ── pricebook ───────────────────────────────────────────────────────────
  const active = pricebook.filter((p) => p.active && p.industry === brand.industryLabel);
  if (!active.length) R.fail('db.pricebook', `no active pricebook items for industry "${brand.industryLabel}" — the Pricebook page will be empty (npm run seed:prices)`);
  else R.pass('db.pricebook', `${active.length} active "${brand.industryLabel}" items`);
  const starters = starterNames();
  const foreign = active.filter((p) => p.category !== 'Labor').filter((p) => {
    const trades = starters.get(p.name.toLowerCase());
    return trades && ![...trades].some((t) => sameFamily(t, brand.tradeType));
  }).map((p) => `"${p.name}" (${[...starters.get(p.name.toLowerCase())].join('/')})`);
  if (foreign.length) R.fail('db.pricebook-trade', `${foreign.length} "${brand.industryLabel}" items are another trade's starter items: ${sample(foreign)}`);
  const zero = active.filter((p) => !(p.price > 0)).map((p) => `#${p.id} ${p.name}=${p.price}`);
  if (zero.length) R.fail('db.pricebook-price', `items priced at 0 or less: ${sample(zero)}`);
  const keys = new Map();
  for (const p of pricebook) { const k = `${p.industry}|${p.category}|${p.name}`.toLowerCase(); keys.set(k, (keys.get(k) || 0) + 1); }
  const dup = [...keys].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
  if (dup.length) R.fail('db.pricebook-dupes', `duplicate pricebook items: ${sample(dup)}`);
  const others = [...new Set(pricebook.filter((p) => p.industry !== brand.industryLabel).map((p) => p.industry))];
  if (others.length) R.warn('db.pricebook-industry', `pricebook also holds ${others.join(', ')} items (hidden by the trade filter; --reset removes them)`);

  // ── people: fictional contact details only ──────────────────────────────
  const realCust = customers.filter((c) => c.email && !isReservedEmailDomain(emailDomain(c.email))).map((c) => c.email);
  if (realCust.length) R.fail('db.customer-emails', `customer emails on real domains: ${sample(realCust)}`);
  else R.pass('db.customer-emails', 'customer emails use reserved example domains');
  const realUsers = users.filter((u) => u.email !== adminEmail && !isReservedEmailDomain(emailDomain(u.email))).map((u) => u.email);
  if (realUsers.length) R.fail('db.user-emails', `team emails on real domains: ${sample(realUsers)}`);
  const phones = [...customers.map((c) => c.phone), ...users.map((u) => u.phone)].filter(Boolean);
  const realPhones = phones.filter((p) => !FICTIONAL_PHONES.some((re) => re.test(p.trim())));
  if (realPhones.length) R.warn('db.phones', `phone numbers outside the fictional ranges (555-01xx; IE 020 91x / 089 011 0): ${sample(realPhones)}`);
  const incomplete = customers.filter((c) => !c.firstName || !c.phone || !c.address || !c.city).map((c) => `customer#${c.id}`);
  if (incomplete.length) R.fail('db.customer-fields', `customers missing name/phone/address/city: ${sample(incomplete)}`);

  // ── job activity feeds (GTM-18) ─────────────────────────────────────────
  // Every job has a trail that starts with "created" and ends in the job's
  // current status and technician; nothing is dated in the future or before
  // the job existed; actors are real users.
  if (jobs.length) {
    const byJob = new Map();
    for (const a of acts) if (a.jobId != null) { if (!byJob.has(a.jobId)) byJob.set(a.jobId, []); byJob.get(a.jobId).push(a); }
    const userIds = new Set(users.map((u) => u.id));
    const quoteJobs = new Set(quotes.map((q) => q.jobId));
    const invoiceJobs = new Set(invoices.map((i) => i.jobId));
    const bad = []; const warn = [];
    const soon = now.getTime() + 5 * 60000;
    for (const j of jobs) {
      const list = byJob.get(j.id) || [];
      const tag = `job#${j.id}`;
      if (!list.length) { bad.push(`${tag} has no activity`); continue; }
      if (list[0].type !== 'created') bad.push(`${tag} first entry is "${list[0].type}", not "created"`);
      const created = list.find((a) => a.type === 'created');
      const lastOf = (type) => [...list].reverse().find((a) => a.type === type);
      const lastStatus = lastOf('status_changed');
      const status = lastStatus ? lastStatus.to && lastStatus.to.status : created && created.to && created.to.status;
      if (status !== j.status) bad.push(`${tag} feed says "${status}", job is "${j.status}"`);
      const lastAssign = lastOf('assigned');
      const tech = lastAssign ? lastAssign.to && lastAssign.to.technicianId : created && created.to && created.to.technicianId;
      if ((tech ?? null) !== (j.technicianId ?? null)) bad.push(`${tag} feed says technician ${tech ?? 'none'}, job has ${j.technicianId ?? 'none'}`);
      const future = list.filter((a) => a.createdAt.getTime() > soon);
      if (future.length) bad.push(`${tag} has ${future.length} entries dated in the future`);
      const early = list.filter((a) => a.createdAt.getTime() < j.createdAt.getTime() - 60000);
      if (early.length) bad.push(`${tag} has ${early.length} entries before the job was created`);
      if (quoteJobs.has(j.id) && !lastOf('quote_created')) warn.push(`${tag} has a quote but no "quote_created" entry`);
      if (invoiceJobs.has(j.id) && !lastOf('invoice_created')) warn.push(`${tag} has an invoice but no "invoice_created" entry`);
      const ghosts = list.filter((a) => a.actorUserId != null && !userIds.has(a.actorUserId));
      if (ghosts.length) warn.push(`${tag} has ${ghosts.length} entries by deleted users ("Deleted user")`);
    }
    if (bad.length) R.fail('db.activity', `job activity feeds missing or contradicting the job: ${sample(bad)} — npm run seed:demo (backfills) or --reset`);
    else R.pass('db.activity', `${acts.length} activity entries; every one of ${jobs.length} jobs has a feed that matches its status and technician`);
    if (warn.length) R.warn('db.activity-links', sample(warn));
  }

  // ── calendar freshness ──────────────────────────────────────────────────
  const dated = jobs.filter((j) => j.scheduledDate);
  const todays = dated.filter((j) => j.scheduledDate === today);
  const future = dated.filter((j) => j.scheduledDate > today);
  if (jobs.length && !future.length) R.fail('db.freshness', `no jobs after today (${today} ${brand.timezone}) — the demo calendar is stale; npm run seed:demo -- --reset`);
  else if (jobs.length && !todays.length) R.warn('db.freshness', `no jobs scheduled today (${today}) — dashboard "today" will be 0`);
  else if (jobs.length) R.pass('db.freshness', `${todays.length} jobs today, ${future.length} upcoming (${today}, ${brand.timezone})`);

  return R.list;
}

// ── API ──────────────────────────────────────────────────────────────────────
async function getJson(base, p, token) {
  const r = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let body = null;
  const text = await r.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, text };
}

async function runApiChecks({ base, brand, denylist = [], email, password }) {
  const R = results();
  let health;
  try { health = await getJson(base, '/api/health'); } catch (e) {
    R.fail('api.reachable', `cannot reach ${base}: ${e.message}`);
    return R.list;
  }
  if (health.status !== 200) R.fail('api.health', `/api/health → HTTP ${health.status}`);

  // /api/brand — what every page reads first
  const b = (await getJson(base, '/api/brand')).body || {};
  const missing = ['companyName', 'tradeType', 'technicianLabel', 'industryLabel'].filter((k) => !b[k] || b[k] === 'undefined');
  if (!Array.isArray(b.jobTypes) || !b.jobTypes.length) missing.push('jobTypes');
  for (const c of ['primary', 'primaryDark', 'navBg', 'navText']) if (!b.colors || !b.colors[c]) missing.push(`colors.${c}`);
  if (missing.length) R.fail('api.brand', `/api/brand is missing ${missing.join(', ')}`);
  else R.pass('api.brand', `/api/brand: ${b.companyName} · ${b.tradeType} · primary ${b.colors.primary} / dark ${b.colors.primaryDark}`);
  if (b.tradeType && b.tradeType !== brand.tradeType) R.fail('api.brand-trade', `server runs ${b.tradeType} but this check's env says ${brand.tradeType} — run demo:check with the instance's ENV_FILE`);
  const absent = ['logoUrl', 'faviconUrl'].filter((k) => !(k in b));
  if (absent.length) R.warn('api.brand-assets', `/api/brand does not expose ${absent.join(', ')} yet (server.js whitelist — WL-7)`);
  const bd = denylistHits(JSON.stringify(b), denylist);
  if (bd.length) R.fail('api.brand-denylist', `/api/brand contains ${bd.join(', ')}`);

  // login
  const lr = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const token = (await lr.json().catch(() => ({}))).token;
  if (!token) { R.fail('api.login', `login as ${email} failed (HTTP ${lr.status}) — pass --email/--password`); return R.list; }
  R.pass('api.login', `logged in as ${email}`);

  const need = {
    '/api/jobs': (rows) => rows.flatMap((j) => [
      !j.customer && `job#${j.id}.customer`, j.customer && !j.customer.firstName && `job#${j.id}.customer.firstName`,
      !brand.jobTypes.includes(j.type) && `job#${j.id}.type=${j.type}`, !j.status && `job#${j.id}.status`,
    ]),
    '/api/customers': (rows) => rows.flatMap((c) => [!c.firstName && `customer#${c.id}.firstName`, !c.phone && `customer#${c.id}.phone`]),
    '/api/quotes': (rows) => rows.flatMap((q) => [!(q.amount > 0) && `quote#${q.id}.amount=${q.amount}`, !(q.job && q.job.customer) && `quote#${q.id}.job.customer`]),
    '/api/invoices': (rows) => rows.flatMap((i) => [!(i.amount > 0) && `invoice#${i.id}.amount=${i.amount}`, !(i.job && i.job.customer) && `invoice#${i.id}.job.customer`]),
    '/api/pricebook': (body) => {
      const items = Array.isArray(body) ? body : (body && body.items) || [];
      return [!items.length && 'pricebook.items is empty', ...items.map((p) => !(p.price > 0) && `pricebook#${p.id}.price=${p.price}`)];
    },
    '/api/users': (rows) => rows.flatMap((u) => [!u.firstName && `user#${u.id}.firstName`]),
  };
  let jobsSeen = [];
  for (const [p, check] of Object.entries(need)) {
    let r;
    try { r = await getJson(base, p, token); } catch (e) { R.fail(`api.${p.slice(5)}`, e.message); continue; }
    if (r.status !== 200) { R.fail(`api.${p.slice(5)}`, `HTTP ${r.status}`); continue; }
    const problems = [];
    if (Array.isArray(r.body) && !r.body.length && p !== '/api/users') problems.push('empty list');
    problems.push(...check(r.body).filter(Boolean));
    if (/"undefined"|\bNaN\b|\[object Object\]/.test(r.text)) problems.push('response contains "undefined"/NaN');
    const hits = denylistHits(r.text, denylist);
    if (hits.length) problems.push(`denylisted: ${hits.join(', ')}`);
    if (problems.length) R.fail(`api.${p.slice(5)}`, sample(problems, 4));
    else R.pass(`api.${p.slice(5)}`, `${Array.isArray(r.body) ? r.body.length : (r.body.items || []).length} rows, display fields present`);
    if (p === '/api/jobs' && Array.isArray(r.body) && r.body.length) jobsSeen = r.body;
  }

  // job activity feed (GTM-18): the busiest-looking job shows a trail with names
  if (jobsSeen.length) {
    const job = jobsSeen.find((j) => j.status === 'completed') || jobsSeen[0];
    let r;
    try { r = await getJson(base, `/api/jobs/${job.id}/activity`, token); } catch (e) { r = { status: 0, text: e.message }; }
    const problems = [];
    if (r.status !== 200 || !Array.isArray(r.body)) problems.push(`HTTP ${r.status}`);
    else {
      if (!r.body.length) problems.push('empty feed');
      problems.push(...r.body.filter((e) => !e.type || !e.createdAt || !(e.actor && e.actor.name)).map((e) => `activity#${e.id} missing type/createdAt/actor.name`));
      if (r.body.length && r.body[r.body.length - 1].type !== 'created') problems.push('oldest entry is not "created"');
      if (/"undefined"|\bNaN\b|\[object Object\]/.test(r.text)) problems.push('response contains "undefined"/NaN');
      const hits = denylistHits(r.text, denylist);
      if (hits.length) problems.push(`denylisted: ${hits.join(', ')}`);
    }
    if (problems.length) R.fail('api.activity', `/api/jobs/${job.id}/activity: ${sample(problems, 4)}`);
    else R.pass('api.activity', `/api/jobs/${job.id}/activity: ${r.body.length} entries, actors named`);
  }
  return R.list;
}

// ── headless pages (via scripts/brand-shot.js) ──────────────────────────────
function shot(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'brand-shot.js'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      try { resolve({ code, json: JSON.parse(out) }); } catch { resolve({ code, error: (err || out).trim().slice(0, 300) }); }
    });
  });
}

const PAGES = ['index.html', 'dispatch.html', 'schedule.html', 'customers.html', 'quote-invoice.html', 'pricebook.html', 'team.html', 'communications.html'];

async function runHeadlessChecks({ port, denylist = [], email, password, token, repair = false, shotsDir = null, extraPages = [] }) {
  const R = results();
  if (!token) {
    const lr = await fetch(`http://localhost:${port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    token = (await lr.json().catch(() => ({}))).token;
    if (!token) { R.fail('page.login', `login as ${email} failed (HTTP ${lr.status})`); return R.list; }
  }
  const env = { ...process.env, DEMO_PASSWORD: password, BRAND_SHOT_TOKEN: token };
  if (shotsDir) require('fs').mkdirSync(shotsDir, { recursive: true });
  for (const page of [...PAGES, ...extraPages]) {
    const out = shotsDir ? path.join(shotsDir, `check-${page.replace(/[^a-z0-9]+/gi, '_')}.png`) : '-';
    const args = ['--port', String(port), '--page', page, '--out', out, '--email', email, '--text-limit', '200000'];
    if (repair) args.push('--repair-onclick-quotes');
    const r = await shot(args, env);
    const id = `page.${page}`;
    if (!r.json) { R.fail(id, `headless run failed: ${r.error}`); continue; }
    const { errs = [], httpErrors = [], text = '' } = r.json;
    const problems = [];
    const warnings = [];
    const wsNoise = errs.filter((e) => /WebSocket connection to .* failed/.test(e));
    const jsErrs = errs.filter((e) => !wsNoise.includes(e));
    if (wsNoise.length) warnings.push('websocket closed early (realtime presence; usually harmless in a headless run)');
    if (jsErrs.length) problems.push(`JS errors: ${sample(jsErrs.map((e) => e.slice(0, 120)), 2)}`);
    const http = [...new Set(httpErrors)];
    const favicon = http.filter((h) => /\/favicon\.ico$/.test(h));
    if (favicon.length) warnings.push('favicon.ico 404 (WL-7)');
    if (http.length > favicon.length) problems.push(`HTTP errors: ${sample(http.filter((h) => !favicon.includes(h)), 3)}`);
    const bad = text.match(/(^|[^A-Za-z])(undefined|NaN|\[object Object\])([^A-Za-z]|$)/g);
    if (bad) problems.push(`shows ${[...new Set(bad.map((s) => s.trim()))].join(', ')} (${bad.length}×)`);
    const hits = denylistHits(text, denylist);
    if (hits.length) problems.push(`denylisted: ${hits.join(', ')}`);
    if (/\$0\.00/.test(text)) warnings.push('shows $0.00 somewhere');
    if (problems.length) R.fail(id, [...problems, ...warnings].join(' · '));
    else if (warnings.length) R.warn(id, warnings.join(' · '));
    else R.pass(id, `${text.length} chars rendered, no errors`);
  }
  return R.list;
}

module.exports = { runDbChecks, runApiChecks, runHeadlessChecks, PAGES, GARBAGE };
