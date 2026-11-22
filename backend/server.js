const path    = require('path');
const express = require('express');
const http    = require('http');
const helmet  = require('helmet');
const cors    = require('cors');
const rateLimit = require('express-rate-limit');
require('./helpers/loadEnv');

// Refuse to boot with an unsafe production config (missing/weak/published
// JWT_SECRET, DEMO_MODE in production) — RT-6, PLAT-8, RT-23.
const { assertBootConfig, isProduction } = require('./helpers/security');
assertBootConfig();

const brand = require('../brand.config');
const { requireAuth, userFromToken } = require('./routes/auth');
const { errorHandler } = require('./helpers/errorHandler');

const app    = express();
const server = http.createServer(app);
// Flat query strings (RT-28) — must be set before the first app.use().
app.set('query parser', 'simple');

// Money is Decimal(12,2) in the DB (Phase 2b). helpers/prisma.js already reads
// money fields back as numbers; this replacer is the safety net that keeps the
// API contract "money = JSON number" for any Decimal that slips through.
const { Prisma: PrismaNS } = require('@prisma/client');
app.set('json replacer', function moneyReplacer(key, value) {
  const raw = this[key];
  return raw != null && typeof raw === 'object' && PrismaNS.Decimal.isDecimal(raw) ? raw.toNumber() : value;
});

// ── Reverse proxy (RT-24) ──────────────────────────────────────────────────
// Behind a proxy / load balancer set TRUST_PROXY so req.ip (rate limiting,
// logs) is the client, not the proxy:  1 (one hop — typical), a hop count,
// "loopback", or a comma-separated list of proxy IPs/CIDRs. Unset = no proxy
// trusted (X-Forwarded-For ignored). "true" trusts everything — spoofable.
function parseTrustProxy(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxy);
if (trustProxy === true) console.warn('[CONFIG] WARNING: TRUST_PROXY=true trusts any X-Forwarded-For — clients can spoof their IP. Use a hop count (e.g. 1) instead.');

// ── Allowed browser origins (RT-27) ────────────────────────────────────────
// Same-origin only unless APP_URL and/or CORS_ORIGINS (comma-separated) are set.
function allowedOrigins() {
  const list = String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.APP_URL) { try { list.push(new URL(process.env.APP_URL).origin); } catch { /* ignore bad APP_URL */ } }
  return [...new Set(list.map((o) => o.replace(/\/+$/, '')))];
}
const ORIGINS = allowedOrigins();

// ── Socket.io — real-time presence ──────────────────────────────────────────
const { Server } = require('socket.io');
const io = new Server(server, {
  ...(ORIGINS.length ? { cors: { origin: ORIGINS, methods: ['GET', 'POST'] } } : {}),
  maxHttpBufferSize: 64 * 1024,
});

// Handshake auth (RT-14): the client must send its JWT —
//   io({ auth: { token } })   (or an `Authorization: Bearer` header).
// The viewer identity comes from that token, never from event payloads.
io.use((socket, next) => {
  const hs = socket.handshake || {};
  const header = hs.headers && typeof hs.headers.authorization === 'string' ? hs.headers.authorization : '';
  const token = (hs.auth && typeof hs.auth.token === 'string' && hs.auth.token)
    || (header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  userFromToken(token)
    .then((user) => {
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    })
    .catch(() => next(new Error('unauthorized')));
});

// In-memory presence: { jobId: { socketId: { userId, firstName, lastName } } }
const presence = {};

// Socket event payloads come straight from the network: never trust their shape
// (RT-2 — one malformed `viewing-job` used to crash the whole process).
function safeHandler(fn) {
  return (...args) => {
    try { fn(...args); } catch (e) { console.warn('[SOCKET] handler error:', e.message); }
  };
}

function parseJobId(payload) {
  const raw = payload && typeof payload === 'object' ? payload.jobId : undefined;
  const s = typeof raw === 'number' ? String(raw) : raw;
  if (typeof s !== 'string' || !/^\d{1,15}$/.test(s)) return null;
  return String(Number(s));
}

io.on('connection', (socket) => {
  const me = socket.data.user;
  let currentJobId = null;
  // Per-user room: lets routes/users.js drop every socket of a user who is
  // deactivated, deleted or has their role changed (disconnectUserSockets).
  socket.join(`user:${me.id}`);

  function leaveCurrent() {
    if (currentJobId && presence[currentJobId]) {
      delete presence[currentJobId][socket.id];
      if (Object.keys(presence[currentJobId]).length === 0) delete presence[currentJobId];
      io.to(`job:${currentJobId}`).emit('presence-update', { jobId: currentJobId, viewers: presence[currentJobId] || {} });
    }
    if (currentJobId) socket.leave(`job:${currentJobId}`);
    currentJobId = null;
  }

  // payload: { jobId } — any `user` field is ignored (identity = token)
  socket.on('viewing-job', safeHandler((payload) => {
    const jobId = parseJobId(payload);
    if (!jobId) return; // ignore malformed events
    leaveCurrent();
    currentJobId = jobId;
    if (!presence[currentJobId]) presence[currentJobId] = {};
    presence[currentJobId][socket.id] = { userId: me.id, firstName: me.firstName, lastName: me.lastName };
    socket.join(`job:${currentJobId}`);
    io.to(`job:${currentJobId}`).emit('presence-update', { jobId: currentJobId, viewers: presence[currentJobId] });
  }));

  socket.on('leave-job', safeHandler(() => leaveCurrent()));
  socket.on('disconnect', safeHandler(() => leaveCurrent()));
});

/**
 * Disconnect every live socket of a user (deactivated / demoted / deleted).
 * Their presence entries are removed by the normal 'disconnect' handler; a
 * reconnect re-runs the handshake, which re-reads the user row (RT-5).
 */
function disconnectUserSockets(userId) {
  if (!Number.isSafeInteger(userId)) return;
  io.in(`user:${userId}`).disconnectSockets(true);
}

// Make io accessible to routes
app.set('io', io);
app.set('disconnectUserSockets', disconnectUserSockets);
app.set('presence', presence);

// ── Security headers (RT-15) ────────────────────────────────────────────────
// No page in public/ uses inline <script>, inline on* handlers or style=""
// attributes any more (Phase 2c), so scripts and styles are 'self' only.
// tests/backend.test.js ("2c CSP …") loads every page under this policy in headless Chrome and
// fails on any violation. Pages may still set element.style.* from script
// (CSSOM) — CSP does not restrict that.
//   img-src     'self' data: blob: + the https origin of BRAND_LOGO_URL /
//               BRAND_FAVICON_URL when they point at another host
//   connect-src 'self' + ws(s):// of the same host (socket.io presence)
const { cspAssetOrigins, sameOriginSockets } = require('./helpers/csp');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      scriptSrcAttr:  ["'none'"],
      styleSrc:       ["'self'"],
      imgSrc:         ["'self'", 'data:', 'blob:', ...cspAssetOrigins(brand)],
      fontSrc:        ["'self'", 'data:'],
      connectSrc:     ["'self'", (req) => sameOriginSockets(req)],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
    },
  },
}));
app.disable('x-powered-by');

const PORT = process.env.PORT || 3001;

// TECH_VISIBILITY=own|all (helpers/access.js) — unknown values fall back to own.
{
  const tv = String(process.env.TECH_VISIBILITY || '').trim().toLowerCase();
  if (tv && !['own', 'all'].includes(tv)) console.warn(`[CONFIG] TECH_VISIBILITY="${process.env.TECH_VISIBILITY}" is not own|all — using own.`);
}

app.use(cors({
  origin: ORIGINS.length ? ORIGINS : false,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json({ limit: '1mb' }));

// ── Query strings are flat strings (RT-28) ──────────────────────────────────
// No nested objects (?a[not]=x) that could reach Prisma as operators; a
// repeated key keeps its first value.
app.use((req, _res, next) => {
  for (const [k, v] of Object.entries(req.query)) {
    if (Array.isArray(v)) req.query[k] = typeof v[0] === 'string' ? v[0] : '';
    else if (typeof v !== 'string') delete req.query[k];
  }
  next();
});

// ── API key authentication (runs before routes, sets req.user if valid) ────
const { authenticateApiKey } = require('./middleware/apiKeyAuth');
app.use('/api/', authenticateApiKey);

// ── Rate limiting (UX-15) ───────────────────────────────────────────────────
// A whole office often shares one public IP, so signed-in requests are counted
// per user (valid session JWT) or per API key, not per IP. Anonymous requests
// stay per IP. The strict login limiter below is still per IP.
//   RATE_LIMIT_USER_MAX  requests / 15 min per signed-in user or key (default 1000)
//   RATE_LIMIT_IP_MAX    requests / 15 min per IP for anonymous calls (default 300)
const { verifyToken } = require('./helpers/security');
const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
const USER_MAX = envInt('RATE_LIMIT_USER_MAX', 1000);
const IP_MAX   = envInt('RATE_LIMIT_IP_MAX', 300);
function limiterIdentity(req) {
  if (req._rlIdentity !== undefined) return req._rlIdentity;
  let id = null;
  if (req.apiKey && req.apiKey.id) id = `key:${req.apiKey.id}`;
  else {
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.startsWith('Bearer ')) {
      try { id = `user:${verifyToken(h.slice(7).trim()).id}`; } catch { id = null; }
    }
  }
  req._rlIdentity = id;
  return id;
}
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: (req) => (limiterIdentity(req) ? USER_MAX : IP_MAX),
  keyGenerator: (req) => limiterIdentity(req) || `ip:${rateLimit.ipKeyGenerator(req.ip || '')}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/google/exchange', authLimiter);

// ── Favicon (WL-7): BRAND_FAVICON_URL (or the logo) — else 204, never a 404 ──
app.get('/favicon.ico', (_req, res) => {
  const url = brand.faviconUrl;
  if (!url) return res.status(204).end();
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (m) {
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(Buffer.from(m[2], 'base64'));
  }
  return res.redirect(302, url);
});

// HTML is never cached (a deploy or brand change shows up on the next load);
// other static assets keep the default caching.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Presence REST endpoints (initial page load) — signed-in users only ──────
app.get('/api/presence', requireAuth, (_req, res) => {
  res.json(presence);
});

app.get('/api/presence/:jobId', requireAuth, (req, res) => {
  const jobId = String(req.params.jobId);
  res.json({ jobId, viewers: presence[jobId] || {} });
});

// ── API routes ──────────────────────────────────────────────────────────────
app.use('/api/customers',       require('./routes/customers'));
app.use('/api/jobs',            require('./routes/jobs'));
app.use('/api/users',           require('./routes/users'));
app.use('/api/quotes',          require('./routes/quotes'));
app.use('/api/invoices',        require('./routes/invoices'));
app.use('/api/auth',            require('./routes/auth').router);
// Google sign-in: /api/auth/google, /api/auth/google/callback, /api/auth/google/exchange
app.use('/api/auth',            require('./routes/googleAuth'));
app.use('/api/quickbooks',      require('./routes/quickbooks'));
app.use('/api/sms',             require('./routes/sms'));
app.use('/api/backup',          require('./routes/backup'));
app.use('/api/pricebook',       require('./routes/pricebook'));
app.use('/api/exports',         require('./routes/exports'));
app.use('/api/imports',         require('./routes/imports'));
app.use('/api/invites',         require('./routes/invites'));
app.use('/api/communications',  require('./routes/communications'));
app.use('/api/api-keys',        require('./routes/apiKeys'));
app.use('/api/activity',        require('./routes/activity').router);

const demoMode = () => process.env.DEMO_MODE === 'true' && !isProduction();

// ── Brand config endpoint (read-only, safe for front-end consumption) ──────
// helpers/brandValidate.publicBrand: companyName, companySlogan, tradeType,
// technicianLabel, industryLabel, jobTypes, colors, logoUrl, faviconUrl,
// timezone — plus demoMode / demoLogin and the `locale` block (Phase 2b).
const { publicBrand } = require('./helpers/brandValidate');
const { publicLocale } = require('./helpers/locale');
const { integrationStatus } = require('./helpers/integrations');
app.get('/api/brand', (_req, res) => {
  res.json(publicBrand(brand, {
    // Show "Sign in with Google" only when it can work: Google OAuth configured
    // (GOOGLE_CLIENT_ID / _SECRET / _CALLBACK_URL) and not disabled by SANDBOX_MODE.
    googleAuth:      integrationStatus('google').enabled,
    // Shortcuts for pages (same values as in `locale`).
    country:         brand.locale.country,
    currency:        brand.locale.currency,
    weekStart:       brand.locale.weekStart,
    demoMode:        demoMode(),
    // Demo sign-in hint for the login page — ONLY in demo mode (never in
    // production: the server refuses DEMO_MODE there). null otherwise.
    demoLogin:       demoMode() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
      ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
      : null,
    locale:          publicLocale(brand.locale),
  }));
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    message:   `${brand.companyName} Platform is running!`,
    tradeType: brand.tradeType,
    version:   '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Unknown API routes → JSON 404 (not the static-file 404 page)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' }));

// ── Global error handler (RT-17): helpers/errorHandler.js ───────────────────
app.use(errorHandler);

// ── Nightly backup cron (03:00) ─────────────────────────────────────────────
try {
  const cron         = require('node-cron');
  const { runBackup} = require('./backup');
  cron.schedule('0 3 * * *', () => {
    console.log('[CRON] Starting nightly backup at 03:00...');
    runBackup().catch(e => console.error('[CRON] Backup failed:', e.message));
  }, { timezone: brand.timezone });
  console.log(`Nightly backup scheduled at 03:00 (${brand.timezone})`);
} catch (e) {
  console.warn('node-cron not available — nightly backup disabled:', e.message);
}

// Document numbers for rows inserted outside the API (seeds, imports) use the
// prefix stored in "DocumentCounter": keep it in step with BRAND_*_PREFIX.
require('./helpers/prisma').$executeRaw`UPDATE "DocumentCounter" SET "prefix" = CASE "type" WHEN 'quote' THEN ${brand.locale.quotePrefix} ELSE ${brand.locale.invoicePrefix} END`
  .catch((e) => console.warn('[BOOT] could not sync document number prefixes:', e.message));

// HOST: interface to listen on. Unset = all interfaces (Docker / production
// behind a proxy). `npm run sandbox` defaults it to 127.0.0.1.
const HOST = String(process.env.HOST || '').trim() || undefined;
server.listen(PORT, HOST, () => {
  console.log(`[${brand.companyName}] Server running on ${HOST ? `${HOST}:` : 'port '}${PORT} | trade=${brand.tradeType}`);
});

module.exports = { app, server };
