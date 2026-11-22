/**
 * middleware/apiKeyAuth.js
 * Authenticates requests using API keys (X-API-Key header).
 *
 * Keys look like `mbc_<40 hex>`. New keys store a 16-character lookup prefix
 * ("mbc_" + 12 hex); keys created before that change used 8 characters
 * ("mbc_" + 4 hex), so both lengths are looked up. Only the bcrypt hash of the
 * full key is stored.
 *
 * A key acts AS ITS CREATOR (RT-22): the creator must still exist and be active,
 * and the key gets the creator's current role. On top of that the key's scopes
 * apply (RT-4): "read" allows GET/HEAD, "write" allows POST/PUT/PATCH/DELETE —
 * enforced by requireAuth in routes/auth.js. Actions that need a person
 * (user / key management, invites) reject API keys (requireSession).
 */

const bcrypt = require('bcryptjs');
const prisma = require('../helpers/prisma');

const PREFIX_LENGTH        = 16;
const LEGACY_PREFIX_LENGTH = 8;
const KEY_FORMAT = /^mbc_[0-9a-f]{40}$/;

function parseScopes(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Express middleware — checks X-API-Key header.
 * On success, sets req.user and req.apiKey. On failure, calls next() without
 * setting req.user (requireAuth then answers 401).
 */
async function authenticateApiKey(req, _res, next) {
  const key = req.headers['x-api-key'];
  if (!key || typeof key !== 'string' || !KEY_FORMAT.test(key)) return next();

  try {
    const records = await prisma.apiKey.findMany({
      where: { prefix: { in: [key.substring(0, PREFIX_LENGTH), key.substring(0, LEGACY_PREFIX_LENGTH)] }, active: true },
      include: { createdBy: { select: { id: true, email: true, role: true, firstName: true, lastName: true, active: true } } },
    });

    let record = null;
    for (const r of records) {
      if (r.expiresAt && r.expiresAt < new Date()) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(key, r.hashedKey)) { record = r; break; }
    }
    if (!record) return next();
    const owner = record.createdBy;
    if (!owner || !owner.active) return next();

    prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

    req.user = {
      id:         owner.id,
      email:      owner.email,
      role:       owner.role,
      firstName:  owner.firstName,
      lastName:   owner.lastName,
      apiKeyId:   record.id,
      apiKeyName: record.name,
      scopes:     parseScopes(record.scopes),
    };
    req.apiKey = { id: record.id, name: record.name, scopes: req.user.scopes };
    next();
  } catch (err) {
    console.error('[API-KEY] Auth error:', err.message);
    next();
  }
}

/**
 * Extra scope check for a specific route (beyond the read/write rule that
 * requireAuth applies to every API-key request).
 *   router.post('/...', requireAuth, requireScope('admin'), handler)
 */
function requireScope(...needed) {
  return (req, res, next) => {
    if (!req.apiKey) return next(); // JWT users: roles apply, not scopes
    const has = req.user.scopes || [];
    const missing = needed.filter((s) => !has.includes(s));
    if (missing.length) {
      return res.status(403).json({ error: `API key missing required scope(s): ${missing.join(', ')}`, code: 'SCOPE_REQUIRED' });
    }
    next();
  };
}

module.exports = { authenticateApiKey, requireScope, parseScopes, PREFIX_LENGTH, LEGACY_PREFIX_LENGTH };
