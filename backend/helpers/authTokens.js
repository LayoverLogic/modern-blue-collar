/**
 * helpers/authTokens.js — passwords and single-use account links (Phase 2d / B3).
 *
 * Password rule (shared by POST /api/users, PATCH /api/users/me/password, the
 * reset and accept-invite flows): at least PASSWORD_MIN_LENGTH characters
 * (default 10, never below 8), at most 72 bytes (bcrypt limit).
 *   400 WEAK_PASSWORD     too short
 *   400 INVALID_PASSWORD  not a string / longer than 72 bytes
 *
 * Links (table AuthToken): the raw token (32 random bytes, base64url) is only
 * ever in the link; the DB keeps its sha256. Single use (usedAt), with expiry:
 *   reset   RESET_TOKEN_TTL_MINUTES  (default 30)  — forgot password / admin "send reset link"
 *   invite  INVITE_TTL_HOURS         (default 168) — accept invite → set password
 * Issuing a new token of a kind revokes the user's earlier unused ones of that kind.
 *
 * Link URLs put the token in the #fragment, so it never reaches server or
 * proxy logs: <APP_URL>/reset-password.html#token=…, /accept-invite.html#token=…
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { badRequest } = require('./httpError');

const BCRYPT_ROUNDS = 12;

function envInt(name, fallback, { min = 1 } = {}) {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

const minPasswordLength = () => Math.max(8, envInt('PASSWORD_MIN_LENGTH', 10));
const resetTtlMs  = () => envInt('RESET_TOKEN_TTL_MINUTES', 30) * 60 * 1000;
const inviteTtlMs = () => envInt('INVITE_TTL_HOURS', 168) * 60 * 60 * 1000;

/** Validate a new password; returns it or throws a 400. */
function validPassword(pw, field = 'password') {
  const min = minPasswordLength();
  if (typeof pw !== 'string' || pw === '') {
    throw badRequest(`${field} is required (at least ${min} characters)`, { code: 'WEAK_PASSWORD', field, minLength: min });
  }
  if (Buffer.byteLength(pw) > 72) throw badRequest(`${field} must be at most 72 bytes`, { code: 'INVALID_PASSWORD', field });
  if (pw.length < min) throw badRequest(`${field} must be at least ${min} characters`, { code: 'WEAK_PASSWORD', field, minLength: min });
  return pw;
}

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_ROUNDS);

/** A random password nobody knows (Google-only / invited-not-yet-accepted users). */
const unusablePasswordHash = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

/** 16-character temporary password (admin reset, seed_superadmin). */
const temporaryPassword = () => crypto.randomBytes(12).toString('base64url');

const hashToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

/**
 * Create a token for userId (revoking that user's unused tokens of the kind).
 * @param tx  prisma client or transaction
 * @returns {{ token: string, expiresAt: Date, id: number }}
 */
async function issueToken(tx, { userId, kind, createdById = null, ttlMs }) {
  if (!['reset', 'invite'].includes(kind)) throw new Error(`unknown token kind ${kind}`);
  const ttl = ttlMs || (kind === 'reset' ? resetTtlMs() : inviteTtlMs());
  await tx.authToken.deleteMany({ where: { userId, kind, usedAt: null } });
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttl);
  const row = await tx.authToken.create({ data: { userId, kind, tokenHash: hashToken(token), expiresAt, createdById } });
  return { token, expiresAt, id: row.id };
}

/** Find a usable (unused, unexpired) token of `kind`, with its user. null when invalid. */
async function findToken(client, raw, kind) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null;
  const row = await client.authToken.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
  if (!row || row.kind !== kind || row.usedAt || row.expiresAt <= new Date()) return null;
  return row;
}

/** Mark a token used — atomically; false if someone else used it first / it expired. */
async function consumeToken(tx, row) {
  const r = await tx.authToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
    data:  { usedAt: new Date() },
  });
  return r.count === 1;
}

/** Revoke every unused token of a user (all kinds, or one). */
function revokeTokens(tx, userId, kind) {
  return tx.authToken.deleteMany({ where: { userId, usedAt: null, ...(kind ? { kind } : {}) } });
}

/**
 * Base URL for links in emails: APP_URL; outside production the request's own
 * host as a fallback (never in production — a forged Host header would poison
 * the emailed link). '' → a relative link.
 */
function appBase(req) {
  const fromEnv = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === 'production' || !req || typeof req.get !== 'function') return '';
  const host = req.get('host');
  return host && /^[a-z0-9.:[\]-]+$/i.test(host) ? `${req.protocol}://${host}` : '';
}

const resetLink  = (req, token) => `${appBase(req)}/reset-password.html#token=${encodeURIComponent(token)}`;
const inviteLink = (req, token) => `${appBase(req)}/accept-invite.html#token=${encodeURIComponent(token)}`;

module.exports = {
  BCRYPT_ROUNDS, minPasswordLength, resetTtlMs, inviteTtlMs,
  validPassword, hashPassword, unusablePasswordHash, temporaryPassword,
  hashToken, issueToken, findToken, consumeToken, revokeTokens,
  appBase, resetLink, inviteLink,
};
