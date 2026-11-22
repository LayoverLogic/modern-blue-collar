/**
 * helpers/publishedSecrets.js — JWT_SECRET values that have ever appeared in
 * this repo (examples, docs, tests). They are public, so never acceptable in
 * production (helpers/security.js) and always replaced by `npm run sandbox`
 * (scripts/sandbox.js). No side effects: safe to require before env loading.
 * Compare lower-cased.
 */
const PUBLISHED_SECRETS = new Set([
  'change_this_to_a_random_secret_string_min_32_chars',
  'sandbox_only_jwt_secret_not_for_production_0123456789abcdef',
  'demo_dev_secret_change_me_to_a_random_32_plus_char_string',
  '__generate_on_first_run__',
  'test-secret-key',
  'secret',
  'changeme',
  'change_me',
  'your_jwt_secret',
]);

/** True for values that are public knowledge: published in this repo or an obvious placeholder. */
function isKnownSecret(secret) {
  if (secret == null) return false;
  const s = String(secret).trim();
  if (!s) return false;
  return PUBLISHED_SECRETS.has(s.toLowerCase()) || /^(placeholder|change[-_ ]?me|your[-_ ]|<.*>$|__.*__$)/i.test(s);
}

module.exports = { PUBLISHED_SECRETS, isKnownSecret };
