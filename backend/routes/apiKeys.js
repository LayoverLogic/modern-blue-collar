/**
 * routes/apiKeys.js
 * API key management — create, list, revoke.
 * Only super-admin and admin roles can manage keys.
 *
 * Endpoints:
 *   GET    /api/api-keys       — list all keys (hashed key is never returned)
 *   POST   /api/api-keys       — create a new key (plaintext returned ONCE)
 *   DELETE /api/api-keys/:id   — revoke (deactivate) a key
 */

const express          = require('express');
const router           = express.Router();
const crypto           = require('crypto');
const bcrypt           = require('bcryptjs');
const { requireAuth, requireRole, requireSession } = require('./auth');
const { PREFIX_LENGTH } = require('../middleware/apiKeyAuth');
const { ADMIN } = require('../helpers/roles');
const { parseId, badRequest } = require('../helpers/httpError');

const prisma = require('../helpers/prisma');

// read  = GET / HEAD, write = POST / PUT / PATCH / DELETE (routes/auth.js requireAuth)
// export = may also download the whole-company zip GET /api/exports/all (with read;
//          a write key may too) — a read-only reporting key cannot (B4 Info item)
const VALID_SCOPES = ['read', 'write', 'export'];

// All routes require a signed-in admin+ (API keys cannot mint or revoke keys)
router.use(requireAuth);
router.use(requireSession);
router.use(requireRole(...ADMIN));

// ── GET /api/api-keys ─────────────────────────────────────────────────────────
router.get('/', async (_req, res, next) => {
  try {
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        active: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });
    res.json(keys);
  } catch (err) { next(err); }
});

// ── POST /api/api-keys ────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, scopes, expiresAt } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required (e.g. "QuickBooks Sync")' });
    }
    if (name.trim().length > 100) throw badRequest('name must be at most 100 characters');

    const scopeList = scopes == null || scopes === ''
      ? ['read', 'write']
      : (Array.isArray(scopes) ? scopes : String(scopes).split(',')).map((x) => String(x).trim()).filter(Boolean);
    const unknown = scopeList.filter((x) => !VALID_SCOPES.includes(x));
    if (!scopeList.length || unknown.length) {
      throw badRequest(`scopes must be a comma-separated list of: ${VALID_SCOPES.join(', ')}`, { code: 'INVALID_SCOPES' });
    }
    let expires = null;
    if (expiresAt) {
      expires = new Date(expiresAt);
      if (Number.isNaN(expires.getTime())) throw badRequest('expiresAt must be a date');
    }

    // Key: mbc_ + 40 random hex chars. Lookup prefix: first 16 chars
    // ("mbc_" + 12 hex) — wide enough that collisions do not happen in practice;
    // retried anyway because prefix is UNIQUE.
    let record;
    let plainKey;
    for (let attempt = 0; attempt < 5 && !record; attempt++) {
      plainKey = `mbc_${crypto.randomBytes(20).toString('hex')}`;
      const prefix = plainKey.substring(0, PREFIX_LENGTH);
      // eslint-disable-next-line no-await-in-loop
      const hashedKey = await bcrypt.hash(plainKey, 12);
      try {
        // eslint-disable-next-line no-await-in-loop
        record = await prisma.apiKey.create({
          data: {
            name:        name.trim(),
            prefix,
            hashedKey,
            scopes:      [...new Set(scopeList)].join(','),
            createdById: req.user.id,
            expiresAt:   expires,
          },
        });
      } catch (e) {
        if (e.code !== 'P2002') throw e;
      }
    }
    if (!record) throw new Error('could not allocate a unique API key prefix');

    // Return plaintext key ONCE — it cannot be retrieved again
    res.status(201).json({
      id:        record.id,
      name:      record.name,
      key:       plainKey,
      prefix:    record.prefix,
      scopes:    record.scopes,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      message:   'Save this key now — it will not be shown again.',
    });
  } catch (err) { next(err); }
});

// ── DELETE /api/api-keys/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const key = await prisma.apiKey.findUnique({ where: { id } });
    if (!key) return res.status(404).json({ error: 'API key not found' });

    await prisma.apiKey.update({
      where: { id },
      data:  { active: false },
    });

    res.json({ success: true, message: `API key "${key.name}" revoked.` });
  } catch (err) { next(err); }
});

module.exports = router;
