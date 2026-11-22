# Modern Blue Collar

> **White-label field service management platform for blue-collar trades.**  
> Supports: Electrical · Plumbing · HVAC · General Contracting

---

## What is this?

Modern Blue Collar is a production-ready, self-hosted web platform for small field service businesses. It provides:

- Job scheduling & dispatch board
- Customer CRM
- Quoting & invoicing
- Trade-specific pricebook
- Team management with role-based access
- QuickBooks Online sync
- Twilio SMS notifications
- Google OAuth team invites
- Nightly database backups
- CSV data exports

The entire platform is **white-labeled via `BRAND_*` environment variables** (read by `brand.config.js`). Swapping it to a new trade or client requires changing only environment variables — no source code edits. Invalid brand settings stop the server at boot.

---

## Running a local demo (Docker — free, no cloud accounts)

Spin up the whole platform — app, PostgreSQL, S3-compatible storage (MinIO), and
an email catch-all (Mailpit) — with **no paid services and no real credentials**.
Requires only Docker + Docker Compose.

```bash
cp .env.example .env
docker compose --profile demo up --build
```

Then open:

| URL | What |
|-----|------|
| http://localhost:3001 | The app — sign in with **admin@demo.test** / **demo1234** |
| http://localhost:8025 | Mailpit — every outbound email lands here |
| http://localhost:9001 | MinIO console — uploaded job photos (`minioadmin` / `minioadmin`) |

`--profile demo` + `DEMO_MODE=true` together:

- Seed a demo admin, team, customers, jobs and a pricebook on first boot.
- **Auth:** local email/password login (the Google button is hidden).
- **Storage:** job photos upload to MinIO — open any job → **Photos** → **Upload Photo**.
- **Email:** team-invite emails are caught by Mailpit instead of being sent.
- **Twilio / QuickBooks:** dormant — SMS is logged to the console, QuickBooks
  live auth is disabled (the "Connect" path stays visible).

Tear down (and wipe data) with `docker compose --profile demo down -v`.

### Same file, production

The compose file is production-capable by **changing only `.env`** — omit the
profile so MinIO/Mailpit don't start and the app uses your external services:

```bash
# in .env: DEMO_MODE=false, real DATABASE_URL, S3_*/SMTP_* → Wasabi + real SMTP,
#          plus any Google / QuickBooks / Twilio creds you use
docker compose up -d --build
```

---

## Running a local sandbox (no Docker, no paid services, no internet)

Needs Node 20.19+ / 22.12+ and a local PostgreSQL role that can create a database.

```bash
cd backend
npm install
npm run sandbox        # first run copies .env.sandbox.example → .env.sandbox,
                       # creates the DB if missing, migrates, seeds demo data, starts
```

Open http://localhost:3101 and sign in with **admin@demo.test** / **demo1234**.
Edit `backend/.env.sandbox` (gitignored) for the DB URL / port, or override with
real env vars (`PORT=3150 DATABASE_URL=... npm run sandbox`).
`npm run sandbox:setup` does everything except start the server.

Sandbox drivers (all chosen by env, defaults keep the Docker/production behaviour):

| Concern | Env | Sandbox value | Where it goes |
|---|---|---|---|
| Job photos | `STORAGE_DRIVER` | `local` | `backend/storage/` (`LOCAL_STORAGE_DIR`) |
| Email | `MAIL_DRIVER` | `outbox` | `.eml` + `.json` in `backend/outbox/` (`MAIL_OUTBOX_DIR`) |
| DB backups | `BACKUP_DRIVER` | `local` | `pg_dump` → `backend/backups/*.sql.gz` (`BACKUP_DIR`) |
| Twilio / QuickBooks / Google | `SANDBOX_MODE` | `true` | inert: 503 "disabled in sandbox", SMS logged only |

**Prisma 7 note.** The Prisma client is Rust-free (WASM + `pg` driver adapter,
one shared client in `backend/helpers/prisma.js`). The Prisma 7 CLI still wants
to download a native schema engine from `binaries.prisma.sh`, so:
`npm install` runs `scripts/prisma-generate.js` (generate needs no binary), and
migrations run with `npm run migrate:deploy` (`scripts/migrate-deploy.mjs`, Prisma's
own schema engine compiled to WASM — same `_prisma_migrations` table as the CLI).
Creating *new* migrations (`prisma migrate dev`) still needs the native engine,
i.e. a machine that can reach `binaries.prisma.sh`.

Tests: `npm test` (API suite — **it deletes all customers/jobs in the target DB**)
and `npm run test:platform` (sandbox drivers, no server needed).

---

## Supported Trade Types

| Trade | `BRAND_TRADE_TYPE` |
|-------|--------------------|
| Electrical | `electrical` |
| Plumbing | `plumbing` |
| HVAC | `hvac` |
| Plumbing & HVAC | `plumbing-hvac` |
| General Contracting | `contracting` |

Each trade gets trade-specific job type lists, a technician label, a colour palette and a
trade-correct starter pricebook (`npm run seed:prices`). The value is case-insensitive
(`HVAC`, `Plumbing & HVAC` work); anything else stops the server at boot.

---

## Quick Start

```bash
git clone https://github.com/AlexJ2804/modern-blue-collar.git
cd modern-blue-collar/backend
npm install
cp .env.example .env   # edit with your values
npm run migrate
npm run generate
npm run seed:admin
npm run seed:prices
npm run dev
```

Then open http://localhost:3001.

See **[SETUP.md](SETUP.md)** for the full local development guide.  
See **[DEPLOYMENT.md](DEPLOYMENT.md)** for production deployment (VPS, Railway, Render, Fly.io).

---

## White-Label in 60 Seconds

Edit `.env`:

```ini
BRAND_COMPANY_NAME=Apex Plumbing LLC
BRAND_TRADE_TYPE=plumbing
BRAND_COLOR_PRIMARY="#1565c0"
BRAND_LOGO_URL=https://cdn.example.com/apex-logo.svg
BRAND_DEFAULT_STATE=TX
BRAND_TIMEZONE=America/Chicago
```

That's it. No other files need to change. Full variable list: SETUP.md → **White-label**.

### Sales demos per prospect

```bash
cd backend
node scripts/seed-demo.js --prospect ks-plumbing-example --print-env   # writes .env.demo.<slug>
ENV_FILE=.env.demo.ks-plumbing-example npm run sandbox
ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3101 --headless
```

Prospect files live in `backend/demo/prospects/` (generic US `default`, a fictional Kansas
plumber, a fictional Irish heating firm). Demo data is trade-correct, dated relative to today,
and uses only fictional names, reserved email domains and fictional phone ranges.
`demo:check` exits non-zero if a prospect would see client names, "undefined", $0 amounts,
wrong-trade jobs or a stale calendar. See SETUP.md → **Demo per prospect**.

Tests for this: `npm run test:whitelabel`.

---

## Tech Stack

- **Backend:** Node.js / Express
- **Database:** PostgreSQL via Prisma ORM
- **Frontend:** Vanilla HTML/JS/CSS (no framework dependency)
- **Auth:** JWT email/password + Google OAuth (Passport.js)
- **SMS:** Twilio
- **Accounting:** QuickBooks Online API
- **Object storage:** AWS S3 SDK — MinIO locally, Wasabi / S3 in production
- **Scheduler:** node-cron
- **Local demo stack:** Docker Compose (PostgreSQL · MinIO · Mailpit)

---

## License

MIT
