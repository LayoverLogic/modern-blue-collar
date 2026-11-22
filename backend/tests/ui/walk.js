#!/usr/bin/env node
/**
 * tests/ui/walk.js — headless-Chrome UI regression walk of every page in backend/public/.
 *
 * What it does
 *   1. Page audit: every page x role (admin, technician, dispatcher) x viewport
 *      (desktop 1440x900, mobile 390x844). For each it saves a full-page PNG and
 *      checks: console errors, page (JS) errors, any 4xx/5xx response, failed
 *      requests, external hosts, placeholder text ("undefined", "NaN",
 *      "Invalid Date", "[object Object]", "null"), inline event-handler
 *      attributes and inline <script> (CSP readiness), and on mobile: horizontal
 *      overflow and tap targets under 44px.
 *   2. Main-flow walk by clicking (no API shortcuts): login, create customer,
 *      create job, open it from the board, assign technician + date/time, build
 *      a quote from the pricebook, approve it, create the invoice (refuses 0),
 *      invite + add a team member, export CSV from three pages, technician on
 *      mobile: Today view with Navigate / Call / Text / On My Way, open the job,
 *      change status, upload a photo; dispatcher nav has no admin items.
 *   3. XSS: stores `<img src=x onerror=...>`-style payloads in a customer, job,
 *      quote, communication and pricebook item (via the API), opens every page
 *      that shows them and asserts nothing executed / no payload element exists.
 *      The payload records are deleted afterwards.
 *   4. Final screenshots (named PNGs) into UI_FINAL_DIR.
 *   5. Writes results.json next to the audit screenshots.
 *
 * It is a REGRESSION TEST: it exits 1 when any audit check, flow step or XSS
 * check fails. Set UI_REPORT_ONLY=1 to always exit 0 (inspection mode).
 *
 * ── How to run ──────────────────────────────────────────────────────────────
 *   1. cd backend && npm install            (installs puppeteer-core, a devDependency)
 *   2. Make sure a Chrome / Chromium binary exists. Default: /usr/bin/google-chrome
 *      On a Mac: export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   3. Set up a throwaway sandbox database (the walk creates customers, jobs,
 *      quotes, invoices and team members in it):
 *        DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_frontend?schema=public \
 *        PORT=3121 npm run sandbox:setup
 *   4. Run the walk. By default it starts its own server (node server.js) on
 *      UI_PORT (default 3121) with your DATABASE_URL and restarts it between
 *      segments, because the API rate limiter (200 req / 15 min per IP) would
 *      otherwise start returning 429s part-way through:
 *        DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_frontend?schema=public \
 *        UI_PORT=3121 npm run test:ui
 *      To test an already-running server instead (no restarts; expect 429s on
 *      long runs):  UI_BASE_URL=http://localhost:3121 npm run test:ui
 *   5. Output: PNGs + results.json in UI_OUT_DIR (default
 *      /home/claude/mbc-team/screenshots/phase2 if that folder's parent exists,
 *      else backend/tests/ui/out); final named PNGs in UI_FINAL_DIR (default the
 *      parent screenshots folder, else backend/tests/ui/out/final).
 *
 * Options (env): UI_ROLES=admin,technician  UI_VIEWPORTS=desktop,mobile
 *                UI_PAGES=index,dispatch    UI_SKIP_AUDIT=1  UI_SKIP_FLOW=1  UI_SKIP_XSS=1  UI_SKIP_FINAL=1
 *                UI_REPORT_ONLY=1   UI_KEEP_DATA=1 (keep the customer/job/quote/invoice/users the flow created)
 * Logins (seeded, password demo1234): admin@demo.test, plus a technician and a
 * dispatcher — override with UI_TECH_EMAIL / UI_DISP_EMAIL / UI_PASSWORD.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const BACKEND = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PORT = Number(process.env.UI_PORT || 3121);
const EXTERNAL = process.env.UI_BASE_URL || '';
const BASE = (EXTERNAL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TEAM_SHOTS = '/home/claude/mbc-team/screenshots';
const HAS_TEAM = fs.existsSync(path.dirname(TEAM_SHOTS));
const OUT = process.env.UI_OUT_DIR || (HAS_TEAM ? path.join(TEAM_SHOTS, 'phase2') : path.join(__dirname, 'out'));
const FINAL = process.env.UI_FINAL_DIR || (HAS_TEAM ? TEAM_SHOTS : path.join(__dirname, 'out', 'final'));
const REPORT_ONLY = !!process.env.UI_REPORT_ONLY;
const PASSWORD = process.env.UI_PASSWORD || 'demo1234';

const USERS = {
  admin:      process.env.UI_ADMIN_EMAIL || 'admin@demo.test',
  technician: process.env.UI_TECH_EMAIL  || 'mike@allproplumbinghvac.com',
  dispatcher: process.env.UI_DISP_EMAIL  || 'lisa@allproplumbinghvac.com',
};
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile:  { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const pick = (envName, all) => (process.env[envName] ? process.env[envName].split(',').map((s) => s.trim()) : all);
const ROLES = pick('UI_ROLES', Object.keys(USERS));
const VPS = pick('UI_VIEWPORTS', Object.keys(VIEWPORTS));
const ALL_PAGES = fs.readdirSync(path.join(BACKEND, 'public')).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
const PAGES = pick('UI_PAGES', ALL_PAGES);
const BAD_TOKENS = ['undefined', 'NaN', 'Invalid Date', '[object Object]', 'null'];

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = localISO();

// ── Server management ────────────────────────────────────────────────────────
let server = null;
async function waitHealthy(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`server at ${BASE} not healthy after ${timeoutMs}ms`);
}
async function startServer() {
  if (EXTERNAL) return waitHealthy();
  await stopServer();
  const env = { ...process.env, PORT: String(PORT), APP_URL: process.env.APP_URL || BASE };
  if (!env.ENV_FILE && fs.existsSync(path.join(BACKEND, '.env.sandbox')) && !fs.existsSync(path.join(BACKEND, '.env'))) env.ENV_FILE = '.env.sandbox';
  // Wait until nothing answers on the port any more (a previous server must be gone).
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/health`); await sleep(200); } catch { break; } }
  server = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logFile = path.join(OUT, 'server.log');
  server.stdout.on('data', (d) => fs.appendFileSync(logFile, d));
  server.stderr.on('data', (d) => fs.appendFileSync(logFile, d));
  try { await waitHealthy(); } catch (e) { await stopServer(); throw e; }
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  if (s.exitCode !== null) return;
  await new Promise((r) => {
    const t = setTimeout(() => { s.kill('SIGKILL'); setTimeout(r, 500); }, 5000);
    s.once('exit', () => { clearTimeout(t); r(); });
    s.kill('SIGTERM');
  });
}

// ── Small API helpers (fixtures, XSS payloads, lookups — never the walked flow) ─
async function apiLogin(email) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`API login ${email}: ${r.status} ${JSON.stringify(d)}`);
  return d;
}
async function api(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: d };
}

// Makes sure the pages have something to show: a quote and an invoice with real
// amounts, and jobs TODAY for the technician (seeded demo dates may be stale).
async function ensureFixtures() {
  const { token: t } = await apiLogin(USERS.admin);
  const tech = await apiLogin(USERS.technician);
  const techId = tech.user.id;
  let jobs = (await api(t, 'GET', '/api/jobs')).body || [];
  const customers = (await api(t, 'GET', '/api/customers')).body || [];
  const fx = { quote: null, invoice: null, todayJobs: [] };
  const qJob = jobs.find((j) => j.quote) || jobs.find((j) => !j.quote && !j.invoice && j.status !== 'completed');
  if (qJob && !qJob.quote) fx.quote = (await api(t, 'POST', '/api/quotes', { jobId: qJob.id, amount: 1450, notes: 'UI-walk fixture quote' })).body;
  else if (qJob) fx.quote = qJob.quote;
  const iJob = jobs.find((j) => j.invoice) || jobs.find((j) => !j.invoice && j.status === 'completed');
  if (iJob && !iJob.invoice) fx.invoice = (await api(t, 'POST', '/api/invoices', { jobId: iJob.id, amount: 185.5, dueDate: localISO(new Date(Date.now() + 14 * 864e5)), notes: 'UI-walk fixture invoice' })).body;
  else if (iJob) fx.invoice = iJob.invoice;
  const mineToday = jobs.filter((j) => j.technicianId === techId && j.scheduledDate === TODAY);
  const slots = [['09:00', 'Water heater not heating'], ['13:30', 'Kitchen drain slow']];
  for (let i = mineToday.length; i < 2 && customers.length; i++) {
    const c = customers[i % customers.length];
    const r = await api(t, 'POST', '/api/jobs', { title: slots[i][1], customerId: c.id, technicianId: techId, status: 'scheduled', scheduledDate: TODAY, scheduledTime: slots[i][0], duration: 1.5 });
    if (r.status === 201) fx.todayJobs.push(r.body.id);
  }
  jobs = (await api(t, 'GET', '/api/jobs')).body || [];
  const techJob = jobs.find((j) => j.technicianId === techId && j.scheduledDate === TODAY) || jobs.find((j) => j.technicianId === techId);
  const billed = jobs.find((j) => j.quote && j.invoice) || jobs.find((j) => j.quote) || jobs[0];
  const brand = await (await fetch(BASE + '/api/brand')).json();
  return { fixtures: fx, brand, techId, adminJobId: (billed || {}).id, techJobId: (techJob || {}).id, sampleCustomerId: (billed || jobs[0] || {}).customerId };
}

// ── Browser helpers ─────────────────────────────────────────────────────────
function instrument(page, log) {
  const host = new URL(BASE).host;
  page.on('console', (m) => { if (m.type() === 'error') log.console.push(m.text().slice(0, 400)); else if (m.type() === 'warn') log.warnings.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message || e).split('\n')[0].slice(0, 300)));
  page.on('requestfailed', (req) => { const f = req.failure() && req.failure().errorText; if (f !== 'net::ERR_ABORTED') log.failed.push(`${req.method()} ${req.url()} — ${f}`); });
  page.on('request', (req) => { try { const u = new URL(req.url()); if (/^https?:$/.test(u.protocol) && u.host !== host) log.external.push(req.url()); } catch { /* data: etc */ } });
  page.on('response', (res) => { if (res.status() >= 400) log.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url().replace(BASE, '')}`); });
  page.on('dialog', async (d) => { log.dialogs.push(`${d.type()}: ${d.message()}`.slice(0, 300)); await d.accept().catch(() => {}); });
}
function detach(page) { for (const ev of ['console', 'pageerror', 'requestfailed', 'request', 'response', 'dialog']) page.removeAllListeners(ev); }
function newLog() { return { console: [], warnings: [], pageErrors: [], failed: [], external: [], httpErrors: [], dialogs: [] }; }

async function newPage(browser, vp) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORTS[vp]);
  if (vp === 'mobile') await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  return { ctx, page };
}
async function settle(page, ms = 700) { await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {}); await sleep(ms); }
const shot = async (page, name, dir = OUT) => { const f = `${name}.png`; await page.screenshot({ path: path.join(dir, f), fullPage: true }); return f; };
const visibleText = (page, sel) => page.$eval(sel, (e) => (e.offsetParent !== null || getComputedStyle(e).position === 'fixed' ? e.innerText : '')).catch(() => '');
const isVisible = (page, sel) => page.$eval(sel, (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; }).catch(() => false);

// In-page inspection: placeholders, overflow, tap targets, inline handlers, branding.
async function inspect(page, brand, vp) {
  return page.evaluate((brand, badTokens, designWidth, mobile) => {
    const vis = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const text = document.body ? document.body.innerText : '';
    const tokens = {};
    for (const t of badTokens) {
      const m = text.match(new RegExp('(^|[^A-Za-z])' + t.replace(/[[\]]/g, '\\$&') + '([^A-Za-z]|$)', 'g'));
      if (m) tokens[t] = m.length;
    }
    const docW = document.documentElement.scrollWidth;
    const overflowEls = [];
    if (docW > designWidth + 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (vis(el) && r.right > designWidth + 1) overflowEls.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : '') + ` right=${Math.round(r.right)}`);
        if (overflowEls.length > 6) break;
      }
    }
    const smallTargets = [];
    if (mobile) {
      const sel = 'main button, main a.btn, main select, main input:not([type=checkbox]):not([type=radio]):not([type=file]), #topnav button, #topnav a, .modal-overlay.open button';
      for (const el of document.querySelectorAll(sel)) {
        if (!vis(el) || el.closest('.calendar-grid.month')) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 43.5) smallTargets.push(`${(el.innerText || el.id || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24)}:${Math.round(r.height)}px`);
      }
    }
    const inlineHandlers = [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')).slice(0, 10);
    const inlineScripts = [...document.querySelectorAll('script:not([src])')].length;
    const rootStyle = getComputedStyle(document.documentElement);
    const primary = rootStyle.getPropertyValue('--color-primary').trim();
    const navCompany = document.getElementById('nav-company');
    const navLinks = [...document.querySelectorAll('#topnav .nav-links a')].map((a) => a.textContent.trim());
    return {
      title: document.title, url: location.pathname + location.search, h2: (document.querySelector('h2') || {}).innerText || '',
      tokens, docWidth: docW, viewportWidth: designWidth, overflow: docW > designWidth + 1, overflowEls, smallTargets,
      inlineHandlers, inlineScripts, navLinks,
      branding: {
        navCompany: navCompany ? navCompany.innerText : null,
        titleHasCompany: !!brand.companyName && document.title.includes(brand.companyName),
        primaryCss: primary, brandPrimary: brand.colors && brand.colors.primary,
        primaryApplied: !!(brand.colors && primary.toLowerCase() === String(brand.colors.primary).toLowerCase()),
        favicon: !!document.querySelector('link[rel~="icon"][href^="data:image"], link[rel~="icon"][href$=".png"], link[rel~="icon"][href$=".ico"], link[rel~="icon"][href$=".svg"]'),
        industryBadge: (document.getElementById('nav-trade') || {}).innerText || null,
      },
      snippet: text.replace(/\s+/g, ' ').slice(0, 240),
    };
  }, brand, BAD_TOKENS, VIEWPORTS[vp].width, vp === 'mobile');
}

function auditProblems(info, log, vp) {
  const p = [];
  if (log.pageErrors.length) p.push(`JS errors: ${log.pageErrors.slice(0, 3).join(' | ')}`);
  if (log.console.length) p.push(`console errors: ${log.console.slice(0, 3).join(' | ')}`);
  if (log.httpErrors.length) p.push(`HTTP errors: ${log.httpErrors.slice(0, 4).join(', ')}`);
  if (log.failed.length) p.push(`failed requests: ${log.failed.slice(0, 3).join(', ')}`);
  if (log.external.length) p.push(`external hosts: ${log.external.slice(0, 3).join(', ')}`);
  if (info.error) p.push(`inspect failed: ${info.error}`);
  if (info.tokens && Object.keys(info.tokens).length) p.push(`placeholder text: ${JSON.stringify(info.tokens)}`);
  if (info.inlineHandlers && info.inlineHandlers.length) p.push(`inline on* handlers: ${info.inlineHandlers.join(', ')}`);
  if (info.inlineScripts) p.push(`${info.inlineScripts} inline <script> block(s)`);
  if (vp === 'mobile' && info.overflow) p.push(`horizontal overflow ${info.docWidth}px: ${info.overflowEls.join(', ')}`);
  if (vp === 'mobile' && info.smallTargets && info.smallTargets.length) p.push(`tap targets < 44px: ${info.smallTargets.slice(0, 8).join(', ')}`);
  if (info.branding && !info.branding.primaryApplied) p.push(`brand primary colour not applied (css ${info.branding.primaryCss} vs ${info.branding.brandPrimary})`);
  if (info.branding && !info.branding.favicon) p.push('no favicon');
  return p;
}

// UI login by typing + clicking. Technicians are sent on to today.html.
async function uiLogin(page, email) {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await settle(page, 200);
  await page.waitForSelector('#email-input', { visible: true, timeout: 8000 });
  await page.type('#email-input', email);
  await page.type('#password-input', PASSWORD);
  await page.click('.login-card .btn-primary');
  await settle(page, 600);
  const state = await page.evaluate(() => ({
    token: !!localStorage.getItem('token'),
    path: location.pathname,
    appVisible: !!document.getElementById('app') && getComputedStyle(document.getElementById('app')).display !== 'none',
    todayVisible: !!document.getElementById('today-list'),
    err: (document.getElementById('error-msg') || {}).innerText || '',
  }));
  return { ok: state.token && (state.appVisible || state.todayVisible), ...state };
}

// ── 1. Page audit ───────────────────────────────────────────────────────────
async function pageAudit(browser, ctxInfo, results) {
  const { brand } = ctxInfo;
  for (const role of ROLES) {
    const query = { job: `?id=${role === 'technician' ? ctxInfo.techJobId : ctxInfo.adminJobId}`, 'customer-detail': `?id=${ctxInfo.sampleCustomerId}` };
    for (const vp of VPS) {
      await startServer(); // fresh rate-limit window per segment
      const { ctx, page } = await newPage(browser, vp);
      const lg = newLog(); instrument(page, lg);
      const login = await uiLogin(page, USERS[role]).catch((e) => ({ ok: false, reason: e.message }));
      const loginProblems = auditProblems({}, lg, vp).filter((x) => !/brand primary|favicon/.test(x));
      if (!login.ok) loginProblems.push(`login failed: ${JSON.stringify(login)}`);
      results.logins.push({ role, viewport: vp, ...login, problems: loginProblems, screenshot: await shot(page, `login-${role}-${vp}`) });
      detach(page);
      for (const p of PAGES) {
        const log = newLog(); instrument(page, log);
        const url = `/${p}.html${query[p] || ''}`;
        await page.goto(BASE + url, { waitUntil: 'domcontentloaded' }).catch((e) => log.failed.push('goto ' + e.message));
        await settle(page);
        const info = await inspect(page, brand, vp).catch((e) => ({ error: e.message }));
        const file = await shot(page, `${p}-${role}-${vp}`);
        const problems = auditProblems(info, log, vp);
        results.pages.push({ page: p, role, viewport: vp, url, screenshot: file, problems, ...info, ...log });
        detach(page);
        process.stdout.write(`  ${(problems.length ? 'FAIL' : 'ok  ')} ${p.padEnd(16)} ${role.padEnd(10)} ${vp.padEnd(7)} ${problems.join(' ; ').slice(0, 220)}\n`);
      }
      await ctx.close();
    }
  }
}

// ── 2. Main-flow walk (clicking) ────────────────────────────────────────────
async function flowWalk(browser, ctxInfo, results) {
  await startServer();
  const steps = results.flow;
  const step = (name, ok, detail, extra = {}) => { const status = ok === true ? 'pass' : (ok === null ? 'skip' : 'fail'); steps.push({ step: name, status, detail, ...extra }); console.log(`  [${status}] ${name} — ${detail}`); };
  const stamp = Date.now().toString().slice(-5);
  const { brand } = ctxInfo;
  results.flowCreated = { customerLast: `Walsh-${stamp}`, jobTitle: `Leaking outside tap ${stamp}`, emails: [`niamh${stamp}@example.test`, `niamh.b${stamp}@example.test`] };

  // Admin on desktop.
  const A = await newPage(browser, 'desktop'); const alog = newLog(); instrument(A.page, alog); const page = A.page;
  const login = await uiLogin(page, USERS.admin);
  step('1. Login (admin, desktop, typed credentials + Sign In)', login.ok, login.ok ? 'dashboard shown' : JSON.stringify(login), { screenshot: await shot(page, 'flow-01-login-admin') });

  // Create customer.
  const first = 'Siobhan', last = `Walsh-${stamp}`;
  await page.goto(BASE + '/customers.html'); await settle(page);
  try {
    await page.click('#btn-new'); await sleep(250);
    if (!(await isVisible(page, '#modal'))) throw new Error('"+ New Customer" did not open the modal');
    await page.type('#f-first', first); await page.type('#f-last', last);
    await page.type('#f-phone', '620-555-0142'); await page.type('#f-email', `siobhan${stamp}@example.test`);
    await page.type('#f-address', '12 Main St'); await page.type('#f-city', 'Hutchinson'); await page.type('#f-state', 'Reno County'); await page.type('#f-zip', '67501');
    await page.click('#modal .btn-primary'); await settle(page, 400);
    const err = await visibleText(page, '#modal-error');
    const row = await page.$$eval('#customers-tbody tr', (rs, n) => rs.some((r) => r.innerText.includes(n)), last);
    step('2. Create customer (Customers > + New Customer)', !err && row, err ? `modal error: "${err}"` : `created; row shown: ${row}; state field accepted a county name`, { screenshot: await shot(page, 'flow-02-create-customer') });
  } catch (e) { step('2. Create customer', false, e.message, { screenshot: await shot(page, 'flow-02-create-customer') }); }

  // Create job.
  const jobTitle = `Leaking outside tap ${stamp}`;
  await page.goto(BASE + '/dispatch.html'); await settle(page);
  try {
    await page.click('#btn-new'); await sleep(250);
    const custVal = await page.$$eval('#f-customer option', (os, n) => (os.find((o) => o.textContent.includes(n)) || {}).value, last);
    if (!custVal) throw new Error('new customer not in the dropdown');
    await page.select('#f-customer', custVal);
    await page.type('#f-title', jobTitle);
    await page.type('#f-notes', 'UI walk: tap drips constantly');
    await page.click('#modal .btn-primary'); await settle(page, 400);
    const err = await visibleText(page, '#modal-error');
    const row = await page.$$eval('#jobs-tbody tr', (rs, t) => rs.some((r) => r.innerText.includes(t)), jobTitle);
    step('3. Create job (Dispatch > + New Job)', !err && row, err ? `modal error: "${err}"` : `created; row on board: ${row}`, { screenshot: await shot(page, 'flow-03-create-job') });
  } catch (e) { step('3. Create job', false, e.message, { screenshot: await shot(page, 'flow-03-create-job') }); }

  // Open from the board, assign technician + date/time.
  let jobUrl = null;
  try {
    const rows = await page.$$('#jobs-tbody tr');
    let target = null;
    for (const r of rows) if ((await r.evaluate((e) => e.innerText)).includes(jobTitle)) { target = r; break; }
    if (!target) throw new Error('job row not found');
    await target.$eval('td:nth-child(2)', (td) => td.click()); await settle(page);
    jobUrl = page.url();
    step('4a. Open the job from the Dispatch board (row click)', /job\.html\?id=\d+/.test(jobUrl), jobUrl.replace(BASE, ''));
    await page.waitForSelector('#job-content', { visible: true, timeout: 8000 });
    await page.waitForSelector('#a-tech option:not([value=""])', { timeout: 8000 });
    const techVal = await page.$$eval('#a-tech option', (os) => (os.find((o) => o.value) || {}).value);
    const techName = await page.$$eval('#a-tech option', (os, v) => (os.find((o) => o.value === v) || {}).textContent, techVal);
    await page.select('#a-tech', techVal);
    await page.$eval('#a-date', (el, d) => { el.value = d; }, TODAY);
    // Pick a slot this technician is free (the API rejects double-booking).
    const busy = ((await api((await apiLogin(USERS.admin)).token, 'GET', `/api/jobs?technicianId=${techVal}&date=${TODAY}`)).body || [])
      .filter((j) => j.scheduledTime && ['pending', 'scheduled', 'in-progress'].includes(j.status)).map((j) => parseInt(j.scheduledTime, 10));
    const hour = [10, 15, 7, 17, 12, 19, 6].find((h) => busy.every((b) => Math.abs(b - h) >= 3)) || 21;
    await page.$eval('#a-time', (el, v) => { el.value = v; }, `${String(hour).padStart(2, '0')}:30`);
    await page.click('#btn-assign'); await settle(page, 400);
    const tech = await visibleText(page, '#d-tech'); const sched = await visibleText(page, '#d-scheduled'); const st = await visibleText(page, '#d-status');
    step('4b. Assign technician + date/time on the job page', tech === techName && /:30/.test(sched) && /Scheduled/i.test(st), `technician "${tech}", scheduled "${sched}", status "${st}"`, { screenshot: await shot(page, 'flow-04b-assign') });
  } catch (e) { step('4. Open + assign', false, e.message, { screenshot: await shot(page, 'flow-04-assign') }); }

  // Build a quote from the pricebook.
  let quoteTotal = null;
  try {
    await page.goto(BASE + '/quote-invoice.html'); await settle(page);
    await page.click('#btn-new-quote'); await settle(page, 200);
    const jobId = jobUrl && jobUrl.match(/id=(\d+)/)[1];
    const has = await page.$$eval('#f-job option', (os, id) => os.some((o) => o.value === id), jobId);
    if (!has) throw new Error('job not offered in "New Quote"');
    await page.select('#f-job', jobId);
    await page.click('#new-quote-form .btn-primary'); await settle(page);
    if (!(await isVisible(page, '#quote-builder'))) throw new Error('quote builder did not open on the job page');
    const item = await page.$$eval('#qb-item option', (os) => { const o = os.find((x) => /^\d+$/.test(x.value)); return o && { v: o.value, t: o.textContent }; });
    if (!item) throw new Error('pricebook is empty');
    await page.select('#qb-item', item.v);
    await page.$eval('#qb-qty', (el) => { el.value = '2'; });
    await page.click('#qb-add');
    await page.select('#qb-item', 'custom');
    await page.type('#qb-desc', 'Call-out fee'); await page.type('#qb-price', '49.50');
    await page.click('#qb-add'); await sleep(150);
    const lines = await page.$$eval('#qb-lines tr', (rs) => rs.length);
    quoteTotal = await visibleText(page, '#qb-total');
    await shot(page, 'flow-05a-quote-builder');
    await page.click('#qb-save'); await settle(page, 400);
    const inv = await visibleText(page, '#inv-list');
    step('5. Build a quote (New Quote > job > pricebook lines)', lines === 2 && inv.includes('Quote #') && inv.includes(quoteTotal), `lines ${lines}, total ${quoteTotal}; card: "${inv.replace(/\s+/g, ' ').slice(0, 160)}"`, { screenshot: await shot(page, 'flow-05-quote') });
    await page.select('#quote-status', 'approved'); await settle(page, 400);
    const st = await page.$eval('#quote-status', (s) => s.value).catch(() => '');
    step('5b. Approve the quote', st === 'approved', `quote status now "${st}"`);
  } catch (e) { step('5. Build a quote', false, e.message, { screenshot: await shot(page, 'flow-05-quote') }); }

  // Create the invoice from the quote.
  try {
    if (!jobUrl) throw new Error('no job page reached');
    await page.goto(jobUrl); await settle(page);
    await page.click('#btn-create-invoice'); await sleep(200);
    const prefill = await page.$eval('#inv-amount', (e) => e.value);
    await page.$eval('#inv-amount', (e) => { e.value = '0'; });
    await page.click('#btn-confirm-invoice'); await sleep(250);
    const zeroErr = await visibleText(page, '#inv-error');
    await page.$eval('#inv-amount', (e, v) => { e.value = v; }, prefill);
    await page.click('#btn-confirm-invoice'); await settle(page, 500);
    const inv = await visibleText(page, '#inv-list');
    const btnHidden = !(await isVisible(page, '#btn-create-invoice'));
    const ok = !!prefill && Number(prefill) > 0 && /greater than 0/i.test(zeroErr) && inv.includes('Invoice #') && btnHidden && (!quoteTotal || inv.split('Invoice #')[1].includes(quoteTotal));
    step('6. Create invoice (prefilled from approved quote, refuses 0, hides afterwards)', ok, `prefill ${prefill}; zero → "${zeroErr}"; card "${inv.replace(/\s+/g, ' ').slice(0, 200)}"; Create Invoice hidden: ${btnHidden}`, { screenshot: await shot(page, 'flow-06-invoice') });
  } catch (e) { step('6. Create invoice', false, e.message, { screenshot: await shot(page, 'flow-06-invoice') }); }

  // Invite + add a team member.
  await page.goto(BASE + '/team.html'); await settle(page);
  try {
    await page.click('#btn-invite'); await sleep(250);
    await page.type('#f-first', 'Niamh'); await page.type('#f-last', `Invited-${stamp}`);
    await page.type('#f-email', `niamh${stamp}@example.test`);
    const n = alog.httpErrors.length;
    await page.click('#invite-form .btn-primary'); await settle(page, 400);
    const res = await visibleText(page, '#invite-result');
    const err = await visibleText(page, '#modal-error');
    step('7. Invite a team member (Team > + Invite Member)', !err && /outbox|not set up|emailed/i.test(res) && /api\/auth\/google/.test(res), `${err ? 'error: ' + err : res.replace(/\s+/g, ' ').slice(0, 220)}; HTTP errors: ${JSON.stringify(alog.httpErrors.slice(n))}`, { screenshot: await shot(page, 'flow-07-invite') });
    await page.click('#modal [data-close-modal]');
    await page.click('#btn-add'); await sleep(250);
    await page.type('#a-first', 'Niamh'); await page.type('#a-last', `Byrne-${stamp}`); await page.type('#a-email', `niamh.b${stamp}@example.test`);
    await page.select('#a-role', 'technician'); await page.type('#a-password', 'temporary-pass-123');
    await page.click('#add-form .btn-primary'); await settle(page, 400);
    const added = await page.$$eval('.team-card', (cs, n) => cs.some((c) => c.innerText.includes(n)), `Byrne-${stamp}`);
    step('7b. Add a team member with a temporary password', added, added ? 'card shown' : `error: ${await visibleText(page, '#add-error')}`, { screenshot: await shot(page, 'flow-07b-add-member') });
  } catch (e) { step('7. Team', false, e.message, { screenshot: await shot(page, 'flow-07-invite') }); }

  // Export CSV from three pages.
  const exp = [];
  for (const [p, btn] of [['customers', '#btn-export'], ['dispatch', '#btn-export'], ['quote-invoice', '#btn-export']]) {
    await page.goto(`${BASE}/${p}.html`); await settle(page, 200);
    const resP = page.waitForResponse((r) => r.url().includes('/api/exports/'), { timeout: 8000 }).catch(() => null);
    await page.click(btn).catch(() => {});
    const r = await resP;
    exp.push({ page: p, status: r && r.status(), type: r && r.headers()['content-type'], url: r && r.url().replace(BASE, '') });
  }
  step('8. Export CSV (Customers, Dispatch, Quotes & Invoices)', exp.every((e) => e.status === 200 && /csv/.test(e.type || '')), JSON.stringify(exp));
  results.flowAdminLog = alog;
  await A.ctx.close();

  // Technician on mobile.
  await startServer();
  const T = await newPage(browser, 'mobile'); const tlog = newLog(); instrument(T.page, tlog); const tp = T.page;
  const tl = await uiLogin(tp, USERS.technician);
  step('9a. Login (technician, mobile) lands on Today', tl.ok && /today\.html/.test(tl.path), `path ${tl.path}`, { screenshot: await shot(tp, 'flow-09a-tech-today') });
  try {
    await tp.goto(BASE + '/today.html'); await settle(tp);
    const cards = await tp.$$eval('.today-card', (cs) => cs.map((c) => ({
      text: c.innerText.replace(/\s+/g, ' ').slice(0, 120),
      buttons: [...c.querySelectorAll('.big-actions .btn')].map((b) => ({ label: b.innerText.trim(), href: b.getAttribute('href') || '', h: Math.round(b.getBoundingClientRect().height) })),
    })));
    if (!cards.length) throw new Error('no jobs on the technician Today view');
    const c0 = cards[0];
    const lbl = (l) => c0.buttons.find((b) => b.label === l) || {};
    const omw = decodeURIComponent(lbl('On My Way').href || '');
    const txt = decodeURIComponent(lbl('Text Customer').href || '');
    const ok = /maps/.test(lbl('Navigate').href) && /^tel:/.test(lbl('Call').href) && /^sms:/.test(txt) && /^sms:/.test(omw) &&
      omw.includes(brand.companyName) && /on my way/i.test(omw) && c0.buttons.every((b) => b.h >= 44);
    step('9b. Technician Today view: Navigate / Call / Text Customer / On My Way', ok, `${cards.length} job(s); first: ${c0.text}; buttons ${c0.buttons.map((b) => `${b.label}:${b.h}px`).join(', ')}; On My Way → "${omw.slice(0, 160)}"`, { screenshot: await shot(tp, 'flow-09b-tech-today') });
    await tp.click('.today-card .title a'); await settle(tp);
    const head = await visibleText(tp, '#job-heading');
    await tp.select('#status-select', 'in-progress'); await settle(tp, 400);
    const st = await visibleText(tp, '#d-status');
    step('9c. Technician opens the job on mobile and starts it', !!head && /in progress/i.test(st), `${head}; status "${st}"`, { screenshot: await shot(tp, 'flow-09c-tech-job') });
    const png = path.join(os.tmpdir(), 'mbc-ui-walk-photo.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJklEQVR4nGP8z4AKGBkZGRgYGBj+M2ADjEwMjAwMDAwMjIwMDAAA7RQHAW1sZ8gAAAAASUVORK5CYII=', 'base64'));
    const input = await tp.$('#photo-input');
    await input.uploadFile(png);
    await tp.click('#btn-upload-photo'); await settle(tp, 800);
    const status = await visibleText(tp, '#photo-status');
    const thumbs = await tp.$$eval('.photo-thumb img', (is) => is.filter((i) => i.naturalWidth > 0).length);
    step('10. Upload a photo (technician, mobile)', /Uploaded/i.test(status) && thumbs > 0, `status "${status}", rendered thumbnails ${thumbs}`, { screenshot: await shot(tp, 'flow-10-photo-upload') });
  } catch (e) { step('9/10. Technician', false, e.message, { screenshot: await shot(tp, 'flow-09-tech-error') }); }
  results.flowTechLog = tlog;
  await T.ctx.close();

  // Dispatcher: no admin-only nav items, can reach dispatch.
  const D = await newPage(browser, 'desktop'); const dlog = newLog(); instrument(D.page, dlog);
  const dl = await uiLogin(D.page, USERS.dispatcher);
  const nav = await D.page.$$eval('#topnav .nav-links a', (as) => as.map((a) => a.textContent.trim())).catch(() => []);
  const adminItems = nav.filter((n) => /Team|API Keys|Quotes/.test(n));
  step('11. Dispatcher nav has no admin-only items', dl.ok && !adminItems.length && nav.includes('Dispatch') && nav.includes('Communications'), `nav: ${nav.join(', ')}`);
  await D.ctx.close();

  for (const [who, log] of [['admin', alog], ['technician', tlog], ['dispatcher', dlog]]) {
    const bad = [...log.pageErrors, ...log.console];
    step(`12. No JS/console errors during the ${who} flow`, bad.length === 0, bad.slice(0, 4).join(' | ') || 'none');
  }
}

// ── 3. XSS: stored payloads must render as text everywhere ────────────────────
async function xssCheck(browser, ctxInfo, results) {
  await startServer();
  const { token: t } = await apiLogin(USERS.admin);
  const P = (n) => `<img src=x onerror="window.__xss=(window.__xss||[]).concat(${n})">`;
  const created = {};
  const cust = await api(t, 'POST', '/api/customers', {
    firstName: P(1), lastName: `"><svg onload="window.__xss=(window.__xss||[]).concat(2)">`, phone: '620-555-0100',
    email: 'xss@example.test', address: P(3), city: `<b onmouseover=alert(1)>Town</b>`, zip: '<i>67501</i>', notes: P(5),
  });
  created.customer = cust.body && cust.body.id;
  const job = await api(t, 'POST', '/api/jobs', { customerId: created.customer, title: `<script>window.__xss=[6]</script>${P(7)}`, type: P(8), description: P(9), notes: P(10), status: 'scheduled', scheduledDate: TODAY, scheduledTime: '11:00', technicianId: ctxInfo.techId });
  created.job = job.body && job.body.id;
  const quote = await api(t, 'POST', '/api/quotes', { jobId: created.job, amount: 99, notes: P(11) });
  created.quote = quote.body && quote.body.id;
  const comm = await api(t, 'POST', '/api/communications', { customerId: created.customer, type: 'note', direction: 'outbound', subject: P(12), body: P(13) });
  created.comm = comm.body && comm.body.id;
  const pb = await api(t, 'POST', '/api/pricebook', { category: P(14), name: P(15), description: P(16), price: 1 });
  created.pricebook = pb.body && pb.body.id;
  const setupOk = created.customer && created.job;
  const pages = ['index', 'customers', `customer-detail?id=${created.customer}`, 'dispatch', `job?id=${created.job}`, 'schedule', 'today', `communications?customerId=${created.customer}`, 'communications', 'quote-invoice', 'pricebook'];
  const out = [];
  for (const role of ['admin', 'technician']) {
    const { ctx, page } = await newPage(browser, 'desktop');
    const login = await apiLogin(USERS[role]);
    await page.goto(BASE + '/api/health'); await page.evaluate((tk) => localStorage.setItem('token', tk), login.token);
    for (const p of (role === 'admin' ? pages : ['today', `job?id=${created.job}`, 'schedule'])) {
      const [name, q] = p.split('?');
      const reqs = [];
      page.on('request', (r) => { if (/\/x$/.test(r.url())) reqs.push(r.url()); });
      await page.goto(`${BASE}/${name}.html${q ? '?' + q : ''}`); await settle(page, 300);
      if (name === 'schedule') { await page.click('#btn-day').catch(() => {}); await sleep(200); }
      if (name === 'job' && role === 'admin') { await page.click('#btn-build-quote').catch(() => {}); await settle(page, 300); }
      const r = await page.evaluate(() => ({
        executed: window.__xss || null,
        injected: document.querySelectorAll('img[src="x"], svg[onload], b[onmouseover], script:not([src])').length,
        shownAsText: /onerror=/.test(document.body.innerText),
      }));
      page.removeAllListeners('request');
      out.push({ role, page: p, ...r, imgRequests: reqs.length, ok: !r.executed && !r.injected && !reqs.length });
    }
    await ctx.close();
  }
  // Clean up the payload records.
  if (created.comm) await api(t, 'DELETE', `/api/communications/${created.comm}`);
  if (created.quote) await api(t, 'DELETE', `/api/quotes/${created.quote}`);
  if (created.job) await api(t, 'DELETE', `/api/jobs/${created.job}`);
  if (created.customer) await api(t, 'DELETE', `/api/customers/${created.customer}`);
  if (created.pricebook) await api(t, 'DELETE', `/api/pricebook/${created.pricebook}`);
  results.xss = { setupOk: !!setupOk, created, checks: out };
  for (const c of out) console.log(`  [${c.ok ? 'pass' : 'FAIL'}] XSS ${c.role.padEnd(10)} ${c.page.padEnd(28)} executed=${JSON.stringify(c.executed)} injectedNodes=${c.injected} shownAsText=${c.shownAsText}`);
  if (!setupOk) console.log('  [FAIL] XSS fixtures could not be created: ' + JSON.stringify({ cust: cust.body, job: job.body }));
}

// ── 4. Final named screenshots ────────────────────────────────────────────────
async function finalShots(browser, ctxInfo, results) {
  await startServer();
  fs.mkdirSync(FINAL, { recursive: true });
  const { token: at } = await apiLogin(USERS.admin);
  const jobs = (await api(at, 'GET', '/api/jobs')).body || [];
  const billed = jobs.filter((j) => j.quote && j.invoice).pop() || jobs.find((j) => j.quote) || jobs[0];
  const quotable = jobs.find((j) => !j.quote && !j.invoice && j.status !== 'cancelled') || billed;
  const techJob = jobs.find((j) => j.technicianId === ctxInfo.techId && j.scheduledDate === TODAY) || jobs.find((j) => j.technicianId === ctxInfo.techId);
  const shots = [];
  const take = async (vp, role, url, name, prep) => {
    const { ctx, page } = await newPage(browser, vp);
    const log = newLog(); instrument(page, log);
    const { token } = await apiLogin(USERS[role]);
    await page.goto(BASE + '/api/health'); await page.evaluate((tk) => localStorage.setItem('token', tk), token);
    await page.goto(BASE + url); await settle(page);
    if (prep) await prep(page);
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(100); // sticky nav renders at the scroll position
    await shot(page, name, FINAL);
    shots.push({ file: path.join(FINAL, name + '.png'), url, role, viewport: vp, jsErrors: log.pageErrors.length + log.console.length });
    await ctx.close();
  };
  await take('desktop', 'admin', '/index.html', 'dashboard');
  await take('desktop', 'admin', '/schedule.html', 'schedule');
  await take('desktop', 'admin', '/dispatch.html', 'dispatch');
  await take('desktop', 'admin', `/job.html?id=${billed.id}`, 'job');
  await take('desktop', 'admin', `/job.html?id=${quotable.id}#quote`, 'quote', async (page) => {
    const opts = await page.$$eval('#qb-item option', (os) => os.filter((o) => /^\d+$/.test(o.value)).slice(0, 3).map((o) => o.value));
    for (const [i, v] of opts.entries()) { await page.select('#qb-item', v); await page.$eval('#qb-qty', (e, q) => { e.value = q; }, String(i + 1)); await page.click('#qb-add'); }
    await sleep(200);
  });
  await take('desktop', 'admin', '/quote-invoice.html?tab=invoices', 'invoice');
  await take('desktop', 'admin', '/customers.html', 'customers');
  await take('desktop', 'admin', '/team.html', 'team');
  await take('mobile', 'dispatcher', '/index.html', 'dashboard-mobile');
  if (techJob) await take('mobile', 'technician', `/job.html?id=${techJob.id}`, 'job-mobile-technician');
  await take('mobile', 'technician', '/today.html', 'today-mobile-technician');
  results.finalShots = shots;
  for (const s of shots) console.log(`  ${s.file}${s.jsErrors ? '  (JS/console errors: ' + s.jsErrors + ')' : ''}`);
}

// ── 5. Remove what the flow created, so re-runs start clean (no schedule clashes) ─
async function cleanupFlow(results) {
  const fc = results.flowCreated; if (!fc) return;
  await startServer();
  const { token: t } = await apiLogin(USERS.admin);
  const jobs = (await api(t, 'GET', '/api/jobs')).body || [];
  for (const j of jobs.filter((x) => x.title === fc.jobTitle)) {
    if (j.invoice) await api(t, 'DELETE', `/api/invoices/${j.invoice.id}`);
    if (j.quote) await api(t, 'DELETE', `/api/quotes/${j.quote.id}`);
    await api(t, 'DELETE', `/api/jobs/${j.id}`);
  }
  const custs = (await api(t, 'GET', '/api/customers')).body || [];
  for (const c of custs.filter((x) => x.lastName === fc.customerLast)) await api(t, 'DELETE', `/api/customers/${c.id}`);
  const users = (await api(t, 'GET', '/api/users')).body || [];
  for (const u of users.filter((x) => fc.emails.includes(x.email))) await api(t, 'DELETE', `/api/users/${u.id}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const results = { base: BASE, startedAt: new Date().toISOString(), roles: ROLES, viewports: VPS, pages: [], logins: [], flow: [], xss: null };
  let browser;
  try {
    await startServer();
    const ctxInfo = await ensureFixtures();
    results.brand = ctxInfo.brand; results.fixtures = ctxInfo.fixtures;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'] });
    if (!process.env.UI_SKIP_AUDIT) { console.log('Page audit'); await pageAudit(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_FLOW) { console.log('Main flow'); await flowWalk(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_XSS) { console.log('XSS'); await xssCheck(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_FINAL) { console.log('Final screenshots'); await finalShots(browser, ctxInfo, results); }
    if (!process.env.UI_KEEP_DATA) await cleanupFlow(results);
  } catch (e) {
    results.fatal = String(e.stack || e);
    console.error('FATAL', e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer();
    results.finishedAt = new Date().toISOString();
    const failPages = results.pages.filter((p) => p.problems.length);
    const failLogins = results.logins.filter((l) => l.problems.length);
    const failSteps = results.flow.filter((s) => s.status === 'fail');
    const failXss = results.xss ? results.xss.checks.filter((c) => !c.ok).length + (results.xss.setupOk ? 0 : 1) : 0;
    const count = (k) => results.pages.reduce((s, p) => s + (p[k] ? p[k].length : 0), 0);
    results.summary = {
      captures: results.pages.length, failingCaptures: failPages.length, failingLogins: failLogins.length,
      consoleErrors: count('console'), pageErrors: count('pageErrors'), httpErrors: count('httpErrors'),
      placeholderCaptures: results.pages.filter((p) => p.tokens && Object.keys(p.tokens).length).length,
      flowSteps: results.flow.length, flowFailures: failSteps.length, xssFailures: failXss,
    };
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`\nWrote ${path.join(OUT, 'results.json')}`);
    console.log('Summary', JSON.stringify(results.summary));
    const failed = !!results.fatal || failPages.length || failLogins.length || failSteps.length || failXss;
    if (failed) console.log(REPORT_ONLY ? 'FAILURES (report-only mode, exit 0)' : 'FAILED');
    process.exit(failed && !REPORT_ONLY ? 1 : 0);
  }
})();
