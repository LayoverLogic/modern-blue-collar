# SETUP.md — Local setup and reference

How to run Modern Blue Collar locally, what every environment variable does, how the tests work, and how
white-labelling and prospect demos work. For a Mac, the short path is [docs/RUN-ON-MAC.md](docs/RUN-ON-MAC.md).
For deploying a client instance see [DEPLOYMENT.md](DEPLOYMENT.md) (owned by Platform).

Current state of the code, including what does not work yet: [README.md → Status](README.md#status-2026-11-21)
and [backend/SECURITY_AUDIT.md](backend/SECURITY_AUDIT.md).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.19+, 22.12+ or 24+ | Prisma 7 refuses older versions; `npm run sandbox` checks |
| PostgreSQL | 16 (15 in Docker Compose) | A role that can create databases. The examples use role `mbc`, password `mbc_sandbox` |
| `pg_dump` | same major as the server | Only for backups and the backup tests. Docker image includes it |
| Chrome / Chromium | any recent | Only for `test:ui`, the RT-3 red-team test and `demo:check --headless`. Set `CHROME_PATH` if not at `/usr/bin/google-chrome` |
| Docker + Compose | optional | Only for the Docker demo stack |

There is no SQLite mode any more: the app and its migrations are PostgreSQL only.

---

## 1. Sandbox (recommended)

```bash
cd backend
npm install          # also generates the Prisma client (scripts/prisma-generate.js); no binary download
npm run sandbox
```

What `npm run sandbox` does (`backend/scripts/sandbox.js`):

1. If `ENV_FILE` is not set: copies `.env.sandbox.example` to `backend/.env.sandbox` the first time, replaces a
   placeholder or published `JWT_SECRET` in it with a random one, and uses that file.
2. Creates the database named in `DATABASE_URL` if it does not exist.
3. Applies migrations (`npm run migrate:deploy`).
4. If `DEMO_MODE=true`: seeds the super-admin, the trade's price book, and the demo team, customers, jobs,
   quotes, invoices and activity for `DEMO_PROSPECT` (idempotent).
5. Starts `node server.js` (skip with `npm run sandbox:setup`).

Open http://localhost:3101 (`PORT` in the env file). Logins are in [README.md → Demo logins](README.md#demo-logins).

Real environment variables always win over the env file:

```bash
PORT=3150 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_other?schema=public npm run sandbox
```

### Which env file is read

`backend/helpers/loadEnv.js`, first match wins, and never overrides a variable already set in the process:

1. `ENV_FILE=<path>` (relative to `backend/`)
2. `backend/.env`
3. `backend/.env.sandbox`

`npm run sandbox` sets `ENV_FILE=.env.sandbox` itself, but **other commands** (`npm run dev`, `npm run seed:demo`,
`npm run demo:check`, `node seed_*.js`) pick `backend/.env` first if it exists. Pass `ENV_FILE=...` when in doubt.
All env files are gitignored.

## 2. Docker demo stack

```bash
cp .env.example .env               # repo root; already points at the bundled services
docker compose --profile demo up --build
```

| URL | What |
|---|---|
| http://localhost:3001 | The app |
| http://localhost:8025 | Mailpit: every outbound email |
| http://localhost:9001 | MinIO console (`minioadmin` / `minioadmin`): uploaded photos and backup bucket |

The entrypoint (`backend/docker-entrypoint.sh`) migrates and, with `DEMO_MODE=true`, seeds on every start
(idempotent). Postgres is not published; to reach it from the host for debugging add
`-f docker-compose.yml -f docker-compose.db-port.yml` (binds 127.0.0.1 only). `docker compose --profile demo down -v`
deletes all data. Without `--profile demo` only the app and Postgres start; production use is described in
[DEPLOYMENT.md](DEPLOYMENT.md).

## 3. Running without the sandbox script

```bash
cd backend
cp .env.example .env               # then edit: DATABASE_URL, JWT_SECRET, BRAND_*
npm install
npm run migrate:deploy
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='<a long password>' npm run seed:admin
npm run seed:prices                # starter price book for BRAND_TRADE_TYPE (never duplicates)
npm run dev                        # nodemon; or `npm start` (migrates, then starts)
```

If `ADMIN_PASSWORD` is unset, `seed:admin` generates one and prints it once. Do not run `seed:jobs` / `seed:demo`
for a real business: they create fictional data and refuse non-demo databases unless `DEMO_MODE=true`.

`npm run studio` (Prisma Studio) and `npm run migrate` (`prisma migrate dev`) run the Prisma CLI, which fetches its
native engine from `binaries.prisma.sh` when it starts. That works on a normal internet connection (for example a
Mac) and fails in locked-down environments such as the team's cloud sandbox, where even `npx prisma migrate diff --help` stops
with a checksum error.

## 4. Database migrations

- **Applying** migrations: `npm run migrate:deploy` (`scripts/migrate-deploy.mjs`). It runs Prisma's own schema
  engine compiled to WebAssembly, writes the same `_prisma_migrations` table as the stock CLI, and needs no
  download. `npm start`, `npm run sandbox` and the Docker entrypoint call it.
- **Creating** migrations needs the native engine: on a Mac use `npx prisma migrate dev --create-only` against a
  scratch database, then read and edit the SQL. Exact steps and the drift check:
  [docs/RUN-ON-MAC.md §1.4](docs/RUN-ON-MAC.md#14-creating-migrations-and-checking-drift).
- Rules for migration SQL, because `migrate:deploy` goes through the `pg` driver adapter, which splits each file on
  every `;` (PLAT-15): no PL/pgSQL functions or triggers, and no `;` inside comments or string literals.
- Every schema change is verified by applying it to an empty database and to a seeded one.

## 5. Tests

All database suites need `TEST_DATABASE_URL` set to a throwaway database on a server where the role can create
databases. They only touch rows tagged with their own run id, so they can share one database in any order.

| Command | What | Needs |
|---|---|---|
| `npm test` | Prisma-level suite (auth helpers, CRUD, locking, price book, role guards) | DB must exist; name must contain `test` (override `ALLOW_DESTRUCTIVE_TESTS=1`); refuses if equal to `DATABASE_URL` |
| `npm run test:redteam` | Security and abuse tests, one per Red Team finding | creates/migrates the DB if missing; RT-3 needs Chrome |
| `npm run test:backend` | API contract (Google gate, QuickBooks state, roles, CORS, errors…) | RT-30 needs `pg_dump` |
| `npm run test:activity` | Job activity log | |
| `npm run test:whitelabel` | Brand validation, per-trade seeds, demo guard, `--print-env`, denylist | creates `<db>_wl` (keep it with `WL_KEEP_DB=1`); CREATEDB |
| `npm run test:platform` | Storage, mail, integration and backup drivers | backup tests skip without `DATABASE_URL` |
| `npm run test:ui` | Headless-Chrome walk of every page × role × viewport, plus the main flows by clicking; screenshots + `results.json` | `DATABASE_URL` of a sandbox DB, Chrome; exits 0 unless `--strict` |

```bash
cd backend
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_test?schema=public"
PGPASSWORD=mbc_sandbox createdb -h localhost -U mbc mbc_test     # npm test needs it to exist
npm test && npm run test:redteam && npm run test:backend && npm run test:activity && npm run test:whitelabel
DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform
```

For `test:ui`: `DATABASE_URL=<sandbox db> PORT=3121 npm run sandbox:setup`, then
`DATABASE_URL=<same> UI_PORT=3121 UI_OUT_DIR=/tmp/mbc-ui npm run test:ui`. It starts and restarts its own server
because of the API rate limit. Header of `backend/tests/ui/walk.js` lists all options.

Expected results on 2026-11-21 (`808631f`): `npm test` 69/69, redteam 46/48 (RT-25 and RT-3 fail until the
Frontend rewrite merges), backend 21/21, activity 16/16, whitelabel 36/36, platform 12/12.

---

## 6. Environment variable reference

Authoritative sources: `backend/.env.sandbox.example` (sandbox), `backend/.env.example` (direct runs), repo-root
`.env.example` (Docker), and the code. Defaults below are the code's defaults when the variable is unset.

### App and network

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | (unset) | `production` turns on the boot checks: refuses a missing/weak/published `JWT_SECRET` and `DEMO_MODE=true`; cookies get `Secure` |
| `PORT` | `3001` | HTTP port (sandbox example: 3101). In Docker the container port is fixed at 3001 and `PORT` is the host port |
| `APP_URL` | (unset) | Public base URL; used in invite links and allowed as a CORS origin |
| `CORS_ORIGINS` | (unset) | Extra allowed browser origins, comma-separated. Unset + no `APP_URL` = same-origin only |
| `TRUST_PROXY` | (unset = none) | Behind a reverse proxy: `1` (one hop), a hop count, `loopback`, or proxy IPs/CIDRs. `true` is spoofable and warns |
| `APP_BIND` | `0.0.0.0` | Docker Compose only: host address the app port is published on (`127.0.0.1` behind a local proxy) |
| `ENV_FILE` | (unset) | Which env file to load (see §1) |

### Modes and seeding

| Variable | Default | Purpose |
|---|---|---|
| `SANDBOX_MODE` | (unset) | `true`: Twilio, QuickBooks and Google are inert (503, nothing sent) |
| `DEMO_MODE` | (unset) | `true`: seed demo data on boot (sandbox/Docker), show the demo login hint; Twilio and QuickBooks inert. Refused with `NODE_ENV=production` |
| `DEMO_PROSPECT` | `default` | Prospect file in `backend/demo/prospects/<slug>.json` used by the seeds |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_FIRST`, `ADMIN_LAST` | `admin@example.com`, random (printed once), `Super`, `Admin` | Super-admin created by `seed:admin`. Also the demo login hint and the `demo:check` login |
| `DEFAULT_PASSWORD` | (required by the demo seed) | Password for the seeded demo team |
| `SEED_DEMO_ALLOW_DB` | (unset) | Database name `seed:demo` may seed even without a demo token in its name (same as `--allow-db`) |
| `DEMO_DENYLIST_FILE` | `backend/demo/denylist.local.txt` | Client-name denylist for `demo:check` |
| `API_KEY_NAME` | `Default Integration Key` | Name for `npm run seed:apikey` |

### Database and backups

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | `postgresql://user:pass@host:5432/db?schema=public`. `?schema=` is stripped before `pg_dump` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | `mbc`, `mbc_demo_password`, `mbc`, `5432` | Docker Compose Postgres service only |
| `BACKUP_DRIVER` | `s3` if `WASABI_BUCKET` + keys are set, else `local` | `local`: keep dumps on disk. `s3` (alias `wasabi`): also upload to an S3-compatible bucket |
| `BACKUP_DIR` | `backend/backups/` | Where dumps are written |
| `BACKUP_KEEP` | `30` | Local dumps kept |
| `BACKUP_COOLDOWN_SECONDS` | `300` | Minimum gap between manual backup runs |
| `PG_DUMP_PATH` | `pg_dump` | Path to `pg_dump` if not on `PATH` |
| `WASABI_ENDPOINT`, `WASABI_REGION`, `WASABI_BUCKET`, `WASABI_ACCESS_KEY`, `WASABI_SECRET_KEY` | region `us-east-1` | S3-compatible backup target (MinIO in Docker). The names are historical; any S3-compatible store works. Platform may rename them (GTM-16); check DEPLOYMENT.md |

The nightly backup runs at 03:00 in `BRAND_TIMEZONE`. Dumps are gzipped, not encrypted, and do not include photos.

### Authentication

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | random per process outside production | Session signing key. Production: 32+ random characters, refused if published. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES` | `8h` | Session lifetime (`30m`, `1d`…). Invalid values stop the boot |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | (unset = Google off) | Google sign-in. Callback: `<APP_URL>/api/auth/google/callback` |
| `GOOGLE_ALLOWED_DOMAINS` | (unset = nobody) | Domains whose unknown Google users may be auto-created as technicians. Everyone else must be invited first |

### Storage (job photos)

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_DRIVER` | `s3` | `local` (sandbox) or `s3` |
| `LOCAL_STORAGE_DIR` | `backend/storage/` | Where `local` stores files |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | region `us-east-1`, bucket `mbc-uploads`; endpoint and keys fall back to `WASABI_*` | Any S3-compatible store |
| `S3_FORCE_PATH_STYLE` | `true` | Needed by MinIO |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_PORT`, `MINIO_CONSOLE_PORT` | `minioadmin`, `minioadmin`, `9000`, `9001` | Docker demo MinIO only |

### Email

| Variable | Default | Purpose |
|---|---|---|
| `MAIL_DRIVER` | `smtp` if `SMTP_HOST` is set, else `none` | `smtp`, `outbox` (write `.eml` + `.json` files, send nothing) or `none` |
| `MAIL_OUTBOX_DIR` | `backend/outbox/` | Where `outbox` writes |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | port `587` | SMTP server (Mailpit in Docker: `mailpit:1025`) |
| `SMTP_FROM` | `SMTP_USER`, else `no-reply@localhost` | From address |
| `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | `1025`, `8025` | Docker demo Mailpit only |

Email is used for team invitations only.

### Integrations

| Variable | Default | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | (unset = SMS off) | Outbound SMS. Inert in sandbox/demo; without them SMS is logged, not sent |
| `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI` | (unset = off) | QuickBooks Online OAuth. Callback: `<APP_URL>/api/quickbooks/callback`. Invoice sync is a stub |
| `QB_ENVIRONMENT` | `sandbox` | `sandbox` or `production` (Intuit) |
| `INTEGRATION_ENCRYPTION_KEY` | derived from `JWT_SECRET` | Key for encrypting stored QuickBooks tokens. Set it so rotating `JWT_SECRET` does not force a reconnect |
| `GMAIL_WEBHOOK_SECRET` | (unset = webhook 503) | 16+ characters; required by `POST /api/communications/gmail/webhook` (handler is a placeholder) |

Placeholder values (`placeholder`, `changeme`, `your_…`, `xxx`, empty) count as "not configured".

### Branding

All `BRAND_*` variables: see [White-label → Variables](#variables) below.

### Tests and tools

| Variable | Used by | Purpose |
|---|---|---|
| `TEST_DATABASE_URL` | all DB test suites | Throwaway test database (required) |
| `ALLOW_DESTRUCTIVE_TESTS` | `npm test` | `1` allows a DB name without `test` |
| `WL_KEEP_DB` | `test:whitelabel` | `1` keeps the derived `<db>_wl` database |
| `CHROME_PATH` | `test:ui`, redteam RT-3, `demo:check --headless`, `brand-shot.js` | Chrome binary |
| `UI_PORT`, `UI_BASE_URL`, `UI_OUT_DIR`, `UI_PASSWORD`, `UI_ADMIN_EMAIL`, `UI_TECH_EMAIL`, `UI_DISP_EMAIL`, `UI_SKIP_AUDIT`, `UI_SKIP_FLOW`, `UI_SKIP_PREVIEW` | `test:ui` | See the header of `backend/tests/ui/walk.js` |
| `DEMO_PASSWORD`, `BRAND_SHOT_TOKEN` | `demo:check`, `scripts/brand-shot.js` | Login fallback / pre-issued token for screenshots |
| `DEBUG` | `migrate:deploy` | Print full engine errors |

### In the example files but not read by the code

- `GOOGLE_MAPS_API_KEY`: no code uses it. Leave it empty.

### Planned, not in the code on this branch

- `TECH_VISIBILITY`: planned setting for what technicians can see. Not implemented; technicians currently see only
  their own jobs and those customers.
- Localisation (`BRAND_COUNTRY`, `BRAND_LOCALE`, `BRAND_CURRENCY`, tax settings): designed in the White-label
  Phase 1 report and in progress on the Backend branch. Names may change; not available until merged.

---

## White-label

The white-label promise: **a client or trade is configured with `BRAND_*`
environment variables only — no source edits.** `brand.config.js` (repo root) is a
thin wrapper over `backend/helpers/brandValidate.js`; you never edit either per client.

### Variables

| Variable | Default | Notes |
|---|---|---|
| `BRAND_TRADE_TYPE` | `electrical` | `electrical` \| `plumbing` \| `hvac` \| `plumbing-hvac` \| `contracting`. Case-insensitive; `Plumbing & HVAC`, `HVAC`, `General Contracting`, `GC` also accepted. **Anything else stops the server at boot** with a message naming the variable and the valid values. |
| `BRAND_COMPANY_NAME` / `_SLOGAN` / `_PHONE` / `_EMAIL` / `_ADDRESS` | Modern Blue Collar | Shown in the nav, page titles, login screen, emails. |
| `BRAND_TECH_LABEL`, `BRAND_INDUSTRY_LABEL` | from the trade | e.g. `Engineer` for an Irish heating firm. The industry label is what the pricebook is filtered by. |
| `BRAND_COLOR_PRIMARY`, `_SECONDARY`, `_ACCENT`, `_NAV_BG`, `_NAV_TEXT`, `_HEADER_BG`, `_HEADER_TEXT` | the trade's palette | Hex (`#rgb`/`#rrggbb`), quoted in `.env`. Invalid values stop the boot. |
| `BRAND_COLOR_PRIMARY_DARK` | derived | Hover/active shade, 18% darker than primary unless set. |
| `BRAND_LOGO_URL`, `BRAND_FAVICON_URL` | none | `https://` URL, same-origin path (`/brand/logo.svg`) or `data:image/...;base64`. Favicon defaults to the logo. Validated at boot, but **`/api/brand` does not return them yet** (the response is a fixed list in `server.js`), so no page shows a logo on this commit (WL-7; `demo:check` warns). |
| `BRAND_DEFAULT_STATE` | `KS` | Default for US address forms. |
| `BRAND_TIMEZONE` | `America/Chicago` | IANA zone; used for "today", demo dates, backups. Invalid zones stop the boot. |

Trade palettes when no colour is set: electrical yellow `#f5a623`, plumbing blue `#1e6fd9`,
hvac teal `#0d9488`, plumbing-hvac blue `#2563eb`, contracting orange `#ea580c`.

| `BRAND_TRADE_TYPE` | Technician label | Industry label | Job types |
|---|---|---|---|
| `electrical` | Electrician | Electrical | Panel Upgrade, Outlet / Switch, Lighting, EV Charger, Generator, Inspection, Troubleshooting, Other |
| `plumbing` | Plumber | Plumbing | Leak Repair, Drain Cleaning, Water Heater, Fixture Install, Sewer Line, Inspection, Troubleshooting, Other |
| `hvac` | HVAC Technician | HVAC | AC Install, Furnace Install, AC Repair, Furnace Repair, Duct Work, Tune-Up, Inspection, Other |
| `plumbing-hvac` | Technician | Plumbing & HVAC | the plumbing and HVAC lists combined |
| `contracting` | Contractor | General Contracting | Framing, Drywall, Flooring, Roofing, Painting, Demo, General Repair, Other |

### New client

1. Copy `backend/.env.example` to `backend/.env` and set the `BRAND_*` block.
2. `npm run seed:prices` — starter pricebook for **that** trade (electrical gets
   electrical items; `plumbing-hvac` gets both), stamped with the industry label.
   Prices are 2026 US ballparks; the client edits them on the Pricebook page.
3. Do **not** run `seed_jobs.js` / `seed:demo` for a real client — they create fictional
   customers and are refused outside demo databases / `DEMO_MODE=true`.

### Demo per prospect (`seed:demo`, `demo:check`)

Demo data comes from `backend/demo/`:

```
demo/prospects/<slug>.json        default (generic "Anytown", US), ks-plumbing-example, ie-heating-example
demo/fixtures/trades/<trade>.json pricebook, inventory and job templates per trade (+ Irish variants)
demo/fixtures/locales/US.json, IE.json   names, streets, phone / postcode formats, invoice terms
```

```bash
cd backend
node scripts/seed-demo.js --list                                  # available prospects
node scripts/seed-demo.js --prospect ks-plumbing-example --print-env --port 3102  # → .env.demo.ks-plumbing-example (gitignored)
ENV_FILE=.env.demo.ks-plumbing-example npm run sandbox             # own DB mbc_demo_<slug>, seeded, started
ENV_FILE=.env.demo.ks-plumbing-example npm run seed:demo -- --reset   # fresh dates before every demo
ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3102 --headless
```

Notes on the generated file:

- Without `--port` it keeps the example's `PORT=3101`, the same as the main sandbox. Give each prospect its own port.
- It keeps `JWT_SECRET=__GENERATE_ON_FIRST_RUN__`, and `npm run sandbox` does **not** replace it when `ENV_FILE` is
  set. Replace it with a random value before starting (see [docs/RUN-ON-MAC.md §3](docs/RUN-ON-MAC.md#3-a-branded-demo-for-a-prospect)).
- Its `DATABASE_URL` assumes role `mbc` / `mbc_sandbox` on `localhost:5432`.

What the seed guarantees: job types from the trade's list; pricebook items for the trade;
quote/invoice amounts are the sum of real pricebook lines (> 0); dates relative to
**today in `BRAND_TIMEZONE`** (finished work with paid / unpaid / overdue invoices, three
jobs today, the next days booked, two pending quotes); fictional people only — reserved
domains (`demo.test`, `*.example`, `example.com`), US `555-01xx` numbers, Irish
ComReg drama ranges (`020 91x xxxx`, `089 011 0xxx`); deterministic for a given day.
Team logins: `office@`, `dispatch@`, `tech1@`–`tech3@` + the prospect's `emailDomain`
(default `demo.test`), password `DEFAULT_PASSWORD` (required, no fallback).
The super-admin stays `ADMIN_EMAIL` (`admin@demo.test`).

Safety: `seed:demo` refuses a database whose name lacks `demo`, `sandbox`, `test` or `wl`
(override: `--allow-db <name>`, e.g. Docker's `mbc`) and refuses `NODE_ENV=production`.

`demo:check` prints PASS / WARN / FAIL per check and exits 1 on any FAIL:
client names (denylist), `undefined`/`NaN` text, job types and trade, amounts > 0,
another trade's pricebook items, duplicate items, real email domains, stale calendar, activity trails;
with `--port`, `/api/brand` and every list endpoint; with `--headless`, the main pages in
Chrome (JS errors, "undefined" on screen, client names). On this commit it WARNs that `/api/brand` has no
`logoUrl` / `faviconUrl` (WL-7) and, without a denylist file, that client names were not checked.

**Denylist:** the real list of client names lives in `backend/demo/denylist.local.txt`
(**gitignored** — this repository is public, so client names must not be committed) or in
any file named by `DEMO_DENYLIST_FILE`. `backend/demo/denylist.example.txt` shows the format.

### Switching trade on an existing database

Environment-only for everything the server computes (labels, job types, colours, the
pricebook filter). The **data** does not move with it: jobs keep their old `tradeType`
and type, and the pricebook keeps the old industry's items (hidden by the filter).

- Demo / sandbox DB: `npm run seed:demo -- --reset` (refuses to mix trades without it;
  `seed_jobs.js` prints a warning and skips so boot is never blocked).
- Real client changing trade (rare): run `npm run seed:prices` to add the new trade's
  starter items; existing jobs and items stay as they were.

---

## Project structure

```
modern-blue-collar/
├── brand.config.js            White-label config: reads BRAND_* (no per-client edits)
├── .env.example               Docker Compose env template
├── docker-compose.yml         App + Postgres; MinIO + Mailpit under --profile demo
├── docker-compose.db-port.yml Optional: publish Postgres on 127.0.0.1 for debugging
├── Dockerfile
├── README.md · SETUP.md · DEPLOYMENT.md · LICENSE-PROPOSAL.md
├── docs/
│   ├── RUN-ON-MAC.md
│   └── legal/                 Draft privacy notice, terms of use, DPA (for counsel)
└── backend/
    ├── server.js              Express app, Socket.io presence, security headers, nightly backup cron
    ├── SECURITY_AUDIT.md
    ├── .env.example · .env.sandbox.example
    ├── prisma/schema.prisma · prisma/migrations/   Hand-written SQL migrations
    ├── prisma.config.js
    ├── routes/                activity, apiKeys, auth, backup, communications, customers, exports,
    │                          googleAuth, invites, invoices, jobs, pricebook, quickbooks, quotes, sms, users
    ├── helpers/               access, activity, brandValidate, errorHandler, integrations, mailer,
    │                          optimisticUpdate, prisma, roles, secretBox, security, storage, validate, …
    ├── middleware/apiKeyAuth.js
    ├── public/                Pages: index (login + dashboard), customers, customer-detail, dispatch, job,
    │                          schedule, team, pricebook, quote-invoice, communications, api-keys
    ├── demo/                  Prospects, trade and locale fixtures, seed and check libraries
    ├── scripts/               sandbox, migrate-deploy, prisma-generate, seed-demo, demo-check, brand-shot
    ├── tests/                 api, redteam, backend, activity, whitelabel, platform; ui/walk.js
    ├── seed_superadmin.js · seed_pricebook.js · seed_jobs.js · seed_apikey.js
    └── backup.js · docker-entrypoint.sh
```

---

## Troubleshooting

**`[sandbox] ERROR: Cannot connect to PostgreSQL`** — Postgres is not running, or the role/password in
`DATABASE_URL` does not exist. Create the role (`CREATE ROLE mbc LOGIN PASSWORD 'mbc_sandbox' CREATEDB;`).

**`Could not create database …`** — the role lacks `CREATEDB`. Grant it or create the database yourself.

**`Node … is too old for Prisma 7`** — use Node 20.19+, 22.12+ or 24+.

**`[CONFIG] FATAL: …`** — the boot checks refused the configuration (production `JWT_SECRET`, `DEMO_MODE` in
production, or an invalid `BRAND_*` value). The message names the variable.

**`Failed to fetch sha256 checksum at https://binaries.prisma.sh/…`** — a Prisma CLI command that needs the native
engine (`migrate dev`, `migrate diff`, `studio`) cannot download it. Use `npm run migrate:deploy` to apply
migrations; create migrations on a machine with internet access.

**Login page does nothing / "missing ) after argument list" in the browser console** — RT-25, five pages do not
parse on this commit. Use the API (`curl -X POST localhost:3101/api/auth/login -H 'Content-Type: application/json'
-d '{"email":"admin@demo.test","password":"demo1234"}'`) or wait for the Frontend merge.

**429 "Too many requests"** — the per-IP limit (200 API requests / 15 min, 20 logins / 15 min). Restart the server
to reset it in development.

**Port already in use** — change `PORT` in your env file or pass `PORT=…`.

**`seed:demo` REFUSED** — the database name has no `demo`/`sandbox`/`test`/`wl` token, or the database holds jobs
of another trade (`--reset`), or `NODE_ENV=production`.
