/**
 * demo/lib/guard.js — safety rails for demo seeding and checking.
 *
 *   assertDemoDatabase(url, opts)  refuse anything that is not obviously a demo DB
 *   isReservedEmailDomain(d)       RFC 2606 / 6761 names only (example.*, *.test, ...)
 *   loadDenylist(file?)            client names that must never appear in demo data
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseDatabaseUrl } = require('../../helpers/databaseUrl');

const DEMO_DIR = path.join(__dirname, '..');
const DEMO_DB_TOKENS = /(^|[_-])(demo|sandbox|test|wl)([_-]|$)/i;

class DemoGuardError extends Error {
  constructor(message) { super(message); this.name = 'DemoGuardError'; }
}

/**
 * A database is a demo database when its NAME contains a demo token
 * (demo | sandbox | test | wl as a _-separated word: mbc_sandbox, mbc_demo_acme,
 * mbc_wl_hvac, mbc_redteam_test), or when it is named exactly in allowDb
 * (--allow-db / SEED_DEMO_ALLOW_DB — e.g. the Docker demo's plain "mbc").
 * NODE_ENV=production is always refused unless allowDb names the database.
 */
function assertDemoDatabase(databaseUrl, { allowDb = process.env.SEED_DEMO_ALLOW_DB, nodeEnv = process.env.NODE_ENV } = {}) {
  let database;
  try { ({ database } = parseDatabaseUrl(databaseUrl)); } catch (e) { throw new DemoGuardError(e.message); }
  if (!database) throw new DemoGuardError('DATABASE_URL has no database name.');
  const allowed = allowDb && allowDb === database;
  if (/^\s*production\s*$/i.test(String(nodeEnv || '')) && !allowed) {
    throw new DemoGuardError(`NODE_ENV=production — refusing to write demo data to "${database}". ` +
      `If this really is a demo instance, pass --allow-db ${database}.`);
  }
  if (!allowed && !DEMO_DB_TOKENS.test(database)) {
    throw new DemoGuardError(`"${database}" does not look like a demo database (name must contain demo, sandbox, test or wl, ` +
      `e.g. mbc_demo_${'acme'}). Refusing to write demo data. If you are sure, pass --allow-db ${database}.`);
  }
  return database;
}

const RESERVED_SLDS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];

function isReservedEmailDomain(domain) {
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!d) return false;
  if (RESERVED_SLDS.some((s) => d === s || d.endsWith('.' + s))) return true;
  return RESERVED_TLDS.includes(d.split('.').pop());
}

function emailDomain(email) {
  const m = /@([^@\s]+)$/.exec(String(email || ''));
  return m ? m[1] : '';
}

/**
 * Denylist = client names / domains / towns that must never show up in a demo.
 * Real names are kept OUT of the public repo: they live in the gitignored
 * backend/demo/denylist.local.txt (or a file named by DEMO_DENYLIST_FILE).
 * backend/demo/denylist.example.txt shows the format with placeholder entries.
 * One term per line, case-insensitive substring match, '#' starts a comment.
 */
function defaultDenylistFile() {
  return process.env.DEMO_DENYLIST_FILE || path.join(DEMO_DIR, 'denylist.local.txt');
}

function parseDenylist(text) {
  return String(text).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

function loadDenylist(file = defaultDenylistFile()) {
  if (!file || !fs.existsSync(file)) return { file, terms: [], found: false };
  return { file, terms: parseDenylist(fs.readFileSync(file, 'utf8')), found: true };
}

/** Return the denylisted terms found in `text` (case-insensitive). */
function denylistHits(text, terms) {
  const t = String(text).toLowerCase();
  return terms.filter((term) => t.includes(term.toLowerCase()));
}

module.exports = {
  DemoGuardError, assertDemoDatabase, DEMO_DB_TOKENS,
  isReservedEmailDomain, emailDomain,
  loadDenylist, parseDenylist, denylistHits, defaultDenylistFile,
};
