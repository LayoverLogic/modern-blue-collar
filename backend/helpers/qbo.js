/**
 * helpers/qbo.js — QuickBooks Online over plain fetch (replaces the intuit-oauth package).
 *
 * OAuth 2.0 (Intuit):
 *   authorize  GET  https://appcenter.intuit.com/connect/oauth2
 *                   ?client_id&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri&state
 *   tokens     POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 *                   Basic base64(client_id:client_secret), application/x-www-form-urlencoded,
 *                   grant_type=authorization_code&code&redirect_uri | grant_type=refresh_token&refresh_token
 *              → { access_token, refresh_token, token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in }
 *   Refresh tokens ROTATE: every token response carries a new refresh token and the newest one
 *   must be stored (reusing an old one can revoke the authorisation), so refreshes are
 *   serialised in-process and every response is persisted before use.
 * Accounting API: {base}/v3/company/{realmId}/{entity}?minorversion=75, base
 *   https://quickbooks.api.intuit.com (production) | https://sandbox-quickbooks.api.intuit.com.
 *   Create/update = POST {entity} (update: Id + SyncToken [+ sparse:true]); read = GET {entity}/{id};
 *   query = GET query?query=SELECT … (MAXRESULTS ≤ 1000, STARTPOSITION paging).
 *   Errors come back as { Fault: { Error: [{ Message, Detail, code }], type } } — sometimes with 200.
 *
 * Endpoint overrides (local stubs in tests; must be https when NODE_ENV=production):
 *   QBO_AUTHORIZE_URL, QBO_TOKEN_URL, QBO_API_BASE, QBO_MINOR_VERSION (default 75)
 * Mapping config:
 *   QBO_ITEM_ID            QBO Item (product/service) every line is booked to (default "1")
 *   QBO_TAX_CODES          non-US companies: MBC tax-rate key → QBO TaxCode Id, "standard=12|reduced=13|zero=14|none=15|reverse_charge=16"
 *                          (none = untaxed lines, reverse_charge = reverse-charge invoices). An unmapped
 *                          key fails closed (409 QBO_TAX_CODE_UNMAPPED) — nothing is pushed.
 *   QBO_US_TAX_CODE        US companies: TaxCode Id for TxnTaxDetail.TxnTaxCodeRef on taxed invoices
 *                          (lines are TAX / NON); TotalTax is sent so QBO's total equals MBC's.
 *   QBO_CUSTOMER_MATCH     create (default: never adopt a QBO customer by name) | displayName
 *   QBO_PAYMENT_SYNC_CRON  optional node-cron expression for the payment sync-back job
 *
 * Links (IntegrationLink, provider "quickbooks:<realmId>"): customer / invoice (remoteId = QBO Id,
 * syncToken), payment (remoteId = Payment Id, localId = MBC invoice), cursor "payments".
 */
'use strict';

const crypto = require('crypto');
const prisma = require('./prisma');
const { seal, open } = require('./secretBox');
const { getLocale } = require('./locale');

const PROVIDER = 'quickbooks';
const SCOPE = 'com.intuit.quickbooks.accounting';
const TIMEOUT_MS = Number(process.env.QBO_TIMEOUT_MS) || 15000;

class QboError extends Error {
  constructor(status, message, extra = {}) { super(message); this.name = 'QboError'; this.status = status; this.expose = true; this.extra = extra; }
}

function endpoint(envName, fallback) {
  const v = (process.env[envName] || '').trim();
  if (!v) return fallback;
  let u;
  try { u = new URL(v); } catch { throw new QboError(500, `${envName} is not a URL`, { code: 'QBO_CONFIG' }); }
  if (require('./security').isProduction() && u.protocol !== 'https:') throw new QboError(500, `${envName} must be https in production`, { code: 'QBO_CONFIG' });
  return v.replace(/\/+$/, '');
}

function config() {
  const prod = (process.env.QB_ENVIRONMENT || 'sandbox') === 'production';
  return {
    clientId: process.env.QB_CLIENT_ID,
    clientSecret: process.env.QB_CLIENT_SECRET,
    redirectUri: process.env.QB_REDIRECT_URI,
    authorizeUrl: endpoint('QBO_AUTHORIZE_URL', 'https://appcenter.intuit.com/connect/oauth2'),
    tokenUrl: endpoint('QBO_TOKEN_URL', 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'),
    apiBase: endpoint('QBO_API_BASE', prod ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com'),
    minorVersion: (process.env.QBO_MINOR_VERSION || '75').trim(),
  };
}

function authorizeUrl(state) {
  const c = config();
  const u = new URL(c.authorizeUrl);
  u.searchParams.set('client_id', c.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('redirect_uri', c.redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

async function fetchJson(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new QboError(502, `QuickBooks request failed: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`, { code: 'QBO_UNREACHABLE' });
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { res, body, text };
}

// ── Tokens ───────────────────────────────────────────────────────────────────
async function tokenRequest(params) {
  const c = config();
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const { res, body } = await fetchJson(c.tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok || !body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    const err = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const reauth = err === 'invalid_grant';
    throw new QboError(reauth ? 409 : 502, reauth ? 'QuickBooks authorisation expired or was revoked — reconnect QuickBooks' : `QuickBooks token request failed (${err})`, { code: reauth ? 'QBO_REAUTH_REQUIRED' : 'QBO_TOKEN_FAILED' });
  }
  return body;
}

async function saveTokens(json, { realmId, userId, keep = null }) {
  const now = Date.now();
  const data = {
    realmId: realmId ? String(realmId).slice(0, 64) : (keep ? keep.realmId : null),
    accessToken: seal(json.access_token),
    refreshToken: seal(json.refresh_token),
    tokenType: json.token_type ? String(json.token_type).slice(0, 20) : null,
    expiresAt: json.expires_in ? new Date(now + Number(json.expires_in) * 1000) : null,
    refreshExpiresAt: json.x_refresh_token_expires_in ? new Date(now + Number(json.x_refresh_token_expires_in) * 1000) : (keep ? keep.refreshExpiresAt : null),
    connectedById: userId != null ? userId : (keep ? keep.connectedById : null),
  };
  return prisma.integrationToken.upsert({ where: { provider: PROVIDER }, create: { provider: PROVIDER, ...data }, update: data });
}

async function loadTokens() {
  const row = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER } });
  if (!row) return null;
  return { ...row, accessToken: open(row.accessToken), refreshToken: open(row.refreshToken) };
}

async function exchangeCode(code, { realmId, userId }) {
  const c = config();
  const json = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: c.redirectUri });
  return saveTokens(json, { realmId, userId });
}

let refreshing = null;
/** Serialised refresh: concurrent callers share one token call (refresh tokens rotate). */
function refreshTokens() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const cur = await loadTokens();
      if (!cur) throw new QboError(400, 'Not connected to QuickBooks. Connect it from Settings first.', { code: 'QBO_NOT_CONNECTED' });
      const json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: cur.refreshToken });
      await saveTokens(json, { keep: cur });
      return loadTokens();
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function session() {
  let t = await loadTokens();
  if (!t) throw new QboError(400, 'Not connected to QuickBooks. Connect it from Settings first.', { code: 'QBO_NOT_CONNECTED' });
  if (!t.realmId) throw new QboError(409, 'QuickBooks connection has no company (realmId) — reconnect', { code: 'QBO_REAUTH_REQUIRED' });
  if (!t.expiresAt || t.expiresAt.getTime() - 60000 < Date.now()) t = await refreshTokens();
  return t;
}

// ── API ──────────────────────────────────────────────────────────────────────
function faultOf(body) {
  const f = body && (body.Fault || body.fault);
  if (!f) return null;
  const e = (f.Error || f.error || [])[0] || {};
  return { type: f.type, code: String(e.code || ''), message: e.Message || e.message || 'QuickBooks error', detail: e.Detail || e.detail || '' };
}

async function api(method, entityPath, { query = {}, body } = {}) {
  const c = config();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const t = attempt === 0 ? await session() : await refreshTokens();
    const u = new URL(`${c.apiBase}/v3/company/${encodeURIComponent(t.realmId)}/${entityPath}`);
    u.searchParams.set('minorversion', c.minorVersion);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const { res, body: out } = await fetchJson(u.toString(), {
      method,
      headers: { Authorization: `Bearer ${t.accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) continue; // expired early / revoked access token → refresh once
    if (res.status === 429) throw new QboError(503, 'QuickBooks rate limit reached — try again shortly', { code: 'QBO_THROTTLED', retryAfter: res.headers.get('retry-after') || null });
    const fault = faultOf(out);
    if (!res.ok || fault) {
      const f = fault || { code: String(res.status), message: `HTTP ${res.status}`, detail: '' };
      throw new QboError(res.status === 401 ? 409 : 502, `QuickBooks rejected the request: ${f.message}${f.detail ? ` — ${f.detail}` : ''}`.slice(0, 500), { code: res.status === 401 ? 'QBO_REAUTH_REQUIRED' : 'QBO_API_ERROR', qboCode: f.code });
    }
    return out;
  }
  throw new QboError(409, 'QuickBooks rejected the refreshed token — reconnect QuickBooks', { code: 'QBO_REAUTH_REQUIRED' });
}

/** QBO query string literal (single quotes escaped with a backslash). */
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function query(sql) {
  const out = await api('GET', 'query', { query: { query: sql } });
  return (out && out.QueryResponse) || {};
}

// ── Links ────────────────────────────────────────────────────────────────────
const providerFor = (realmId) => `${PROVIDER}:${realmId}`;
const findLink = (provider, entity, localId) => prisma.integrationLink.findFirst({ where: { provider, entity, localId }, orderBy: { id: 'asc' } });
async function saveLink(provider, entity, localId, remoteId, syncToken, data) {
  return prisma.integrationLink.upsert({
    where: { provider_entity_remoteId: { provider, entity, remoteId: String(remoteId) } },
    create: { provider, entity, localId, remoteId: String(remoteId), syncToken: syncToken != null ? String(syncToken) : null, data: data || undefined },
    update: { localId, syncToken: syncToken != null ? String(syncToken) : null, data: data || undefined, syncedAt: new Date() },
  });
}

const hashOf = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
const clean = (s, max) => (s == null || s === '' ? undefined : String(s).replace(/[\t\r\n]+/g, ' ').trim().slice(0, max));

// ── Tax mapping ──────────────────────────────────────────────────────────────
function parseMap(raw) {
  const out = {};
  for (const part of String(raw || '').split('|').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Per-line TaxCodeRef + document tax fields, or throws 409 QBO_TAX_CODE_UNMAPPED. */
function taxPlan(invoice, lines, locale = getLocale()) {
  if (locale.country === 'US') {
    const taxed = !invoice.reverseCharge && lines.some((l) => Number(l.taxRate) > 0);
    const lineCodes = lines.map((l) => (!invoice.reverseCharge && Number(l.taxRate) > 0 ? 'TAX' : 'NON'));
    if (!taxed) return { lineCodes, doc: {} };
    const code = (process.env.QBO_US_TAX_CODE || '').trim();
    if (!code) throw new QboError(409, 'Invoice has sales tax but QBO_US_TAX_CODE (the QuickBooks TaxCode Id) is not set — nothing was pushed', { code: 'QBO_TAX_CODE_UNMAPPED', keys: ['QBO_US_TAX_CODE'] });
    return { lineCodes, doc: { TxnTaxDetail: { TxnTaxCodeRef: { value: code }, TotalTax: Number(invoice.taxTotal) } } };
  }
  const map = parseMap(process.env.QBO_TAX_CODES);
  const keys = lines.map((l) => (invoice.reverseCharge ? 'reverse_charge' : (l.taxRateKey || 'none').toLowerCase()));
  const missing = [...new Set(keys.filter((k) => !map[k]))];
  if (missing.length) throw new QboError(409, `No QuickBooks tax code mapped for ${missing.join(', ')} — set QBO_TAX_CODES (e.g. standard=12|none=15). Nothing was pushed.`, { code: 'QBO_TAX_CODE_UNMAPPED', keys: missing });
  return { lineCodes: keys.map((k) => map[k]), doc: { GlobalTaxCalculation: 'TaxExcluded' } };
}

const ymdIn = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d instanceof Date ? d : new Date(d));

// ── Customer push ────────────────────────────────────────────────────────────
function customerBody(c) {
  const display = clean((c.company || `${c.firstName || ''} ${c.lastName || ''}`).replace(/:/g, '-'), 480) || `Customer ${c.id}`;
  const body = {
    DisplayName: display,
    GivenName: c.company ? undefined : clean(c.firstName, 100),
    FamilyName: c.company ? undefined : clean(c.lastName, 100),
    CompanyName: clean(c.company, 100),
    PrimaryEmailAddr: c.email ? { Address: clean(c.email, 100) } : undefined,
    PrimaryPhone: c.phone ? { FreeFormNumber: clean(c.phone, 30) } : undefined,
    BillAddr: (c.address || c.city || c.zip) ? {
      Line1: clean(c.address, 500), Line2: clean(c.addressLine2, 500), City: clean(c.city, 255),
      CountrySubDivisionCode: clean(c.state, 255), PostalCode: clean(c.zip, 30), Country: clean(c.country, 255),
    } : undefined,
  };
  return JSON.parse(JSON.stringify(body));
}

async function pushCustomer(customer, provider) {
  const body = customerBody(customer);
  const hash = hashOf(body);
  const link = await findLink(provider, 'customer', customer.id);
  if (link) {
    if (link.data && link.data.hash === hash) return { qboId: link.remoteId, action: 'unchanged' };
    let syncToken = link.syncToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const out = await api('POST', 'customer', { body: { ...body, Id: link.remoteId, SyncToken: syncToken, sparse: true } });
        const qc = out.Customer;
        await saveLink(provider, 'customer', customer.id, qc.Id, qc.SyncToken, { hash });
        return { qboId: qc.Id, action: 'updated' };
      } catch (e) {
        // stale SyncToken → read the current one and retry once
        if (attempt === 0 && e.extra && /^(5010|3200)$/.test(e.extra.qboCode || '')) {
          const cur = await api('GET', `customer/${encodeURIComponent(link.remoteId)}`);
          syncToken = cur.Customer.SyncToken;
          continue;
        }
        throw e;
      }
    }
  }
  if ((process.env.QBO_CUSTOMER_MATCH || 'create') === 'displayName') {
    const found = (await query(`SELECT * FROM Customer WHERE DisplayName = ${q(body.DisplayName)}`)).Customer || [];
    if (found.length === 1) {
      await saveLink(provider, 'customer', customer.id, found[0].Id, found[0].SyncToken, { hash: null, adopted: true });
      return pushCustomer(customer, provider);
    }
  }
  let out;
  try {
    out = await api('POST', 'customer', { body });
  } catch (e) {
    // 6240 duplicate DisplayName: never adopt by name (playbook §5.2) — make the name unique
    if (e.extra && e.extra.qboCode === '6240') out = await api('POST', 'customer', { body: { ...body, DisplayName: `${body.DisplayName} (MBC ${customer.id})`.slice(0, 500) } });
    else throw e;
  }
  const qc = out.Customer;
  await saveLink(provider, 'customer', customer.id, qc.Id, qc.SyncToken, { hash });
  return { qboId: qc.Id, action: 'created' };
}

// ── Invoice push ─────────────────────────────────────────────────────────────
const invoiceLocks = new Map();
async function withInvoiceLock(id, fn) {
  while (invoiceLocks.has(id)) await invoiceLocks.get(id).catch(() => {});
  const p = fn();
  invoiceLocks.set(id, p);
  try { return await p; } finally { invoiceLocks.delete(id); }
}

const marker = (inv) => `MBC invoice ${inv.number} (id ${inv.id})`;

function invoiceBody(inv, qboCustomerId, { brandTz } = {}) {
  const lines = (inv.lines && inv.lines.length) ? inv.lines.slice().sort((a, b) => a.position - b.position) : [{
    position: 1, description: `Invoice ${inv.number}${inv.job && inv.job.title ? ` – ${inv.job.title}` : ''}`,
    quantity: 1, unitPrice: inv.subtotal != null ? inv.subtotal : inv.amount, lineTotal: inv.subtotal != null ? inv.subtotal : inv.amount, taxRateKey: null, taxRate: 0,
  }];
  const tax = taxPlan(inv, lines);
  const item = (process.env.QBO_ITEM_ID || '1').trim();
  const body = {
    CustomerRef: { value: String(qboCustomerId) },
    DocNumber: String(inv.number).slice(0, 21),
    TxnDate: ymdIn(inv.issuedAt || inv.createdAt, brandTz),
    ...(inv.dueDate ? { DueDate: ymdIn(inv.dueDate, 'UTC') } : {}), // due dates are calendar dates stored at UTC midnight
    PrivateNote: marker(inv),
    ...(inv.notes ? { CustomerMemo: { value: String(inv.notes).slice(0, 1000) } } : {}),
    Line: lines.map((l, i) => ({
      LineNum: i + 1,
      Description: String(l.description || '').slice(0, 4000),
      Amount: Number(l.lineTotal),
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: item }, Qty: Number(l.quantity), UnitPrice: Number(l.unitPrice), TaxCodeRef: { value: tax.lineCodes[i] } },
    })),
    ...tax.doc,
  };
  return body;
}

async function pushInvoice(invoiceId, { brandTz } = {}) {
  return withInvoiceLock(invoiceId, async () => {
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { lines: { orderBy: { position: 'asc' } }, job: { include: { customer: true } } } });
    if (!inv) throw new QboError(404, 'Invoice not found', { code: 'NOT_FOUND' });
    if (inv.status === 'void') throw new QboError(409, 'Void invoices are not pushed to QuickBooks', { code: 'QBO_INVOICE_VOID' });
    const t = await session();
    const provider = providerFor(t.realmId);
    // validate the tax mapping before touching QBO at all
    invoiceBody(inv, '0', { brandTz });
    const cust = await pushCustomer(inv.job.customer, provider);
    const body = invoiceBody(inv, cust.qboId, { brandTz });
    const hash = hashOf(body);
    const warnings = [];
    let link = await findLink(provider, 'invoice', inv.id);
    if (!link) {
      // crash recovery: an invoice we created but never recorded carries our marker
      const found = ((await query(`SELECT * FROM Invoice WHERE DocNumber = ${q(body.DocNumber)}`)).Invoice || [])
        .filter((x) => x.PrivateNote === body.PrivateNote);
      if (found.length === 1) link = await saveLink(provider, 'invoice', inv.id, found[0].Id, found[0].SyncToken, { hash: null, recovered: true });
    }
    let qi; let action;
    if (link && link.data && link.data.hash === hash) {
      return { invoiceId: inv.id, number: inv.number, action: 'unchanged', qbo: { id: link.remoteId, syncToken: link.syncToken, totalAmt: link.data.totalAmt, balance: link.data.balance }, customer: { id: inv.job.customerId, qboId: cust.qboId, action: cust.action }, warnings };
    }
    if (link) {
      let syncToken = link.syncToken;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          qi = (await api('POST', 'invoice', { body: { ...body, Id: link.remoteId, SyncToken: syncToken, sparse: true } })).Invoice;
          break;
        } catch (e) {
          if (attempt === 0 && e.extra && /^(5010|3200)$/.test(e.extra.qboCode || '')) {
            syncToken = (await api('GET', `invoice/${encodeURIComponent(link.remoteId)}`)).Invoice.SyncToken;
            continue;
          }
          throw e;
        }
      }
      action = 'updated';
    } else {
      qi = (await api('POST', 'invoice', { body })).Invoice;
      action = 'created';
    }
    const totalAmt = Number(qi.TotalAmt);
    if (Number.isFinite(totalAmt) && Math.round(totalAmt * 100) !== Math.round(Number(inv.amount) * 100)) {
      warnings.push(`QuickBooks total ${totalAmt.toFixed(2)} ≠ MBC total ${Number(inv.amount).toFixed(2)} — check the tax codes`);
    }
    await saveLink(provider, 'invoice', inv.id, qi.Id, qi.SyncToken, { hash, docNumber: qi.DocNumber, totalAmt, balance: Number(qi.Balance), warnings });
    return { invoiceId: inv.id, number: inv.number, action, qbo: { id: qi.Id, syncToken: qi.SyncToken, docNumber: qi.DocNumber, totalAmt, balance: Number(qi.Balance) }, customer: { id: inv.job.customerId, qboId: cust.qboId, action: cust.action }, warnings };
  });
}

// ── Payment sync-back ────────────────────────────────────────────────────────
let syncing = null;
/**
 * Read QBO Payments changed since the stored cursor, follow LinkedTxn → our linked invoices,
 * re-read those invoices' Balance and mark fully paid MBC invoices `paid` (paidAt = latest
 * payment TxnDate). Partial payments are reported, never shown as paid.
 */
function syncPayments({ since: sinceArg } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const t = await session();
      const provider = providerFor(t.realmId);
      const startedAt = new Date();
      const cursor = await prisma.integrationLink.findUnique({ where: { provider_entity_remoteId: { provider, entity: 'cursor', remoteId: 'payments' } } });
      let since = sinceArg ? new Date(sinceArg) : (cursor && cursor.data && cursor.data.since ? new Date(cursor.data.since) : null);
      if (!since || Number.isNaN(since.getTime())) {
        const first = await prisma.integrationLink.findFirst({ where: { provider, entity: 'invoice' }, orderBy: { createdAt: 'asc' } });
        since = new Date((first ? first.createdAt.getTime() : Date.now()) - 86400000);
      }
      const payments = [];
      for (let start = 1; ; start += 1000) {
        const page = (await query(`SELECT * FROM Payment WHERE MetaData.LastUpdatedTime >= ${q(since.toISOString())} ORDERBY MetaData.LastUpdatedTime STARTPOSITION ${start} MAXRESULTS 1000`)).Payment || [];
        payments.push(...page);
        if (page.length < 1000) break;
      }
      let maxUpdated = since;
      const touched = new Map(); // qbo invoice id → [{ paymentId, txnDate, amount }]
      let unmatched = 0;
      for (const p of payments) {
        const lu = p.MetaData && p.MetaData.LastUpdatedTime ? new Date(p.MetaData.LastUpdatedTime) : null;
        if (lu && lu > maxUpdated) maxUpdated = lu;
        let matched = false;
        let firstLocal = null;
        for (const line of p.Line || []) {
          for (const lt of line.LinkedTxn || []) {
            if (lt.TxnType !== 'Invoice') continue;
            const link = await prisma.integrationLink.findUnique({ where: { provider_entity_remoteId: { provider, entity: 'invoice', remoteId: String(lt.TxnId) } } });
            if (!link) continue;
            matched = true; firstLocal = firstLocal || link.localId;
            if (!touched.has(String(lt.TxnId))) touched.set(String(lt.TxnId), { localId: link.localId, payments: [] });
            touched.get(String(lt.TxnId)).payments.push({ paymentId: String(p.Id), txnDate: p.TxnDate || null, amount: Number(line.Amount) });
          }
        }
        if (!matched) { unmatched += 1; continue; }
        await saveLink(provider, 'payment', firstLocal, p.Id, p.SyncToken, { txnDate: p.TxnDate || null, totalAmt: Number(p.TotalAmt), lastUpdated: lu ? lu.toISOString() : null });
      }
      const markedPaid = []; const partial = []; const alreadyClosed = [];
      const ids = [...touched.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const invs = (await query(`SELECT * FROM Invoice WHERE Id IN (${chunk.map(q).join(', ')})`)).Invoice || [];
        for (const qi of invs) {
          const info = touched.get(String(qi.Id));
          if (!info) continue;
          const balance = Number(qi.Balance);
          await prisma.integrationLink.updateMany({ where: { provider, entity: 'invoice', remoteId: String(qi.Id) }, data: { syncToken: String(qi.SyncToken), syncedAt: new Date() } });
          const inv = await prisma.invoice.findUnique({ where: { id: info.localId }, select: { id: true, number: true, status: true } });
          if (!inv) continue;
          if (balance > 0) { partial.push({ invoiceId: inv.id, number: inv.number, qboInvoiceId: String(qi.Id), balance, totalAmt: Number(qi.TotalAmt) }); continue; }
          if (inv.status === 'paid' || inv.status === 'void') { alreadyClosed.push({ invoiceId: inv.id, number: inv.number, status: inv.status }); continue; }
          const latest = info.payments.map((x) => x.txnDate).filter(Boolean).sort().pop();
          const paidAt = latest ? new Date(`${latest}T12:00:00Z`) : new Date();
          const upd = await prisma.invoice.updateMany({ where: { id: inv.id, status: { notIn: ['paid', 'void'] } }, data: { status: 'paid', paidAt, version: { increment: 1 } } });
          if (upd.count) markedPaid.push({ invoiceId: inv.id, number: inv.number, qboInvoiceId: String(qi.Id), paidAt: paidAt.toISOString(), payments: info.payments.map((x) => x.paymentId) });
        }
      }
      // Next run starts at the newest LastUpdatedTime seen (inclusive ≥, so nothing is skipped;
      // re-reading a payment is harmless).
      // With no payments, advance to 5 minutes before this run (clock-skew margin), never backwards.
      const next = payments.length ? maxUpdated : new Date(Math.max(since.getTime(), startedAt.getTime() - 5 * 60000));
      await prisma.integrationLink.upsert({
        where: { provider_entity_remoteId: { provider, entity: 'cursor', remoteId: 'payments' } },
        create: { provider, entity: 'cursor', remoteId: 'payments', data: { since: next.toISOString(), lastRunAt: startedAt.toISOString() } },
        update: { data: { since: next.toISOString(), lastRunAt: startedAt.toISOString() }, syncedAt: new Date() },
      });
      return { realmId: t.realmId, since: since.toISOString(), nextSince: next.toISOString(), payments: payments.length, unmatchedPayments: unmatched, invoicesChecked: touched.size, markedPaid, partial, alreadyClosed };
    } finally { syncing = null; }
  })();
  return syncing;
}

async function linkStatus(entity, localId) {
  const t = await prisma.integrationToken.findUnique({ where: { provider: PROVIDER }, select: { realmId: true } });
  if (!t || !t.realmId) return null;
  const link = await findLink(providerFor(t.realmId), entity, localId);
  if (!link) return null;
  return { qboId: link.remoteId, syncToken: link.syncToken, syncedAt: link.syncedAt, ...(link.data && typeof link.data === 'object' ? { totalAmt: link.data.totalAmt, balance: link.data.balance, warnings: link.data.warnings || [] } : {}) };
}

module.exports = {
  PROVIDER, SCOPE, QboError, config, authorizeUrl, exchangeCode, refreshTokens, loadTokens, saveTokens, session,
  api, query, pushCustomer, pushInvoice, syncPayments, taxPlan, invoiceBody, customerBody, linkStatus, providerFor, q,
};
