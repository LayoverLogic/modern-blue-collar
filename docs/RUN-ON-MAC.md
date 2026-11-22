# Run MBC on your Mac (Apple silicon)

For Alex's Mac mini. Written 2026-11-21 against `mbc/sandbox-revival` at `808631f`. Two ways to run it:
**(1) no Docker** (fastest, recommended) or **(2) Docker Desktop** (closest to how a client server will run).
Section 3 builds a branded demo for a prospect, section 4 switches brand or trade, section 5 is troubleshooting.

> **Before you show anyone:** on `808631f` the login page and four other pages do not run (RT-25), and
> `demo:check --headless` reports **NOT READY**. The API and the database are fine. Pull again after the Frontend
> work merges, and only demo when `demo:check --headless` says `READY`.

Commands are for the macOS Terminal (zsh). Lines starting with `#` are comments.

---

## 1. No-Docker path

### 1.1 Install the tools (once)

```bash
# Homebrew, if you don't have it: https://brew.sh
brew install node@22 postgresql@16 git

# Both are "keg-only": put them on your PATH (Apple silicon prefix /opt/homebrew)
echo 'export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

node -v          # v22.12 or newer
psql --version   # 16.x
pg_dump --version  # 16.x (backups use it)

brew services start postgresql@16
```

### 1.2 Create the sandbox database role (once)

Homebrew's Postgres makes your macOS user a superuser, so this works without a password:

```bash
psql postgres -c "CREATE ROLE mbc LOGIN PASSWORD 'mbc_sandbox' CREATEDB;"
```

`CREATEDB` is enough for the sandbox, the tests and Prisma's shadow database. All example env files expect exactly
this role and password on `localhost:5432`.

### 1.3 Get the code and start the sandbox

```bash
mkdir -p ~/code && cd ~/code
git clone https://github.com/LayoverLogic/modern-blue-collar.git
cd modern-blue-collar
git checkout mbc/sandbox-revival
cd backend
npm install
npm run sandbox
```

First run: creates `backend/.env.sandbox` with a random `JWT_SECRET`, creates database `mbc_sandbox`, applies the
migrations, seeds a demo company (generic "Anytown", Plumbing & HVAC) and starts on **http://localhost:3101**.
Stop with `Ctrl-C`. Run `npm run sandbox` again any time; seeding is skipped if the data is already there.

| Login | Role |
|---|---|
| `admin@demo.test` | super-admin |
| `office@demo.test` | admin |
| `dispatch@demo.test` | dispatcher |
| `tech1@demo.test`, `tech2@demo.test`, `tech3@demo.test` | technician |

Password: `demo1234` (`DEFAULT_PASSWORD` / `ADMIN_PASSWORD` in `backend/.env.sandbox`).

Nothing leaves the Mac: photos go to `backend/storage/`, emails to `backend/outbox/*.eml` (open them in Mail),
backups to `backend/backups/`, and Twilio, QuickBooks and Google answer "disabled in sandbox".

The server listens on all network interfaces, so other devices on your Wi-Fi can reach
`http://<mac-name>.local:3101` (handy for trying the technician view on your phone). macOS may ask whether to
allow incoming connections for `node`; say no if you don't want that.

Quick API check while the pages are broken:

```bash
curl -s -X POST localhost:3101/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@demo.test","password":"demo1234"}' | head -c 80; echo
```

Run the tests (each suite cleans up after itself; use a throwaway database):

```bash
cd ~/code/modern-blue-collar/backend
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_test?schema=public"
createdb -U mbc mbc_test
npm test && npm run test:redteam && npm run test:backend && npm run test:activity && npm run test:whitelabel
DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform
```

For the Chrome-based tests (`test:redteam` RT-3, `test:ui`, `demo:check --headless`):

```bash
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Expected on `808631f`: 69/69, 46/48 (RT-25 and RT-3 fail until the Frontend merge), 21/21, 16/16, 36/36, 12/12.

### 1.4 Creating migrations and checking drift

The team's cloud sandbox cannot run Prisma's native engine, so every migration so far was written by hand and
applied with the WebAssembly engine (`npm run migrate:deploy`). On your Mac, with internet, the native Prisma CLI
works, so this is where new migrations get generated and where the hand-written ones get checked.

Always use a **scratch database** for this, never `mbc_sandbox` or a demo database.

**Drift check** (do this once now, and after every merge that adds a migration):

```bash
cd ~/code/modern-blue-collar/backend
export DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_drift?schema=public"
dropdb -U mbc --if-exists mbc_drift && createdb -U mbc mbc_drift

npm run migrate:deploy                        # apply the hand-written migrations (WASM engine)
npx prisma migrate status                     # native CLI: should say the database schema is up to date
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script                                    # SQL needed to make the DB match schema.prisma
```

Read the SQL it prints:

- **Expected:** `ALTER TABLE "JobActivity" DROP CONSTRAINT "JobActivity_jobId_fkey";`. That foreign key is
  deliberately in the migration but not modelled in `schema.prisma` (see the comment at the top of
  `prisma/migrations/20261121150000_job_activity/migration.sql`). Ignore it.
- `-- This is an empty migration.` or only the line above: **no drift**.
- **Anything else** is real drift between the schema and the migrations. Save the output and send it to the team.

The first run downloads the native engine for macOS arm64 from `binaries.prisma.sh` (a few seconds).

**Creating a new migration** after someone changes `prisma/schema.prisma`:

```bash
cd ~/code/modern-blue-collar/backend
export DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_migrate_dev?schema=public"
dropdb -U mbc --if-exists mbc_migrate_dev && createdb -U mbc mbc_migrate_dev
npm run migrate:deploy                        # bring the scratch DB up to the current migrations

npx prisma migrate dev --create-only --name describe_the_change
# → prisma/migrations/<timestamp>_describe_the_change/migration.sql (not applied yet)
```

Then open the new `migration.sql` and:

1. **Delete** any `ALTER TABLE "JobActivity" DROP CONSTRAINT "JobActivity_jobId_fkey";` line (same reason as above).
2. Make sure there is **no `;` inside comments or string literals** and **no `CREATE FUNCTION` / `CREATE TRIGGER`
   / `DO $$` blocks**: `migrate:deploy` splits the file on every `;` (PLAT-15).
3. Apply and verify it the way the team does:

```bash
npm run migrate:deploy                                    # on mbc_migrate_dev
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
# expect only the JobActivity FK line again

# on an empty DB and on a seeded DB:
DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_mig_empty?schema=public npm run sandbox:setup
DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_sandbox?schema=public npm run migrate:deploy
npm run generate
npm test     # and the other suites, with TEST_DATABASE_URL as in 1.3
```

4. Commit `prisma/schema.prisma` and the new migration folder together.

If `migrate dev` ever says **"Drift detected… We need to reset the database"**, answer **No**: you are pointed at a
database that was changed by hand. Start again with a fresh scratch database.

---

## 2. Docker Desktop path

Install **Docker Desktop for Mac (Apple silicon)** from docker.com and start it. All images used
(`node:22-bookworm-slim`, `postgres:15`, `minio/minio`, `minio/mc`, `axllent/mailpit`) have arm64 builds.
The team could not run this path (no Docker daemon in the cloud sandbox), so tell the team about anything that
does not work.

```bash
cd ~/code/modern-blue-collar          # repo root, not backend/
cp .env.example .env
docker compose --profile demo up --build
```

| URL | What |
|---|---|
| http://localhost:3001 | The app (same logins and password as 1.3) |
| http://localhost:8025 | Mailpit: every email the app sends (team invitations) |
| http://localhost:9001 | MinIO console, `minioadmin` / `minioadmin`: buckets `mbc-uploads` (photos) and `mbc-backups` |

- Postgres runs inside Docker and is **not** published, so it does not clash with Homebrew's Postgres on 5432.
  If you need `psql` into it: `docker compose exec postgres psql -U mbc mbc`.
- MinIO and Mailpit listen on 127.0.0.1 only.
- `JWT_SECRET` is blank in `.env`, so every container restart signs everyone out. Fine for a demo.
- `Ctrl-C` stops it; `docker compose --profile demo up -d` runs it in the background;
  `docker compose --profile demo down` stops it; `docker compose --profile demo down -v` **deletes all data**.
- Port 3001 busy? Set `PORT=3002` in `.env` (that is the host port; the container always uses 3001).

---

## 3. A branded demo for a prospect

One prospect = one env file, one database and one port, so demos never touch each other or the main sandbox.
**Keep real prospect files outside the repository** (the repository is public): the examples in
`backend/demo/prospects/` are fictional on purpose.

```bash
cd ~/code/modern-blue-collar/backend
mkdir -p ~/mbc-prospects
cp demo/prospects/ks-plumbing-example.json ~/mbc-prospects/acme-heating.json
```

Edit `~/mbc-prospects/acme-heating.json`:

- `slug`: `acme-heating` (lower-case letters, digits, dashes)
- `brand`: the prospect's `BRAND_COMPANY_NAME`, `BRAND_TRADE_TYPE`, colours (`BRAND_COLOR_PRIMARY`,
  `BRAND_COLOR_NAV_BG`), `BRAND_TIMEZONE`, phone/email/address shown in the app
- `emailDomain`: must stay a reserved domain, e.g. `acme-heating.example` (the seed refuses real domains)
- `area.towns`: the towns their customers are in; `locale`: `US` or `IE`

Generate the env file on its own port, then fix the two things the generator does not do:

```bash
node scripts/seed-demo.js --prospect ~/mbc-prospects/acme-heating.json --print-env --port 3102
# → backend/.env.demo.acme-heating (gitignored)

# 1) a real random JWT secret (the generated file keeps the published placeholder)
sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 48)/" .env.demo.acme-heating
# 2) point DEMO_PROSPECT at the file outside the repo (the generator writes just the slug)
sed -i '' "s|^DEMO_PROSPECT=.*|DEMO_PROSPECT=$HOME/mbc-prospects/acme-heating.json|" .env.demo.acme-heating

ENV_FILE=.env.demo.acme-heating npm run sandbox     # creates mbc_demo_acme_heating, seeds, starts on 3102
```

Logins: `admin@demo.test` and `office@acme-heating.example`, `dispatch@…`, `tech1@…`–`tech3@…`, password `demo1234`.

Put the names of real clients (past and present) in `backend/demo/denylist.local.txt`, one per line
(format: `demo/denylist.example.txt`). It is gitignored; `demo:check` fails if any of them appear in a demo.

**Before every demo** (same morning), in a second Terminal tab while the demo server runs:

```bash
cd ~/code/modern-blue-collar/backend
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ENV_FILE=.env.demo.acme-heating npm run seed:demo -- --reset          # today's jobs, fresh overdue invoices
ENV_FILE=.env.demo.acme-heating npm run demo:check -- --port 3102 --headless --shots ~/mbc-prospects/shots-acme
```

Only demo if the last line says **`READY`**. `--shots` saves a PNG per page so you can eyeball them. If it says
`NOT READY`, the failing lines name the problem; move the demo rather than show it. On `808631f` it will say
NOT READY because of RT-25 (pages) and the team page's "undefined"; a WARN for the missing logo (WL-7) is expected
until that lands.

---

## 4. Switching brand or trade

**Brand only** (name, colours, labels): edit the `BRAND_*` lines in the env file (`backend/.env.sandbox`, or the
prospect's `.env.demo.<slug>`), then stop and restart `npm run sandbox`. No data changes.

**Trade**, keeping one database: the existing jobs and price book belong to the old trade, so reset the demo data:

```bash
cd ~/code/modern-blue-collar/backend
# edit BRAND_TRADE_TYPE in backend/.env.sandbox first, then:
ENV_FILE=.env.sandbox npm run seed:demo -- --reset
ENV_FILE=.env.sandbox npm run seed:prices
npm run sandbox
```

**Trade, side by side** (nothing to reset; each trade gets its own database and port):

```bash
BRAND_TRADE_TYPE=electrical PORT=3103 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_sandbox_electrical?schema=public npm run sandbox
BRAND_TRADE_TYPE=hvac       PORT=3104 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_sandbox_hvac?schema=public       npm run sandbox
```

Valid trades: `electrical`, `plumbing`, `hvac`, `plumbing-hvac`, `contracting`. A typo stops the server at boot
with a message listing them.

**Docker:** edit `BRAND_*` in the repo-root `.env`, then
`docker compose --profile demo up -d --force-recreate app`. For a trade change also wipe the data:
`docker compose --profile demo down -v && docker compose --profile demo up -d`.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: psql` / `createdb` / `pg_dump` | The PATH line in 1.1 is missing; `source ~/.zshrc` or open a new Terminal |
| `Cannot connect to PostgreSQL at localhost:5432` | `brew services list` shows postgresql@16 not started: `brew services restart postgresql@16`. Logs: `/opt/homebrew/var/log/postgresql@16.log` |
| `password authentication failed for user "mbc"` / `role "mbc" does not exist` | Redo 1.2 (`psql postgres -c "ALTER ROLE mbc PASSWORD 'mbc_sandbox';"` if it exists) |
| `Node … is too old for Prisma 7` | `node -v`; make sure `/opt/homebrew/opt/node@22/bin` is first on PATH |
| `EADDRINUSE` / port already in use | Another server is on that port: `lsof -i :3101`, stop it, or use `PORT=…` |
| Login page does nothing; browser console shows "missing ) after argument list" | RT-25 on this commit. Pull the latest `mbc/sandbox-revival` after the Frontend merge |
| Every request returns 429 | Rate limit (200 / 15 min per IP; 20 logins). Restart the server |
| `Failed to fetch sha256 checksum … binaries.prisma.sh` | Only happens without internet (or behind a strict proxy). `npm run migrate:deploy` still works offline |
| Backup fails: `pg_dump: error: aborting because of server version mismatch` | `pg_dump --version` must be 16; check the PATH line, or set `PG_DUMP_PATH=/opt/homebrew/opt/postgresql@16/bin/pg_dump` |
| `seed:demo` says REFUSED … trade | The database holds another trade's jobs: add `--reset`, or use a separate database (section 4) |
| `seed:demo` says `Unknown demo prospect` | `DEMO_PROSPECT` in the env file must be the full path to your prospect JSON (section 3) |
| `demo:check --headless`: `Chrome not found` | `export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` |
| `[CONFIG] FATAL: …` | The message names the variable: usually a `BRAND_*` typo (bad colour, unknown trade or time zone) |
| Docker: `port is already allocated` | Change `PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT` or `MAILPIT_UI_PORT` in `.env` |
| Docker: app keeps restarting | `docker compose logs app`; usually `DATABASE_URL` edited away from host `postgres` |
| Start completely fresh (sandbox) | `dropdb -U mbc mbc_sandbox && rm backend/.env.sandbox && npm run sandbox` (deletes the sandbox data) |

More detail: `SETUP.md` (environment variables, tests, white-label), `backend/SECURITY_AUDIT.md` (what is and is
not secured yet), `DEPLOYMENT.md` (client deployment, owned by Platform).
