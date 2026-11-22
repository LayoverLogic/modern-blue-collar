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
 *   2. Main-flow walk by clicking (no API shortcuts): login, create customer
 *      (address fields per the brand locale), create job, open it from the board,
 *      assign technician + date/time, build a 3-line quote (2 pricebook lines +
 *      1 free-text line) with mixed tax rates, check the saved totals equal the
 *      API's, approve it, convert it to an invoice (POST /api/invoices/from-quote),
 *      open the print view, email the invoice and check a new .eml appears in the
 *      outbox and the email shows in the communications timeline, check the job's
 *      activity panel, reverse-charge placeholder handling on the print view,
 *      invite + add a team member, export CSV from three pages, technician on
 *      mobile: Today view with Navigate / Call / Text / On My Way, open the job,
 *      change status, upload a photo; dispatcher nav has no admin items.
 *   3. XSS: stores `<img src=x onerror=...>`-style payloads in a customer, job,
 *      quote, communication and pricebook item (via the API), opens every page
 *      that shows them and asserts nothing executed / no payload element exists.
 *      The payload records are deleted afterwards.
 *   4. Final screenshots (named PNGs) into UI_FINAL_DIR: dashboard, schedule,
 *      dispatch, job, quote (editor with 3 lines), invoice (job page with the
 *      flow's invoice), invoice-print, job-activity, customers, team,
 *      dashboard-mobile, job-mobile-technician, today-mobile-technician.
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
 *                UI_SHOT_SUFFIX=-ie  (appended to final screenshot names)
 *                UI_FINAL_ONLY=invoice,invoice-print  (take only these final screenshots)
 *
 * Logins: the generic demo seed (npm run seed:demo / sandbox:setup) — admin@demo.test,
 * tech1@demo.test (technician), dispatch@demo.test (dispatcher), password
 * DEFAULT_PASSWORD (default demo1234). Override with UI_ADMIN_EMAIL / UI_TECH_EMAIL /
 * UI_DISP_EMAIL / UI_PASSWORD. No client names or addresses live in this file.
 *
 * Tax: when the walk starts its own server and BRAND_TAX_RATES is not set, it
 * starts it with UI_TAX_RATES (default "standard:8.5,reduced:4,exempt:0") so the
 * quote can use mixed rates on the US demo too. Email: the server's sandbox
 * outbox (MAIL_DRIVER=outbox); the walk looks for new .eml files in
 * MAIL_OUTBOX_DIR (default backend/outbox).
 *
 * Irish screenshots (invoice-ie.png, invoice-print-ie.png):
 *   DATABASE_URL=…/mbc_frontend2_ie_demo BRAND_COUNTRY=IE BRAND_CURRENCY=EUR \
 *   BRAND_TAX_RATES=standard:23,reduced:13.5,zero:0 npm run seed:demo -- --prospect demo/prospects/ie-heating-example.json --reset
 *   then the same env + the prospect's BRAND_* vars (seed:demo --print-env) and
 *   UI_SKIP_AUDIT=1 UI_SKIP_XSS=1 UI_SHOT_SUFFIX=-ie UI_FINAL_ONLY=invoice,invoice-print npm run test:ui
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
const PASSWORD = process.env.UI_PASSWORD || process.env.DEFAULT_PASSWORD || 'demo1234';
const OUTBOX = path.resolve(process.env.MAIL_OUTBOX_DIR || path.join(BACKEND, 'outbox'));
const TAX_RATES = process.env.UI_TAX_RATES || 'standard:8.5,reduced:4,exempt:0';
const SHOT_SUFFIX = process.env.UI_SHOT_SUFFIX || '';
const FINAL_ONLY = process.env.UI_FINAL_ONLY ? process.env.UI_FINAL_ONLY.split(',').map((x) => x.trim()) : null;

// Generic demo seed logins (scripts/seed-demo.js); never client accounts.
const USERS = {
  admin:      process.env.UI_ADMIN_EMAIL || 'admin@demo.test',
  technician: process.env.UI_TECH_EMAIL  || 'tech1@demo.test',
  dispatcher: process.env.UI_DISP_EMAIL  || 'dispatch@demo.test',
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
  if (env.BRAND_TAX_RATES === undefined && TAX_RATES) env.BRAND_TAX_RATES = TAX_RATES;
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
  return {
    fixtures: fx, brand, techId, adminJobId: (billed || {}).id, techJobId: (techJob || {}).id, sampleCustomerId: (billed || jobs[0] || {}).customerId,
    sampleInvoiceId: ((billed && billed.invoice) || (jobs.find((j) => j.invoice) || {}).invoice || {}).id,
  };
}

const job_customer = (r) => (r && r.body && r.body.customerId) || '';

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
    const query = { job: `?id=${role === 'technician' ? ctxInfo.techJobId : ctxInfo.adminJobId}`, 'customer-detail': `?id=${ctxInfo.sampleCustomerId}`, print: `?type=invoice&id=${ctxInfo.sampleInvoiceId}` };
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
    const ie = ((brand.locale || {}).country || 'US') === 'IE';
    await page.type('#f-phone', ie ? '087 555 0142' : '620-555-0142'); await page.type('#f-email', `siobhan${stamp}@example.test`);
    // Synthetic address in the brand's locale format (IE: town, county, Eircode).
    const addr = ie ? ['14 Canal View', 'Naas', 'Co. Kildare', 'W91 C2X7'] : ['12 Main St', 'Hutchinson', 'Reno County', '67501'];
    await page.type('#f-address', addr[0]); await page.type('#f-city', addr[1]); await page.type('#f-state', addr[2]); await page.type('#f-zip', addr[3]);
    await page.click('#modal .btn-primary'); await settle(page, 400);
    const err = await visibleText(page, '#modal-error');
    const row = await page.$$eval('#customers-tbody tr', (rs, n) => rs.some((r) => r.innerText.includes(n)), last);
    step('2. Create customer (Customers > + New Customer)', !err && row, err ? `modal error: "${err}"` : `created; row shown: ${row}; address ${addr.join(', ')}`, { screenshot: await shot(page, 'flow-02-create-customer') });
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

  // Build a 3-line quote with mixed tax rates (2 pricebook lines + 1 free-text line).
  const jobId = jobUrl && (jobUrl.match(/id=(\d+)/) || [])[1];
  results.flowJobId = jobId ? Number(jobId) : null;
  const { token: at } = await apiLogin(USERS.admin);
  const rates = ((brand.locale || {}).taxRates || []).map((r) => r.key);
  const cardText = (sel) => visibleText(page, sel).then((t) => t.replace(/\s+/g, ' '));
  let quote = null, invoice = null;
  try {
    await page.goto(BASE + '/quote-invoice.html'); await settle(page);
    await page.click('#btn-new-quote'); await settle(page, 200);
    const has = await page.$$eval('#f-job option', (os, id) => os.some((o) => o.value === id), jobId);
    if (!has) throw new Error('job not offered in "New Quote"');
    await page.select('#f-job', jobId);
    await page.click('#new-quote-form .btn-primary'); await settle(page);
    if (!(await isVisible(page, '#doc-editor .doc-editor'))) throw new Error('line editor did not open on the job page');
    const items = await page.$$eval('#de-item option', (os) => os.filter((x) => /^\d+$/.test(x.value)).map((o) => o.value));
    if (items.length < 2) throw new Error('pricebook has fewer than 2 items');
    await page.select('#de-item', items[0]); await sleep(100);
    await page.select('#de-item', items[1]); await sleep(100);
    await page.click('#de-add'); await sleep(100);
    await page.type('[data-line="2"] [data-f="description"]', 'Call-out fee (free text)');
    await page.$eval('[data-line="0"] [data-f="quantity"]', (e) => { e.value = ''; });
    await page.type('[data-line="0"] [data-f="quantity"]', '2');
    await page.type('[data-line="2"] [data-f="unitPrice"]', '49.95');
    const mixed = rates.length >= 2;
    if (mixed) {
      await page.select('[data-line="0"] [data-f="taxRateKey"]', rates[0]);
      await page.select('[data-line="1"] [data-f="taxRateKey"]', rates[1]);
      await page.select('[data-line="2"] [data-f="taxRateKey"]', rates[rates.length - 1]);
    }
    await page.type('#de-notes', 'UI walk quote — valid 30 days');
    const lines = await page.$$eval('#de-lines .de-line', (rs) => rs.length);
    const preview = await visibleText(page, '#de-total');
    await shot(page, 'flow-05a-quote-editor');
    await page.click('#de-save'); await settle(page, 500);
    const err = await visibleText(page, '#de-error');
    const job = (await api(at, 'GET', `/api/jobs/${jobId}`)).body || {};
    quote = job.quote ? (await api(at, 'GET', `/api/quotes/${job.quote.id}`)).body : null;
    const card = await cardText('#quote-card');
    const f = quote && quote.print && quote.print.formatted;
    const ok = !err && lines === 3 && quote && quote.lines.length === 3 && /^\S+\d{4}$/.test(quote.number || '') &&
      card.includes(quote.number) && f && card.includes(f.total) && card.includes(f.subtotal) && preview === f.total &&
      (!mixed || (new Set(quote.lines.map((l) => l.taxRateKey)).size >= 2 && quote.taxTotal > 0 && card.includes(f.taxTotal)));
    step('5. Build a 3-line quote with mixed tax rates (pricebook + free text), totals = API', ok,
      err ? `editor error: "${err}"` : `${quote && quote.number}: preview ${preview}; API subtotal ${f && f.subtotal} tax ${f && f.taxTotal} total ${f && f.total}; rates ${quote && quote.lines.map((l) => l.taxRateKey + ':' + l.taxRate).join(',')}; card "${card.slice(0, 200)}"`,
      { screenshot: await shot(page, 'flow-05-quote') });
    await page.select('#quote-status', 'approved'); await settle(page, 500);
    const st = await page.$eval('#quote-status', (x) => x.value).catch(() => '');
    const locked = !(await page.$('#btn-edit-quote'));
    step('5b. Approve the quote (locks its lines: no "Edit lines")', st === 'approved' && locked, `quote status "${st}", edit button gone: ${locked}`);
  } catch (e) { step('5. Build a quote', false, e.message, { screenshot: await shot(page, 'flow-05-quote') }); }

  // Convert the quote to an invoice.
  try {
    if (!quote) throw new Error('no quote to convert');
    await page.goto(jobUrl); await settle(page);
    await page.click('#btn-convert'); await sleep(250);
    if (!(await isVisible(page, '#convert-modal'))) throw new Error('convert dialog did not open');
    await page.click('#btn-convert-confirm'); await settle(page, 500);
    const job = (await api(at, 'GET', `/api/jobs/${jobId}`)).body || {};
    invoice = job.invoice ? (await api(at, 'GET', `/api/invoices/${job.invoice.id}`)).body : null;
    const card = await cardText('#invoice-card');
    const f = invoice && invoice.print && invoice.print.formatted;
    const ok = invoice && invoice.amount === quote.amount && invoice.subtotal === quote.subtotal && invoice.taxTotal === quote.taxTotal &&
      invoice.lines.length === quote.lines.length && card.includes(invoice.number) && card.includes(f.total) && !(await page.$('#btn-convert'));
    step('6. Convert quote → invoice (lines and totals copied, equal to the API)', !!ok,
      `${invoice ? invoice.number : 'no invoice'}: total ${f && f.total} (quote ${quote.print.formatted.total}); card "${card.slice(0, 200)}"`, { screenshot: await shot(page, 'flow-06-invoice') });
  } catch (e) { step('6. Convert quote → invoice', false, e.message, { screenshot: await shot(page, 'flow-06-invoice') }); }

  // Print view of the invoice.
  try {
    if (!invoice) throw new Error('no invoice');
    const P = await newPage(browser, 'desktop'); const plog = newLog(); instrument(P.page, plog);
    await P.page.goto(BASE + '/api/health'); await P.page.evaluate((tk) => localStorage.setItem('token', tk), at);
    await P.page.goto(`${BASE}/print.html?type=invoice&id=${invoice.id}`); await settle(P.page);
    const v = await P.page.evaluate(() => ({
      number: (document.getElementById('p-fact-invoice-no') || {}).textContent,
      totals: document.getElementById('p-totals').innerText.replace(/\s+/g, ' '),
      lines: document.querySelectorAll('#p-lines-body tr').length,
      customer: document.getElementById('p-customer').innerText.replace(/\s+/g, ' '),
      paper: document.getElementById('page-size').getAttribute('href'),
      title: document.title,
    }));
    const f = invoice.print.formatted;
    const paperOk = ['US', 'CA'].includes(String((brand.locale || {}).country || 'US')) ? /letter/.test(v.paper) : /a4/.test(v.paper);
    const ok = v.number === invoice.number && v.lines === invoice.lines.length && v.totals.includes(f.total) && v.totals.includes(f.subtotal) &&
      (!invoice.taxTotal || v.totals.includes(f.taxTotal)) && invoice.print.customer.addressLines.every((l) => v.customer.includes(l)) && paperOk &&
      !plog.pageErrors.length && !plog.console.length;
    step('6b. Print view (print.html?type=invoice) matches the API', ok, `${JSON.stringify(v).slice(0, 300)}`, { screenshot: await shot(P.page, 'flow-06b-invoice-print') });
    await P.ctx.close();
  } catch (e) { step('6b. Print view', false, e.message); }

  // Email the invoice: a new .eml in the outbox + an email in the communications timeline.
  try {
    if (!invoice) throw new Error('no invoice');
    const emls = () => (fs.existsSync(OUTBOX) ? fs.readdirSync(OUTBOX).filter((x) => x.endsWith('.eml')) : []);
    const before = new Set(emls());
    await page.goto(jobUrl); await settle(page);
    await page.click('#btn-email-invoice'); await sleep(250);
    const to = await visibleText(page, '#email-to');
    await page.type('#email-message', 'Thanks — invoice attached below.');
    await page.click('#btn-email-send'); await settle(page, 600);
    const err = await visibleText(page, '#email-error');
    const fresh = emls().filter((x) => !before.has(x));
    const eml = fresh.length ? fs.readFileSync(path.join(OUTBOX, fresh[0]), 'utf8') : '';
    const card = await cardText('#invoice-card');
    const ok = !err && fresh.length === 1 && eml.includes(invoice.number) && /emailed/i.test(card) && !!to;
    step('6c. Email invoice to customer → new .eml in the outbox', ok, err ? `error "${err}"` : `to ${to}; new .eml: ${fresh.join(', ') || 'none'} in ${OUTBOX}; card "${card.slice(0, 140)}"`, { screenshot: await shot(page, 'flow-06c-emailed') });
    await page.goto(`${BASE}/communications.html?customerId=${job_customer(await api(at, 'GET', `/api/jobs/${jobId}`))}`); await settle(page);
    const tl = await visibleText(page, '#timeline');
    step('6d. Communications timeline shows the email', new RegExp(`email[\\s\\S]*${invoice.number.replace(/[-]/g, '\\-')}`, 'i').test(tl) && tl.includes(invoice.number),
      `timeline: "${tl.replace(/\s+/g, ' ').slice(0, 220)}"`, { screenshot: await shot(page, 'flow-06d-communications') });
  } catch (e) { step('6c. Email invoice', false, e.message); }

  // Activity panel on the job page.
  try {
    await page.goto(jobUrl); await settle(page);
    const acts = await page.$$eval('#activity-list li[data-type]', (ls) => ls.map((l) => ({ type: l.getAttribute('data-type'), text: l.innerText.replace(/\s+/g, ' ') })));
    const api_ = (await api(at, 'GET', `/api/jobs/${jobId}/activity`)).body || [];
    const types = acts.map((x) => x.type);
    const base = acts.length === api_.length && ['created', 'assigned'].every((t) => types.includes(t)) && acts.every((x) => !/undefined|null|NaN/.test(x.text));
    step('6e. Activity panel lists the job history (actor, human labels)', base, `${acts.length} entries (API ${api_.length}): ${acts.slice(0, 5).map((x) => x.text).join(' | ').slice(0, 300)}`, { screenshot: await shot(page, 'flow-06e-activity') });
    const docTypes = ['quote_created', 'invoice_created'].filter((t) => types.includes(t));
    step('6f. Activity shows quote_created / invoice_created', docTypes.length === 2 ? true : null,
      docTypes.length === 2 ? 'both shown' : `tolerated: the API logged ${docTypes.join(', ') || 'neither'} for UI-created documents (Backend gap)`);
  } catch (e) { step('6e. Activity panel', false, e.message); }

  // Reverse charge with placeholder wording: nothing printed, admins see a screen-only banner.
  try {
    const tax = brand.locale || {};
    if (!tax.taxEnabled) { step('6g. Reverse-charge placeholder handling', null, 'tax not enabled for this brand'); }
    else {
      const custs = (await api(at, 'GET', '/api/customers')).body || [];
      const c = custs.find((x) => x.lastName === `Walsh-${stamp}`) || custs[0];
      const j = (await api(at, 'POST', '/api/jobs', { customerId: c.id, title: `Reverse charge check ${stamp}` })).body;
      const inv = (await api(at, 'POST', '/api/invoices', { jobId: j.id, reverseCharge: true, dueDate: localISO(new Date(Date.now() + 864e6)), lines: [{ description: 'Subcontract labour', quantity: 1, unitPrice: 500, taxRateKey: (tax.taxRates[0] || {}).key }] })).body;
      const R = await newPage(browser, 'desktop'); instrument(R.page, newLog());
      await R.page.goto(BASE + '/api/health'); await R.page.evaluate((tk) => localStorage.setItem('token', tk), at);
      await R.page.goto(`${BASE}/print.html?type=invoice&id=${inv.id}`); await settle(R.page);
      const screen = await R.page.evaluate(() => ({ banner: !document.getElementById('rc-placeholder-banner').hidden, note: !document.getElementById('p-rc-note').hidden, text: document.getElementById('sheet').innerText }));
      await R.page.emulateMediaType('print');
      const printed = await R.page.evaluate(() => ({ banner: getComputedStyle(document.getElementById('rc-placeholder-banner')).display, text: document.getElementById('sheet').innerText }));
      await R.page.emulateMediaType(null);
      const ph = !!tax.reverseChargeNoteIsPlaceholder;
      const ok = ph ? (screen.banner && !screen.note && printed.banner === 'none' && !/placeholder/i.test(printed.text))
        : (!screen.banner && screen.note && printed.text.includes(tax.reverseChargeNote));
      step('6g. Reverse charge: placeholder wording never printed; admin banner on screen only', ok, `placeholder=${ph}; screen ${JSON.stringify({ banner: screen.banner, note: screen.note })}; print banner display ${printed.banner}`, { screenshot: await shot(R.page, 'flow-06g-reverse-charge') });
      await R.ctx.close();
      await api(at, 'DELETE', `/api/invoices/${inv.id}`); await api(at, 'DELETE', `/api/jobs/${j.id}`);
    }
  } catch (e) { step('6g. Reverse charge', false, e.message); }

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
  if (jobUrl) {
    await D.page.goto(jobUrl); await settle(D.page);
    const ro = await D.page.evaluate(() => ({
      quote: (document.getElementById('quote-number') || {}).textContent || '', invoice: (document.getElementById('invoice-number') || {}).textContent || '',
      editable: !!document.querySelector('#btn-edit-quote, #btn-edit-invoice, #btn-email-quote, #btn-email-invoice, #btn-convert, #quote-status'),
      print: !!document.getElementById('lnk-print-invoice'),
    }));
    step('11b. Dispatcher sees quote/invoice read-only (numbers + print, no edit/email)', !!ro.quote && !!ro.invoice && !ro.editable && ro.print, JSON.stringify(ro));
  }
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
    email: 'xss@example.test', address: P(3), addressLine2: P(4), city: `<b onmouseover=alert(1)>Town</b>`, state: '<i>KS</i>', company: P(18), notes: P(5),
  });
  created.customer = cust.body && cust.body.id;
  // Today, for the technician, at the first slot that is free (the API refuses double-booking).
  let job = null;
  for (const at of ['11:00', '06:00', '19:00', '21:00', '05:00', '22:30', '23:30']) {
    job = await api(t, 'POST', '/api/jobs', { customerId: created.customer, title: `<script>window.__xss=[6]</script>${P(7)}`, type: P(8), description: P(9), notes: P(10), status: 'scheduled', scheduledDate: TODAY, scheduledTime: at, duration: 0.5, technicianId: ctxInfo.techId });
    if (!(job.body && job.body.code === 'SCHEDULE_CONFLICT')) break;
  }
  created.job = job.body && job.body.id;
  const quote = await api(t, 'POST', '/api/quotes', { jobId: created.job, notes: P(11), lines: [{ description: P(17), quantity: 1, unitPrice: 99 }] });
  created.quote = quote.body && quote.body.id;
  const comm = await api(t, 'POST', '/api/communications', { customerId: created.customer, type: 'note', direction: 'outbound', subject: P(12), body: P(13) });
  created.comm = comm.body && comm.body.id;
  const pb = await api(t, 'POST', '/api/pricebook', { category: P(14), name: P(15), description: P(16), price: 1 });
  created.pricebook = pb.body && pb.body.id;
  const setupOk = created.customer && created.job;
  const pages = ['index', 'customers', `customer-detail?id=${created.customer}`, 'dispatch', `job?id=${created.job}`, 'schedule', 'today', `communications?customerId=${created.customer}`, 'communications', 'quote-invoice', 'pricebook', `print?type=quote&id=${created.quote}`];
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
  const take = async (vp, role, url, name, prep, element) => {
    if (FINAL_ONLY && !FINAL_ONLY.includes(name)) return;
    const { ctx, page } = await newPage(browser, vp);
    const log = newLog(); instrument(page, log);
    const { token } = await apiLogin(USERS[role]);
    await page.goto(BASE + '/api/health'); await page.evaluate((tk) => localStorage.setItem('token', tk), token);
    await page.goto(BASE + url); await settle(page);
    if (prep) await prep(page);
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(100); // sticky nav renders at the scroll position
    const file = path.join(FINAL, name + SHOT_SUFFIX + '.png');
    const el = element && await page.$(element);
    if (el) {
      // Element shot with the sticky nav out of the way.
      await page.evaluate(() => { const n = document.getElementById('topnav'); if (n) n.style.position = 'static'; });
      await el.screenshot({ path: file });
    } else await page.screenshot({ path: file, fullPage: true });
    shots.push({ file, url, role, viewport: vp, jsErrors: log.pageErrors.length + log.console.length });
    await ctx.close();
  };
  const flowJob = results.flowJobId && jobs.find((j) => j.id === results.flowJobId && j.invoice);
  const invJob = flowJob || jobs.filter((j) => j.invoice).pop() || billed;
  await take('desktop', 'admin', '/index.html', 'dashboard');
  await take('desktop', 'admin', '/schedule.html', 'schedule');
  await take('desktop', 'admin', '/dispatch.html', 'dispatch');
  await take('desktop', 'admin', `/job.html?id=${billed.id}`, 'job');
  await take('desktop', 'admin', `/job.html?id=${quotable.id}#quote`, 'quote', async (page) => {
    const rates = ((ctxInfo.brand.locale || {}).taxRates || []).map((r) => r.key);
    const opts = await page.$$eval('#de-item option', (os) => os.filter((o) => /^\d+$/.test(o.value)).slice(0, 2).map((o) => o.value));
    for (const v of opts) { await page.select('#de-item', v); await sleep(60); }
    await page.click('#de-add'); await sleep(60);
    await page.type('[data-line="2"] [data-f="description"]', 'Call-out fee');
    await page.type('[data-line="2"] [data-f="unitPrice"]', '49.95');
    if (rates.length >= 2) {
      await page.select('[data-line="1"] [data-f="taxRateKey"]', rates[1]);
      await page.select('[data-line="2"] [data-f="taxRateKey"]', rates[rates.length - 1]);
    }
    await sleep(150);
  }, '#billing-card');
  if (invJob && invJob.invoice) {
    await take('desktop', 'admin', `/job.html?id=${invJob.id}`, 'invoice', null, '#billing-card');
    await take('desktop', 'admin', `/print.html?type=invoice&id=${invJob.invoice.id}`, 'invoice-print');
  }
  // A seeded job with a full history (quote_created / invoice_created included).
  const richJob = jobs.find((j) => j.quote && j.invoice && j.id !== results.flowJobId) || flowJob || billed;
  await take('desktop', 'admin', `/job.html?id=${richJob.id}`, 'job-activity', null, '#activity-card');
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
    // Sent / approved documents are locked by design (409 DOCUMENT_LOCKED): void the
    // invoice and cancel the job instead, so it never blocks a schedule slot again.
    let locked = false;
    if (j.invoice && (await api(t, 'DELETE', `/api/invoices/${j.invoice.id}`)).status === 409) {
      locked = true; await api(t, 'PATCH', `/api/invoices/${j.invoice.id}`, { status: 'void', version: j.invoice.version });
    }
    if (j.quote && (await api(t, 'DELETE', `/api/quotes/${j.quote.id}`)).status === 409) locked = true;
    if (!locked) await api(t, 'DELETE', `/api/jobs/${j.id}`);
    else if (j.status !== 'cancelled') await api(t, 'PATCH', `/api/jobs/${j.id}`, { status: 'cancelled', version: j.version });
  }
  const custs = (await api(t, 'GET', '/api/customers')).body || [];
  for (const c of custs.filter((x) => x.lastName === fc.customerLast)) await api(t, 'DELETE', `/api/customers/${c.id}`); // 409 while it still has (locked) jobs
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
