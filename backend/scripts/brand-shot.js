#!/usr/bin/env node
/**
 * scripts/brand-shot.js — headless-Chrome screenshot of one page of a running
 * MBC instance, logged in as the seeded demo admin. Used by the white-label
 * audit to check that each BRAND_* configuration actually renders.
 *
 * How to run (sandbox only):
 *   1. cd backend && npm install            (puppeteer-core is a devDependency;
 *                                            it does NOT download a browser)
 *   2. Start an instance, e.g.
 *        PORT=3133 BRAND_TRADE_TYPE=hvac BRAND_COMPANY_NAME="Demo HVAC" npm run sandbox
 *   3. In another terminal:
 *        node scripts/brand-shot.js --port 3133 --out /tmp/hvac.png --page index.html
 *      Options:
 *        --port <n>        instance port (default 3101)
 *        --out <file>      PNG path, or "-" for no screenshot (default brand.png)
 *        --page <path>     page to open, e.g. "job.html?id=1" (default index.html)
 *        --email <addr>    login email (default admin@demo.test, password demo1234)
 *        --mobile          390x844 phone viewport instead of 1366x900
 *        --repair-onclick-quotes
 *                          TEMPORARY audit aid: rewrites the broken
 *                          onclick="location.href='x.html?id='+id+''" quoting in
 *                          the served HTML in-flight (no source change) so pages
 *                          whose inline script fails to parse can still be seen.
 *   CHROME_PATH overrides the browser (default /usr/bin/google-chrome).
 *
 * Prints JSON: page title, console/page errors, first 1500 chars of visible text.
 */
const puppeteer = require('puppeteer-core');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

(async () => {
  const port   = arg('port', '3101');
  const out    = arg('out', 'brand.png');
  const page   = arg('page', 'index.html');
  const email  = arg('email', 'admin@demo.test');
  const mobile = arg('mobile', false) === true;
  const repair = arg('repair-onclick-quotes', false) === true;
  const base   = `http://localhost:${port}`;

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD || 'demo1234' }),
  });
  const { token } = await login.json();
  if (!token) throw new Error(`login failed for ${email} (HTTP ${login.status})`);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-gpu'], headless: 'new',
  });
  const p = await browser.newPage();
  await p.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1366, height: 900 });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  if (repair) {
    await p.setRequestInterception(true);
    p.on('request', async (req) => {
      if (!/\.html(\?|$)/.test(req.url())) return req.continue();
      const r = await fetch(req.url());
      const body = (await r.text()).replace(/location\.href='([^']+)'\+(.+?)\+''"/g, "location.href=\\'$1'+$2+'\\'\"");
      req.respond({ status: r.status, contentType: 'text/html', body });
    });
  }

  // Set the token on an asset-free origin page, then open the target page.
  await p.goto(base + '/api/health', { waitUntil: 'domcontentloaded' });
  await p.evaluate((t) => localStorage.setItem('token', t), token);
  await p.goto(`${base}/${page}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 2000));
  if (out !== '-') await p.screenshot({ path: out, fullPage: !mobile });

  const text = await p.evaluate(() => document.body.innerText);
  console.log(JSON.stringify({ page, title: await p.title(), errs, text: text.slice(0, 1500) }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
