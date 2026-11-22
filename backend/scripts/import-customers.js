#!/usr/bin/env node
/**
 * scripts/import-customers.js — customer CSV import (CLI) with the migration-gate reports.
 * Same engine as POST /api/imports/customers (helpers/importer.js).
 *
 * Setup / run (Terminal):
 *   1. cd backend && npm install
 *   2. Point DATABASE_URL at a FRESH STAGING database (never production before cutover —
 *      playbook §1.2), e.g.
 *        export DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_staging?schema=public
 *      and set the brand locale the client will run with (BRAND_COUNTRY=US|IE, …) — address
 *      and phone rules follow it. `npm run migrate:deploy` once on a new database.
 *   3. Dry run first (writes NOTHING to the database, only the report files):
 *        node scripts/import-customers.js --file raw/customers.csv --source housecallpro --dry-run \
 *             [--map mapping.json] [--decisions merge-candidates.csv] [--out ~/client-acme/import]
 *      Several --file flags are allowed (Jobber splits exports at 1,500 rows) if their headers match.
 *   4. Read <out>/report.md (Gate 1/2/3 tables). Fix the mapping (mapping.json) until every row is
 *      explained; send merge-candidates.csv to the client, they fill in decision = merge | create
 *      | exclude per row; re-run the dry run with --decisions until "pending decisions" is 0.
 *   5. Real run (one transaction per batch; a failing batch rolls back and stops the run):
 *        node scripts/import-customers.js --file raw/customers.csv --source housecallpro --commit \
 *             --map mapping.json --decisions merge-candidates.csv --expect-sha256 <sha from the dry run>
 *      Re-running is safe: rows are matched on (sourceSystem, sourceId).
 *   6. Gate 5: give the client <out>/spot-check.csv and the staging UI.
 *   7. Roll a committed run back if needed:
 *        node scripts/import-customers.js --undo <out>/report.json
 *
 * Options: --source housecallpro|jobber|generic (default generic) · --map mapping.json ·
 *   --decisions file (CSV from merge-candidates.csv or JSON) · --out dir (default: a new folder
 *   under the OS temp dir — client data must not land in git) · --batch-size N ·
 *   --undecided hold|create · --missing-phone error|blank · --exclude-archived ·
 *   --source-system name · --date-format YYYY-MM-DD|MM/DD/YYYY|DD/MM/YYYY · --template (print the
 *   generic template CSV and exit) · --quiet
 * mapping.json: { "sourceSystem": "hcp-acme", "dateFormat": "MM/DD/YYYY",
 *   "fields": { "sourceId": "Customer ID", "phone": ["Mobile", "Phone"], … } |
 *             { "sourceId": { "derive": ["First Name", "Last Name", "Email"] } },
 *   "typeMap": { "Homeowner": "residential", "Business": "commercial" },
 *   "options": { "excludeArchived": true } }
 * Exit codes: 0 ok (dry run or committed, 0 unexplained), 1 usage / input error,
 *   2 committed with a rolled-back batch, 3 Gate 3 equation does not hold (bug — report it).
 */
'use strict';

require('../helpers/loadEnv');
const fs = require('fs');
const os = require('os');
const path = require('path');

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: node scripts/import-customers.js --file x.csv [--file y.csv] (--dry-run | --commit) [--source housecallpro|jobber|generic] [--map mapping.json] [--decisions file] [--out dir]\n       node scripts/import-customers.js --undo report.json\n       node scripts/import-customers.js --template');
  process.exit(1);
}

function parseArgs(argv) {
  const a = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const val = () => { const v = argv[i + 1]; if (v == null || v.startsWith('--')) usage(`${k} needs a value`); i += 1; return v; };
    switch (k) {
      case '--file': a.files.push(val()); break;
      case '--source': a.source = val(); break;
      case '--map': case '--mapping': a.map = val(); break;
      case '--decisions': a.decisions = val(); break;
      case '--out': a.out = val(); break;
      case '--dry-run': a.dryRun = true; break;
      case '--commit': a.commit = true; break;
      case '--batch-size': a.batchSize = Number(val()); break;
      case '--undecided': a.undecided = val(); break;
      case '--missing-phone': a.missingPhone = val(); break;
      case '--exclude-archived': a.excludeArchived = true; break;
      case '--source-system': a.sourceSystem = val(); break;
      case '--date-format': a.dateFormat = val(); break;
      case '--expect-sha256': a.expectSha256 = val(); break;
      case '--undo': a.undo = val(); break;
      case '--template': a.template = true; break;
      case '--quiet': a.quiet = true; break;
      case '-h': case '--help': usage(); break;
      default: usage(`unknown option ${k}`);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imp = require('../helpers/importer');
  if (args.template) { process.stdout.write(imp.templateCsv()); return 0; }
  const prisma = require('../helpers/prisma');
  try {
    if (args.undo) {
      const report = JSON.parse(fs.readFileSync(args.undo, 'utf8'));
      const result = await imp.undoCustomerImport(report, { prisma });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (!args.files.length) usage('--file is required');
    if (!!args.dryRun === !!args.commit) usage('choose exactly one of --dry-run or --commit');
    let mapping = {};
    if (args.map) {
      try { mapping = JSON.parse(fs.readFileSync(args.map, 'utf8')); } catch (e) { usage(`--map: ${e.message}`); }
    }
    if (args.sourceSystem) mapping.sourceSystem = args.sourceSystem;
    if (args.dateFormat) mapping.dateFormat = args.dateFormat;
    const decisions = args.decisions ? imp.parseDecisions(fs.readFileSync(args.decisions)) : {};
    const options = {};
    for (const k of ['batchSize', 'undecided', 'missingPhone', 'excludeArchived']) if (args[k] !== undefined) options[k] = args[k];
    const files = args.files.map((f) => ({ name: path.basename(f), content: fs.readFileSync(f) }));
    const plan = await imp.planCustomerImport({ files, source: args.source || 'generic', mapping, decisions, options, prisma, actor: { cli: os.userInfo().username } });
    if (args.expectSha256 && args.expectSha256 !== plan.report.files[0].sha256) {
      console.error(`error: ${files[0].name} sha256 ${plan.report.files[0].sha256} ≠ --expect-sha256 ${args.expectSha256} — the file changed since the dry run`);
      return 1;
    }
    const report = args.commit ? await imp.commitCustomerImport(plan) : plan.report;
    const out = args.out || path.join(os.tmpdir(), 'mbc-import-reports', report.runId);
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const write = (name, text) => fs.writeFileSync(path.join(out, name), text, { mode: 0o600 });
    write('report.json', JSON.stringify(report, null, 2));
    write('report.md', imp.renderMarkdown(report));
    write('exceptions.csv', imp.exceptionsCsv(report));
    write('merge-candidates.csv', imp.mergeCsv(report));
    write('spot-check.csv', imp.spotCheckCsv(report));
    const c = report.counts;
    if (!args.quiet) {
      console.log(`${report.mode === 'commit' ? (report.committed ? 'COMMITTED' : 'COMMIT FAILED') : 'DRY RUN'} ${report.runId}  source=${report.source} sourceSystem=${report.sourceSystem}`);
      console.log('entity     source  created  updated  merged  excluded  errored  unexplained');
      console.log(`customers ${String(c.sourceRows).padStart(7)} ${String(c.created).padStart(8)} ${String(c.updated).padStart(8)} ${String(c.merged).padStart(7)} ${String(c.excluded).padStart(9)} ${String(c.errored).padStart(8)} ${String(c.unexplained).padStart(12)}`);
      if (report.pendingDecisions) console.log(`${report.pendingDecisions} merge decision(s) pending — see merge-candidates.csv`);
      for (const f of report.files) console.log(`sha256 ${f.sha256}  ${f.name} (${f.rows} rows)`);
      console.log(`reports: ${out}`);
    }
    if (c.unexplained !== 0) return 3;
    if (report.mode === 'commit' && !report.committed) return 2;
    return 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
