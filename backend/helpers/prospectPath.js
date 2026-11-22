/**
 * helpers/prospectPath.js — where a demo prospect file may live.
 *
 * DEMO_PROSPECT / --prospect is either
 *   - a slug: backend/demo/prospects/<slug>.json (fictional examples only), or
 *   - an ABSOLUTE path to a prospect .json kept OUTSIDE the repository, e.g.
 *     ~/mbc-prospects/acme-plumbing.json. Real prospect details (names, towns,
 *     colours) must never be committed to the public repo, so a path that
 *     points inside the repository (other than demo/prospects/) is refused.
 *
 *   resolveProspectRef(value, { cwd }?) → { kind: 'slug', value } | { kind: 'file', value: <absolute path> }
 *     throws Error with a readable message when refused. A relative path is
 *     accepted only when `cwd` is given (a command-line --prospect argument);
 *     the DEMO_PROSPECT env var must hold an absolute path.
 * No side effects; used by scripts/sandbox.js and scripts/seed-demo.js.
 */
'use strict';

const path = require('path');
const os = require('os');

const BACKEND = path.join(__dirname, '..');
const REPO = path.join(BACKEND, '..');
const EXAMPLES = path.join(BACKEND, 'demo', 'prospects');

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function resolveProspectRef(raw, { cwd } = {}) {
  const v = String(raw == null || raw === '' ? 'default' : raw).trim();
  if (!/[\\/]|\.json$/i.test(v)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(v)) throw new Error(`DEMO_PROSPECT "${v}" is neither a prospect slug nor a path to a .json file`);
    return { kind: 'slug', value: v };
  }
  let p = v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
  if (!path.isAbsolute(p) && cwd) p = path.resolve(cwd, p);
  if (!path.isAbsolute(p)) {
    throw new Error(`DEMO_PROSPECT "${v}" must be an absolute path (e.g. ${path.join(os.homedir(), 'mbc-prospects', 'acme.json')}) or a slug from demo/prospects/`);
  }
  p = path.normalize(p);
  if (inside(p, REPO) && !inside(p, EXAMPLES)) {
    throw new Error(`Prospect file ${p} is inside the repository. Keep real prospect files OUTSIDE the repo (e.g. ${path.join(os.homedir(), 'mbc-prospects')}/) — the repo is public.`);
  }
  return { kind: 'file', value: p };
}

module.exports = { resolveProspectRef, REPO, EXAMPLES };
