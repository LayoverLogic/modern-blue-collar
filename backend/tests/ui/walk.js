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
 *      change status, upload a photo; dispatcher nav has no admin items but does have
 *      Quotes & Invoices (read-only: lists, no New Quote / export).
 *      F4 layout checks: admin nav is one row at 1440px with a keyboard-usable "More" menu;
 *      mobile header (name + hamburger) is one row ≤ 72px; the reverse-charge checkbox is
 *      hidden for a US brand (shown only where the brand allows it); the import dry run has
 *      no "§", "Gate ", option keys or record refs on screen.
 *   2b. Integrations walk (admin, Settings): download the import template, dry-run a
 *      small generic CSV (new rows, a duplicate of a seeded customer, a bad phone, an
 *      XSS payload) → counts + gate-3 equation, decide the duplicate, report zip,
 *      commit with expectSha256, undo; export everything (zip manifest lists the
 *      tables); Xero CSV (date check, unmapped-tax warning); quotes CSV; QuickBooks
 *      in sandbox (Connect / Sync payments / Push to QuickBooks say "no request was
 *      sent"). Screenshots settings-data, import-dry-run, quickbooks.
 *   2c. Accounts walk: temporary password → forced change screen; profile menu →
 *      Change password (new token stored, old one revoked); Team: badges, change role,
 *      role matrix for a plain admin, reset password (temporary, shown once),
 *      deactivate / reactivate; Forgot password → outbox mail → reset-password.html
 *      (token from the fragment, stripped, single use); invite → accept-invite.html →
 *      signed in; Pricebook → Import CSV (dry run, problems, import); two quotes →
 *      two invoices on one job; dashboard "Scheduled Today" in the brand time zone and
 *      Recent Jobs order. Screenshots team-manage, reset-password, job-multi-documents.
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
 *      segments, because the API rate limiter (anonymous calls: 300 req / 15 min per IP) would
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
 *                UI_SKIP_INTEGRATIONS=1 (skip the Settings import / export / QuickBooks walk)
 *                UI_SKIP_ACCOUNTS=1 (skip the accounts walk)  UI_OFFICE_EMAIL (an admin, not super-admin; default office@demo.test)
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
// "Today" is the BRAND time zone's date (the pages use it too); set from /api/brand at start.
let TODAY = localISO();
function brandToday(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => parts.find((x) => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch { return localISO(); }
}

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
  // F4: the admin nav fits on ONE row at 1440px (less-used items under "More"), and "More" works by keyboard.
  try {
    const navRow = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#topnav .nav-links > a, #topnav .nav-links > .nav-more')];
      // A new row starts when an item begins below the previous item's bottom edge.
      const rects = items.map((e) => e.getBoundingClientRect());
      const tops = rects.filter((r, i) => i === 0 || r.top >= rects[i - 1].bottom - 1);
      return { items: items.map((e) => (e.querySelector('button') || e).innerText.trim()), rows: tops.length, navHeight: Math.round(document.getElementById('topnav').getBoundingClientRect().height),
        more: [...document.querySelectorAll('#nav-more-menu a')].map((a) => a.textContent.trim()) };
    });
    step('1b. Admin nav is one row at 1440px (Team / Pricebook / API Keys / Settings / Communications under "More")',
      navRow.rows === 1 && navRow.navHeight <= 72 && ['Team', 'Settings', 'API Keys'].every((x) => navRow.more.includes(x)), JSON.stringify(navRow));
    await page.focus('#nav-more-btn'); await page.keyboard.press('Enter'); await sleep(150);
    const opened = await page.evaluate(() => ({ open: !document.getElementById('nav-more-menu').hidden, expanded: document.getElementById('nav-more-btn').getAttribute('aria-expanded'),
      focus: document.activeElement && document.activeElement.closest('#nav-more-menu') ? document.activeElement.textContent.trim() : null }));
    await page.keyboard.press('ArrowDown'); await sleep(50);
    const second = await page.evaluate(() => (document.activeElement || {}).textContent);
    await page.keyboard.press('Escape'); await sleep(100);
    const closed = await page.evaluate(() => ({ open: !document.getElementById('nav-more-menu').hidden, focusOnButton: document.activeElement === document.getElementById('nav-more-btn') }));
    step('1c. "More" menu by keyboard: Enter opens + focuses the first item, arrows move, Escape closes back to the button',
      opened.open && opened.expanded === 'true' && !!opened.focus && second !== opened.focus && !closed.open && closed.focusOnButton, JSON.stringify({ opened, second, closed }));
  } catch (e) { step('1b/1c. Admin nav', false, e.message); }

  // Create customer.
  const first = 'Siobhan', last = `Walsh-${stamp}`;
  await page.goto(BASE + '/customers.html'); await settle(page);
  try {
    await page.click('#btn-new'); await sleep(250);
    if (!(await isVisible(page, '#modal'))) throw new Error('"+ New Customer" did not open the modal');
    await page.type('#f-company', `Walsh Plumbing ${stamp}`);
    await page.type('#f-first', first); await page.type('#f-last', last);
    const ie = ((brand.locale || {}).country || 'US') === 'IE';
    await page.type('#f-phone', ie ? '087 555 0142' : '620-555-0142'); await page.type('#f-email', `siobhan${stamp}@example.test`);
    // Synthetic address in the brand's locale format (IE: town, county, Eircode).
    const addr = ie ? ['14 Canal View', 'Naas', 'Co. Kildare', 'W91 C2X7'] : ['12 Main St', 'Hutchinson', 'Reno County', '67501'];
    await page.type('#f-address', addr[0]); await page.type('#f-city', addr[1]); await page.type('#f-state', addr[2]); await page.type('#f-zip', addr[3]);
    await page.click('#modal .btn-primary'); await settle(page, 400);
    const err = await visibleText(page, '#modal-error');
    const row = await page.$$eval('#customers-tbody tr', (rs, n) => rs.some((r) => r.innerText.includes(n)), last);
    // Company set → the company is the display name, the person shows underneath.
    const named = await page.$$eval('#customers-tbody tr', (rs, n) => { const r = rs.find((x) => x.innerText.includes(n)); return r ? { name: r.querySelector('a.row-link').innerText, contact: (r.querySelector('.contact-line') || {}).innerText || '' } : null; }, last);
    const nameOk = !!named && named.name === `Walsh Plumbing ${stamp}` && named.contact === `${first} ${last}`;
    step('2. Create customer with a company (Customers > + New Customer)', !err && row && nameOk, err ? `modal error: "${err}"` : `created; row shown: ${row}; name "${named && named.name}" / contact "${named && named.contact}"; address ${addr.join(', ')}`, { screenshot: await shot(page, 'flow-02-create-customer') });
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
    // GAP-16: the reverse-charge box only where the brand allows it — never for US sales tax.
    const rc = await page.evaluate(() => ({ box: !!document.getElementById('de-reverse'), available: MBC.fmt.reverseChargeAvailable(), country: MBC.fmt.country(), tax: MBC.fmt.tax().enabled, label: MBC.fmt.tax().label }));
    step('5r. Reverse-charge checkbox shown only when the brand allows it (hidden for a US brand)', rc.country === 'US' ? (!rc.box && !rc.available) : rc.box === rc.available, JSON.stringify(rc));
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
    const rcFlag = [tax.reverseChargeAvailable, tax.reverseCharge && tax.reverseCharge.available].find((v) => typeof v === 'boolean');
    const rcAvailable = typeof rcFlag === 'boolean' ? rcFlag : (tax.country || 'US') !== 'US';
    if (!tax.taxEnabled) { step('6g. Reverse-charge placeholder handling', null, 'tax not enabled for this brand'); }
    else if (!rcAvailable) { step('6g. Reverse-charge placeholder handling', null, 'reverse charge is not available for this brand (US sales tax / no RCT)'); }
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
    step('7. Invite a team member (Team > + Invite Member) → accept-invite link', !err && /outbox|not sent|emailed/i.test(res) && /accept-invite\.html#token=/.test(res) && !!(await page.$('#btn-copy-link')), `${err ? 'error: ' + err : res.replace(/\s+/g, ' ').slice(0, 220)}; HTTP errors: ${JSON.stringify(alog.httpErrors.slice(n))}`, { screenshot: await shot(page, 'flow-07-invite') });
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
  // F4: brand name + hamburger share one header row (≤ 72px); a long name truncates instead of wrapping.
  try {
    const hdr = await tp.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
      const name = document.getElementById('nav-company');
      return { nav: r('#topnav'), brand: r('.nav-brand'), toggle: r('.nav-toggle'), nameTruncates: !!name && getComputedStyle(name).textOverflow === 'ellipsis',
        badgeShown: !!document.getElementById('nav-trade') && getComputedStyle(document.getElementById('nav-trade')).display !== 'none' };
    });
    const oneRow = hdr.nav && hdr.toggle && hdr.brand && hdr.nav.h <= 72 && hdr.toggle.top < hdr.brand.bottom && hdr.toggle.bottom > hdr.brand.top;
    step('9a2. Mobile header: name + hamburger on one row, height ≤ 72px', !!oneRow && hdr.toggle.h >= 44, JSON.stringify(hdr));
  } catch (e) { step('9a2. Mobile header', false, e.message); }
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
  const adminItems = nav.filter((n) => /Team|API Keys|Settings/.test(n));
  step('11. Dispatcher nav has no admin-only items (and does have Quotes & Invoices)', dl.ok && !adminItems.length && nav.includes('Dispatch') && nav.includes('Communications') && nav.includes('Quotes & Invoices'), `nav: ${nav.join(', ')}`);
  // L10: dispatcher reads Quotes & Invoices — lists load, no New Quote / export, a read-only note.
  try {
    const before = dlog.httpErrors.length;
    await D.page.goto(BASE + '/quote-invoice.html'); await settle(D.page);
    const qi = await D.page.evaluate(() => ({
      rows: document.querySelectorAll('#list-tbody tr.clickable').length,
      newQuote: !document.getElementById('btn-new-quote').hidden, exportBtn: !document.getElementById('btn-export').hidden,
      note: !document.getElementById('readonly-note').hidden, denied: /do not have access/i.test(document.querySelector('main').innerText),
    }));
    const errs = dlog.httpErrors.slice(before);
    step('11a. Dispatcher sees Quotes & Invoices read-only (lists, no New Quote / export)', qi.rows > 0 && !qi.newQuote && !qi.exportBtn && qi.note && !qi.denied && !errs.length,
      `${JSON.stringify(qi)}; HTTP errors: ${errs.join(', ') || 'none'}`, { screenshot: await shot(D.page, 'flow-11a-dispatcher-billing') });
  } catch (e) { step('11a. Dispatcher Quotes & Invoices', false, e.message); }
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

// ── 2b. Integrations (admin): Settings → Data import / exports, QuickBooks ───
// Import: a small generic CSV (2 new rows, 1 duplicate of a seeded customer, 1 bad
// phone, 1 XSS payload) → dry run → decide the duplicate → commit → undo. Export
// everything: the zip's manifest lists the tables. Xero CSV with the unmapped-tax
// warning. QuickBooks in sandbox: every button says "no request was sent".
async function integrationsWalk(browser, ctxInfo, results) {
  await startServer();
  const steps = results.flow;
  const step = (name, ok, detail, extra = {}) => { const status = ok === true ? 'pass' : (ok === null ? 'skip' : 'fail'); steps.push({ step: name, status, detail, ...extra }); console.log(`  [${status}] ${name} — ${detail}`); };
  const stamp = Date.now().toString().slice(-5);
  const { token: at } = await apiLogin(USERS.admin);
  const S = await newPage(browser, 'desktop'); const slog = newLog(); instrument(S.page, slog); const page = S.page;
  await page.goto(BASE + '/api/health'); await page.evaluate((tk) => localStorage.setItem('token', tk), at);
  // Keep every Blob the page saves (the real fetch + save path still runs).
  const trapSaves = () => page.evaluate(() => {
    window.__saved = [];
    const orig = window.MBC.api.saveBlob;
    window.MBC.api.saveBlob = (b, n) => { window.__saved.push({ b, n }); return orig(b, n); };
  });
  const lastSaved = () => page.evaluate(async () => {
    const x = window.__saved[window.__saved.length - 1]; if (!x) return null;
    const buf = new Uint8Array(await x.b.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { name: x.n, size: buf.length, b64: btoa(bin) };
  });
  const tileVal = (sel, k) => page.$eval(`${sel} [data-count="${k}"] .value`, (e) => Number(e.textContent)).catch(() => null);

  await page.goto(BASE + '/settings.html'); await settle(page);
  await trapSaves();
  const tabs = await page.$$eval('.tabs .tab', (ts) => ts.map((t) => t.textContent.trim()));
  step('I1. Settings opens (admin) with Data + QuickBooks tabs', tabs.join(',') === 'Data,QuickBooks' && await isVisible(page, '#import-card'), `tabs ${tabs.join(', ')}`);

  // Template download.
  try {
    const resP = page.waitForResponse((r) => r.url().includes('/api/imports/templates/customers.csv'), { timeout: 8000 });
    await page.click('#btn-template');
    const r = await resP; await sleep(200);
    const saved = await lastSaved();
    const head = saved ? Buffer.from(saved.b64, 'base64').toString('utf8').split('\n')[0] : '';
    step('I2. Download the import template', r.status() === 200 && /^source_id,company,first_name/.test(head), `${r.status()} ${saved && saved.name}: "${head.slice(0, 60)}"`);
  } catch (e) { step('I2. Download the import template', false, e.message); }

  // Build the CSV: a duplicate of a seeded customer (same email + phone → auto_merge).
  const custs = (await api(at, 'GET', '/api/customers')).body || [];
  const dup = custs.find((c) => c.email && c.phone && c.zip && c.firstName && c.lastName && !c.company && !c.sourceSystem) || null;
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const ie = ((ctxInfo.brand.locale || {}).country || 'US') === 'IE';
  const addr = ie ? ['1 Canal View', 'Naas', 'Co. Kildare', 'W91 C2X7', 'IE', '087 555 01'] : ['1 Test Rd', 'Hutchinson', 'KS', '67501', 'US', '620-555-01'];
  const last = `Importwalk${stamp}`;
  const xss = '<img src=x onerror="window.__xss=(window.__xss||[]).concat(99)">';
  const csvRows = [
    'source_id,company,first_name,last_name,email,phone,phone_alt,line1,line2,city,region,postcode,country,type,tax_number,notes,created_at,lifetime_value,service_address,archived',
    `W${stamp}-1,,Aoife,${last},aoife.${stamp}@example.test,${addr[5]}11,,${addr[0]},,${addr[1]},${addr[2]},${addr[3]},${addr[4]},residential,,,2024-01-02,,,false`,
    `W${stamp}-2,${last} Builders,Ciaran,${last},builders.${stamp}@example.test,${addr[5]}12,,${addr[0]},,${addr[1]},${addr[2]},${addr[3]},${addr[4]},commercial,,"${xss.replace(/"/g, '""')}",2024-01-03,,,false`,
    `W${stamp}-3,,Bad,Phone${stamp},bad.${stamp}@example.test,12345,,${addr[0]},,${addr[1]},${addr[2]},${addr[3]},${addr[4]},residential,,,2024-01-03,,,false`,
  ];
  if (dup) csvRows.push([`W${stamp}-4`, '', dup.firstName, dup.lastName, dup.email, dup.phone, '', dup.address || '9 Elm', '', dup.city || addr[1], dup.state || addr[2], dup.zip, dup.country || addr[4], 'residential', '', '', '2024-01-04', '', '', 'false'].map(q).join(','));
  const csvFile = path.join(os.tmpdir(), `mbc-ui-walk-import-${stamp}.csv`);
  fs.writeFileSync(csvFile, csvRows.join('\n') + '\n');
  const expectRows = csvRows.length - 1;
  let committed = false;
  try {
    await page.select('#imp-source', 'generic');
    await (await page.$('#imp-file')).uploadFile(csvFile);
    await page.click('#btn-dry-run'); await settle(page, 400);
    if (!(await isVisible(page, '#dry-run'))) throw new Error('dry-run results not shown: ' + await visibleText(page, '#import-error'));
    const c = {};
    for (const k of ['sourceRows', 'created', 'excluded', 'errored', 'unexplained']) c[k] = await tileVal('#dr-counts', k);
    const gate = await visibleText(page, '#dr-gate3');
    const mergeRows = await page.$$eval('#dr-merge tbody tr', (rs) => rs.length);
    const excRows = await page.$$eval('#dr-exceptions tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
    const spot = await page.$$eval('#dr-spot tbody tr', (rs) => rs.length);
    const banner = await visibleText(page, '#dr-banner');
    const xssRun = await page.evaluate(() => ({ executed: window.__xss || null, injected: document.querySelectorAll('img[src="x"]').length }));
    const ok = c.sourceRows === expectRows && c.created === 2 && c.errored === 1 && c.unexplained === 0 && c.excluded === (dup ? 1 : 0) &&
      /Every row is accounted for/.test(gate) && /\d+ rows in the file = \d+ new \+/.test(gate) && mergeRows === (dup ? 1 : 0) &&
      excRows.some((r) => /phone number not valid/i.test(r)) && spot > 0 && /nothing has been written/i.test(banner) && !xssRun.executed && !xssRun.injected;
    step('I3. Import dry run: counts, gate-3 equation, duplicate, exceptions, spot check (nothing written, payload inert)', ok,
      `counts ${JSON.stringify(c)}; gate "${gate.replace(/\s+/g, ' ')}"; merge rows ${mergeRows}; exceptions ${excRows.length}; spot ${spot}; xss ${JSON.stringify(xssRun)}`);
    const before = (await api(at, 'GET', '/api/customers')).body.filter((x) => x.lastName === last).length;
    step('I3b. Dry run wrote nothing', before === 0, `${before} customer(s) named ${last}`);
    // F4: plain end-user wording — no playbook sections, gate numbers, option keys or record refs on screen.
    const jargon = await page.evaluate(() => {
      const t = document.getElementById('dry-run').innerText;
      return [/§/, /Gate \d/, /options\.\w/, /\b(customer|row):\d/, /merge-candidates\.csv/, /sourceRows/].map((re) => re.exec(t)).filter(Boolean)
        .map((m) => m[0] + ' in "…' + t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ') + '…"');
    });
    step('I3c. Import dry run uses plain wording (no "§", "Gate ", option keys, record ids or file names)', jargon.length === 0, jargon.length ? `found: ${jargon.join(', ')}` : 'clean');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(FINAL, 'import-dry-run' + SHOT_SUFFIX + '.png'), fullPage: true });

    // Decide the duplicate → merge, re-check.
    if (dup) {
      await page.select('#dr-merge tbody select.merge-decision', 'merge');
      await page.click('#btn-apply-decisions'); await settle(page, 400);
      const merged = await tileVal('#dr-counts', 'merged');
      const pending = await visibleText(page, '#dr-pending');
      step('I4. Decide the duplicate ("Same customer: merge") and re-check', merged === 1 && /0 still to decide/.test(pending), `merged ${merged}; "${pending}"`);
    } else step('I4. Decide the duplicate', null, 'no seeded customer with email + E.164 phone to duplicate');

    // Report zip.
    const zr = page.waitForResponse((r) => r.url().includes('/api/imports/customers') && r.url().includes('format=zip'), { timeout: 10000 });
    await page.click('#btn-report-zip');
    const zres = await zr; await sleep(300);
    const zsaved = await lastSaved();
    let zfiles = [];
    try { zfiles = Object.keys(require('fflate').unzipSync(Buffer.from(zsaved.b64, 'base64'))); } catch { /* not a zip */ }
    step('I5. Download the dry-run report (.zip)', zres.status() === 200 && ['report.json', 'report.md', 'exceptions.csv', 'merge-candidates.csv', 'spot-check.csv'].every((f) => zfiles.includes(f)), `${zres.status()} ${zsaved && zsaved.name}: ${zfiles.join(', ')}`);

    // Commit with expectSha256.
    const label = await visibleText(page, '#btn-commit');
    const cr = page.waitForResponse((r) => r.url().includes('/api/imports/customers') && r.url().includes('dryRun=false'), { timeout: 15000 });
    await page.click('#btn-commit'); await sleep(250);
    await page.click('#btn-commit-confirm');
    const cres = await cr; await settle(page, 400);
    const sha = /expectSha256=([0-9a-f]{64})/.test(cres.url());
    const ib = await visibleText(page, '#ir-banner');
    const created = await tileVal('#ir-counts', 'created');
    const nowRows = (await api(at, 'GET', '/api/customers')).body.filter((x) => x.lastName === last).length;
    committed = cres.status() === 200 && /Import complete/.test(ib);
    step('I6. Commit the import (expectSha256 = dry run checksum)', committed && sha && created === 2 && nowRows === 2 && /Import \d+ customer/.test(label),
      `${cres.status()} sha256 sent: ${sha}; button "${label}"; banner "${ib.slice(0, 80)}"; created ${created}; API rows ${nowRows}`);
    const undoInfo = await visibleText(page, '#undo-last');
    // Undo last import.
    const ur = page.waitForResponse((r) => r.url().includes('/api/imports/customers/undo'), { timeout: 15000 });
    await page.click('#btn-undo-last');
    const ures = await ur; await settle(page, 300);
    const us = await visibleText(page, '#undo-summary');
    const after = (await api(at, 'GET', '/api/customers')).body.filter((x) => x.lastName === last).length;
    const restoredDup = dup ? (await api(at, 'GET', `/api/customers/${dup.id}`)).body : null;
    const dupOk = !dup || (restoredDup && restoredDup.sourceSystem == null);
    step('I7. Undo last import', ures.status() === 200 && /2 removed/.test(us) && (!dup || /1 restored/.test(us)) && after === 0 && dupOk && /Undo last import/.test(undoInfo),
      `${ures.status()} "${us}"; customers left ${after}; duplicate restored ${dupOk}`, { screenshot: await shot(page, 'flow-I7-undo') });
    committed = after !== 0;
  } catch (e) { step('I3-7. Import wizard', false, e.message, { screenshot: await shot(page, 'flow-I3-import-error') }); }
  if (committed) { // the undo did not run: remove what the commit created
    for (const c of ((await api(at, 'GET', '/api/customers')).body || []).filter((x) => x.lastName === last)) await api(at, 'DELETE', `/api/customers/${c.id}`);
  }
  fs.rmSync(csvFile, { force: true });

  // Export everything.
  try {
    const er = page.waitForResponse((r) => r.url().includes('/api/exports/all'), { timeout: 20000 });
    await page.click('#btn-export-all');
    const eres = await er;
    await page.waitForFunction(() => /Saved|failed/.test((document.getElementById('export-all-status') || {}).innerText || ''), { timeout: 20000 });
    const st = await visibleText(page, '#export-all-status');
    const saved = await lastSaved();
    const files = require('fflate').unzipSync(Buffer.from(saved.b64, 'base64'));
    const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
    const tables = manifest.files.filter((f) => f.table && !f.photoId).map((f) => f.path);
    const need = ['customers.csv', 'jobs.csv', 'quotes.csv', 'invoices.csv', 'invoice_lines.csv', 'pricebook.csv', 'users.csv'];
    const ok = eres.status() === 200 && /\.zip$/.test(saved.name) && manifest.format === 'mbc-exit-export' && need.every((f) => tables.includes(f) && files[f]) &&
      !!files.SHA256SUMS && manifest.excluded.some((x) => x.table === 'ApiKey') && /Saved/.test(st);
    step('I8. Export everything → zip whose manifest lists the tables', ok, `${eres.status()} ${saved.name} ${saved.size} B; ${tables.length} tables (${tables.slice(0, 8).join(', ')}…); excluded ${manifest.excluded.map((x) => x.table).join(', ')}; status "${st.slice(0, 80)}"`);
  } catch (e) { step('I8. Export everything', false, e.message); }

  // Xero: validation, then a real export with the unmapped-tax warning.
  let fixtureInv = null, fixtureJob = null;
  try {
    const rates = ((ctxInfo.brand.locale || {}).taxRates || []).map((r) => r.key);
    const c0 = custs[0];
    fixtureJob = (await api(at, 'POST', '/api/jobs', { customerId: c0.id, title: `Xero export check ${stamp}` })).body;
    fixtureInv = (await api(at, 'POST', '/api/invoices', { jobId: fixtureJob.id, dueDate: localISO(new Date(Date.now() + 864e6)), lines: [{ description: 'Xero check labour', quantity: 1, unitPrice: 120, taxRateKey: rates[1] || rates[0] || null }] })).body;
    await page.$eval('#xero-from', (e) => { e.value = '2031-01-02'; });
    await page.$eval('#xero-to', (e) => { e.value = '2031-01-01'; });
    await page.click('#btn-xero'); await sleep(200);
    const verr = await visibleText(page, '#xero-error');
    await page.$eval('#xero-from', (e, d) => { e.value = d; }, TODAY.slice(0, 4) + '-01-01');
    await page.$eval('#xero-to', (e, d) => { e.value = d; }, TODAY);
    const xr = page.waitForResponse((r) => r.url().includes('/api/exports/xero-invoices'), { timeout: 10000 });
    await page.click('#btn-xero');
    const xres = await xr; await settle(page, 300);
    const hdr = xres.headers();
    const sum = await visibleText(page, '#xero-summary');
    const unm = (hdr['x-mbc-xero-unmapped-tax'] || '').split(',').filter(Boolean);
    const warn = await visibleText(page, '#xero-unmapped');
    const saved = await lastSaved();
    const csv = Buffer.from(saved.b64, 'base64').toString('utf8');
    const ok = /must be on or before/.test(verr) && xres.status() === 200 && /^\*ContactName,/.test(csv) && csv.includes(fixtureInv.number) &&
      sum.includes(`${hdr['x-mbc-xero-invoices']} invoice`) && unm.length > 0 && unm.every((k) => warn.includes(k));
    step('I9. Xero CSV: date-range check, download, unmapped-tax warning from X-MBC-Xero-Unmapped-Tax', ok,
      `validation "${verr}"; ${xres.status()} invoices ${hdr['x-mbc-xero-invoices']} lines ${hdr['x-mbc-xero-lines']}; unmapped [${unm.join(',')}]; warning "${warn.replace(/\s+/g, ' ').slice(0, 120)}"`);
  } catch (e) { step('I9. Xero export', false, e.message); }

  // A list export (quotes).
  try {
    const qr = page.waitForResponse((r) => r.url().includes('/api/exports/quotes'), { timeout: 8000 });
    await page.click('#list-exports [data-export="quotes"]');
    const qres = await qr; await sleep(200);
    const saved = await lastSaved();
    const head = Buffer.from(saved.b64, 'base64').toString('utf8').replace(/^﻿/, '').split('\n')[0];
    step('I10. Export the quotes list (CSV)', qres.status() === 200 && /csv/.test(qres.headers()['content-type'] || '') && /^"?id"?,"?number"?/.test(head), `${qres.status()} ${saved.name}: ${head.slice(0, 60)}`);
  } catch (e) { step('I10. Quotes export', false, e.message); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.goto(BASE + '/settings.html'); await settle(page);
  await page.screenshot({ path: path.join(FINAL, 'settings-data' + SHOT_SUFFIX + '.png'), fullPage: true });

  // QuickBooks tab (sandbox: disabled, nothing sent).
  try {
    const status = (await api(at, 'GET', '/api/quickbooks/status')).body || {};
    await page.click('#tab-btn-quickbooks'); await settle(page, 300);
    const notice = await visibleText(page, '#qbo-disabled');
    const state = await visibleText(page, '#qbo-state');
    if (status.enabled) step('I11. QuickBooks disabled state', null, 'QuickBooks is enabled on this server');
    else {
      await page.click('#btn-qbo-connect'); await settle(page, 300);
      const m1 = await visibleText(page, '#qbo-message');
      const urlAfter = page.url();
      await page.click('#btn-qbo-sync'); await settle(page, 300);
      const m2 = await visibleText(page, '#qbo-message');
      const ok = /disabled in (sandbox|demo)|not set up/i.test(notice) && /Not connected/.test(state) && /no request was sent/i.test(m1) && /no request was sent/i.test(m2) && /settings\.html/.test(urlAfter);
      step('I11. QuickBooks (sandbox): status, Connect and Sync payments say "no request was sent"', ok, `notice "${notice.slice(0, 90)}"; connect "${m1}"; sync "${m2}"`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(FINAL, 'quickbooks' + SHOT_SUFFIX + '.png'), fullPage: true });
    }
    // Invoice card: link badge + Push to QuickBooks.
    if (fixtureJob) {
      await page.goto(`${BASE}/job.html?id=${fixtureJob.id}`); await settle(page);
      const badge = await visibleText(page, '#qbo-badge');
      const hasPush = !!(await page.$('#btn-qbo-push'));
      if (hasPush) { await page.click('#btn-qbo-push'); await settle(page, 400); }
      const msg = await visibleText(page, '#qbo-msg');
      const ok = /Not in QuickBooks/.test(badge) && hasPush && (status.enabled ? !!msg : /no request was sent/i.test(msg));
      step('I12. Invoice card: QuickBooks badge + "Push to QuickBooks" (sandbox → nothing sent)', ok, `badge "${badge}"; push button ${hasPush}; message "${msg}"`, { screenshot: await shot(page, 'flow-I12-qbo-invoice') });
    }
  } catch (e) { step('I11-12. QuickBooks', false, e.message); }
  if (fixtureInv) await api(at, 'DELETE', `/api/invoices/${fixtureInv.id}`);
  if (fixtureJob) await api(at, 'DELETE', `/api/jobs/${fixtureJob.id}`);
  // The sandbox QuickBooks 503s are expected (and shown in the page); Chrome logs each as a resource error.
  const bad = [...slog.pageErrors, ...slog.console.filter((m) => !/status of 503/.test(m))];
  step('I13. No JS/console errors during the integrations walk', bad.length === 0, bad.slice(0, 4).join(' | ') || 'none');
  await S.ctx.close();
}

// ── 2c. Accounts (Part B): passwords, invites, team management, pricebook import,
//        several quotes / invoices per job, dashboard "today" in the brand time zone ─
function latestMail(to, needle, after) {
  if (!fs.existsSync(OUTBOX)) return null;
  const files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    const full = path.join(OUTBOX, f);
    if (fs.statSync(full).mtimeMs < after) break;
    try { const m = JSON.parse(fs.readFileSync(full, 'utf8')); if (String(m.to).includes(to) && String(m.text || '').includes(needle)) return m; } catch { /* skip */ }
  }
  return null;
}
async function accountsWalk(browser, ctxInfo, results) {
  await startServer();
  const steps = results.flow;
  const step = (name, ok, detail, extra = {}) => { const status = ok === true ? 'pass' : (ok === null ? 'skip' : 'fail'); steps.push({ step: name, status, detail, ...extra }); console.log(`  [${status}] ${name} — ${detail}`); };
  const stamp = Date.now().toString().slice(-5);
  const { token: at } = await apiLogin(USERS.admin);
  const probe = await api(at, 'GET', '/api/users');
  if (!Array.isArray(probe.body) || !probe.body.length || !('mustChangePassword' in probe.body[0])) { step('B0. Accounts API (2d)', null, 'server has no 2d account endpoints'); return; }
  const memberEmail = `orla${stamp}@example.test`, inviteEmail = `cian${stamp}@example.test`;
  results.accountsCreated = [memberEmail, inviteEmail];
  const temp1 = `Temp-pass-${stamp}!`, pw2 = `Orla-own-${stamp}-pw`, pw3 = `Orla-newer-${stamp}-pw`, pw4 = `Orla-reset-${stamp}-pw`;
  const allLogs = [];
  const adminPage = async () => {
    const X = await newPage(browser, 'desktop'); const lg = newLog(); instrument(X.page, lg); allLogs.push(lg);
    await X.page.goto(BASE + '/api/health'); await X.page.evaluate((tk) => localStorage.setItem('token', tk), at);
    return X;
  };
  const cardOf = (page, email) => page.$$eval('.team-card', (cs, e) => { const c = cs.find((x) => x.innerText.includes(e)); return c ? { text: c.innerText.replace(/\s+/g, ' '), id: c.getAttribute('data-user') } : null; }, email);

  // Member with a temporary password (server default mustChangePassword: true).
  const created = await api(at, 'POST', '/api/users', { firstName: 'Orla', lastName: `Kinsella-${stamp}`, email: memberEmail, role: 'technician', password: temp1 });
  const memberId = created.body && created.body.id;
  const A = await adminPage(); const page = A.page;
  try {
    await page.goto(BASE + '/team.html'); await settle(page);
    const c = await cardOf(page, memberEmail);
    const self = await cardOf(page, USERS.admin);
    const selfNoActions = self && !(await page.$(`.team-card[data-user="${self.id}"] [data-deactivate], .team-card[data-user="${self.id}"] select[data-role-for]`));
    step('B1. Team: new member shows "Must change password" + "Never signed in"; own card has no actions', !!c && /Must change password/.test(c.text) && /Never signed in/.test(c.text) && selfNoActions && created.body.mustChangePassword === true,
      `card "${c && c.text.slice(0, 140)}"; own card actions hidden ${selfNoActions}`);
    // Change role technician → dispatcher.
    await page.select(`select[data-role-for="${memberId}"]`, 'dispatcher'); await settle(page, 400);
    const after = (await api(at, 'GET', '/api/users')).body.find((u) => u.id === memberId);
    const opts = await page.$$eval(`select[data-role-for="${memberId}"] option`, (os) => os.map((o) => o.value));
    step('B2. Change role (technician → dispatcher); super-admin may grant admin', after && after.role === 'dispatcher' && opts.includes('admin'), `role now ${after && after.role}; options ${opts.join(',')}`);
  } catch (e) { step('B1-2. Team', false, e.message, { screenshot: await shot(page, 'flow-B1-team') }); }

  // Role matrix for a plain admin (office@demo.test by default).
  try {
    const officeEmail = process.env.UI_OFFICE_EMAIL || 'office@demo.test';
    const off = await apiLogin(officeEmail).catch(() => null);
    if (!off || off.user.role !== 'admin') step('B2b. Role matrix (admin)', null, `${officeEmail} is not an admin login here`);
    else {
      const O = await newPage(browser, 'desktop'); instrument(O.page, newLog());
      await O.page.goto(BASE + '/api/health'); await O.page.evaluate((tk) => localStorage.setItem('token', tk), off.token);
      await O.page.goto(BASE + '/team.html'); await settle(O.page);
      const users = (await api(at, 'GET', '/api/users')).body;
      const supers = users.filter((u) => ['admin', 'super-admin'].includes(u.role) && u.id !== off.user.id);
      const privActions = await O.page.evaluate((ids) => ids.filter((id) => document.querySelector(`.team-card[data-user="${id}"] [data-deactivate], .team-card[data-user="${id}"] select[data-role-for]`)).length, supers.map((u) => String(u.id)));
      const opts = await O.page.$$eval(`select[data-role-for="${memberId}"] option`, (os) => os.map((o) => o.value)).catch(() => []);
      step('B2b. Role matrix: an admin cannot manage admins / super-admins or grant admin', privActions === 0 && opts.length > 0 && !opts.includes('admin') && !opts.includes('super-admin'),
        `${supers.length} privileged cards, ${privActions} with actions; member role options ${opts.join(',')}`);
      await O.ctx.close();
    }
  } catch (e) { step('B2b. Role matrix', false, e.message); }

  // Forced password change on first sign-in (temporary password).
  let memberToken = null;
  try {
    const M = await newPage(browser, 'mobile'); const mlog = newLog(); instrument(M.page, mlog); allLogs.push(mlog);
    await M.page.goto(BASE + '/index.html'); await settle(M.page, 200);
    await M.page.type('#email-input', memberEmail); await M.page.type('#password-input', temp1);
    await M.page.click('#btn-login'); await settle(M.page, 600);
    const landed = M.page.url();
    await M.page.type('#cp-current', temp1); await M.page.type('#cp-new', pw2); await M.page.type('#cp-confirm', pw2);
    await M.page.click('#btn-cp-save'); await settle(M.page, 600);
    const end = M.page.url();
    memberToken = await M.page.evaluate(() => localStorage.getItem('token'));
    const me = (await api(memberToken, 'GET', '/api/users/me')).body || {};
    step('B3. Temporary password → forced "Choose a new password" screen → start page', /change-password\.html/.test(landed) && /index\.html|\/$/.test(end) && me.mustChangePassword === false,
      `after sign-in ${landed.replace(BASE, '')}; after save ${end.replace(BASE, '')}; mustChangePassword ${me.mustChangePassword}`, { screenshot: await shot(M.page, 'flow-B3-forced-change') });
    // Profile menu → Change password (the response's new token replaces the old one).
    await M.page.goto(BASE + '/dispatch.html'); await settle(M.page);
    await M.page.click('#topnav .nav-toggle').catch(() => {}); await sleep(150);
    await M.page.click('#nav-profile'); await sleep(150);
    await M.page.click('#nav-change-password'); await sleep(200);
    await M.page.type('#pw-current', pw2); await M.page.type('#pw-new', pw3); await M.page.type('#pw-confirm', pw3);
    await M.page.click('#pw-save'); await settle(M.page, 500);
    const err = await visibleText(M.page, '#pw-error');
    const tok2 = await M.page.evaluate(() => localStorage.getItem('token'));
    const oldTok = await api(memberToken, 'GET', '/api/users/me');
    const newTok = await api(tok2, 'GET', '/api/users/me');
    const relog = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password: pw3 }) });
    step('B4. Profile menu → Change password (mobile): new token stored, old session revoked, new password works', !err && tok2 && tok2 !== memberToken && oldTok.status === 401 && newTok.status === 200 && relog.status === 200,
      `error "${err}"; old token → ${oldTok.status}; new token → ${newTok.status}; sign-in with new password → ${relog.status}`, { screenshot: await shot(M.page, 'flow-B4-change-password') });
    memberToken = tok2;
    await M.ctx.close();
  } catch (e) { step('B3-4. Password change', false, e.message); }

  // Admin: reset password (temporary, shown once), deactivate / reactivate.
  try {
    await page.goto(BASE + '/team.html'); await settle(page);
    await page.click(`[data-reset="${memberId}"]`); await sleep(200);
    await page.click('#btn-reset-temp'); await settle(page, 400);
    const secret = await visibleText(page, '#reset-secret');
    const copyBtn = !!(await page.$('#reset-secret-copy'));
    const u1 = (await api(at, 'GET', '/api/users')).body.find((u) => u.id === memberId);
    const tl = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password: secret }) });
    step('B5. Reset password → temporary password shown once with Copy; user must change it', secret.length >= 10 && copyBtn && u1.mustChangePassword === true && tl.status === 200,
      `secret length ${secret.length}; copy ${copyBtn}; mustChangePassword ${u1.mustChangePassword}; sign-in with it → ${tl.status}`);
    await page.click('#reset-modal [data-close-modal]'); await settle(page, 300);
    const live = (await tl.json()).token;
    await page.click(`[data-deactivate="${memberId}"]`); await settle(page, 500);
    const c1 = await cardOf(page, memberEmail);
    const dead = await api(live, 'GET', '/api/users/me');
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await page.screenshot({ path: path.join(FINAL, 'team-manage' + SHOT_SUFFIX + '.png'), fullPage: true });
    await page.click(`[data-reactivate="${memberId}"]`); await settle(page, 500);
    const c2 = await cardOf(page, memberEmail);
    step('B6. Deactivate (session ends at once) and reactivate', /Deactivated/.test(c1.text) && dead.status === 401 && !/Deactivated/.test(c2.text) && !!(await page.$(`[data-deactivate="${memberId}"]`)),
      `after deactivate "${c1.text.slice(0, 80)}", their token → ${dead.status}; after reactivate "${c2.text.slice(0, 60)}"`);
  } catch (e) { step('B5-6. Reset / deactivate', false, e.message, { screenshot: await shot(page, 'flow-B5-team') }); }

  // Forgot password (login page) → emailed link (sandbox outbox) → reset page.
  try {
    const t0 = Date.now() - 1000;
    const F = await newPage(browser, 'desktop'); const flog = newLog(); instrument(F.page, flog); allLogs.push(flog);
    await F.page.goto(BASE + '/index.html'); await settle(F.page, 200);
    await F.page.click('#btn-forgot'); await sleep(150);
    await F.page.$eval('#forgot-email', (e) => { e.value = ''; });
    await F.page.type('#forgot-email', memberEmail);
    await F.page.click('#btn-forgot-send'); await settle(F.page, 500);
    const done = await visibleText(F.page, '#forgot-done');
    let mail = null;
    for (let i = 0; i < 20 && !mail; i++) { mail = latestMail(memberEmail, 'reset-password.html#token=', t0); if (!mail) await sleep(250); }
    const link = mail && (String(mail.text).match(/https?:\/\/\S+reset-password\.html#token=[A-Za-z0-9_-]+/) || [])[0];
    step('B7. Forgot password? → same answer for everyone + reset link emailed (sandbox outbox)', /If an account exists/i.test(done) && !!link, `"${done.slice(0, 90)}"; link ${link ? link.replace(/token=.*/, 'token=…') : 'not found in ' + OUTBOX}`);
    if (link) {
      await F.page.goto(link.replace(/^https?:\/\/[^/]+/, BASE)); await settle(F.page, 400);
      const urlAfter = await F.page.evaluate(() => location.href);
      const status = await visibleText(F.page, '#rp-status');
      await F.page.screenshot({ path: path.join(FINAL, 'reset-password' + SHOT_SUFFIX + '.png'), fullPage: true });
      await F.page.type('#rp-new', pw4); await F.page.type('#rp-confirm', pw4);
      await F.page.click('#btn-rp-save'); await settle(F.page, 400);
      const ok = await visibleText(F.page, '#rp-done');
      const relog = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: memberEmail, password: pw4 }) });
      // The same link again → expired / used (via about:blank: a hash-only change would not reload).
      await F.page.goto('about:blank');
      await F.page.goto(link.replace(/^https?:\/\/[^/]+/, BASE)); await settle(F.page, 400);
      const again = await visibleText(F.page, '#rp-bad');
      step('B8. Reset page: token read from the fragment and stripped, new password set, link single-use', !/token=/.test(urlAfter) && status.includes(memberEmail) && /changed/i.test(ok) && relog.status === 200 && /expired|used/i.test(again),
        `URL after load ${urlAfter.replace(BASE, '')}; "${status.slice(0, 70)}"; done "${ok.slice(0, 60)}"; sign-in → ${relog.status}; reuse → "${again.slice(0, 60)}"`);
    }
    await F.ctx.close();
  } catch (e) { step('B7-8. Forgot / reset', false, e.message); }

  // Invite → accept-invite page (set a password) → signed in.
  try {
    await page.goto(BASE + '/team.html'); await settle(page);
    await page.click('#btn-invite'); await sleep(200);
    await page.type('#f-first', 'Cian'); await page.type('#f-last', `Invitee-${stamp}`); await page.type('#f-email', inviteEmail);
    await page.click('#btn-send'); await settle(page, 400);
    const link = (await visibleText(page, '#invite-link')).trim();
    await page.click('#modal [data-close-modal]');
    const c0 = await cardOf(page, inviteEmail);
    const I = await newPage(browser, 'mobile'); const ilog = newLog(); instrument(I.page, ilog); allLogs.push(ilog);
    await I.page.goto(link.replace(/^https?:\/\/[^/]+/, BASE)); await settle(I.page, 400);
    const urlAfter = await I.page.evaluate(() => location.href);
    const email = await visibleText(I.page, '#ai-email');
    const first = await I.page.$eval('#ai-first', (e) => e.value);
    await I.page.type('#ai-password', `Cian-own-${stamp}-pw`); await I.page.type('#ai-confirm', `Cian-own-${stamp}-pw`);
    await I.page.click('#btn-ai-accept'); await settle(I.page, 600);
    const end = I.page.url();
    const tok = await I.page.evaluate(() => localStorage.getItem('token'));
    const me = tok ? (await api(tok, 'GET', '/api/users/me')).body : null;
    await page.goto(BASE + '/team.html'); await settle(page);
    const c1 = await cardOf(page, inviteEmail);
    step('B9. Invite → accept-invite page (token stripped) → password set → signed in; "Invited" badge goes', /Invited/.test(c0 && c0.text) && !/token=/.test(urlAfter) && email === inviteEmail && first === 'Cian' &&
      /today\.html/.test(end) && me && me.email === inviteEmail && !/Invited/.test(c1 && c1.text),
      `before "${c0 && c0.text.slice(0, 60)}"; URL ${urlAfter.replace(BASE, '')}; landed ${end.replace(BASE, '')}; me ${me && me.email}; after "${c1 && c1.text.slice(0, 60)}"`, { screenshot: await shot(I.page, 'flow-B9-accepted') });
    await I.ctx.close();
  } catch (e) { step('B9. Accept invite', false, e.message); }

  // Pricebook import (dry run → problems → commit).
  let pbItem = null;
  try {
    const csv = path.join(os.tmpdir(), `mbc-ui-walk-pricebook-${stamp}.csv`);
    fs.writeFileSync(csv, `sku,name,category,price,unit\nWALK-${stamp},Walk test valve ${stamp},Parts,12.50,each\n,Bad price ${stamp},Parts,abc,each\n`);
    await page.goto(BASE + '/pricebook.html'); await settle(page);
    await page.click('#btn-import'); await sleep(200);
    await (await page.$('#pb-file')).uploadFile(csv);
    await page.click('#btn-pb-dry'); await settle(page, 400);
    const v = async (k) => page.$eval(`#pb-counts [data-count="${k}"] .value`, (e) => Number(e.textContent)).catch(() => null);
    const dry = { created: await v('created'), errored: await v('errored') };
    const errRows = await page.$$eval('#pb-errors tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
    const none = ((await api(at, 'GET', '/api/pricebook')).body.items || []).some((i) => i.sku === `WALK-${stamp}`);
    const label = await visibleText(page, '#btn-pb-commit');
    await page.click('#btn-pb-commit'); await settle(page, 500);
    const banner = await visibleText(page, '#pb-banner');
    pbItem = ((await api(at, 'GET', '/api/pricebook')).body.items || []).find((i) => i.sku === `WALK-${stamp}`);
    await page.click('#import-modal [data-close-modal]'); await settle(page, 200);
    const listed = await page.$$eval('#items-tbody tr', (rs, s) => rs.some((r) => r.innerText.includes(s)), `WALK-${stamp}`);
    step('B10. Pricebook → Import CSV: dry run (1 new, 1 problem row shown), then import', dry.created === 1 && dry.errored === 1 && errRows.some((r) => /price/i.test(r)) && !none && /Import 1 row/.test(label) && /Imported/.test(banner) && !!pbItem && listed,
      `dry ${JSON.stringify(dry)}; problems ${errRows.join(' | ').slice(0, 100)}; before commit in DB ${none}; button "${label}"; "${banner.slice(0, 50)}"; listed ${listed}`, { screenshot: await shot(page, 'flow-B10-pricebook-import') });
    fs.rmSync(csv, { force: true });
  } catch (e) { step('B10. Pricebook import', false, e.message); }
  if (pbItem) await api(at, 'DELETE', `/api/pricebook/${pbItem.id}`);

  // Several quotes and invoices on one job.
  let mjob = null;
  try {
    const cust = ((await api(at, 'GET', '/api/customers')).body || [])[0];
    mjob = (await api(at, 'POST', '/api/jobs', { customerId: cust.id, title: `Two quotes ${stamp}` })).body;
    await page.goto(`${BASE}/job.html?id=${mjob.id}`); await settle(page);
    const build = async (desc, price) => {
      await page.click('#btn-build-quote'); await settle(page, 300);
      await page.click('#de-add'); await sleep(100);
      await page.type('[data-line="0"] [data-f="description"]', desc);
      await page.type('[data-line="0"] [data-f="unitPrice"]', price);
      await page.click('#de-save'); await settle(page, 500);
    };
    await build('Option A: repair', '180');
    await build('Option B: replace', '640');
    const cards = await page.$$eval('#quote-card .doc-item', (cs) => cs.map((c) => c.querySelector('.doc-number').textContent));
    // Convert the OLDER quote (the second card) → invoice; then the newer one too.
    const older = await page.$$('#quote-card .doc-item');
    await (await older[1].$('[data-act="convert"]')).click(); await sleep(250);
    await page.click('#btn-convert-confirm'); await settle(page, 500);
    await page.click('#btn-convert'); await sleep(250);
    await page.click('#btn-convert-confirm'); await settle(page, 500);
    const inv = await page.$$eval('#invoice-card .doc-item', (cs) => cs.map((c) => c.innerText.replace(/\s+/g, ' ')));
    const convertLeft = await page.$$eval('#quote-card [data-act="convert"]', (bs) => bs.length);
    const j = (await api(at, 'GET', `/api/jobs/${mjob.id}`)).body;
    step('B11. Job page: two quotes, each converted → two invoices (no "Convert" left)', cards.length === 2 && inv.length === 2 && convertLeft === 0 && (j.quotes || []).length === 2 && (j.invoices || []).length === 2 &&
      inv.every((t) => /from Q/.test(t) || /from quote/.test(t)), `quotes ${cards.join(', ')}; invoices ${inv.map((t) => t.slice(0, 40)).join(' | ')}; API ${(j.quotes || []).length}/${(j.invoices || []).length}`,
      { screenshot: await shot(page, 'flow-B11-multi-docs') });
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('.toast').forEach((t) => t.remove()); });
    const el = await page.$('#billing-card');
    if (el) { await page.evaluate(() => { document.getElementById('topnav').style.position = 'static'; }); await el.screenshot({ path: path.join(FINAL, 'job-multi-documents' + SHOT_SUFFIX + '.png') }); }
  } catch (e) { step('B11. Several quotes / invoices', false, e.message, { screenshot: await shot(page, 'flow-B11-multi-docs') }); }
  if (mjob) {
    const j = (await api(at, 'GET', `/api/jobs/${mjob.id}`)).body || {};
    for (const i of j.invoices || []) await api(at, 'DELETE', `/api/invoices/${i.id}`);
    for (const q of j.quotes || []) await api(at, 'DELETE', `/api/quotes/${q.id}`);
    await api(at, 'DELETE', `/api/jobs/${mjob.id}`);
  }

  // Dashboard: "Scheduled Today" in the brand time zone; Recent Jobs = ?sort=recent.
  try {
    await page.goto(BASE + '/index.html'); await settle(page);
    const shown = Number(await visibleText(page, '#stat-today'));
    const jobs = (await api(at, 'GET', '/api/jobs')).body || [];
    const want = jobs.filter((x) => x.scheduledDate === TODAY && x.status !== 'cancelled').length;
    const recentApi = ((await api(at, 'GET', '/api/jobs?sort=recent&limit=10')).body || []).map((x) => '#' + x.id);
    const recentUi = await page.$$eval('#jobs-tbody tr td:first-child', (ts) => ts.map((t) => t.innerText.trim()));
    step('B12. Dashboard: "Scheduled Today" counts the brand time zone\'s today; Recent Jobs newest first', shown === want && want > 0 && recentUi.join(',') === recentApi.join(','),
      `today (${(ctxInfo.brand || {}).timezone}) ${TODAY}: shown ${shown}, API ${want}; recent ${recentUi.slice(0, 5).join(',')}`);
    const slogan = (ctxInfo.brand || {}).companySlogan;
    if (slogan === '') {
      const L = await newPage(browser, 'desktop');
      await L.page.goto(BASE + '/index.html'); await settle(L.page, 200);
      const vis = await isVisible(L.page, '#login-slogan');
      step('B13. Empty brand slogan is hidden on the sign-in page', !vis, `slogan visible: ${vis}`);
      await L.ctx.close();
    }
  } catch (e) { step('B12. Dashboard', false, e.message); }

  await A.ctx.close();
  // Expected refusals from the negative checks (revoked token 401, temp-password 403, reused
  // reset link 400, sandbox 503) are logged by Chrome as resource errors: not page bugs.
  const bad = allLogs.flatMap((l) => [...l.pageErrors, ...l.console.filter((m) => !/status of (400|401|403|503)/.test(m))]);
  step('B14. No JS/console errors during the accounts walk', bad.length === 0, bad.slice(0, 4).join(' | ') || 'none');
  for (const u of ((await api(at, 'GET', '/api/users')).body || []).filter((x) => results.accountsCreated.includes(x.email))) await api(at, 'DELETE', `/api/users/${u.id}`);
}

// ── 3. XSS: stored payloads must render as text everywhere ────────────────────
async function xssCheck(browser, ctxInfo, results) {
  await startServer();
  const { token: t } = await apiLogin(USERS.admin);
  const P = (n) => `<img src=x onerror="window.__xss=(window.__xss||[]).concat(${n})">`;
  const created = {};
  const cust = await api(t, 'POST', '/api/customers', {
    firstName: P(1), lastName: `"><svg onload="window.__xss=(window.__xss||[]).concat(2)">`, phone: ((ctxInfo.brand.locale || {}).country === 'IE' ? '087 555 0100' : '620-555-0100'),
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
    const b0 = await (await fetch(BASE + '/api/brand')).json().catch(() => ({}));
    if (b0 && b0.timezone) TODAY = brandToday(b0.timezone);
    console.log(`Brand time zone ${b0 && b0.timezone}; today there = ${TODAY}`);
    const ctxInfo = await ensureFixtures();
    results.brand = ctxInfo.brand; results.fixtures = ctxInfo.fixtures;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'] });
    if (!process.env.UI_SKIP_AUDIT) { console.log('Page audit'); await pageAudit(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_FLOW) { console.log('Main flow'); await flowWalk(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_ACCOUNTS) { console.log('Accounts (passwords, invites, team, pricebook import, several documents per job, dashboard today)'); fs.mkdirSync(FINAL, { recursive: true }); await accountsWalk(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_INTEGRATIONS) { fs.mkdirSync(FINAL, { recursive: true }); console.log('Integrations (Settings: import, exports, QuickBooks)'); await integrationsWalk(browser, ctxInfo, results); }
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
