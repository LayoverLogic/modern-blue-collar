/**
 * helpers/publishedSecrets.js — JWT_SECRET values that have ever appeared in
 * this repo (examples, docs, tests). They are public, so never acceptable in
 * production (helpers/security.js) and always replaced by `npm run sandbox`
 * (scripts/sandbox.js). No side effects: safe to require before env loading.
 * Compare lower-cased.
 *
 * tests/backend.test.js ("M1 every JWT secret literal in the repo …") scans
 * every tracked file (tests, docs, env examples, scripts) for JWT-secret-like
 * literals and fails if one is not rejected here — add any new literal to the
 * list below (better: generate test secrets with crypto.randomBytes).
 */
const PUBLISHED_SECRETS = new Set([
  'change_this_to_a_random_secret_string_min_32_chars',
  'sandbox_only_jwt_secret_not_for_production_0123456789abcdef',
  'demo_dev_secret_change_me_to_a_random_32_plus_char_string',
  // tests/whitelabel.test.js used this literal until B4 (M1) — it is in git history
  'whitelabel_test_secret_0123456789abcdef0123456789',
  // the deliberately weak value of the L7 boot test (tests/backend.test.js, in history since B4)
  'short',
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
