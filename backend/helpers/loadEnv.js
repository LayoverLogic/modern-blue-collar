/**
 * helpers/loadEnv.js
 * Loads environment variables once, without overriding anything already set
 * in the real process environment (Docker / PaaS env always wins).
 *
 * Resolution order (first match wins):
 *   1. ENV_FILE=<path>   explicit file (relative to backend/)
 *   2. backend/.env      normal local / Docker setup
 *   3. backend/.env.sandbox  the zero-paid-services sandbox (see .env.sandbox.example)
 */
const fs   = require('fs');
const path = require('path');

if (!global.__mbcEnvLoaded) {
  global.__mbcEnvLoaded = true;
  const root = path.join(__dirname, '..');
  const candidates = process.env.ENV_FILE
    ? [path.resolve(root, process.env.ENV_FILE)]
    : [path.join(root, '.env'), path.join(root, '.env.sandbox')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (file) {
    require('dotenv').config({ path: file, quiet: true });
    process.env.MBC_ENV_FILE = file;
  }
}

// NODE_ENV is compared with === 'production' by Express and by our boot checks
// (L7): "Production", " PRODUCTION " … would silently skip every production
// safeguard, so any spelling of production is normalised to 'production'.
if (typeof process.env.NODE_ENV === 'string' && process.env.NODE_ENV !== 'production'
    && /^\s*production\s*$/i.test(process.env.NODE_ENV)) {
  console.warn(`[CONFIG] NODE_ENV="${process.env.NODE_ENV}" read as "production".`);
  process.env.NODE_ENV = 'production';
}

module.exports = { envFile: process.env.MBC_ENV_FILE || null };
