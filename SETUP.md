# SETUP.md — Local setup and reference

How to run Modern Blue Collar locally, what every environment variable does, how the tests work, how
white-labelling, prospect demos and import / export work. For a Mac, the short path is
[docs/RUN-ON-MAC.md](docs/RUN-ON-MAC.md). For a client server see [DEPLOYMENT.md](DEPLOYMENT.md).

Current state of the code, including what has no screen yet: [README.md → Status](README.md#status-2026-11-21-6d63a31),
[docs/FEATURES.md](docs/FEATURES.md) and [backend/SECURITY_AUDIT.md](backend/SECURITY_AUDIT.md).
Written against `mbc/sandbox-revival` at `6d63a31`.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.19+, 22.12+ or 24+ | Prisma 7 refuses older versions; `npm run sandbox` checks |
| PostgreSQL | 16 | A role that can create databases. The examples use role `mbc`, password `mbc_sandbox`. The Docker **demo** compose runs 15; the production compose runs 16 |
| `pg_dump`, `psql`, `tar` | same major as the server | Backups need `pg_dump`; `npm run restore` needs `psql` and `tar`; so do the backup/restore tests. The Docker image includes them |
| Chrome / Chromium | any recent | `test:ui`, the RT-3 red-team test, the CSP browser test in `test:backend`, `demo:check --headless`. Set `CHROME_PATH` if not at `/usr/bin/google-chrome` |
| Docker + Compose | optional | Only for the Docker demo stack and client servers |

There is no SQLite mode: the app and its migrations are PostgreSQL only.

---

## 1. Sandbox (recommended)

```bash
cd backend
npm install          # also generates the Prisma client (scripts/prisma-generate.js); no binary download
npm run sandbox
```

What `npm run sandbox` does (`backend/scripts/sandbox.js`):

1. Uses `ENV_FILE` if set, else `backend/.env.sandbox` (copied from `.env.sandbox.example` the first time). In
   whichever file it uses, an empty, placeholder or published `JWT_SECRET` is replaced by a random one (so
   sessions survive restarts). A known secret set in your shell is refused.
2. Creates the database named in `DATABASE_URL` if it does not exist.
3. Applies migrations (`npm run migrate:deploy`).
4. If `DEMO_MODE=true`: seeds the super-admin, the trade's price book, and the demo team, customers, jobs,
   quotes, invoices and activity for `DEMO_PROSPECT` (idempotent).
5. Starts `node server.js` on `HOST` (default **`127.0.0.1`**) and `PORT` (skip with `npm run sandbox:setup`).

Open http://localhost:3101 (`PORT` in the env file). Logins are in [README.md → Demo logins](README.md#demo-logins).
To reach it from a phone or another computer, start it with `HOST=0.0.0.0` and only on a network you control
(the demo login is printed on the login page); see [RUN-ON-MAC §1.5](docs/RUN-ON-MAC.md#15-try-it-on-your-phone).

Real environment variables always win over the env file:

```bash
PORT=3150 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_other?schema=public npm run sandbox
```

### Which env file is read

`backend/helpers/loadEnv.js`, first match wins, and never overrides a variable already set in the process:

1. `ENV_FILE=<path>` (relative to `backend/`)
2. `backend/.env`
3. `backend/.env.sandbox`

`npm run sandbox` sets `ENV_FILE=.env.sandbox` itself when you give none, but **other commands** (`npm run dev`,
`npm run seed:demo`, `npm run demo:check`, `npm run backup:run`, `npm run restore`, `node seed_*.js`) pick
`backend/.env` first if it exists. Pass `ENV_FILE=...` when in doubt. All env files are gitignored.

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
deletes all data. Leave `HOST` unset in Docker. **The team has not run this path** (no Docker daemon in the cloud
sandbox). Client servers use `docker-compose.prod.yml` (app + Postgres 16 + Caddy), see [DEPLOYMENT.md](DEPLOYMENT.md).

## 3. Running without the sandbox script

```bash
cd backend
cp .env.example .env               # then edit: DATABASE_URL, JWT_SECRET, BRAND_*, MAIL_DRIVER / SMTP_*
npm install
npm run migrate:deploy
ADMIN_EMAIL=you@example.com npm run seed:admin   # prints a generated temporary password once
npm run seed:prices                # starter price book for BRAND_TRADE_TYPE (never duplicates)
npm run dev                        # nodemon; or `npm start` (migrates, then starts)
```

With `ADMIN_PASSWORD` unset, `seed:admin` generates a password, prints it once and flags the account
`mustChangePassword`: until it is changed, every API call except `GET /api/users/me`, `GET /api/auth/me`,
`PATCH /api/users/me/password` and logout answers 403 `PASSWORD_CHANGE_REQUIRED`. An explicit `ADMIN_PASSWORD` is
not temporary unless `ADMIN_FORCE_PASSWORD_CHANGE=true`.

**No screen for changing a password exists on this commit**, so change it with the API:

```bash
TOKEN=$(curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"<printed password>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -X PATCH localhost:3001/api/users/me/password -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"currentPassword":"<printed password>","newPassword":"<at least 10 characters>"}'
```

The same applies to team members created by `POST /api/users` (the Team page's "+ Add with password"): they must change the
temporary password first. To create a user who can sign in straight away, send `"mustChangePassword": false`.

Do not run `seed:jobs` / `seed:demo` for a real business: they create fictional data and refuse non-demo
databases.

`npm run studio` (Prisma Studio) and `npm run migrate` (`prisma migrate dev`) run the Prisma CLI, which fetches its
native engine from `binaries.prisma.sh` when it starts. That works on a normal internet connection (for example a
Mac) and fails in locked-down environments such as the team's cloud sandbox.

## 4. Database migrations

- **Applying** migrations: `npm run migrate:deploy` (`scripts/migrate-deploy.mjs`). It runs Prisma's own schema
  engine compiled to WebAssembly, writes the same `_prisma_migrations` table as the stock CLI, and needs no
  download. `npm start`, `npm run sandbox`, the Docker entrypoint and `deploy/update.sh` call it.
- The statement splitter respects quotes, dollar-quoting (`$$ … $$`, `$tag$`) and comments (PLAT-15 fixed), so
  SQL functions and PL/pgSQL bodies are allowed.
- **Creating** migrations needs the native engine: on a Mac use `npx prisma migrate dev --create-only` against a
  scratch database, then read and edit the SQL. All seven migrations so far were written by hand; the drift check
  and the generated lines you must delete are in
  [docs/RUN-ON-MAC.md §2](docs/RUN-ON-MAC.md#2-migrations-drift-check-and-new-migrations).
- Every schema change is verified by applying it to an empty database and to a seeded one.

## 5. Tests

Database suites need `TEST_DATABASE_URL` set to a throwaway database **whose name contains `test`**, on a server
where the role can create databases. They only touch rows tagged with their own run id (some create and drop
scratch databases next to it), so they can share one database in any order.

| Command | What | Count | Needs |
|---|---|---|---|
| `npm test` | Prisma-level suite (auth helpers, CRUD, locking, price book, role guards) | 69 | DB must exist; refuses if equal to `DATABASE_URL` (`ALLOW_DESTRUCTIVE_TESTS=1` allows a name without `test`) |
| `npm run test:redteam` | Security and abuse tests, one per Red Team finding | 48 | RT-3 needs Chrome |
| `npm run test:backend` | API contract (Google gate, QuickBooks state, roles, CORS, CSP in a real browser, TECH_VISIBILITY, phones, sockets, secrets, sandbox binding) | 36 | Chrome; RT-30 needs `pg_dump` |
| `npm run test:activity` | Job and document activity log | 18 | |
| `npm run test:documents` | Line items, tax, Decimal totals, numbering, locking, email, addresses, migration on old data | 21 | creates/drops `<db>_mig_<run>` |
| `npm run test:integrations` | Customer import, exports, export-everything, Xero, QuickBooks (local stub) | 19 | |
| `npm run test:accounts` | Password change / reset / forgot, temporary passwords, leavers, login limiter, invites, several documents per job, customer company, price book import, due dates | 25 | |
| `npm run test:whitelabel` | Brand validation, per-trade/country seeds, demo guard, `--print-env`, denylist, job types, demo:check | 43 | creates `<db>_wl` (keep with `WL_KEEP_DB=1`) |
| `npm run test:platform` | Storage, mail, integration kill-switches, backup + restore round trips (plain, encrypted, photos, S3 stub, heartbeat), migration splitter | 22 | backup tests need `pg_dump`, restore tests `psql` + `tar`; skipped without them |
| `npm run test:ui` | Headless-Chrome walk: every page × role × viewport, main flows by clicking, XSS payloads, final screenshots | – | a **sandbox** database (not `TEST_DATABASE_URL`), Chrome; exits 1 on any failure (`UI_REPORT_ONLY=1` for inspection) |

```bash
cd backend
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_test?schema=public"
PGPASSWORD=mbc_sandbox createdb -h localhost -U mbc mbc_test     # npm test needs it to exist
for s in test test:redteam test:backend test:activity test:documents test:integrations test:accounts test:whitelabel test:platform; do
  npm run $s || break
done
```

For `test:ui`: `DATABASE_URL=<sandbox db> PORT=3121 npm run sandbox:setup`, then
`DATABASE_URL=<same> UI_PORT=3121 UI_OUT_DIR=/tmp/mbc-ui npm run test:ui`. It starts and restarts its own server.
The header of `backend/tests/ui/walk.js` lists all options.

Results on 2026-11-21 (`6d63a31`): every suite above passes in full. `test:ui`: 78/78 page captures clean, XSS all
pass, main flow 25/26 — step 7 (invite) fails because the walk still expects a Google sign-in link while invites
now link to the not-yet-built `accept-invite.html` (Frontend).

---

## 6. Environment variable reference

Authoritative sources: `backend/.env.sandbox.example` (sandbox), `backend/.env.example` (direct runs), repo-root
`.env.example` (Docker), `deploy/clients/example.env.example` (client servers), and the code. Defaults below are
the code's defaults when the variable is unset **or empty** (except where noted). Placeholder values
(`placeholder`, `changeme`, `your_…`, `xxx`, empty) count as "not configured" for integrations.

### App and network

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | (unset) | `production` turns on the boot checks (refuses a missing/weak/published `JWT_SECRET` and `DEMO_MODE=true`); cookies get `Secure` |
| `PORT` | `3001` | HTTP port (sandbox example: 3101). In Docker the container port is fixed at 3001 and `PORT` is the host port |
| `HOST` | all interfaces; **`127.0.0.1` under `npm run sandbox`** | Interface to listen on. `0.0.0.0` to reach a sandbox from other devices. Leave unset in Docker |
| `APP_URL` | (unset) | Public base URL: invite, reset and accept-invite links, allowed CORS origin |
| `CORS_ORIGINS` | (unset) | Extra allowed browser origins, comma-separated. Unset + no `APP_URL` = same-origin only |
| `TRUST_PROXY` | (unset = none) | Behind a reverse proxy: `1` (one hop), a hop count, `loopback`, or proxy IPs/CIDRs. `true` is spoofable and warns. provision.sh sets `1` |
| `APP_BIND` | `0.0.0.0` | Docker demo compose only: host address the app port is published on |
| `ENV_FILE` | (unset) | Which env file to load (§1) |

### Modes and seeding

| Variable | Default | Purpose |
|---|---|---|
| `SANDBOX_MODE` | (unset) | `true`: Twilio, QuickBooks and Google are inert (503, nothing sent); a published `JWT_SECRET` outside production is replaced by a per-process one instead of stopping the boot |
| `DEMO_MODE` | (unset) | `true`: seed demo data on boot (sandbox/Docker), show the demo login on the login page; Twilio and QuickBooks inert. Refused with `NODE_ENV=production` |
| `DEMO_PROSPECT` | `default` | Prospect used by the seeds: a slug in `backend/demo/prospects/` or an **absolute path** to a `.json` outside the repo |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_FIRST`, `ADMIN_LAST` | `admin@example.com`, generated (printed once, temporary), `Super`, `Admin` | Super-admin created by `seed:admin`. Also the demo login hint and the `demo:check` login |
| `ADMIN_FORCE_PASSWORD_CHANGE` | `false` | `true`: an explicit `ADMIN_PASSWORD` is also temporary (must be changed at first sign-in) |
| `DEFAULT_PASSWORD` | (required by the demo seed) | Password for the seeded demo team |
| `SEED_DEMO_ALLOW_DB` | (unset) | Database name `seed:demo` may seed without a demo token in its name (same as `--allow-db`) |
| `DEMO_DENYLIST_FILE` | `backend/demo/denylist.local.txt` | Client-name denylist for `demo:check` |
| `API_KEY_NAME` | `Default Integration Key` | Name for `npm run seed:apikey` |

### Accounts, sign-in and rate limits

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | random per process outside production | Session signing key. Production: 32+ random characters, refused if published. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_EXPIRES` | `8h` | Session lifetime (`30m`, `1d`…). Invalid values stop the boot |
| `PASSWORD_MIN_LENGTH` | `10` (never below 8) | Minimum length for every password that is set (max 72 bytes) |
| `RESET_TOKEN_TTL_MINUTES` | `30` | Forgot-password and admin reset links |
| `INVITE_TTL_HOURS` | `168` (7 days) | Accept-invite links |
| `LOGIN_MAX_PER_EMAIL` | `10` | **Failed** sign-ins per IP + email per 15 min (also wrong current passwords on change password, per user) |
| `LOGIN_MAX_PER_IP` | `50` | Failed sign-ins (and failed Google code exchanges) per IP per 15 min |
| `RESET_RATE_MAX` | `20` | Forgot / reset / invite-link requests per IP per 15 min |
| `RATE_LIMIT_USER_MAX` | `1000` | Other API requests per signed-in user or API key per 15 min |
| `RATE_LIMIT_IP_MAX` | `300` | Anonymous API requests per IP per 15 min |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | (unset = Google off) | Google sign-in. Callback: `<APP_URL>/api/auth/google/callback`. The button shows only when all three are real and `SANDBOX_MODE` is not true |
| `GOOGLE_ALLOWED_DOMAINS` | (unset = nobody) | Domains whose unknown Google users may be auto-created as technicians. Everyone else must be invited first |

All limiter counters are in memory and reset when the server restarts.

### Technicians

| Variable | Default | Purpose |
|---|---|---|
| `TECH_VISIBILITY` | `own` | `own`: technicians see only their own jobs and those customers. `all`: they may read every job and customer (not other jobs' quotes, invoices or communications); they still change only their own jobs. Unknown values → `own` with a warning |

### Database, backups and restore

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | `postgresql://user:pass@host:5432/db?schema=public`. `?schema=` is stripped before `pg_dump` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | `mbc`, `mbc_demo_password`, `mbc`, `5432` | Docker Compose Postgres service only (provision.sh generates the password) |
| `BACKUP_DRIVER` | `s3` if a bucket + keys are set, else `local` | `local`: keep sets on disk. `s3` (alias `wasabi`): also upload; a failed upload fails the backup |
| `BACKUP_DIR` | `backend/backups/` | Where backup sets are written (`/data/backups` in production) |
| `BACKUP_KEEP` | `30` | Local sets kept |
| `BACKUP_KEEP_UPLOADS` | `3` | Of those, how many keep their (large) photo archive |
| `BACKUP_ENCRYPTION_KEY` | (unset = not encrypted) | AES-256-GCM encryption of the dump and photo archive. Keep a copy off the server; without it backups cannot be restored. provision.sh generates it |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | region `us-east-1` | S3-compatible backup bucket (R2: region `auto`). Legacy `WASABI_*` names are read as a per-variable fallback |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix in the bucket |
| `BACKUP_S3_FORCE_PATH_STYLE` | `true` | |
| `BACKUP_S3_MULTIPART_MB` | `100` | Files above this size use multipart upload |
| `BACKUP_HEARTBEAT_URL` | (unset) | GET after each successful backup (e.g. a Healthchecks.io ping URL) |
| `BACKUP_HEARTBEAT_FAIL_URL` | `<URL>/fail` for hc-ping.com URLs | POSTed the error when a backup fails |
| `BACKUP_COOLDOWN_SECONDS` | `300` | Minimum gap between manual backup runs through the API |
| `PG_DUMP_PATH`, `PSQL_PATH`, `TAR_PATH` | found on `PATH` | Binaries for backup and `npm run restore` |

The nightly backup runs at 03:00 in `BRAND_TIMEZONE`. `npm run backup:run` runs one now; `npm run restore -- --list`
lists sets, `npm run restore -- latest --database <scratch db>` restores one (header of `scripts/restore.mjs`;
restore drill and disaster recovery: [DEPLOYMENT.md §5](DEPLOYMENT.md)). Photos are in the set only with
`STORAGE_DRIVER=local`.

### Storage (job photos)

| Variable | Default | Purpose |
|---|---|---|
| `STORAGE_DRIVER` | `s3` | `local` (sandbox, and the default client setup) or `s3` |
| `LOCAL_STORAGE_DIR` | `backend/storage/` | Where `local` stores files (`/data/uploads` in production) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | region `us-east-1`, bucket `mbc-uploads`; endpoint, bucket and keys fall back to `WASABI_*` | A **photo** bucket, separate from the backup bucket |
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

Email is used for team invites, password-reset links (forgot password and admin "send link"), and quotes / invoices
sent to customers. With `MAIL_DRIVER=none` (or a failing SMTP server) invites and admin "send reset link" return
the link for the admin to copy, forgot-password sends nothing (the answer is the same either way), and document
email answers 503 `EMAIL_DISABLED` (502 `EMAIL_FAILED` when SMTP fails).

### Integrations

| Variable | Default | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | (unset = SMS off) | Outbound SMS. Inert in sandbox/demo; without them SMS is logged, not sent. The texts have no STOP line yet (DOC-5) |
| `QB_CLIENT_ID`, `QB_CLIENT_SECRET`, `QB_REDIRECT_URI` | (unset = off) | QuickBooks Online OAuth app. Callback: `<APP_URL>/api/quickbooks/callback` |
| `QB_ENVIRONMENT` | `sandbox` | `sandbox` or `production` (Intuit) |
| `QBO_ITEM_ID` | `1` | QuickBooks Item every invoice line is booked to |
| `QBO_TAX_CODES` | (unset) | Non-US companies: MBC tax key → QBO TaxCode id, e.g. `standard=12\|none=15\|reverse_charge=16`. An unmapped key refuses the push (409) |
| `QBO_US_TAX_CODE` | (unset) | US companies: TaxCode id used on taxed invoices |
| `QBO_CUSTOMER_MATCH` | `create` | `create` (never adopt an existing QBO customer by name) or `displayName` |
| `QBO_PAYMENT_SYNC_CRON` | (unset = off) | node-cron expression for the automatic payment sync-back |
| `QBO_TIMEOUT_MS` | `15000` | Request timeout |
| `QBO_MINOR_VERSION` | `75` | QuickBooks API minor version |
| `QBO_AUTHORIZE_URL`, `QBO_TOKEN_URL`, `QBO_API_BASE` | Intuit's | Test stubs only; must be `https` in production |
| `INTEGRATION_ENCRYPTION_KEY` | derived from `JWT_SECRET` | Key for the stored QuickBooks tokens. Set it so rotating `JWT_SECRET` does not force a reconnect |
| `XERO_SALES_ACCOUNT_CODE` | `200` | Account code on every Xero line |
| `XERO_TAX_TYPES` | placeholder names | MBC tax key → Xero tax-rate name, e.g. `standard=23% (VAT on Income)\|zero=Zero Rated`, plus `none` and `reverse_charge`. Unmapped keys are flagged in `X-MBC-Xero-Unmapped-Tax` |
| `XERO_DEFAULT_DUE_DAYS` | `30` | Due date when an invoice has none |
| `XERO_BRANDING_THEME` | (blank = organisation default) | Xero branding theme column |
| `IMPORT_MAX_BYTES` | `20971520` (20 MB) | Maximum customer-import upload |
| `GMAIL_WEBHOOK_SECRET` | (unset = webhook 503) | 16+ characters; required by `POST /api/communications/gmail/webhook` (handler is a placeholder) |

### Branding and locale

All `BRAND_*` variables: see [White-label → Variables](#variables) below.

### Deployment only (`deploy/clients/<slug>.env`, read by `deploy/provision.sh`)

`CLIENT_SLUG`, `APP_DOMAIN`, `ACME_EMAIL`, `MBC_DATA_DIR` (default `/opt/mbc/data`); provision.sh writes
`COMPOSE_FILE`, `COMPOSE_PROJECT_NAME` and forces `NODE_ENV`, `DEMO_MODE`, `SANDBOX_MODE`, `PORT`, `TRUST_PROXY`,
`APP_URL`. See [DEPLOYMENT.md §3](DEPLOYMENT.md).

### Tests and tools

| Variable | Used by | Purpose |
|---|---|---|
| `TEST_DATABASE_URL` | all DB test suites | Throwaway test database (required; name must contain `test`) |
| `ALLOW_DESTRUCTIVE_TESTS` | `npm test` | `1` allows a DB name without `test` |
| `WL_KEEP_DB` | `test:whitelabel` | `1` keeps the derived `<db>_wl` database |
| `CHROME_PATH` | `test:ui`, redteam RT-3, `test:backend` CSP test, `demo:check --headless`, `brand-shot.js` | Chrome binary |
| `UI_PORT`, `UI_BASE_URL`, `UI_OUT_DIR`, `UI_FINAL_DIR`, `UI_PASSWORD`, `UI_ADMIN_EMAIL`, `UI_TECH_EMAIL`, `UI_DISP_EMAIL`, `UI_ROLES`, `UI_VIEWPORTS`, `UI_PAGES`, `UI_SKIP_AUDIT`, `UI_SKIP_FLOW`, `UI_SKIP_XSS`, `UI_SKIP_FINAL`, `UI_REPORT_ONLY`, `UI_KEEP_DATA`, … | `test:ui` | See the header of `backend/tests/ui/walk.js` |
| `DEMO_PASSWORD`, `BRAND_SHOT_TOKEN` | `demo:check`, `scripts/brand-shot.js` | Login fallback / pre-issued token for screenshots |
| `DEBUG` | `migrate:deploy` | Print full engine errors |

`GOOGLE_MAPS_API_KEY` is not read by any code. It was removed from the repo-root `.env.example` and the client
template; `backend/.env.example` and `backend/.env.sandbox.example` still list it (harmless; leave it empty).

---

## 7. Import, export and accounting

Every route below is admin / super-admin only. Committing an import needs a signed-in person (an API key gets 403).
**None of these has a screen on this commit** (the Settings → Data page is in progress on the Frontend branch); use
the API with a session token, as in §3.

### Exports (`/api/exports`)

| Endpoint | What |
|---|---|
| `GET /customers`, `/jobs`, `/quotes`, `/invoices` | CSV; `?view=lines` on quotes and invoices gives one row per line. Customers, jobs and invoices also have Export buttons on their pages |
| `GET /all[?photos=false]` | `<Company>_export_<date>.zip`: one CSV per table, the photos, `manifest.json` (row counts, sha256 per file) and `SHA256SUMS` (`sha256sum -c SHA256SUMS`). Never contains password hashes, API keys, integration tokens or auth tokens. This is the "export everything" a client gets on exit |
| `GET /xero-invoices?from=YYYY-MM-DD&to=YYYY-MM-DD[&status=…][&dateFormat=…]` | Xero's sales-invoice import CSV, one row per line, tax-exclusive amounts, dates by brand country, void invoices excluded. Choose "tax exclusive" in Xero's import dialog; confirm `XERO_TAX_TYPES` names first |

Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed so spreadsheets treat them as text.

### Customer import (`/api/imports`, `scripts/import-customers.js`)

- Sources: `generic` (template: `GET /api/imports/templates/customers.csv`, also
  `backend/import-templates/customers-generic.csv`; example mapping `import-templates/mapping.example.json`),
  `housecallpro`, `jobber`.
- `POST /api/imports/customers?dryRun=true` (the default) writes nothing and returns a report: every row explained,
  merge candidates (email + phone/postcode auto-merge; phone + postcode or name + postcode for review), cleaning
  applied, field coverage, exceptions; `format=zip` gives `report.json`, `report.md`, `exceptions.csv`,
  `merge-candidates.csv`, `spot-check.csv`.
- Fill in `merge-candidates.csv`, re-run with `decisions`, then commit with `dryRun=false&expectSha256=<sha from
  the dry run>`. One transaction per batch; a failing batch rolls back. Re-running is idempotent; `POST
  /api/imports/customers/undo` with the committed `report.json` reverses it.
- Phones become E.164, IE addresses need address + town + county, US ZIPs that lost a leading zero are errors.
- The command-line tool does the same against a staging database; numbered steps are in its header. Jobs import is
  not built.

### Price book import

`GET /api/pricebook/import/template.csv` (also `backend/import-templates/pricebook.csv`), then
`POST /api/pricebook/import?dryRun=true` (default) with the CSV, then `dryRun=false`. Matches on `sku`, else name +
category; blank cells never clear a value; re-running the same file changes nothing.

### QuickBooks Online (`/api/quickbooks`)

Configure `QB_*` and the `QBO_*` mapping (§6). `POST /connect` returns Intuit's authorisation URL; after the
callback, `POST /sync-invoice/:id` creates or updates the QBO customer and invoice (lines, tax codes, MBC number
as DocNumber), `GET /invoice/:id` shows the link, `POST /sync-payments` marks fully paid invoices paid (partial
payments never), optionally on `QBO_PAYMENT_SYNC_CRON`. Every live call answers 503 in sandbox / demo mode.
**Tested against a local stub only**: before a client's first use, push one invoice end to end in an Intuit
sandbox company and confirm the tax code ids and item id.

---

## White-label

The white-label promise: **a client or trade is configured with `BRAND_*` environment variables only — no source
edits.** `brand.config.js` (repo root) is a thin wrapper over `backend/helpers/brandValidate.js` and
`backend/helpers/locale.js`; you never edit them per client. `GET /api/brand` returns the result to the pages.

### Variables

| Variable | Default | Notes |
|---|---|---|
| `BRAND_TRADE_TYPE` | `electrical` | `electrical` \| `plumbing` \| `hvac` \| `plumbing-hvac` \| `contracting`. Case-insensitive; `Plumbing & HVAC`, `HVAC`, `General Contracting`, `GC` also accepted. **Anything else stops the server at boot** |
| `BRAND_COMPANY_NAME` / `_PHONE` / `_EMAIL` / `_ADDRESS` | Modern Blue Collar / blank | Nav, page titles, login screen, printed documents, emails, SMS |
| `BRAND_COMPANY_SLOGAN` | `Field Service Management` | Set it **empty** (`BRAND_COMPANY_SLOGAN=`) to show no tagline |
| `BRAND_TECH_LABEL`, `BRAND_INDUSTRY_LABEL` | from the trade | e.g. `Engineer` for an Irish heating firm |
| `BRAND_JOB_TYPES` | the trade's list in the `BRAND_COUNTRY` wording | Comma list (1–40 entries, each ≤ 60 characters, no duplicates). Invalid → boot refused |
| `BRAND_COLOR_PRIMARY`, `_SECONDARY`, `_ACCENT`, `_NAV_BG`, `_NAV_TEXT`, `_HEADER_BG`, `_HEADER_TEXT` | the trade's palette | Hex (`#rgb`/`#rrggbb`), quoted in `.env`. Invalid values stop the boot |
| `BRAND_COLOR_PRIMARY_DARK` | derived | Hover/active shade, 18% darker than primary unless set |
| `BRAND_LOGO_URL`, `BRAND_FAVICON_URL` | none | `https://` URL, same-origin path (`/brand/logo.svg`) or `data:image/...;base64`. Shown in the nav, login page and printed documents; favicon defaults to the logo (`/favicon.ico`). An external host is added to the CSP `img-src` |
| `BRAND_DEFAULT_STATE` | `KS` | Default state for US address forms |
| `BRAND_TIMEZONE` | `America/Chicago` | IANA zone; "today", document dates, due dates, demo dates, backups. Invalid zones stop the boot |
| `BRAND_COUNTRY` | `US` | `US` or `IE`: currency, tax label and default rates, address labels and required fields, postcode format (ZIP / Eircode), phone normalisation, date and time format, week start (US Sunday, IE Monday), job-type wording |
| `BRAND_CURRENCY` | `USD` (US), `EUR` (IE) | ISO 4217; snapshot on each document |
| `BRAND_TAX_RATES` | none (US), `standard:23,reduced:13.5,zero:0` (IE) | `key:percent` list. **Set but empty means no tax**, so leave it commented to get the default. Rates are configuration, not advice: confirm with the client's accountant |
| `BRAND_TAX_DEFAULT` | first key | Rate used when a line names none |
| `BRAND_TAX_LABEL` | `Sales tax` (US), `VAT` (IE) | |
| `BRAND_TAX_NUMBER` | blank | The company's own tax / VAT number, printed on documents |
| `BRAND_QUOTE_PREFIX`, `BRAND_INVOICE_PREFIX` | `Q-`, `INV-` | Document numbers `Q-0001`, `INV-0001` |
| `BRAND_RCT_NOTE` | a **placeholder** | Reverse-charge wording on documents. The default is flagged as a placeholder on screen and never printed or emailed; set the client's accountant-approved wording |

Trade palettes when no colour is set: electrical yellow `#f5a623`, plumbing blue `#1e6fd9`,
hvac teal `#0d9488`, plumbing-hvac blue `#2563eb`, contracting orange `#ea580c`.

| `BRAND_TRADE_TYPE` | Technician label | Industry label | Job types (US wording) |
|---|---|---|---|
| `electrical` | Electrician | Electrical | Panel Upgrade, Outlet / Switch, Lighting, EV Charger, Generator, Inspection, Troubleshooting, Other |
| `plumbing` | Plumber | Plumbing | Leak Repair, Drain Cleaning, Water Heater, Fixture Install, Sewer Line, Inspection, Troubleshooting, Other |
| `hvac` | HVAC Technician | HVAC | AC Install, Furnace Install, AC Repair, Furnace Repair, Duct Work, Tune-Up, Inspection, Other |
| `plumbing-hvac` | Technician | Plumbing & HVAC | the plumbing and HVAC lists combined |
| `contracting` | Contractor | General Contracting | Framing, Drywall, Flooring, Roofing, Painting, Demo, General Repair, Other |

With `BRAND_COUNTRY=IE` the lists use Irish wording, e.g. electrical: Consumer Unit Upgrade, Socket / Light
Install, Lighting, EV Charger, Rewire, Generator, Inspection & Cert, Fault Finding, Other; heating: Heat Pump
Install, Boiler Install, Heat Pump Repair, Boiler Repair, Radiators / Pipework, Boiler Service, Inspection, Other.

### New client

1. Fill in `deploy/clients/<slug>.env` (client servers, [DEPLOYMENT.md](DEPLOYMENT.md)) or `backend/.env` (direct
   runs) with the `BRAND_*` and locale block.
2. `npm run seed:prices` — starter price book for **that** trade (`plumbing-hvac` gets both), stamped with the
   industry label. Prices are 2026 US ballparks; the client edits them on the Pricebook page or imports their own
   (§7).
3. Do **not** run `seed_jobs.js` / `seed:demo` for a real client.

### Demo per prospect (`seed:demo`, `demo:check`)

Demo data comes from `backend/demo/`:

```
demo/prospects/<slug>.json        default (generic "Anytown", US), ks-plumbing-example, ie-heating-example (EUR, VAT)
demo/fixtures/trades/<trade>.json pricebook, inventory and ≥ 30 job templates per trade (+ Irish variants)
demo/fixtures/locales/US.json, IE.json   names, streets, phone / postcode formats, invoice terms
```

**Real prospects live outside the repository** (it is public):

```bash
cd backend
node scripts/seed-demo.js --list                                       # bundled examples
mkdir -p ~/mbc-prospects && cp demo/prospects/ie-heating-example.json ~/mbc-prospects/acme-heating.json
# edit slug, brand (BRAND_*), emailDomain (keep it *.example), area.towns, locale, team names
node scripts/seed-demo.js --prospect ~/mbc-prospects/acme-heating.json --print-env --port 3102
#   → backend/.env.demo.acme-heating (gitignored, mode 0600): its own DB mbc_demo_acme_heating, a random
#     JWT_SECRET, DEMO_PROSPECT=<absolute path to the json>
ENV_FILE=.env.demo.acme-heating npm run sandbox                          # creates DB, seeds, starts on 3102
ENV_FILE=.env.demo.acme-heating npm run seed:demo -- --reset             # fresh dates before every demo
ENV_FILE=.env.demo.acme-heating npm run demo:check -- --port 3102 --headless
```

- `--prospect` accepts a bundled slug, a relative path or an absolute path; `DEMO_PROSPECT` in an env file must be
  a slug or an absolute path. A prospect file inside the repo other than `demo/prospects/` is refused.
- Without `--port` the file keeps `PORT=3101`, the same as the main sandbox. Give each prospect its own port.
- Its `DATABASE_URL` assumes role `mbc` / `mbc_sandbox` on `localhost:5432`.

What the seed guarantees: job types from the brand's list (country wording); price book items for the trade;
quote / invoice totals are the sum of real price book lines (> 0) in the instance currency; dates relative to
**today in `BRAND_TIMEZONE`** (finished work with paid / unpaid / overdue invoices, three jobs today, the next days
booked, pending quotes); Irish titles and notes for IE; fictional people only — reserved domains (`demo.test`,
`*.example`, `example.com`), US `555-01xx` numbers, Irish ComReg drama ranges; deterministic for a given day.
Team logins: `office@`, `dispatch@`, `tech1@`–`tech3@` + the prospect's `emailDomain` (default `demo.test`),
password `DEFAULT_PASSWORD` (required). The super-admin stays `ADMIN_EMAIL` (`admin@demo.test`).

Safety: `seed:demo` refuses a database whose name lacks `demo`, `sandbox`, `test` or `wl` (override:
`--allow-db <name>`, e.g. Docker's `mbc`) and refuses `NODE_ENV=production`.

`demo:check` prints PASS / WARN / FAIL per check and exits 1 on any FAIL (`--strict`: also on WARN): client names
(denylist), `undefined`/`NaN` text, job types and trade, wording for the country, amounts > 0, totals = subtotal +
tax, one currency, another trade's price book items, real email domains, stale calendar, due dates, activity
trails; with `--port`, `/api/brand`, every list endpoint, currency symbols and Recent Jobs order; with
`--headless`, the main pages as admin plus `today.html` and `job.html` as a technician (`--tech-email`) in Chrome
(JS errors, "undefined" on screen, client names, "$" on a non-USD page); `--shots <dir>` saves a PNG per page.
Verified 2026-11-21 on the default sandbox and an IE prospect kept outside the repo: `33 pass · 1 warn · 0 fail →
READY` (the WARN is the missing denylist).

**Denylist:** the real list of client names lives in `backend/demo/denylist.local.txt` (**gitignored**) or in any
file named by `DEMO_DENYLIST_FILE`. `backend/demo/denylist.example.txt` shows the format.

### Switching trade on an existing database

Environment-only for everything the server computes (labels, job types, colours, locale). The **data** does not move
with it: jobs keep their old `tradeType` and type, and the price book keeps the old trade's items.

- Demo / sandbox DB: `npm run seed:demo -- --reset` (refuses to mix trades without it).
- Real client changing trade (rare): `npm run seed:prices` adds the new trade's starter items; existing jobs and
  items stay as they were.

---

## Project structure

```
modern-blue-collar/
├── brand.config.js            White-label config: reads BRAND_* (no per-client edits)
├── .env.example               Docker demo env template
├── docker-compose.yml         Local demo: app + Postgres 15; MinIO + Mailpit under --profile demo
├── docker-compose.db-port.yml Optional: publish demo Postgres on 127.0.0.1 for debugging
├── docker-compose.prod.yml    Client server: app + Postgres 16 + Caddy (only Caddy publishes ports)
├── Dockerfile
├── deploy/                    provision.sh, update.sh, Caddyfile, clients/example.env.example
├── README.md · SETUP.md · DEPLOYMENT.md · LICENSE-PROPOSAL.md
├── docs/
│   ├── FEATURES.md            Feature matrix (sales / marketing)
│   ├── RUN-ON-MAC.md
│   └── legal/                 Draft privacy notice, terms of use, DPA (for counsel)
└── backend/
    ├── server.js              Express app, CSP and other headers, rate limits, Socket.io presence, nightly backup cron
    ├── SECURITY_AUDIT.md
    ├── .env.example · .env.sandbox.example
    ├── prisma/schema.prisma · prisma/migrations/   Hand-written SQL migrations (7)
    ├── prisma.config.js
    ├── routes/                activity, apiKeys, auth, backup, communications, customers, exports, googleAuth,
    │                          imports, invites, invoices, jobs, pricebook, quickbooks, quotes, sms, users
    ├── helpers/               access, activity, authTokens, brandValidate, csp, documents, importer, locale,
    │                          mailer, phone, qbo, xero, secretBox, security, storage, validate, zip, …
    ├── middleware/apiKeyAuth.js
    ├── public/                Pages: index (login + dashboard), today, schedule, dispatch, job, customers,
    │                          customer-detail, quote-invoice, print, pricebook, team, communications, api-keys;
    │                          js/ and css/ (no inline script or style)
    ├── import-templates/      customers-generic.csv, mapping.example.json, pricebook.csv
    ├── demo/                  Prospects, trade and locale fixtures, seed and check libraries
    ├── scripts/               sandbox, migrate-deploy, prisma-generate, seed-demo, demo-check, brand-shot,
    │                          backup-run, restore, import-customers
    ├── tests/                 api, redteam, backend, activity, documents, integrations, accounts,
    │                          whitelabel, platform; ui/walk.js
    ├── seed_superadmin.js · seed_pricebook.js · seed_jobs.js · seed_apikey.js
    └── backup.js · docker-entrypoint.sh
```

---

## Troubleshooting

**`[sandbox] ERROR: Cannot connect to PostgreSQL`** — Postgres is not running, or the role/password in
`DATABASE_URL` does not exist. Create the role (`CREATE ROLE mbc LOGIN PASSWORD 'mbc_sandbox' CREATEDB;`).

**`Could not create database …`** — the role lacks `CREATEDB`. Grant it or create the database yourself.

**`Node … is too old for Prisma 7`** — use Node 20.19+, 22.12+ or 24+.

**`[CONFIG] FATAL: …`** / `BrandConfigError` — the boot checks refused the configuration (a published or
placeholder `JWT_SECRET` without `SANDBOX_MODE`, `DEMO_MODE` in production, an invalid `BRAND_*` / locale / job-type
value). The message names the variable.

**`JWT_SECRET in your shell environment is empty or a published / placeholder value`** — `npm run sandbox` refuses a
known secret exported in your shell. `unset JWT_SECRET`; the sandbox writes one into its env file.

**Can't reach the sandbox from another device** — it listens on `127.0.0.1`. Start it with `HOST=0.0.0.0`.

**`Failed to fetch sha256 checksum at https://binaries.prisma.sh/…`** — a Prisma CLI command that needs the native
engine (`migrate dev`, `migrate diff`, `studio`) cannot download it. `npm run migrate:deploy` still works offline.

**403 `PASSWORD_CHANGE_REQUIRED` on every call** — the account has a temporary password. Change it with
`PATCH /api/users/me/password` (§3); there is no screen for it yet.

**A reset or invite link opens a 404** — `reset-password.html` and `accept-invite.html` are not on this commit
(Frontend). Until they land: admin "temporary password" reset plus the API change (§3), or create the user with
`"mustChangePassword": false`.

**429 "Too many login attempts"** — 10 failed sign-ins for that email from your address (or 50 from your address)
in 15 minutes. The correct password is refused too until the window passes. Restart the server to clear it in
development.

**429 "Too many requests"** — more than 1000 API requests in 15 minutes for one user (300 for anonymous requests
per IP). Restart in development, or raise `RATE_LIMIT_USER_MAX`.

**Port already in use** — change `PORT` in your env file or pass `PORT=…`.

**`seed:demo` REFUSED** — the database name has no `demo`/`sandbox`/`test`/`wl` token, the database holds jobs of
another trade (`--reset`), or `NODE_ENV=production`.

**`Unknown demo prospect` / prospect path refused** — `DEMO_PROSPECT` must be a bundled slug or an absolute path to a
file outside the repo.
