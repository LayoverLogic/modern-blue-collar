#!/usr/bin/env node
/**
 * tests/ui/walk.js — headless-Chrome UI walk of every page in backend/public/.
 *
 * What it does
 *   1. Page audit: every page x role (admin, technician, dispatcher) x viewport
 *      (desktop 1440x900, mobile 390x844). For each it saves a full-page PNG and
 *      records console errors, page (JS) errors, failed / 4xx / 5xx requests,
 *      external hosts, broken same-origin links, dead onclick buttons (handler
 *      not defined), placeholder text ("undefined", "NaN", "Invalid Date",
 *      "[object Object]", "-" cells, "$0.00"), horizontal overflow and
 *      white-label branding (company name, primary colour, logo, <title>).
 *   2. Main-flow walk by clicking (no API shortcuts): login, create customer,
 *      create job, schedule/dispatch, technician opens the job on mobile and
 *      uploads a photo, build a quote, convert to invoice, invite a team
 *      member, export CSV. Every step is recorded as pass / fail / no-ui-path.
 *   3. Preview: re-renders the 5 pages whose inline script has a quoting
 *      SyntaxError with that one bug fixed in-flight (request interception, no
 *      source edits), to expose the field-name mismatches hiding behind it.
 *   4. Writes results.json next to the screenshots.
 *
 * The walk is an inspection tool: it exits 0 even when it finds problems
 * (pass --strict to exit 1 when any flow step fails).
 *
 * ── How to run ──────────────────────────────────────────────────────────────
 *   1. cd backend && npm install            (installs puppeteer-core, a devDependency)
 *   2. Make sure a Chrome / Chromium binary exists. Default: /usr/bin/google-chrome
 *      On a Mac: export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   3. Set up a throwaway sandbox database (the walk creates customers, jobs,
 *      quotes and invoices in it):
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
 *   5. Output: PNGs + results.json in UI_OUT_DIR
 *      (default /home/claude/mbc-team/screenshots/phase1, else backend/tests/ui/out).
 *
 * Options (env): UI_ROLES=admin,technician  UI_VIEWPORTS=desktop,mobile
 *                UI_PAGES=index,dispatch    UI_SKIP_AUDIT=1  UI_SKIP_FLOW=1  UI_SKIP_PREVIEW=1
 * Logins (seeded, password demo1234): admin@demo.test, mike@allproplumbinghvac.com
 * (technician), lisa@allproplumbinghvac.com (dispatcher).
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
const DEFAULT_OUT = fs.existsSync('/home/claude/mbc-team') ? '/home/claude/mbc-team/screenshots/phase1' : path.join(__dirname, 'out');
const OUT = process.env.UI_OUT_DIR || DEFAULT_OUT;
const STRICT = process.argv.includes('--strict');
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

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  server = spawn(process.execPath, ['server.js'], { cwd: BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  await waitHealthy();
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  await new Promise((r) => { s.once('exit', r); s.kill('SIGTERM'); setTimeout(r, 3000); });
}

// ── Small API helpers (fixtures + seeded-data lookup only, never the walked flow) ─
async function apiLogin(email) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const d = await r.json();
  if (!r.ok) throw new Error(`API login ${email}: ${r.status} ${JSON.stringify(d)}`);
  return d.token;
}
async function api(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, body: d };
}

// Ensures at least one quote and one invoice with real amounts exist so the
// list pages can be checked for "-"/"$0.00" where data exists.
async function ensureBillingFixtures() {
  const t = await apiLogin(USERS.admin);
  const jobs = (await api(t, 'GET', '/api/jobs')).body || [];
  const fx = { quote: null, invoice: null };
  const qJob = jobs.find((j) => j.quote) || jobs.find((j) => !j.quote && j.status !== 'completed');
  if (qJob && !qJob.quote) fx.quote = (await api(t, 'POST', '/api/quotes', { jobId: qJob.id, amount: 1450, notes: 'UI-walk fixture quote' })).body;
  else if (qJob) fx.quote = qJob.quote;
  const iJob = jobs.find((j) => j.invoice) || jobs.find((j) => !j.invoice && j.status === 'completed');
  if (iJob && !iJob.invoice) fx.invoice = (await api(t, 'POST', '/api/invoices', { jobId: iJob.id, amount: 185.5, dueDate: '2026-12-15', notes: 'UI-walk fixture invoice' })).body;
  else if (iJob) fx.invoice = iJob.invoice;
  const brand = await (await fetch(BASE + '/api/brand')).json();
  return { fixtures: fx, brand, sampleJobId: (jobs[0] || {}).id, sampleCustomerId: (jobs[0] || {}).customerId };
}

// ── Browser helpers ─────────────────────────────────────────────────────────
function instrument(page, log) {
  const host = new URL(BASE).host;
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') log.console.push(`[${m.type()}] ${m.text()}`.slice(0, 400)); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message || e).split('\n')[0].slice(0, 300)));
  page.on('requestfailed', (req) => log.failed.push(`${req.method()} ${req.url()} — ${req.failure() && req.failure().errorText}`));
  page.on('request', (req) => { try { const u = new URL(req.url()); if (/^https?:$/.test(u.protocol) && u.host !== host) log.external.push(req.url()); } catch { /* data: etc */ } });
  page.on('response', (res) => { if (res.status() >= 400) log.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url().replace(BASE, '')}`); });
  page.on('dialog', async (d) => { log.dialogs.push(`${d.type()}: ${d.message()}`.slice(0, 300)); await d.accept().catch(() => {}); });
}
function newLog() { return { console: [], pageErrors: [], failed: [], external: [], httpErrors: [], dialogs: [] }; }

async function newPage(browser, vp) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(VIEWPORTS[vp]);
  if (vp === 'mobile') await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  return { ctx, page };
}
async function settle(page, ms = 900) { await page.waitForNetworkIdle({ idleTime: 400, timeout: 8000 }).catch(() => {}); await sleep(ms); }
const shot = async (page, name) => { const f = `${name}.png`; await page.screenshot({ path: path.join(OUT, f), fullPage: true }); return f; };

// In-page inspection: placeholders, overflow, dead buttons, branding, links.
async function inspect(page, brand, designWidth) {
  return page.evaluate((brand, designWidth) => {
    const vis = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
    const text = document.body ? document.body.innerText : '';
    const tokens = {};
    for (const t of ['undefined', 'NaN', 'Invalid Date', '[object Object]', 'null']) {
      const m = text.match(new RegExp('(^|[^A-Za-z])' + t.replace(/[[\]]/g, '\\$&') + '([^A-Za-z]|$)', 'g'));
      if (m) tokens[t] = m.length;
    }
    const tds = [...document.querySelectorAll('td')].filter(vis);
    const dashCells = tds.filter((td) => td.innerText.trim() === '-').length;
    const zeroMoney = (text.match(/\$0\.00/g) || []).length;
    // Compare against the emulated device width: with isMobile Chrome zooms out and
    // widens window.innerWidth to fit overflowing content, which would hide the overflow.
    const docW = document.documentElement.scrollWidth; const vw = designWidth || window.innerWidth;
    const overflowEls = [];
    if (docW > vw + 1) {
      for (const el of document.querySelectorAll('nav, nav *, main > *, table, .modal, .controls, .filters, .action-bar')) {
        const r = el.getBoundingClientRect();
        if (vis(el) && r.right > vw + 1) overflowEls.push((el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) + ` right=${Math.round(r.right)}`);
        if (overflowEls.length > 6) break;
      }
    }
    // Dead buttons / clickables: onclick handler names that are not defined on window.
    const dead = [];
    for (const el of document.querySelectorAll('[onclick],[onchange],[oninput]')) {
      const code = el.getAttribute('onclick') || el.getAttribute('onchange') || el.getAttribute('oninput');
      const m = code.match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
      if (m && typeof window[m[1]] !== 'function' && !['confirm', 'alert'].includes(m[1])) dead.push(`${(el.innerText || el.id || el.tagName).trim().slice(0, 30)} -> ${m[1]}()`);
    }
    const rootStyle = getComputedStyle(document.documentElement);
    const primary = (document.documentElement.style.getPropertyValue('--color-primary') || rootStyle.getPropertyValue('--color-primary')).trim();
    const navCompany = document.getElementById('nav-company');
    const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h && !h.startsWith('#') && !h.startsWith('javascript:'));
    const navLinks = [...document.querySelectorAll('nav a[href]')].map((a) => a.getAttribute('href'));
    const loginVisible = !!document.getElementById('login-screen') && vis(document.getElementById('login-screen'));
    return {
      title: document.title, url: location.pathname + location.search, h2: (document.querySelector('h2') || {}).innerText || '',
      tokens, dashCells, zeroMoney, docWidth: docW, viewportWidth: vw, overflow: docW > vw + 1, overflowEls,
      deadHandlers: [...new Set(dead)],
      branding: {
        navCompany: navCompany ? navCompany.innerText : null,
        companyNameShown: !!brand.companyName && text.includes(brand.companyName),
        titleHasCompany: !!brand.companyName && document.title.includes(brand.companyName),
        primaryCss: primary, brandPrimary: brand.colors && brand.colors.primary,
        primaryApplied: !!(brand.colors && primary.toLowerCase() === String(brand.colors.primary).toLowerCase()),
        logo: !!document.querySelector('img[src*="logo" i], img.logo, .logo img, svg.logo, link[rel~="icon"]'),
      },
      links: [...new Set(links)], navLinks, loginVisible,
      snippet: text.replace(/\s+/g, ' ').slice(0, 300), layoutWidth: window.innerWidth,
    };
  }, brand, designWidth);
}

async function checkLinks(hrefs, fromPath) {
  const broken = [];
  for (const h of hrefs) {
    let u; try { u = new URL(h, BASE + fromPath); } catch { broken.push(h + ' (unparseable)'); continue; }
    if (u.origin !== new URL(BASE).origin) continue;
    try { const r = await fetch(u.href, { method: 'GET', redirect: 'manual' }); if (r.status >= 400) broken.push(`${h} -> ${r.status}`); } catch (e) { broken.push(`${h} -> ${e.message}`); }
  }
  return broken;
}

// UI login by typing + clicking. Returns { ok, reason }.
async function uiLogin(page, email) {
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await settle(page, 300);
  await page.type('#email-input', email);
  await page.type('#password-input', PASSWORD);
  await page.click('.login-card .btn-primary');
  await settle(page, 600);
  const state = await page.evaluate(() => ({
    token: !!localStorage.getItem('token'),
    appVisible: getComputedStyle(document.getElementById('app')).display !== 'none',
    err: (document.getElementById('error-msg') || {}).innerText || '',
  }));
  return { ok: state.token && state.appVisible, ...state };
}
// Fallback used only so the per-page audit can proceed when the UI login is broken.
async function injectToken(page, token) {
  await page.goto(BASE + '/api/health', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('token', t), token);
}

// ── 1. Page audit ───────────────────────────────────────────────────────────
async function pageAudit(browser, ctxInfo, results) {
  const { brand, fixtures, sampleJobId, sampleCustomerId } = ctxInfo;
  const query = { job: `?id=${sampleJobId}`, 'customer-detail': `?id=${sampleCustomerId}` };
  for (const role of ROLES) {
    for (const vp of VPS) {
      await startServer(); // fresh rate-limit window per segment
      const token = await apiLogin(USERS[role]);
      const { ctx, page } = await newPage(browser, vp);
      // Try the real login once per segment so the result is visible per role/viewport.
      const lg = newLog(); instrument(page, lg);
      const login = await uiLogin(page, USERS[role]).catch((e) => ({ ok: false, reason: e.message }));
      results.logins.push({ role, viewport: vp, ...login, pageErrors: lg.pageErrors.slice(0, 3), screenshot: await shot(page, `login-${role}-${vp}`) });
      page.removeAllListeners('console'); page.removeAllListeners('pageerror'); page.removeAllListeners('requestfailed');
      page.removeAllListeners('request'); page.removeAllListeners('response'); page.removeAllListeners('dialog');
      if (!login.ok) await injectToken(page, token);
      for (const p of PAGES) {
        const log = newLog(); instrument(page, log);
        const url = `/${p}.html${query[p] || ''}`;
        await page.goto(BASE + url, { waitUntil: 'domcontentloaded' }).catch((e) => log.failed.push('goto ' + e.message));
        await settle(page);
        const info = await inspect(page, brand, VIEWPORTS[vp].width).catch((e) => ({ error: e.message }));
        const file = await shot(page, `${p}-${role}-${vp}`);
        const brokenLinks = vp === 'desktop' ? await checkLinks(info.links || [], url) : [];
        results.pages.push({ page: p, role, viewport: vp, url, screenshot: file, ...info, brokenLinks, ...log });
        page.removeAllListeners('console'); page.removeAllListeners('pageerror'); page.removeAllListeners('requestfailed');
        page.removeAllListeners('request'); page.removeAllListeners('response'); page.removeAllListeners('dialog');
        process.stdout.write(`  ${p.padEnd(16)} ${role.padEnd(10)} ${vp.padEnd(7)} jsErr=${log.pageErrors.length} http4xx5xx=${log.httpErrors.length} overflow=${info.overflow ? 'Y' : 'n'} dead=${(info.deadHandlers || []).length}\n`);
      }
      await ctx.close();
    }
  }
  results.fixtures = fixtures;
}

// ── 2. Main-flow walk (clicking) ────────────────────────────────────────────
async function flowWalk(browser, ctxInfo, results) {
  await startServer();
  const steps = results.flow;
  const step = (name, status, detail, extra = {}) => { steps.push({ step: name, status, detail, ...extra }); console.log(`  [${status}] ${name} — ${detail}`); };
  const stamp = Date.now().toString().slice(-5);

  // Admin on desktop.
  const A = await newPage(browser, 'desktop'); const alog = newLog(); instrument(A.page, alog); const page = A.page;
  const login = await uiLogin(page, USERS.admin);
  step('1. Login (admin, desktop, typed credentials + Sign In)', login.ok ? 'pass' : 'fail',
    login.ok ? 'dashboard shown' : `no token / dashboard after clicking Sign In; JS errors: ${alog.pageErrors.slice(0, 2).join(' | ') || 'none'}`, { screenshot: await shot(page, 'flow-01-login-admin') });
  if (!login.ok) await injectToken(page, await apiLogin(USERS.admin));

  // Create customer.
  await page.goto(BASE + '/customers.html'); await settle(page);
  const custName = `Siobhan Walsh-${stamp}`;
  try {
    await page.click('.page-header .btn-primary');
    await sleep(300);
    const modalOpen = await page.$eval('#modal', (m) => m.classList.contains('open'));
    if (!modalOpen) throw new Error('"+ New Customer" did not open the modal (handler not defined)');
    await page.type('#f-name', custName); await page.type('#f-phone', '620-555-0142'); await page.type('#f-email', `siobhan${stamp}@example.test`);
    await page.type('#f-address', '12 Main St'); await page.type('#f-city', 'Hutchinson'); await page.type('#f-state', 'KS'); await page.type('#f-zip', '67501');
    await page.click('#modal .btn-primary'); await settle(page, 500);
    const err = await page.$eval('#modal-error', (e) => (e.style.display !== 'none' ? e.innerText : ''));
    step('2. Create customer (Customers > + New Customer)', err ? 'fail' : 'pass', err ? `modal error: "${err}"` : 'customer created', { screenshot: await shot(page, 'flow-02-create-customer') });
  } catch (e) { step('2. Create customer (Customers > + New Customer)', 'fail', e.message, { screenshot: await shot(page, 'flow-02-create-customer') }); }

  // Create job.
  await page.goto(BASE + '/dispatch.html'); await settle(page);
  try {
    await page.click('.page-header .btn-primary'); await sleep(300);
    const modalOpen = await page.$eval('#modal', (m) => m.classList.contains('open'));
    if (!modalOpen) throw new Error('"+ New Job" did not open the modal (handler not defined)');
    const opts = await page.$$eval('#f-customer option', (os) => os.map((o) => [o.value, o.textContent]));
    const techOpts = await page.$$eval('#f-tech option', (os) => os.length);
    const typeOpts = await page.$$eval('#f-type option', (os) => os.length);
    const custOpt = opts.find((o) => o[0]);
    if (!custOpt) throw new Error(`customer dropdown is empty (options: ${JSON.stringify(opts)})`);
    await page.select('#f-customer', custOpt[0]);
    if (typeOpts > 1) await page.select('#f-type', await page.$eval('#f-type option:nth-child(2)', (o) => o.value));
    await page.type('#f-notes', 'UI walk: leaking outside tap');
    await page.click('#modal .btn-primary'); await settle(page, 500);
    const err = await page.$eval('#modal-error', (e) => (e.style.display !== 'none' ? e.innerText : ''));
    step('3. Create job (Dispatch > + New Job)', err ? 'fail' : 'pass', (err ? `modal error: "${err}"` : 'job created') + `; customer options labelled ${JSON.stringify(custOpt[1])}; technician options=${techOpts - 1}`, { screenshot: await shot(page, 'flow-03-create-job') });
  } catch (e) { step('3. Create job (Dispatch > + New Job)', 'fail', e.message, { screenshot: await shot(page, 'flow-03-create-job') }); }

  // Schedule + dispatch: open a job from the board, set status / technician.
  let jobUrl = null; let monthLabel = '';
  try {
    const rows = await page.$$('#jobs-tbody tr');
    const before = page.url();
    if (rows.length) { await rows[0].click(); await settle(page, 300); }
    if (page.url() === before) {
      // Board rows are not clickable; try the Schedule page chips instead.
      await page.goto(BASE + '/schedule.html'); await settle(page);
      await page.click('#btn-month').catch(() => {});
      await page.evaluate((d) => { const el = document.getElementById('date-picker'); el.value = d; el.dispatchEvent(new Event('change')); }, '2026-04-02');
      await settle(page, 300);
      monthLabel = await page.$eval('#nav-label', (e) => e.innerText);
      await shot(page, 'flow-04a-schedule-month-jump');
      await page.click('#btn-day').catch(() => {});
      await page.evaluate((d) => { const el = document.getElementById('date-picker'); el.value = d; el.dispatchEvent(new Event('change')); }, '2026-04-02');
      await settle(page, 300);
      const chip = await page.$('.day-job, .job-chip');
      step('4a. Open a job from the Dispatch board', 'fail', `clicking a board row did nothing (rows rendered: ${rows.length}); fell back to Schedule; month view after picking 2026-04-02 in the date picker shows "${monthLabel}"; day view 2026-04-02 > ${chip ? 'job chip' : 'no chip found'}`, { screenshot: await shot(page, 'flow-04a-schedule-month') });
      if (chip) { await chip.click(); await settle(page); }
    } else step('4a. Open a job from the Dispatch board', 'pass', 'row click opened job page');
    jobUrl = page.url();
    const jobHeading = await page.$eval('#job-heading', (e) => e.innerText).catch(() => '');
    if (!/job\.html\?id=\d+/.test(jobUrl)) throw new Error('could not reach a job page by clicking');
    const hasTechPicker = await page.$('#job-content select:not(#status-select)');
    const hasDatePicker = await page.$('#job-content input[type=date], #job-content input[type=datetime-local], #job-content input[type=time]');
    await page.select('#status-select', 'scheduled'); await settle(page, 400);
    const st = await page.$eval('#d-status', (e) => e.innerText);
    step('4b. Schedule & dispatch the job (job page)', hasTechPicker && hasDatePicker ? 'pass' : 'no-ui-path',
      `${jobHeading}: status select -> "${st}"; technician picker on job page: ${hasTechPicker ? 'yes' : 'NO'}; date/time picker: ${hasDatePicker ? 'yes' : 'NO'} (Schedule page is read-only, no drag/drop or assign)`, { screenshot: await shot(page, 'flow-04b-job-admin') });
  } catch (e) { step('4. Schedule & dispatch', 'fail', e.message, { screenshot: await shot(page, 'flow-04-dispatch') }); }

  // Build a quote.
  await page.goto(BASE + '/quote-invoice.html'); await settle(page);
  try {
    const btns = await page.$$eval('main button', (bs) => bs.map((b) => b.innerText.trim()));
    const quoteBtn = btns.find((b) => /quote/i.test(b) && /new|create|\+/i.test(b));
    await page.click('.page-header .btn-primary'); await settle(page, 400);
    const landed = page.url().replace(BASE, '');
    const notFound = await page.$eval('#error-msg', (e) => getComputedStyle(e).display !== 'none').catch(() => false);
    const onJob = jobUrl ? (await page.goto(jobUrl), await settle(page), await page.$$eval('button', (bs) => bs.map((b) => b.innerText.trim()))) : [];
    const jobQuoteBtn = onJob.find((b) => /quote/i.test(b));
    step('5. Build a quote', quoteBtn || jobQuoteBtn ? 'pass' : 'no-ui-path',
      `no "New Quote" control on Quotes & Invoices (buttons: ${JSON.stringify(btns)}) or job page (buttons: ${JSON.stringify(onJob)}); "+ From Job" goes to ${landed}${notFound ? ' which shows "Job not found."' : ''}; no line-item editor (Line Items card is read-only, reads jobParts)`,
      { screenshot: await shot(page, 'flow-05-quote') });
  } catch (e) { step('5. Build a quote', 'fail', e.message); }

  // Convert to invoice (job page "Create Invoice").
  try {
    if (!jobUrl) throw new Error('no job page reached');
    // Re-runs: find (by clicking Schedule day-view chips) a job that has no invoice yet.
    // (Day view: the date picker lands on the wrong week/month in week and month views.)
    let found = false;
    for (const day of ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-07']) {
      for (let i = 0; i < 6 && !found; i++) {
        await page.goto(BASE + '/schedule.html'); await settle(page, 300);
        await page.click('#btn-day');
        await page.evaluate((d) => { const el = document.getElementById('date-picker'); el.value = d; el.dispatchEvent(new Event('change')); }, day);
        await settle(page, 200);
        const chips = await page.$$('.day-job');
        if (i >= chips.length) break;
        await chips[i].click(); await settle(page);
        found = !(await page.$eval('#inv-list', (e) => /Invoice #/.test(e.innerText)).catch(() => true));
      }
      if (found) break;
    }
    if (!found) throw new Error('every job in the week of 2026-04-01 already has an invoice — reset the sandbox DB and re-run');
    jobUrl = page.url();
    const n = alog.dialogs.length;
    const hadInvoice = await page.$eval('#inv-list', (e) => /Invoice #/.test(e.innerText));
    await page.click('#btn-create-invoice'); await settle(page, 700);
    const dialogs = alog.dialogs.slice(n);
    const inv = await page.$eval('#inv-list', (e) => e.innerText);
    step('6. Convert to invoice (job page > Create Invoice)', /\$0\.00/.test(inv) ? 'fail' : (dialogs.some((d) => /created/i.test(d)) ? 'pass' : 'fail'),
      `job already had invoice: ${hadInvoice}; dialogs: ${JSON.stringify(dialogs.map((d) => d.slice(0, 160)))}; Invoices & Quotes card now: "${inv.replace(/\s+/g, ' ')}" (no amount prompt, quote not used)`, { screenshot: await shot(page, 'flow-06-invoice') });
  } catch (e) { step('6. Convert to invoice', 'fail', e.message); }
  try {
    if (!jobUrl) throw new Error('no job page reached');
    const n = alog.dialogs.length;
    const visible = await page.$eval('#btn-create-invoice', (b) => getComputedStyle(b).display !== 'none');
    await page.click('#btn-create-invoice'); await settle(page, 700);
    const dialogs = alog.dialogs.slice(n);
    const raw = dialogs.some((d) => /prisma|invocation|\.js:\d+/i.test(d));
    step('6b. Click Create Invoice again on the same job', raw ? 'fail' : 'pass', `button still visible: ${visible}; dialogs: ${JSON.stringify(dialogs.map((d) => d.slice(0, 160)))}${raw ? ' (raw Prisma error + server file path shown to the user)' : ''}`, { screenshot: await shot(page, 'flow-06b-invoice-again') });
  } catch (e) { step('6b. Create Invoice again', 'fail', e.message); }

  // Invite a team member.
  await page.goto(BASE + '/team.html'); await settle(page);
  try {
    await page.click('.page-header .btn-primary'); await sleep(300);
    await page.type('#f-email', `niamh${stamp}@example.test`); await page.type('#f-name', 'Niamh Byrne'); await page.select('#f-role', 'technician');
    const n = alog.httpErrors.length;
    await page.click('#modal .btn-primary'); await settle(page, 500);
    const err = await page.$eval('#modal-error', (e) => (e.style.display !== 'none' ? e.innerText : ''));
    step('7. Invite a team member (Team > + Invite Member)', err ? 'fail' : 'pass', `${err ? `modal error: "${err}"` : 'invite sent'}; HTTP: ${JSON.stringify(alog.httpErrors.slice(n))}`, { screenshot: await shot(page, 'flow-07-invite') });
  } catch (e) { step('7. Invite a team member', 'fail', e.message, { screenshot: await shot(page, 'flow-07-invite') }); }

  // Export.
  const exportHits = [];
  for (const p of ALL_PAGES) {
    await page.goto(`${BASE}/${p}.html`, { waitUntil: 'domcontentloaded' }); await settle(page, 200);
    const hits = await page.$$eval('a, button', (els) => els.filter((e) => /export|csv|download/i.test(e.innerText + (e.getAttribute('href') || ''))).map((e) => e.innerText.trim()));
    if (hits.length) exportHits.push(`${p}: ${hits.join(', ')}`);
  }
  step('8. Run an export (CSV)', exportHits.length ? 'pass' : 'no-ui-path', exportHits.length ? exportHits.join('; ') : 'no Export/CSV/Download control on any page; /api/exports/{customers,jobs,invoices} exist API-only');
  results.flowAdminLog = alog;
  await A.ctx.close();

  // Technician on mobile: open the job, upload a photo.
  await startServer();
  const T = await newPage(browser, 'mobile'); const tlog = newLog(); instrument(T.page, tlog); const tp = T.page;
  const tl = await uiLogin(tp, USERS.technician);
  step('9a. Login (technician, mobile)', tl.ok ? 'pass' : 'fail', tl.ok ? 'dashboard shown' : 'login button does nothing', { screenshot: await shot(tp, 'flow-09a-login-tech-mobile') });
  if (!tl.ok) await injectToken(tp, await apiLogin(USERS.technician));
  try {
    await tp.goto(BASE + '/index.html'); await settle(tp);
    const myJobsVisible = await tp.evaluate(() => /my jobs|today/i.test(document.body.innerText));
    await tp.goto(BASE + '/schedule.html'); await settle(tp);
    await tp.click('#btn-day').catch(() => {});
    await tp.evaluate((d) => { const el = document.getElementById('date-picker'); el.value = d; el.dispatchEvent(new Event('change')); }, '2026-04-01');
    await settle(tp, 300);
    const navFits = await tp.evaluate(() => document.documentElement.scrollWidth <= 390 && document.querySelector('nav').scrollWidth <= 390);
    const layoutW = await tp.evaluate(() => document.documentElement.scrollWidth);
    const chip = await tp.$('.day-job, .job-chip');
    await shot(tp, 'flow-09b-tech-schedule-mobile');
    if (!chip) throw new Error('no job visible on Schedule day view for 2026-04-01');
    await chip.click(); await settle(tp);
    const head = await tp.$eval('#job-heading', (e) => e.innerText).catch(() => '');
    const tapTargets = await tp.$$eval('#job-content button, #job-content select', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${(e.innerText || e.id).trim().slice(0, 18)}:${Math.round(r.height)}px`; }));
    step('9b. Technician opens the job on mobile', head ? 'pass' : 'fail', `${head || 'job not shown'}; dashboard has a "my jobs/today" view: ${myJobsVisible ? 'yes' : 'NO'}; page/nav fits 390px: ${navFits ? 'yes' : `NO (laid out ${layoutW}px wide, browser zooms out)`}; tap targets ${tapTargets.join(', ')}`, { screenshot: await shot(tp, 'flow-09b-tech-job-mobile') });
    const png = path.join(os.tmpdir(), 'mbc-ui-walk-photo.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJklEQVR4nGP8z4AKGBkZGRgYGBj+M2ADjEwMjAwMDAwMjIwMDAAA7RQHAW1sZ8gAAAAASUVORK5CYII=', 'base64'));
    const input = await tp.$('#photo-input');
    await input.uploadFile(png);
    const btn = await tp.$('#btn-upload-photo');
    await btn.click().catch(async () => { await btn.evaluate((b) => b.click()); });
    await settle(tp, 800);
    const status = await tp.$eval('#photo-status', (e) => e.innerText);
    const thumbs = await tp.$$eval('.photo-thumb img', (is) => is.filter((i) => i.naturalWidth > 0).length);
    step('10. Upload a photo (technician, mobile)', /Uploaded/i.test(status) && thumbs > 0 ? 'pass' : 'fail', `status "${status}", rendered thumbnails ${thumbs}`, { screenshot: await shot(tp, 'flow-10-photo-upload') });
  } catch (e) { step('9b/10. Technician job + photo', 'fail', e.message, { screenshot: await shot(tp, 'flow-09-tech-error') }); }
  results.flowTechLog = tlog;
  await T.ctx.close();
}

// ── 3. Preview: what the 5 syntax-broken pages render once the quoting bug is fixed ──
// The fix is applied in-flight via request interception (no source edits) so the
// next layer of problems (field-name mismatches) is visible now, before Phase 2.
function fixInlineQuoting(html) {
  return html
    .replace(/location\.href='([\w.-]+\.html\?\w+=)'\+/g, "location.href=\\'$1'+")
    .replace(/\+''"/g, "+'\\'\"");
}
async function previewFixedPages(browser, ctxInfo, results) {
  await startServer();
  const { brand, sampleCustomerId } = ctxInfo;
  const token = await apiLogin(USERS.admin);
  const targets = { index: '', customers: '', 'customer-detail': `?id=${sampleCustomerId}`, dispatch: '', 'quote-invoice': '' };
  for (const vp of ['desktop']) {
    const { ctx, page } = await newPage(browser, vp);
    await page.setRequestInterception(true);
    page.on('request', async (req) => {
      const m = req.url().match(/\/([\w-]+)\.html(\?|$)/);
      if (req.resourceType() === 'document' && m && targets[m[1]] !== undefined) {
        const r = await fetch(req.url()); const body = fixInlineQuoting(await r.text());
        return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body });
      }
      req.continue();
    });
    await injectToken(page, token);
    for (const [p, q] of Object.entries(targets)) {
      const log = newLog(); instrument(page, log);
      await page.goto(`${BASE}/${p}.html${q}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const extra = {};
      if (p === 'quote-invoice') {
        extra.quotesTab = await page.$$eval('#list-tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' | ')));
        await shot(page, `preview-quote-invoice-quotes-${vp}`);
        await page.click('.tab:nth-child(2)'); await settle(page, 300);
        extra.invoicesTab = await page.$$eval('#list-tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' | ')));
      }
      if (p === 'index' || p === 'dispatch') extra.rows = await page.$$eval('#jobs-tbody tr', (rs) => rs.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' | ')));
      if (p === 'index') extra.stats = await page.$$eval('.stat-card', (cs) => cs.map((c) => c.innerText.replace(/\s+/g, ' ')));
      if (p === 'customers') extra.rows = await page.$$eval('#customers-tbody tr', (rs) => rs.slice(0, 3).map((r) => r.innerText.replace(/\s+/g, ' | ')));
      if (p === 'dispatch') {
        extra.techOptions = await page.$$eval('#tech-filter option', (os) => os.map((o) => o.textContent));
        extra.customerOptions = await page.$$eval('#f-customer option', (os) => os.slice(0, 3).map((o) => o.textContent));
      }
      if (p === 'customer-detail') extra.detail = await page.evaluate(() => ({ jobs: [...document.querySelectorAll('#jobs-tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' | ')), invoiced: (document.getElementById('stat-invoiced') || {}).innerText, invoices: (document.getElementById('invoices-tbody') || {}).innerText }));
      if (p === 'customers' || p === 'dispatch') {
        // Submit the create form as a user would, to see what the API says once the page runs.
        await page.click('.page-header .btn-primary'); await sleep(300);
        if (p === 'customers') {
          await page.type('#f-name', 'Aoife Kelly'); await page.type('#f-phone', '620-555-0199'); await page.type('#f-address', '4 Elm St');
          await page.type('#f-city', 'Hutchinson'); await page.type('#f-state', 'KS'); await page.type('#f-zip', '67501');
        } else {
          const v = await page.$eval('#f-customer option:nth-child(2)', (o) => o.value).catch(() => '');
          if (v) await page.select('#f-customer', v);
          await page.select('#f-type', await page.$eval('#f-type option:nth-child(2)', (o) => o.value));
          await page.type('#f-notes', 'Preview: burst pipe');
        }
        await page.click('#modal .btn-primary'); await settle(page, 400);
        extra.createResult = await page.$eval('#modal-error', (e) => (e.style.display !== 'none' ? 'error: ' + e.innerText : 'no error shown'));
        await shot(page, `preview-${p}-create-admin-${vp}`);
        await page.evaluate(() => { const m = document.getElementById('modal'); if (m) m.classList.remove('open'); });
      }
      const info = await inspect(page, brand, VIEWPORTS[vp].width);
      const file = await shot(page, `preview-${p}-admin-${vp}`);
      results.preview.push({ page: p, viewport: vp, screenshot: file, tokens: info.tokens, dashCells: info.dashCells, zeroMoney: info.zeroMoney, deadHandlers: info.deadHandlers, pageErrors: log.pageErrors, httpErrors: log.httpErrors, console: log.console.slice(0, 5), ...extra });
      for (const ev of ['console', 'pageerror', 'requestfailed', 'response', 'dialog']) page.removeAllListeners(ev);
      console.log(`  preview ${p.padEnd(16)} dash=${info.dashCells} $0=${info.zeroMoney} tokens=${JSON.stringify(info.tokens)} jsErr=${log.pageErrors.length}`);
    }
    await ctx.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const results = { base: BASE, startedAt: new Date().toISOString(), roles: ROLES, viewports: VPS, pages: [], logins: [], flow: [], preview: [] };
  let browser;
  try {
    await startServer();
    const ctxInfo = await ensureBillingFixtures();
    results.brand = ctxInfo.brand;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'] });
    if (!process.env.UI_SKIP_AUDIT) { console.log('Page audit'); await pageAudit(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_FLOW) { console.log('Main flow'); await flowWalk(browser, ctxInfo, results); }
    if (!process.env.UI_SKIP_PREVIEW) { console.log('Preview (quoting bug fixed in-flight)'); await previewFixedPages(browser, ctxInfo, results); }
  } catch (e) {
    results.fatal = String(e.stack || e);
    console.error('FATAL', e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer();
    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    const failedSteps = results.flow.filter((s) => s.status !== 'pass').length;
    const jsErrPages = new Set(results.pages.filter((p) => p.pageErrors.length).map((p) => p.page));
    console.log(`\nWrote ${path.join(OUT, 'results.json')} — ${results.pages.length} page captures, flow steps not passing: ${failedSteps}, pages with JS errors: ${[...jsErrPages].join(', ') || 'none'}`);
    process.exit(results.fatal || (STRICT && failedSteps) ? 1 : 0);
  }
})();
