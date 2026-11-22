/**
 * helpers/secretBox.js — encrypt integration tokens at rest (AES-256-GCM).
 *
 * Key: INTEGRATION_ENCRYPTION_KEY (any string; hashed to 32 bytes) if set,
 * otherwise derived from JWT_SECRET with HKDF. Rotating JWT_SECRET without
 * setting INTEGRATION_ENCRYPTION_KEY therefore means reconnecting QuickBooks.
 *
 * Format: "v1:" + base64url(iv[12] | tag[16] | ciphertext)
 */
const crypto = require('crypto');
const { getJwtSecret } = require('./security');

function key() {
  const explicit = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (explicit) return crypto.createHash('sha256').update(explicit).digest();
  return Buffer.from(crypto.hkdfSync('sha256', getJwtSecret(), 'mbc-integration-tokens', 'v1', 32));
}

function seal(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

function open(sealed) {
  if (sealed == null) return null;
  if (!String(sealed).startsWith('v1:')) throw new Error('unknown sealed-secret format');
  const raw = Buffer.from(String(sealed).slice(3), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { seal, open };
