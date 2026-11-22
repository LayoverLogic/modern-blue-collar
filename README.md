# Modern Blue Collar

White-label field service management for small trades businesses: electrical, plumbing, HVAC,
plumbing & HVAC, and general contracting, in the US or Ireland. One installation per client, branded
entirely through `BRAND_*` environment variables.

What it does today: customers, jobs with scheduling and dispatch, technician assignment with
double-booking checks, a technician "Today" view for phones, job photos, a per-job activity history,
a trade-specific price book, line-item quotes and invoices with tax (US sales tax or Irish VAT), sequential
numbers, a printable view (print / save as PDF from the browser) and email to the customer, team roles,
password sign-in with reset by email, optional Google sign-in, API keys, CSV exports and a full "export
everything" zip, a customer import (generic CSV, Housecall Pro, Jobber), a Xero invoice export, QuickBooks
Online invoice push and payment sync, nightly encrypted backups with a tested restore, and optional Twilio SMS.
The one-page honest matrix (what works, what is built but not tried live, what is not built) is
[docs/FEATURES.md](docs/FEATURES.md).

## Status (2026-11-21)

This is the **sandbox revival** branch (`mbc/sandbox-revival`). It runs locally with no paid services and no
cloud accounts. It is **not deployed anywhere**:

- Every test suite passes (counts below, [Tests](#tests)). The UI walk has one step (6g, reverse charge on a US
  sales-tax demo) that now expects something the server refuses on purpose; it passes with
  `BRAND_REVERSE_CHARGE=true` until the walk is updated ([SECURITY_AUDIT §1.1](backend/SECURITY_AUDIT.md#11-ui-walk)).
  Security status, with what is enforced, partial and open: [backend/SECURITY_AUDIT.md](backend/SECURITY_AUDIT.md). The findings of the first
  independent verification (rate limit on sign-in, demo data per country with tax, technician data scope,
  published test secret, restore / sandbox safety) were fixed in fix round B4.
- **Account and data screens are in the app** (Frontend F3): the password-reset and accept-invite pages
  (`reset-password.html`, `accept-invite.html`, linked from the emails), "Forgot password?" on the sign-in page,
  Change password (menu under your name) and the forced "choose a new password" screen (`change-password.html`),
  Team-page deactivate / role / reset buttons, Settings → Data (customer import, export everything, Xero export,
  list exports), Settings → QuickBooks (connect, sync payments) with "Push to QuickBooks" on each invoice, and
  Pricebook → Import CSV. A team member added with "+ Invite Member" or "+ Add with password" can now get in.
- QuickBooks, Xero, Twilio, Google sign-in and real SMTP have **not been used against the real services**.
- The Docker / VPS hosting path has **not been run on a real server** yet ([DEPLOYMENT.md §10](DEPLOYMENT.md)).

---

## Quick start: sandbox (no Docker, no internet)

Needs **Node 20.19+, 22.12+ or 24+** and a local **PostgreSQL** with a role that can create databases.
The defaults expect role `mbc`, password `mbc_sandbox` on `localhost:5432`
(on a Mac: [docs/RUN-ON-MAC.md](docs/RUN-ON-MAC.md) has the exact commands).

```bash
cd backend
npm install
npm run sandbox
```

`npm run sandbox` copies `.env.sandbox.example` to `backend/.env.sandbox` on first run (mode 0600, and writes a
random `JWT_SECRET` into it), creates the database if it is missing, applies the migrations, seeds a demo company
(idempotent) and starts the server on **http://localhost:3101**, listening on `127.0.0.1` only.
`HOST=0.0.0.0 npm run sandbox` makes it reachable from other devices on your network (only on a network you
control: the demo login is shown on the login page). Override anything with real environment variables:

```bash
PORT=3150 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_other?schema=public npm run sandbox
```

A localhost `APP_URL` (the address in emailed links) follows `PORT` (here `http://localhost:3150`); an `APP_URL`
set in your shell, or a non-local one in the env file, is used as is.

`npm run sandbox:setup` does everything except start the server.

In the sandbox nothing leaves the machine: photos go to `backend/storage/`, emails (invites, reset links,
quotes, invoices) to `backend/outbox/` as `.eml` files, backups to `backend/backups/`, and Twilio, QuickBooks
and Google answer "disabled in sandbox" (HTTP 503).

### Demo logins

Password for all of them: `DEFAULT_PASSWORD` / `ADMIN_PASSWORD` in your env file (`demo1234` in the example).
The login page shows the admin login in demo mode.

| Email | Role | Sees |
|---|---|---|
| `admin@demo.test` | super-admin | everything, including managing admins |
| `office@demo.test` | admin | everything except managing admins and super-admins |
| `dispatch@demo.test` | dispatcher | customers, jobs, scheduling, SMS; quotes and invoices read-only; no deletes |
| `tech1@demo.test`, `tech2@demo.test`, `tech3@demo.test` | technician | the Today view and their own jobs and those customers (or every job and customer, read-only, with `TECH_VISIBILITY=all`); status, notes and photos |

For a prospect demo the team logins use the prospect's email domain instead of `demo.test`
(for example `office@prairieline.example`); `admin@demo.test` stays the same.

Ten failed sign-ins for one email from one address lock that email out from that address for 15 minutes
(successful sign-ins never count). Restarting the server clears it. Page loads and successful sign-ins do not
count towards the general per-address limit either, so a whole office behind one address can always sign in.

## Quick start: Docker (Postgres + MinIO + Mailpit)

```bash
cp .env.example .env
docker compose --profile demo up --build
```

App on http://localhost:3001 (same logins), Mailpit (caught emails) on http://localhost:8025, MinIO console
(uploaded photos and backups) on http://localhost:9001 with `minioadmin` / `minioadmin`. MinIO and Mailpit listen
on 127.0.0.1 only and Postgres is not published. Tear down and wipe with `docker compose --profile demo down -v`.
**Not run by the team** (no Docker daemon in the cloud sandbox); the Mac guide covers it. Client servers use
`docker-compose.prod.yml` and `deploy/provision.sh`: [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Tests

All database suites need `TEST_DATABASE_URL` pointing at a **throwaway** database whose name contains `test`.
They create and delete only their own tagged rows (some create scratch databases next to it), so they can share
one database, but never point them at data you want to keep.

```bash
cd backend
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_test?schema=public"
PGPASSWORD=mbc_sandbox createdb -h localhost -U mbc mbc_test      # npm test needs it to exist
npm test                    # Prisma-level suite (69)
npm run test:redteam        # security / abuse tests (48; RT-3 needs Chrome)
npm run test:backend        # API contract, CSP in a real browser (45; needs Chrome and pg_dump)
npm run test:activity       # job activity log (18)
npm run test:documents      # line items, tax, Decimal money, numbering, locking, email (22)
npm run test:integrations   # import, exports, Xero, QuickBooks against a local stub (21)
npm run test:accounts       # passwords, reset, leavers, login limiter, invites, multi-document jobs (25)
npm run test:whitelabel     # brand switching, demo seed, demo:check (48; creates <db>_wl, needs CREATEDB)
npm run test:platform       # storage, mail, backup + restore round trips, migration splitter (23)
```

`npm run test:ui` is a headless-Chrome walk of every page × role × viewport plus the main flows by clicking,
with screenshots; it needs a sandbox database, not `TEST_DATABASE_URL` ([SETUP.md §5](SETUP.md#5-tests)).
Results on 2026-11-21 and what each suite proves: [backend/SECURITY_AUDIT.md §1](backend/SECURITY_AUDIT.md).

---

## Demo for a prospect

Keep real prospect files **outside the repository** (it is public). Copy an example and edit it:

```bash
cd backend
node scripts/seed-demo.js --list
mkdir -p ~/mbc-prospects && cp demo/prospects/ks-plumbing-example.json ~/mbc-prospects/acme-plumbing.json
# edit slug, brand, emailDomain (must stay a reserved .example domain), towns, locale
node scripts/seed-demo.js --prospect ~/mbc-prospects/acme-plumbing.json --print-env --port 3102
ENV_FILE=.env.demo.acme-plumbing npm run sandbox                              # own DB, seeded, started
ENV_FILE=.env.demo.acme-plumbing npm run seed:demo -- --reset                 # fresh dates before each demo
ENV_FILE=.env.demo.acme-plumbing npm run demo:check -- --port 3102 --headless
```

`--print-env` writes `backend/.env.demo.<slug>` (gitignored, mode 0600) with the prospect's brand, its own
database `mbc_demo_<slug>`, a fresh random `JWT_SECRET` and the absolute path of the prospect file. The examples
in `backend/demo/prospects/` (a generic `default` that follows the instance's `BRAND_COUNTRY`: Anytown, KS in the
US, Fingal towns with Eircodes in Ireland; a fictional Kansas plumber; a fictional Irish heating firm in EUR with
VAT) can be used by slug. Seeded quotes and invoices have line items taxed at the brand's rate. All demo people,
emails and phone numbers are fictional (stored in E.164, like real ones). `demo:check` exits non-zero if a
prospect would see client names (denylist), "undefined", $0 amounts, wrong totals or currency, untaxed documents
on a taxed brand, addresses of another country, wrong-trade jobs or a stale calendar. **Run it before every demo.** Details:
[SETUP.md → Demo per prospect](SETUP.md#demo-per-prospect-seeddemo-democheck).

## White-label in 60 seconds

Set these in the env file the instance uses (`backend/.env.sandbox`, `backend/.env`, a `.env.demo.<slug>`
file, or the repo-root `.env` for Docker) and restart:

```ini
BRAND_COMPANY_NAME=Apex Plumbing LLC
BRAND_TRADE_TYPE=plumbing
BRAND_COLOR_PRIMARY="#1565c0"
BRAND_LOGO_URL=https://apex.example/logo.svg
BRAND_TIMEZONE=America/Chicago
BRAND_COUNTRY=US            # or IE: EUR, VAT, Eircodes, Irish phone numbers and job wording
```

No source file changes. A bad value (unknown trade, malformed colour, unknown time zone, bad tax rates or job
types) stops the server at boot with a message naming the variable. Labels, job types, colours, logo, currency,
tax and address rules follow the settings. Full list: [SETUP.md → White-label](SETUP.md#white-label).

| Trade | `BRAND_TRADE_TYPE` |
|-------|--------------------|
| Electrical | `electrical` |
| Plumbing | `plumbing` |
| HVAC | `hvac` |
| Plumbing & HVAC | `plumbing-hvac` |
| General Contracting | `contracting` |

Case-insensitive; `HVAC`, `Plumbing & HVAC`, `General Contracting` and `GC` are accepted. Each trade has its own
job types (US and Irish wording), technician label, colour palette and starter price book (`npm run seed:prices`).

## Data in and out

All admin-only; full detail in [SETUP.md §7](SETUP.md#7-import-export-and-accounting).

- **Exports:** CSV of customers, jobs, quotes, invoices (one row per document or per line), and
  `GET /api/exports/all`: a zip of every table plus the photos, a manifest and `SHA256SUMS` (the "leave with
  everything" export; password hashes and keys are never included). An API key needs the `export` (or `write`)
  scope for the zip; `read` is enough for the single CSV exports.
- **Customer import:** `POST /api/imports/customers` from a generic CSV, Housecall Pro or Jobber, dry run by
  default with a full report, merge-candidate review, batch commit and undo; also a command-line tool
  (`scripts/import-customers.js`). Jobs import is not built.
- **Price book import:** `POST /api/pricebook/import` from a CSV template, dry run by default.
- **Xero:** `GET /api/exports/xero-invoices` produces Xero's sales-invoice import CSV.
- **QuickBooks Online:** connect (OAuth), push an invoice (creates the customer and invoice), pull payments back
  (marks fully paid invoices paid). Tested against a local stub only.

---

## Documentation

| Document | For |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | One-page feature matrix for sales and marketing |
| [SETUP.md](SETUP.md) | Local setup in detail, environment variable reference, tests, white-label, demo tooling, import/export, troubleshooting |
| [docs/RUN-ON-MAC.md](docs/RUN-ON-MAC.md) | Running the sandbox on a Mac, phone testing, the migration drift check, prospect demos |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploying a client server (VPS, Caddy, backups, restore drill, first real-server test) |
| [backend/SECURITY_AUDIT.md](backend/SECURITY_AUDIT.md) | Security status with file and test references |
| [docs/legal/](docs/legal/README.md) | Draft privacy notice, terms of use and DPA templates (for counsel) |
| [LICENSE-PROPOSAL.md](LICENSE-PROPOSAL.md) | The licence decision for Paul |

## Tech stack

- Node.js / Express, vanilla HTML/JS/CSS pages in `backend/public/` under a strict Content-Security-Policy
  (no inline script or style)
- PostgreSQL 16 through Prisma 7 (Rust-free client with the `pg` driver adapter; hand-written SQL migrations
  applied by Prisma's schema engine compiled to WebAssembly, `npm run migrate:deploy`); money stored as `Decimal`
- Socket.io for "who is viewing this job"
- Storage: local disk or any S3-compatible store (MinIO in the Docker demo; Cloudflare R2 / Backblaze B2 planned
  for clients)
- Email: outbox folder, Mailpit, or any SMTP server
- Backups: `pg_dump` + photos, AES-256-GCM, S3-compatible upload, heartbeat; `npm run restore`
- Optional: Twilio SMS, Google sign-in (Passport), QuickBooks Online (plain `fetch`, no SDK)
- node-cron for the nightly backup and the optional QuickBooks payment sync

## License

MIT

The README and `backend/package.json` say MIT, which does not fit a commercial product. This is under review and
unchanged for now: see [LICENSE-PROPOSAL.md](LICENSE-PROPOSAL.md).
