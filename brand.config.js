/**
 * brand.config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central branding & trade-type configuration for Modern Blue Collar.
 *
 * White-label promise: a client is configured with BRAND_* environment
 * variables only — no source edits (not even this file). See the "White-label"
 * section of SETUP.md for the full list. The rules live in
 * backend/helpers/brandValidate.js, shared with the seeds and tests.
 *
 *   BRAND_TRADE_TYPE   electrical | plumbing | hvac | plumbing-hvac | contracting
 *                      (case-insensitive; "Plumbing & HVAC", "HVAC" etc. accepted).
 *                      Anything else stops the server at boot with a clear message.
 *   BRAND_COMPANY_NAME / _SLOGAN / _PHONE / _EMAIL / _ADDRESS
 *   BRAND_COLOR_PRIMARY, _PRIMARY_DARK, _SECONDARY, _ACCENT, _NAV_BG, _NAV_TEXT,
 *     _HEADER_BG, _HEADER_TEXT   (hex; unset → per-trade palette, dark/contrast
 *                                 shades derived from the primary colour)
 *   BRAND_LOGO_URL, BRAND_FAVICON_URL   https:// URL, /same-origin/path or data:image
 *   BRAND_TECH_LABEL, BRAND_INDUSTRY_LABEL, BRAND_DEFAULT_STATE, BRAND_TIMEZONE
 *
 * The exported object holds plain values (no getters), so it serialises cleanly:
 *   companyName, companySlogan, companyPhone, companyEmail, companyAddress,
 *   tradeType, colors{primary, primaryDark, primaryContrast, secondary, accent,
 *   navBg, navText, headerBg, headerText}, logoUrl, faviconUrl, defaultState,
 *   industryLabel, jobTypes[], technicianLabel, timezone
 *
 * ── Locale block (Phase 2b) ── brand.locale = helpers/locale.js buildLocale():
 *   BRAND_COUNTRY (US | IE), BRAND_CURRENCY, BRAND_TAX_RATES ("standard:23,reduced:13.5,zero:0"),
 *   BRAND_TAX_DEFAULT, BRAND_TAX_LABEL, BRAND_TAX_NUMBER, BRAND_QUOTE_PREFIX,
 *   BRAND_INVOICE_PREFIX, BRAND_RCT_NOTE. Unset = today's US behaviour (USD, no tax).
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { buildBrand, BrandConfigError } = require('./backend/helpers/brandValidate');

let brand;
try {
  brand = buildBrand(process.env);
  // ── Locale block (Phase 2b, helpers/locale.js) — fails fast like the rest ──
  brand.locale = require('./backend/helpers/locale').buildLocale(process.env, brand);
  // ── end locale block ──
} catch (e) {
  if (!(e instanceof BrandConfigError)) throw e;
  console.error(`\n[brand] Invalid white-label configuration — refusing to start.\n[brand] ${e.message}\n`);
  process.exit(1);
}

module.exports = brand;
