/**
 * helpers/security.js — boot-time configuration checks + JWT helpers.
 *
 * JWT_SECRET policy (RT-6 / PLAT-8):
 *   NODE_ENV=production  → refuse to boot if JWT_SECRET is missing, shorter than
 *                          32 characters, or one of the values ever published in
 *                          this repo's examples / docs.
 *   anything else        → a missing secret gets a random per-process secret
 *                          (sessions end on restart), with a warning. A KNOWN
 *                          value (published in this repo, or a placeholder such
 *                          as __GENERATE_ON_FIRST_RUN__) is refused — anyone
 *                          could forge tokens with it — unless SANDBOX_MODE=true,
 *                          where it is replaced by a random per-process secret
 *                          (never used as is). `npm run sandbox` writes a random
 *                          secret into the env file instead. Short / low-variety
 *                          secrets only warn outside production.
 *
 * DEMO_MODE policy (RT-23): DEMO_MODE=true with NODE_ENV=production refuses to
 * boot — demo mode advertises demo credentials and seeds default passwords.
 *
 * server.js calls assertBootConfig() before it listens; every module that signs
 * or verifies tokens uses signToken() / verifyToken() from here.
 */
require('./loadEnv');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const MIN_SECRET_LENGTH = 32;

// Values that have appeared in this repo (examples, docs, tests). Never secret.
const { PUBLISHED_SECRETS, isKnownSecret } = require('./publishedSecrets');

// Any spelling / padding of "production" counts (L7; helpers/loadEnv.js also normalises it).
const isProduction = () => /^\s*production\s*$/i.test(String(process.env.NODE_ENV || ''));

/** @returns {string|null} why the secret is unacceptable for production, or null */
function jwtSecretProblem(secret) {
  if (secret == null || String(secret).trim() === '') return 'JWT_SECRET is not set';
  const s = String(secret).trim();
  if (PUBLISHED_SECRETS.has(s.toLowerCase())) return 'JWT_SECRET is a published example value';
  if (/^(placeholder|change[-_ ]?me|your[-_ ]|x{3,}|<.*>)/i.test(s)) return 'JWT_SECRET is a placeholder';
  if (s.length < MIN_SECRET_LENGTH) return `JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
  if (new Set(s).size < 8) return 'JWT_SECRET has too little variety (e.g. "aaaa…")';
  return null;
}

let secretResolved = false;
/** The JWT secret in use (resolved once; may be an ephemeral dev secret). */
function getJwtSecret() {
  if (!secretResolved) {
    secretResolved = true;
    if (!process.env.JWT_SECRET && !isProduction()) {
      process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
      process.env.MBC_EPHEMERAL_JWT_SECRET = 'true';
    }
  }
  return process.env.JWT_SECRET;
}

function jwtExpires() {
  return process.env.JWT_EXPIRES || '8h';
}

/**
 * Sign a session token for a user row (honours JWT_EXPIRES). `sv` is the user's
 * sessionVersion: bumping it in the DB revokes every token signed before
 * (password change / reset, deactivation — routes/auth.js userFromToken).
 */
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, firstName: user.firstName, lastName: user.lastName, sv: Number(user.sessionVersion) || 0 },
    getJwtSecret(),
    { expiresIn: jwtExpires(), algorithm: 'HS256' },
  );
}

/**
 * Verify a session token: HS256 only, must carry an integer id and an exp.
 * Throws on anything else. (Role/active state is re-read from the DB by the
 * caller — the token only proves identity.)
 */
function verifyToken(token) {
  const payload = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
  if (!payload || typeof payload !== 'object') throw new Error('malformed token');
  if (typeof payload.exp !== 'number') throw new Error('token has no expiry');
  if (!Number.isSafeInteger(payload.id) || payload.id < 1) throw new Error('token has no user id');
  return payload;
}

/**
 * Validate configuration for this NODE_ENV.
 * @returns {{ fatal: string[], warnings: string[] }}
 */
function checkBootConfig() {
  const fatal = [];
  const warnings = [];
  const prod = isProduction();

  const problem = jwtSecretProblem(process.env.JWT_SECRET);
  let replaceSecret = false;
  const gen = 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
  if (problem) {
    if (prod) fatal.push(`${problem}. ${gen}`);
    else if (!process.env.JWT_SECRET) warnings.push('JWT_SECRET is not set — using a random per-process secret (all sessions end when the server restarts). Set JWT_SECRET to keep sessions across restarts.');
    else if (isKnownSecret(process.env.JWT_SECRET)) {
      // A public value lets anyone on the network forge a session token —
      // in development too (the dev server listens beyond localhost).
      if (process.env.SANDBOX_MODE === 'true') {
        replaceSecret = true;
        warnings.push(`${problem} — SANDBOX_MODE=true, so it is replaced by a random per-process secret (sessions end when the server restarts). Run \`npm run sandbox\` (it writes a random secret into the env file) or set JWT_SECRET.`);
      } else {
        fatal.push(`${problem} — refused outside production too (anyone could forge tokens). ${gen}, or use SANDBOX_MODE=true to run on a generated per-process secret.`);
      }
    } else warnings.push(`${problem} — acceptable only because NODE_ENV is not "production". Never deploy this value.`);
  }

  try { jwt.sign({}, 'x'.repeat(32), { expiresIn: jwtExpires() }); } catch (e) {
    fatal.push(`JWT_EXPIRES="${process.env.JWT_EXPIRES}" is invalid (${e.message}); use e.g. 8h, 30m, 1d.`);
  }

  if (process.env.DEMO_MODE === 'true') {
    if (prod) fatal.push('DEMO_MODE=true is not allowed with NODE_ENV=production (demo mode advertises demo credentials and seeds default passwords). Set DEMO_MODE=false, or NODE_ENV=development for a demo.');
    else warnings.push('DEMO_MODE=true — demo credentials are advertised on the login page. Never expose this instance publicly.');
  }
  if (prod && process.env.SANDBOX_MODE === 'true') {
    warnings.push('SANDBOX_MODE=true in production — Twilio / QuickBooks / Google are disabled.');
  }
  return { fatal, warnings, replaceSecret };
}

/** Print warnings; on fatal problems print them and exit(1). */
function assertBootConfig({ exit = true, log = console } = {}) {
  const { fatal, warnings, replaceSecret } = checkBootConfig();
  for (const w of warnings) log.warn(`[CONFIG] WARNING: ${w}`);
  if (fatal.length) {
    for (const f of fatal) log.error(`[CONFIG] FATAL: ${f}`);
    log.error('[CONFIG] Refusing to start. Fix the configuration above.');
    if (exit) process.exit(1);
  }
  if (replaceSecret && !fatal.length) {
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.MBC_EPHEMERAL_JWT_SECRET = 'true';
  }
  getJwtSecret();
  return { fatal, warnings };
}

module.exports = {
  MIN_SECRET_LENGTH, PUBLISHED_SECRETS,
  isProduction, isKnownSecret, jwtSecretProblem, getJwtSecret, jwtExpires,
  signToken, verifyToken, checkBootConfig, assertBootConfig,
};
