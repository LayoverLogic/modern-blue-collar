/**
 * helpers/brandValidate.js — builds and validates the white-label brand config.
 *
 * brand.config.js (repo root) is a one-liner over buildBrand(process.env), so the
 * same rules apply at server boot, in every seed and in the tests. Anything
 * invalid throws a BrandConfigError with a message that names the env var, the
 * bad value and the accepted values — the server refuses to boot (fail fast)
 * instead of silently falling back to the electrical defaults (WL-5).
 *
 * Exported:
 *   TRADES                      canonical trade slugs
 *   normaliseTrade(raw)         'HVAC ' → 'hvac', 'Plumbing & HVAC' → 'plumbing-hvac'; throws on unknown
 *   buildBrand(env)             the full brand object (plain values, safe to JSON.stringify)
 *   publicBrand(brand, extra)   the fields the front end may see (what /api/brand should return)
 *   darken(hex, amount), contrastText(hex), normaliseColor(name, value)
 */
'use strict';

const TRADES = ['electrical', 'plumbing', 'hvac', 'plumbing-hvac', 'contracting'];

// Letters-only keys ("and"/"&" removed) → canonical slug.
const TRADE_ALIASES = {
  electrical: 'electrical', electric: 'electrical', electrician: 'electrical', electricians: 'electrical',
  plumbing: 'plumbing', plumber: 'plumbing', plumbers: 'plumbing',
  hvac: 'hvac', hvacr: 'hvac', heating: 'hvac', heatingcooling: 'hvac', heatingair: 'hvac', heatingairconditioning: 'hvac',
  plumbinghvac: 'plumbing-hvac', hvacplumbing: 'plumbing-hvac', plumbingheating: 'plumbing-hvac',
  heatingplumbing: 'plumbing-hvac', plumbingheatingcooling: 'plumbing-hvac',
  contracting: 'contracting', contractor: 'contracting', contractors: 'contracting',
  generalcontracting: 'contracting', generalcontractor: 'contracting', gc: 'contracting',
};

const INDUSTRY_LABELS = {
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  'plumbing-hvac': 'Plumbing & HVAC',
  contracting: 'General Contracting',
};

const JOB_TYPES = {
  electrical:      ['Panel Upgrade', 'Outlet / Switch', 'Lighting', 'EV Charger', 'Generator', 'Inspection', 'Troubleshooting', 'Other'],
  plumbing:        ['Leak Repair', 'Drain Cleaning', 'Water Heater', 'Fixture Install', 'Sewer Line', 'Inspection', 'Troubleshooting', 'Other'],
  hvac:            ['AC Install', 'Furnace Install', 'AC Repair', 'Furnace Repair', 'Duct Work', 'Tune-Up', 'Inspection', 'Other'],
  'plumbing-hvac': ['Leak Repair', 'Drain Cleaning', 'Water Heater', 'Fixture Install', 'Sewer Line', 'AC Install', 'Furnace Install', 'AC Repair', 'Furnace Repair', 'Duct Work', 'Tune-Up', 'Inspection', 'Troubleshooting', 'Other'],
  contracting:     ['Framing', 'Drywall', 'Flooring', 'Roofing', 'Painting', 'Demo', 'General Repair', 'Other'],
};

const TECH_LABELS = {
  electrical: 'Electrician',
  plumbing: 'Plumber',
  hvac: 'HVAC Technician',
  'plumbing-hvac': 'Technician',
  contracting: 'Contractor',
};

// Default palette per trade, used only when BRAND_COLOR_* is not set.
const TRADE_PALETTES = {
  electrical:      { primary: '#f5a623', secondary: '#1a1a2e', navBg: '#1a1a2e' }, // yellow / black
  plumbing:        { primary: '#1e6fd9', secondary: '#0f2742', navBg: '#0f2742' }, // blue / navy
  hvac:            { primary: '#0d9488', secondary: '#1f2937', navBg: '#1f2937' }, // teal / grey
  'plumbing-hvac': { primary: '#2563eb', secondary: '#0f172a', navBg: '#0f172a' }, // blue / slate
  contracting:     { primary: '#ea580c', secondary: '#1c1917', navBg: '#1c1917' }, // orange / dark
};

class BrandConfigError extends Error {
  constructor(message) { super(message); this.name = 'BrandConfigError'; }
}

function clean(v) {
  if (v == null) return '';
  return String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function normaliseTrade(raw) {
  const v = clean(raw);
  if (!v) return 'electrical';
  const key = v.toLowerCase().replace(/\band\b/g, ' ').replace(/[^a-z]/g, '');
  const slug = TRADE_ALIASES[key];
  if (!slug) {
    throw new BrandConfigError(
      `BRAND_TRADE_TYPE="${v}" is not a supported trade. ` +
      `Use one of: ${TRADES.join(' | ')} (case-insensitive; "Plumbing & HVAC" also accepted).`,
    );
  }
  return slug;
}

// ── Colours ─────────────────────────────────────────────────────────────────
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normaliseColor(envName, value) {
  const v = clean(value);
  if (!HEX.test(v)) {
    throw new BrandConfigError(`${envName}="${v}" is not a hex colour. Use #rgb or #rrggbb, e.g. #1e6fd9.`);
  }
  let h = v.slice(1).toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h.slice(0, 6);
}

function rgb(hex) {
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}

/** Mix a colour towards black: amount 0..1 (0.18 ≈ a "hover/pressed" shade). */
function darken(hex, amount = 0.18) {
  return toHex(rgb(hex).map((c) => c * (1 - amount)));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** '#000000' or '#ffffff', whichever has the better WCAG contrast on `hex`. */
function contrastText(hex) {
  const L = luminance(hex);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#ffffff' : '#000000';
}

// ── URLs (logo / favicon) ───────────────────────────────────────────────────
function normaliseAssetUrl(envName, value) {
  const v = clean(value);
  if (!v) return '';
  if (/^https?:\/\/[^\s"'<>]+$/i.test(v)) return v;
  if (/^\/(?!\/)[^\s"'<>]*$/.test(v)) return v;                         // same-origin path, e.g. /brand/logo.svg
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i.test(v)) return v;
  throw new BrandConfigError(
    `${envName}="${v.slice(0, 60)}" is not allowed. Use an https:// URL, a same-origin path like /brand/logo.svg, ` +
    'or a base64 data:image/... URL.',
  );
}

function normaliseTimezone(value) {
  const v = clean(value) || 'America/Chicago';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v });
  } catch {
    throw new BrandConfigError(`BRAND_TIMEZONE="${v}" is not an IANA time zone (e.g. America/Chicago, Europe/Dublin).`);
  }
  return v;
}

/**
 * Build the brand object from an env-like map. Pure (no process.env access),
 * so tests and seeds can build any trade without touching the real env.
 */
function buildBrand(env = {}) {
  const tradeType = normaliseTrade(env.BRAND_TRADE_TYPE);
  const pal = TRADE_PALETTES[tradeType];
  const color = (name, fallback) => (clean(env[name]) ? normaliseColor(name, env[name]) : fallback);

  const primary   = color('BRAND_COLOR_PRIMARY', pal.primary);
  const secondary = color('BRAND_COLOR_SECONDARY', pal.secondary);
  const navBg     = color('BRAND_COLOR_NAV_BG', pal.navBg);
  const headerBg  = color('BRAND_COLOR_HEADER_BG', primary);
  const colors = {
    primary,
    primaryDark:     color('BRAND_COLOR_PRIMARY_DARK', darken(primary)),
    primaryContrast: contrastText(primary),
    secondary,
    accent:          color('BRAND_COLOR_ACCENT', '#ffffff'),
    navBg,
    navText:         color('BRAND_COLOR_NAV_TEXT', contrastText(navBg)),
    headerBg,
    headerText:      color('BRAND_COLOR_HEADER_TEXT', contrastText(headerBg)),
  };

  const logoUrl = normaliseAssetUrl('BRAND_LOGO_URL', env.BRAND_LOGO_URL);
  const faviconUrl = normaliseAssetUrl('BRAND_FAVICON_URL', env.BRAND_FAVICON_URL);

  return {
    companyName:    clean(env.BRAND_COMPANY_NAME) || 'Modern Blue Collar',
    // Unset → the generic tagline; set but blank (BRAND_COMPANY_SLOGAN=) → no
    // slogan at all (GAP-15: client env files carry the line empty on purpose).
    companySlogan:  env.BRAND_COMPANY_SLOGAN === undefined ? 'Field Service Management' : clean(env.BRAND_COMPANY_SLOGAN),
    companyPhone:   clean(env.BRAND_COMPANY_PHONE),
    companyEmail:   clean(env.BRAND_COMPANY_EMAIL),
    companyAddress: clean(env.BRAND_COMPANY_ADDRESS),
    tradeType,
    colors,
    logoUrl,
    faviconUrl:     faviconUrl || logoUrl,
    defaultState:   clean(env.BRAND_DEFAULT_STATE) || 'KS',
    industryLabel:  clean(env.BRAND_INDUSTRY_LABEL) || INDUSTRY_LABELS[tradeType],
    jobTypes:       JOB_TYPES[tradeType].slice(),
    technicianLabel: clean(env.BRAND_TECH_LABEL) || TECH_LABELS[tradeType],
    timezone:       normaliseTimezone(env.BRAND_TIMEZONE),
  };
}

/** Fields that are safe for the browser — suggested body of GET /api/brand. */
function publicBrand(brand, extra = {}) {
  return {
    companyName: brand.companyName,
    companySlogan: brand.companySlogan,
    tradeType: brand.tradeType,
    technicianLabel: brand.technicianLabel,
    industryLabel: brand.industryLabel,
    jobTypes: brand.jobTypes,
    colors: brand.colors,
    logoUrl: brand.logoUrl,
    faviconUrl: brand.faviconUrl,
    timezone: brand.timezone,
    ...extra,
  };
}

module.exports = {
  TRADES, INDUSTRY_LABELS, JOB_TYPES, TECH_LABELS, TRADE_PALETTES,
  BrandConfigError, normaliseTrade, normaliseColor, normaliseAssetUrl, normaliseTimezone,
  buildBrand, publicBrand, darken, contrastText,
};
