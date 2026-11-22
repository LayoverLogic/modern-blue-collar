# Modern Blue Collar

White-label field service management for small trades businesses: electrical, plumbing, HVAC,
plumbing & HVAC, and general contracting. One installation per client, branded entirely through
`BRAND_*` environment variables.

What it does today: customers, jobs with scheduling and dispatch, technician assignment with
double-booking checks, job photos, a per-job activity history, a trade-specific price book, quotes
and invoices (a single amount each for now), team roles, API keys, CSV exports, nightly database
backups, and optional Twilio SMS, Google sign-in and QuickBooks connection.

## Status (2026-11-21)

This is the **sandbox revival** branch (`mbc/sandbox-revival`). It runs locally with no paid services
and no cloud accounts. It is not deployed anywhere and is not ready for a client yet:

- **The login page and four other pages do not run on this commit** (a quoting SyntaxError, RT-25). The
  API works; the Frontend rewrite that fixes the pages is in progress. If `npm run test:redteam` reports
  RT-25 as passing on your checkout, this is fixed.
- Quotes and invoices hold one amount each (no line items, tax, PDF or email yet). That work is in progress.
- Security status, with what is enforced, partial and open: [backend/SECURITY_AUDIT.md](backend/SECURITY_AUDIT.md).

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

`npm run sandbox` copies `.env.sandbox.example` to `backend/.env.sandbox` on first run (and puts a random
`JWT_SECRET` in it), creates the database if it is missing, applies the migrations, seeds a demo company,
and starts the server on **http://localhost:3101**. Override anything with real environment variables:

```bash
PORT=3150 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_other?schema=public npm run sandbox
```

`npm run sandbox:setup` does everything except start the server.

In the sandbox nothing leaves the machine: photos go to `backend/storage/`, emails to `backend/outbox/`
as `.eml` files, backups to `backend/backups/`, and Twilio, QuickBooks and Google answer
"disabled in sandbox" (HTTP 503).

### Demo logins

Password for all of them: the `DEFAULT_PASSWORD` / `ADMIN_PASSWORD` in your env file (`demo1234` in the
example file).

| Email | Role | Sees |
|---|---|---|
| `admin@demo.test` | super-admin | everything, including managing admins |
| `office@demo.test` | admin | everything except managing admins and super-admins |
| `dispatch@demo.test` | dispatcher | customers, jobs, scheduling, SMS; no pricing, no deletes |
| `tech1@demo.test`, `tech2@demo.test`, `tech3@demo.test` | technician | only their own jobs and those customers; status, notes and photos |

For a prospect demo the team logins use the prospect's email domain instead of `demo.test`
(for example `office@prairieline.example`); `admin@demo.test` stays the same.

## Quick start: Docker (Postgres + MinIO + Mailpit)

```bash
cp .env.example .env
docker compose --profile demo up --build
```

App on http://localhost:3001 (same logins), Mailpit (caught emails) on http://localhost:8025, MinIO console
(uploaded photos) on http://localhost:9001 with `minioadmin` / `minioadmin`. MinIO and Mailpit listen on
127.0.0.1 only and Postgres is not published. Tear down and wipe with `docker compose --profile demo down -v`.
The Docker path has not been run by the team (no Docker daemon in the cloud sandbox); the Mac guide covers it.

---

## Tests

All database suites need `TEST_DATABASE_URL` pointing at a **throwaway** database. They create and delete
only their own tagged rows, so they can share one database, but never point them at data you want to keep.

```bash
cd backend
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_test?schema=public"
npm test                  # Prisma-level suite; the DB must exist and its name must contain "test"
npm run test:redteam      # security / abuse tests (RT-3 needs Chrome)
npm run test:backend      # API contract tests
npm run test:activity     # job activity log
npm run test:whitelabel   # brand switching, demo seed, demo:check (creates <db>_wl; needs CREATEDB)
DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform   # storage / mail / backup drivers
```

Results on 2026-11-21 and what each suite proves: [backend/SECURITY_AUDIT.md §1](backend/SECURITY_AUDIT.md).
`npm run test:ui` is a headless-Chrome walk of every page that saves screenshots; see [SETUP.md](SETUP.md#5-tests).

---

## Demo for a prospect

```bash
cd backend
node scripts/seed-demo.js --list
node scripts/seed-demo.js --prospect ks-plumbing-example --print-env      # writes .env.demo.ks-plumbing-example
ENV_FILE=.env.demo.ks-plumbing-example npm run sandbox                      # own DB, seeded, started
ENV_FILE=.env.demo.ks-plumbing-example npm run seed:demo -- --reset         # fresh dates before each demo
ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3101 --headless
```

Prospect files live in `backend/demo/prospects/`: a generic US `default`, a fictional Kansas plumber and a
fictional Irish heating firm. All demo people, emails and phone numbers are fictional. `demo:check` exits
non-zero if a prospect would see client names, "undefined", $0 amounts, wrong-trade jobs or a stale calendar.
**Run it before every demo.** Details: [SETUP.md → Demo per prospect](SETUP.md#demo-per-prospect-seeddemo-democheck).

## White-label in 60 seconds

Set these in the env file the instance uses (`backend/.env.sandbox`, `backend/.env`, a `.env.demo.<slug>`
file, or the repo-root `.env` for Docker) and restart:

```ini
BRAND_COMPANY_NAME=Apex Plumbing LLC
BRAND_TRADE_TYPE=plumbing
BRAND_COLOR_PRIMARY="#1565c0"
BRAND_DEFAULT_STATE=TX
BRAND_TIMEZONE=America/Chicago
```

No source file changes. A bad value (unknown trade, malformed colour, unknown time zone) stops the server at
boot with a message naming the variable. Labels, job types, colours and the price book filter follow the trade.
`BRAND_LOGO_URL` / `BRAND_FAVICON_URL` are validated but not yet returned by `/api/brand`, so pages do not show a
logo yet (WL-7). Full list: [SETUP.md → White-label](SETUP.md#white-label).

| Trade | `BRAND_TRADE_TYPE` |
|-------|--------------------|
| Electrical | `electrical` |
| Plumbing | `plumbing` |
| HVAC | `hvac` |
| Plumbing & HVAC | `plumbing-hvac` |
| General Contracting | `contracting` |

Case-insensitive; `HVAC`, `Plumbing & HVAC`, `General Contracting` and `GC` are accepted. Each trade has its own
job types, technician label, colour palette and starter price book (`npm run seed:prices`).

---

## Documentation

| Document | For |
|---|---|
| [SETUP.md](SETUP.md) | Local setup in detail, environment variable reference, tests, white-label, demo tooling, troubleshooting |
| [docs/RUN-ON-MAC.md](docs/RUN-ON-MAC.md) | Running the sandbox on a Mac (Apple silicon), creating migrations, prospect demos |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deploying for a client (owned by Platform; being rewritten in Phase 2c) |
| [backend/SECURITY_AUDIT.md](backend/SECURITY_AUDIT.md) | Security status with file and test references |
| [docs/legal/](docs/legal/README.md) | Draft privacy notice, terms of use and DPA templates (for counsel) |
| [LICENSE-PROPOSAL.md](LICENSE-PROPOSAL.md) | The licence decision for Paul |

## Tech stack

- Node.js / Express, vanilla HTML/JS/CSS pages in `backend/public/`
- PostgreSQL through Prisma 7 (Rust-free client with the `pg` driver adapter; migrations applied by Prisma's
  schema engine compiled to WebAssembly, `npm run migrate:deploy`)
- Socket.io for "who is viewing this job"
- Storage: local disk or any S3-compatible store (MinIO in the Docker demo)
- Email: outbox folder, Mailpit, or any SMTP server
- Optional: Twilio SMS, Google sign-in (Passport), QuickBooks Online OAuth (invoice sync is a stub)
- node-cron for the nightly backup

## License

MIT

The README and `backend/package.json` say MIT, which does not fit a commercial product. This is under review and
unchanged for now: see [LICENSE-PROPOSAL.md](LICENSE-PROPOSAL.md).
