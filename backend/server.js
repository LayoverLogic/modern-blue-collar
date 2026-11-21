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
const app   = express();
const server = http.createServer(app);

// ── Socket.io — real-time presence ──────────────────────────────────────────
const { Server } = require('socket.io');
const io = new Server(server, {
  cors: { origin: process.env.APP_URL || '*', methods: ['GET', 'POST'] },
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

const cleanName = (x) => (typeof x === 'string' ? x.slice(0, 100) : '');

io.on('connection', (socket) => {
  let currentJobId = null;

  function leaveCurrent() {
    if (currentJobId && presence[currentJobId]) {
      delete presence[currentJobId][socket.id];
      if (Object.keys(presence[currentJobId]).length === 0) delete presence[currentJobId];
      io.to(`job:${currentJobId}`).emit('presence-update', { jobId: currentJobId, viewers: presence[currentJobId] || {} });
    }
    if (currentJobId) socket.leave(`job:${currentJobId}`);
    currentJobId = null;
  }

  socket.on('viewing-job', safeHandler((payload) => {
    const jobId = parseJobId(payload);
    const user  = payload && typeof payload.user === 'object' && payload.user ? payload.user : null;
    if (!jobId || !user) return; // ignore malformed events
    leaveCurrent();
    currentJobId = jobId;
    if (!presence[currentJobId]) presence[currentJobId] = {};
    presence[currentJobId][socket.id] = { userId: Number(user.id) || null, firstName: cleanName(user.firstName), lastName: cleanName(user.lastName) };
    socket.join(`job:${currentJobId}`);
    io.to(`job:${currentJobId}`).emit('presence-update', { jobId: currentJobId, viewers: presence[currentJobId] });
  }));

  socket.on('leave-job', safeHandler(() => leaveCurrent()));
  socket.on('disconnect', safeHandler(() => leaveCurrent()));
});

// Make io accessible to routes
app.set('io', io);
app.set('presence', presence);

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.disable('x-powered-by');

const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.APP_URL || '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json());

// ── API key authentication (runs before routes, sets req.user if valid) ────
const { authenticateApiKey } = require('./middleware/apiKeyAuth');
app.use('/api/', authenticateApiKey);

// ── Rate limiting ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
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

app.use(express.static('public'));

// ── Presence REST endpoint (for initial page load) ──────────────────────────
app.get('/api/presence', (req, res) => {
  res.json(presence);
});

app.get('/api/presence/:jobId', (req, res) => {
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
app.use('/api/quickbooks',      require('./routes/quickbooks'));
app.use('/api/sms',             require('./routes/sms'));
app.use('/api/backup',          require('./routes/backup'));
app.use('/api/pricebook',       require('./routes/pricebook'));
app.use('/api/exports',         require('./routes/exports'));
app.use('/api/invites',         require('./routes/invites'));
app.use('/api/communications',  require('./routes/communications'));
app.use('/api/api-keys',        require('./routes/apiKeys'));
// Google OAuth callback — mount invites router at /api/auth so
// GOOGLE_CALLBACK_URL=/api/auth/google/callback works
app.use('/api/auth',            require('./routes/invites'));

const demoMode = () => process.env.DEMO_MODE === 'true' && !isProduction();

// ── Brand config endpoint (read-only, safe for front-end consumption) ──────
app.get('/api/brand', (_req, res) => {
  res.json({
    companyName:     brand.companyName,
    companySlogan:   brand.companySlogan,
    tradeType:       brand.tradeType,
    technicianLabel: brand.technicianLabel,
    industryLabel:   brand.industryLabel,
    jobTypes:        brand.jobTypes,
    colors:          brand.colors,
    demoMode:        demoMode(),
    // Demo sign-in hint for the login page — ONLY in demo mode (never in
    // production: the server refuses DEMO_MODE there). null otherwise.
    demoLogin:       demoMode() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
      ? { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
      : null,
  });
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

server.listen(PORT, () => {
  console.log(`[${brand.companyName}] Server running on port ${PORT} | trade=${brand.tradeType}`);
});

// ── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

module.exports = { app, server };
