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

module.exports = { envFile: process.env.MBC_ENV_FILE || null };
