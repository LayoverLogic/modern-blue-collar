/**
 * demo/lib/fixtures.js — load trade, locale and prospect fixtures.
 *
 *   loadLocale('IE')                 → locale fixture
 *   loadTrade('plumbing-hvac', loc)  → { pricebook, inventory, jobs } with loc.<CC> overrides applied
 *   loadProspect('default' | path)   → validated prospect
 *   listProspects()                  → slugs in demo/prospects/
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { TRADES, normaliseTrade } = require('../../helpers/brandValidate');
const { isReservedEmailDomain } = require('./guard');

const FIX = path.join(__dirname, '..', 'fixtures');
const PROSPECTS = path.join(__dirname, '..', 'prospects');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${path.relative(process.cwd(), file)}: ${e.message}`);
  }
}

function loadLocale(code = 'US') {
  const cc = String(code || 'US').toUpperCase();
  const file = path.join(FIX, 'locales', `${cc}.json`);
  if (!/^[A-Z]{2}$/.test(cc) || !fs.existsSync(file)) {
    const have = fs.readdirSync(path.join(FIX, 'locales')).map((f) => f.replace(/\.json$/, ''));
    throw new Error(`Unknown demo locale "${code}". Available: ${have.join(', ')}`);
  }
  return readJson(file);
}

function roundPrice(v) {
  if (v >= 100) return Math.round(v / 5) * 5;
  if (v >= 20) return Math.round(v);
  return Math.round(v * 4) / 4;
}

/** Apply `loc[CC]` overrides; scale untranslated prices by locale.priceFactor. */
function localise(item, locale) {
  const { loc, ...base } = item;
  const o = (loc && loc[locale.code]) || {};
  const f = locale.priceFactor || 1;
  const out = { ...base, ...o, baseName: base.name || base.title };
  if ('price' in base && !('price' in o)) out.price = roundPrice(base.price * f);
  if ('cost' in base && !('cost' in o)) out.cost = roundPrice(base.cost * f);
  if ('unitCost' in base && !('unitCost' in o)) out.unitCost = roundPrice(base.unitCost * f);
  return out;
}

function rawTrade(trade) {
  const file = path.join(FIX, 'trades', `${trade}.json`);
  if (!fs.existsSync(file)) throw new Error(`No trade fixture for "${trade}" (expected ${file})`);
  return readJson(file);
}

function dedupe(list, key) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x[key]) ? false : seen.add(x[key])));
}

function interleave(lists) {
  const out = [];
  const n = Math.max(...lists.map((l) => l.length));
  for (let i = 0; i < n; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

function loadTrade(trade, locale) {
  const slug = normaliseTrade(trade);
  const raw = rawTrade(slug);
  let pricebook; let inventory; let jobs;
  if (raw.extends) {
    const parts = raw.extends.map((t) => rawTrade(t));
    pricebook = dedupe(parts.flatMap((p) => p.pricebook), 'name');
    inventory = dedupe(parts.flatMap((p) => p.inventory || []), 'name');
    jobs = interleave(parts.map((p) => p.jobs));
  } else {
    ({ pricebook, inventory = [], jobs } = raw);
  }
  return {
    trade: slug,
    pricebook: pricebook.map((i) => localise(i, locale)),
    inventory: inventory.map((i) => localise(i, locale)),
    jobs: jobs.map((j) => localise(j, locale)),
  };
}

function listProspects() {
  return fs.readdirSync(PROSPECTS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
}

function validateProspect(p, where) {
  const err = (m) => { throw new Error(`Prospect ${where}: ${m}`); };
  if (!p || typeof p !== 'object') err('not a JSON object');
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.slug || '')) err('"slug" must be lower-case letters, digits and dashes');
  loadLocale(p.locale || 'US');
  if (!isReservedEmailDomain(p.emailDomain)) {
    err(`"emailDomain" must be a reserved domain (example.com/.net/.org, *.example, *.test, *.invalid) — got "${p.emailDomain}"`);
  }
  if (!p.area || !Array.isArray(p.area.towns) || !p.area.towns.length) err('"area.towns" must list at least one town');
  for (const k of Object.keys(p.brand || {})) if (!/^BRAND_[A-Z_]+$/.test(k)) err(`brand key "${k}" must be a BRAND_* variable`);
  if (p.brand && p.brand.BRAND_TRADE_TYPE) {
    try { normaliseTrade(p.brand.BRAND_TRADE_TYPE); } catch (e) { err(e.message); }
  }
  for (const m of p.team || []) {
    if (!['admin', 'dispatcher', 'technician', 'office'].includes(m.role)) err(`team role "${m.role}" is not allowed in a demo`);
    if (!/^[a-z0-9.+-]+$/.test(m.local || '')) err('team members need a "local" email part, e.g. "tech1"');
  }
  return p;
}

function loadProspect(nameOrPath = 'default') {
  const v = String(nameOrPath || 'default');
  const file = /[\\/]|\.json$/.test(v) ? path.resolve(v) : path.join(PROSPECTS, `${v}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown demo prospect "${v}". Available: ${listProspects().join(', ')} (or pass a path to a .json file)`);
  }
  return validateProspect(readJson(file), path.basename(file));
}

module.exports = { TRADES, loadLocale, loadTrade, loadProspect, listProspects, validateProspect, localise };
