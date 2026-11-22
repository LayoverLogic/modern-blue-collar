# Run MBC on your Mac (Apple silicon)

For Alex's Mac mini. Written 2026-11-21 against `mbc/sandbox-revival` at `6d63a31`, updated for `0cc0953` and
backend fix round B4. Two ways to run it:
**(1) no Docker** (fastest, recommended) or **(3) Docker Desktop** (closest to how a client server will run).
Section 2 is the migration drift check (do it once on the Mac, the team cannot), section 4 builds a branded demo
for a prospect, section 5 switches brand, trade or country, section 6 points at the first real-server test,
section 7 is troubleshooting.

> **Before you show anyone:** every page loads and `demo:check --headless` says `READY` after B4, both on the US
> default sandbox and on an Irish one made with only `BRAND_COUNTRY=IE` (Irish towns, Eircodes, VAT on every
> document). Since Frontend
> F3 the account screens (forgot / reset password, accept-invite, change password, Team-page deactivate / role /
> reset) and Settings (customer import, export everything, Xero, QuickBooks) are in the app (see 1.4).

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

node -v            # v22.12 or newer
psql --version     # 16.x (restore uses it)
pg_dump --version  # 16.x (backups use it)

brew services start postgresql@16
```

Google Chrome in `/Applications` is needed for the browser-based checks; tell the tools where it is (add it to
`~/.zshrc` too):

```bash
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
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

(Already cloned? `cd ~/code/modern-blue-collar && git pull && cd backend && npm install && npm run sandbox`. New
migrations are applied automatically.)

First run: creates `backend/.env.sandbox` with a random `JWT_SECRET`, creates database `mbc_sandbox`, applies the
seven migrations, seeds a demo company (generic "Anytown", Plumbing & HVAC, US) and starts on
**http://localhost:3101**. It listens on this Mac only (`127.0.0.1`). Stop with `Ctrl-C`. Run `npm run sandbox`
again any time; seeding is skipped if the data is already there.

| Login | Role | Lands on |
|---|---|---|
| `admin@demo.test` | super-admin | Dashboard |
| `office@demo.test` | admin | Dashboard |
| `dispatch@demo.test` | dispatcher | Dashboard (no billing edits, no admin pages) |
| `tech1@demo.test`, `tech2@demo.test`, `tech3@demo.test` | technician | Today (their jobs for today) |

Password: `demo1234` (`DEFAULT_PASSWORD` / `ADMIN_PASSWORD` in `backend/.env.sandbox`; the login page shows the
admin one). Ten wrong passwords for one login lock that login for 15 minutes; restarting the server clears it.

Nothing leaves the Mac: photos go to `backend/storage/`, emails to `backend/outbox/*.eml` (double-click to open in
Mail), backups to `backend/backups/`, and Twilio, QuickBooks and Google answer "disabled in sandbox".

### 1.4 Things to try

As `admin@demo.test`:

1. **Customers → + New Customer**, then **Dispatch → + New Job** for them; open the job, set a technician, date
   and time under **Schedule & Assign** (a clash with another booking is refused).
2. On the job, under **Quote & Invoice**: **Build quote** with two price book lines and one free-text line; totals
   and tax are computed by the server. Set it to approved, then **Convert Q-… to invoice**. **Print / PDF** opens the
   printable view (use the browser's "Save as PDF"). **Email** writes the email to `backend/outbox/` and logs it on
   the customer's timeline.
3. The job's **Activity** panel lists every change with who made it.
4. **Export** buttons on Customers, Dispatch and Quotes & Invoices download CSVs.

As `tech1@demo.test` (best on a phone, 1.5): **Today** shows the day's jobs with Navigate / Call / Text / On My Way;
open a job, change its status, add a note, upload a photo.

Also on the screens: "Forgot password?" on the sign-in page and the reset page, accepting an invite, changing your
password (menu under your name), deactivating someone or changing a role (Team), Settings → Data (import, export
everything, Xero) and Settings → QuickBooks. **Team → + Invite Member** writes an email (sandbox: `backend/outbox/`)
with a link to `accept-invite.html`, also shown with a Copy button; **Team → + Add with password** creates an account
with a temporary password, and the person chooses their own at first sign-in.

### 1.5 Try it on your phone

The sandbox listens on the Mac only. To open it on your phone, put both on **your own iPhone's Personal Hotspot**
(not café or office Wi-Fi: in demo mode the login page shows the admin password to anyone who can reach it):

```bash
# 1. iPhone: Settings → Personal Hotspot → Allow Others to Join. Mac: join that hotspot in the Wi-Fi menu.
# 2. Find the Mac's address on the hotspot (usually 172.20.10.x). Wi-Fi is en1 on a Mac mini
#    (en0 is its Ethernet port), en0 on a MacBook; or System Settings → Wi-Fi → Details:
ipconfig getifaddr en1 || ipconfig getifaddr en0
# 3. Start the sandbox on all interfaces:
cd ~/code/modern-blue-collar/backend
HOST=0.0.0.0 npm run sandbox
```

On the phone, open `http://<that address>:3101` (for example `http://172.20.10.3:3101`) and sign in as
`tech1@demo.test`. If macOS asks whether `node` may accept incoming connections, allow it. If the phone that
shares the hotspot cannot load the page, try a second device joined to the same hotspot. Live presence ("who else
is viewing this job") works across devices. Links inside the outbox emails still say `localhost`. When you are
done, stop the server (`Ctrl-C`) and start it again without `HOST=0.0.0.0`. While it runs with `HOST=0.0.0.0` it
is reachable on **every** network the Mac is on, including its Ethernet port, so don't leave it like that.

### 1.6 Run the tests

Each suite cleans up after itself; use a throwaway database whose name contains `test`:

```bash
cd ~/code/modern-blue-collar/backend
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_test?schema=public"
createdb -U mbc mbc_test
for s in test test:redteam test:backend test:activity test:documents test:integrations test:accounts test:whitelabel test:platform; do
  npm run $s || break
done
```

Expected after fix round B4: 69, 48, 45, 18, 22, 21, 25, 48, 23 tests (in the order of the loop), all passing
(about 3½ minutes in total).

The UI walk needs its own sandbox database and Chrome:

```bash
DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_ui_sandbox?schema=public PORT=3121 npm run sandbox:setup
DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_ui_sandbox?schema=public UI_PORT=3121 \
  UI_OUT_DIR=~/mbc-ui UI_FINAL_DIR=~/mbc-ui/final npm run test:ui
```

After B4 (with Frontend F4) it ends with exit 0; step "6g. Reverse charge" says `skip` on the US demo, because
reverse charge exists for VAT only. The PNGs in `~/mbc-ui/final` are good screenshots for a deck.

---

## 2. Migrations: drift check and new migrations

The team's cloud sandbox cannot run Prisma's native engine, so **all seven migrations were written by hand** and
applied with the WebAssembly engine (`npm run migrate:deploy`). Nobody has yet compared them with
`prisma/schema.prisma` using Prisma's own diff. On your Mac, with internet, the native Prisma CLI works, so this is
where it happens. Always use a **scratch database**, never `mbc_sandbox` or a demo database.

### 2.1 Drift check (once now, and after every merge that adds a migration)

```bash
cd ~/code/modern-blue-collar/backend
export DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_drift?schema=public"
dropdb -U mbc --if-exists mbc_drift && createdb -U mbc mbc_drift

npm run migrate:deploy                        # apply the hand-written migrations (WASM engine)
npx prisma migrate status                     # native CLI: should say the database schema is up to date
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script > ~/mbc-drift.sql                  # SQL that would make the DB match schema.prisma
cat ~/mbc-drift.sql
```

The first run downloads the native engine for macOS arm64 from `binaries.prisma.sh` (a few seconds).

Some things in the migrations **cannot be written in `schema.prisma`**, so Prisma will offer to remove them.
These are deliberate. I inspected every migration for them:

| Migration | Deliberate SQL-only item | What the diff prints | Do |
|---|---|---|---|
| `20261121150000_job_activity` | Foreign key `JobActivity_jobId_fkey` (`ON DELETE SET NULL`, so a job's history survives its deletion). Not modelled as a Prisma relation on purpose | `ALTER TABLE "JobActivity" DROP CONSTRAINT "JobActivity_jobId_fkey";` | **Expected. Ignore** |
| `20261121180000_accounts_multi_documents` | Partial unique index `Invoice_quoteId_live_key` (`… WHERE "quoteId" IS NOT NULL AND "status" <> 'void'`: one live invoice per quote). Prisma 7 has no partial indexes | `DROP INDEX "Invoice_quoteId_live_key";` | **Expected. Ignore** |
| `20261121150000_job_activity`, `20261121180000_accounts_multi_documents` | CHECK constraints `JobActivity_type_check` and `AuthToken_kind_check` | Normally nothing (Prisma does not manage CHECK constraints). If a `DROP CONSTRAINT "…_check"` line appears | Expected. Ignore |
| `20261121140000_documents_locale` | SQL function `mbc_next_document_number(type, prefix)` and the `DocumentCounter` rows it uses; `Quote.number` / `Invoice.number` default to it (`@default(dbgenerated(…))` in the schema) | Normally nothing (Prisma ignores functions). Possibly `ALTER COLUMN "number" SET DEFAULT mbc_next_document_number('quote'::text, NULL::text);` (and `'invoice'`) if Postgres prints the default differently | Expected and harmless. Ignore |

Read `~/mbc-drift.sql`:

- `-- This is an empty migration.` or **only** lines from the table above: **no drift**. Tell the team "drift check
  clean on <commit>".
- **Anything else** (a missing column, a different type, an index Prisma wants to create, a `CREATE TABLE`) is real
  drift between the schema and the migrations. Send `~/mbc-drift.sql` and `git rev-parse --short HEAD` to the team;
  don't fix it yourself.

### 2.2 Creating a new migration

When someone changes `prisma/schema.prisma` without writing the SQL:

```bash
cd ~/code/modern-blue-collar/backend
export DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_migrate_dev?schema=public"
dropdb -U mbc --if-exists mbc_migrate_dev && createdb -U mbc mbc_migrate_dev
npm run migrate:deploy                        # bring the scratch DB up to the current migrations

npx prisma migrate dev --create-only --name describe_the_change
# → prisma/migrations/<timestamp>_describe_the_change/migration.sql (not applied yet)
```

Open the new `migration.sql` and **delete these generated lines** if they are there (they would undo the
deliberate items in 2.1):

```sql
ALTER TABLE "JobActivity" DROP CONSTRAINT "JobActivity_jobId_fkey";
DROP INDEX "Invoice_quoteId_live_key";
ALTER TABLE "JobActivity" DROP CONSTRAINT "JobActivity_type_check";
ALTER TABLE "AuthToken" DROP CONSTRAINT "AuthToken_kind_check";
ALTER TABLE "Quote" ALTER COLUMN "number" SET DEFAULT mbc_next_document_number('quote'::text, NULL::text);
ALTER TABLE "Invoice" ALTER COLUMN "number" SET DEFAULT mbc_next_document_number('invoice'::text, NULL::text);
```

Leave everything else. Functions, `DO $$ … $$` blocks and `;` inside strings or comments are fine now (the splitter
was fixed, PLAT-15). Then apply and verify it the way the team does:

```bash
npm run migrate:deploy                                    # on mbc_migrate_dev
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
# expect only the deliberate lines from 2.1

# on an empty DB and on a seeded DB:
DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_mig_empty?schema=public npm run sandbox:setup
DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_sandbox?schema=public npm run migrate:deploy
npm run generate
npm test     # and the other suites, with TEST_DATABASE_URL as in 1.6
```

Commit `prisma/schema.prisma` and the new migration folder together.

If `migrate dev` ever says **"Drift detected… We need to reset the database"**, answer **No**: you are pointed at a
database that was changed by hand. Start again with a fresh scratch database.

---

## 3. Docker Desktop path

Install **Docker Desktop for Mac (Apple silicon)** from docker.com and start it. All images used
(`node:22-bookworm-slim`, `postgres:15`, `minio/minio`, `minio/mc`, `axllent/mailpit`) have arm64 builds.
**The team could not run this path** (no Docker daemon in the cloud sandbox), so tell the team about anything that
does not work.

```bash
cd ~/code/modern-blue-collar          # repo root, not backend/
cp .env.example .env
docker compose --profile demo up --build
```

| URL | What |
|---|---|
| http://localhost:3001 | The app (same logins and password as 1.3) |
| http://localhost:8025 | Mailpit: every email the app sends (invites, reset links, quotes, invoices) |
| http://localhost:9001 | MinIO console, `minioadmin` / `minioadmin`: buckets `mbc-uploads` (photos) and `mbc-backups` |

- Postgres runs inside Docker and is **not** published, so it does not clash with Homebrew's Postgres on 5432.
  If you need `psql` into it: `docker compose exec postgres psql -U mbc mbc`.
- MinIO and Mailpit listen on 127.0.0.1 only. The app port is published on all interfaces (`APP_BIND`); set
  `APP_BIND=127.0.0.1` in `.env` to keep it on the Mac. Do not set `HOST` in Docker.
- `JWT_SECRET` is blank in `.env`, so every container restart signs everyone out. Fine for a demo.
- `Ctrl-C` stops it; `docker compose --profile demo up -d` runs it in the background;
  `docker compose --profile demo down` stops it; `docker compose --profile demo down -v` **deletes all data**.
- Port 3001 busy? Set `PORT=3002` in `.env` (that is the host port; the container always uses 3001).
- Backup into MinIO: `docker compose exec app npm run backup:run` (this is step 10 of DEPLOYMENT.md §10).

---

## 4. A branded demo for a prospect

One prospect = one env file, one database and one port, so demos never touch each other or the main sandbox.
**Keep real prospect files outside the repository** (it is public): the examples in `backend/demo/prospects/` are
fictional on purpose.

```bash
cd ~/code/modern-blue-collar/backend
mkdir -p ~/mbc-prospects
cp demo/prospects/ks-plumbing-example.json ~/mbc-prospects/acme-heating.json     # or ie-heating-example.json
```

Edit `~/mbc-prospects/acme-heating.json`:

- `slug`: `acme-heating` (lower-case letters, digits, dashes)
- `brand`: the prospect's `BRAND_COMPANY_NAME`, `BRAND_TRADE_TYPE`, colours (`BRAND_COLOR_PRIMARY`,
  `BRAND_COLOR_NAV_BG`), `BRAND_LOGO_URL` (an `https://` link to their logo), `BRAND_TIMEZONE`, phone/email/address
  shown in the app; for an Irish prospect `BRAND_COUNTRY=IE`, `BRAND_CURRENCY=EUR`, `BRAND_TAX_*` as in
  `ie-heating-example.json`
- `emailDomain`: must stay a reserved domain, e.g. `acme-heating.example` (the seed refuses real domains)
- `area.towns`: the towns their customers are in; `locale`: `US` or `IE`; `team`: first names you like

Generate the env file on its own port and start it:

```bash
node scripts/seed-demo.js --prospect ~/mbc-prospects/acme-heating.json --print-env --port 3102
# → backend/.env.demo.acme-heating (gitignored): its own database mbc_demo_acme_heating, a random JWT_SECRET,
#   and DEMO_PROSPECT=/Users/<you>/mbc-prospects/acme-heating.json
ENV_FILE=.env.demo.acme-heating npm run sandbox     # creates the DB, seeds, starts on 3102
```

Logins: `admin@demo.test` and `office@acme-heating.example`, `dispatch@…`, `tech1@…`–`tech3@…`, password `demo1234`.
To show it on a phone, add `HOST=0.0.0.0` as in 1.5.

Put the names of real clients (past and present) in `backend/demo/denylist.local.txt`, one per line
(format: `demo/denylist.example.txt`). It is gitignored; `demo:check` fails if any of them appear in a demo.

**Before every demo** (same morning), in a second Terminal tab while the demo server runs:

```bash
cd ~/code/modern-blue-collar/backend
ENV_FILE=.env.demo.acme-heating npm run seed:demo -- --reset          # today's jobs, fresh overdue invoices
ENV_FILE=.env.demo.acme-heating npm run demo:check -- --port 3102 --headless --shots ~/mbc-prospects/shots-acme
```

Only demo if the last line says **`READY`**. `--shots` saves a PNG per page so you can eyeball them. If it says
`NOT READY`, the failing lines name the problem; move the demo rather than show it. With a denylist file in place
there should be no WARN lines. (Checked on 2026-11-21 with an Irish prospect file outside the repo: `33 pass · 1 warn
· 0 fail → READY`, the WARN being the missing denylist.)

---

## 5. Switching brand, trade or country

**Brand only** (name, colours, logo, labels): edit the `BRAND_*` lines in the env file (`backend/.env.sandbox`, or
the prospect's `.env.demo.<slug>`), then stop and restart `npm run sandbox`. No data changes.

**Trade or country**, keeping one database: the existing jobs, price book and documents belong to the old trade /
currency, so reset the demo data:

```bash
cd ~/code/modern-blue-collar/backend
# edit BRAND_TRADE_TYPE (and/or BRAND_COUNTRY, BRAND_CURRENCY, BRAND_TAX_*) in backend/.env.sandbox first, then:
ENV_FILE=.env.sandbox npm run seed:demo -- --reset
npm run sandbox
```

**Side by side** (nothing to reset; each gets its own database and port):

```bash
BRAND_TRADE_TYPE=electrical PORT=3103 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_sandbox_electrical?schema=public npm run sandbox
DEMO_PROSPECT=ie-heating-example BRAND_COUNTRY=IE BRAND_CURRENCY=EUR BRAND_TAX_RATES=standard:23,reduced:13.5,zero:0 BRAND_TIMEZONE=Europe/Dublin \
  PORT=3104 DATABASE_URL=postgresql://mbc:mbc_sandbox@localhost:5432/mbc_sandbox_ie?schema=public npm run sandbox
```

(The second one is easier with `node scripts/seed-demo.js --prospect ie-heating-example --print-env --port 3104`
and `ENV_FILE=.env.demo.ie-heating-example npm run sandbox`.)

Valid trades: `electrical`, `plumbing`, `hvac`, `plumbing-hvac`, `contracting`; countries `US`, `IE`. A typo stops
the server at boot with a message listing the choices.

**Docker:** edit `BRAND_*` in the repo-root `.env`, then
`docker compose --profile demo up -d --force-recreate app`. For a trade or country change also wipe the data:
`docker compose --profile demo down -v && docker compose --profile demo up -d`.

---

## 6. First real server

Nothing about client hosting has run on a real server yet: Docker, Caddy and its certificates, the firewall,
`deploy/provision.sh` and `deploy/update.sh` are lint-checked only. Before the first client, do the one-off test on
a cheap throwaway VPS with a spare subdomain: **[DEPLOYMENT.md §10 "First real-server test"](../DEPLOYMENT.md)**
(ten steps: provision, versions, TLS and websockets, port checks, backup, restore drill and disaster restore, the
failure path, update and rollback, reboot, and the Mac demo stack). Write down what you saw at each step and send it
to the team.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: psql` / `createdb` / `pg_dump` | The PATH line in 1.1 is missing; `source ~/.zshrc` or open a new Terminal |
| `Cannot connect to PostgreSQL at localhost:5432` | `brew services list` shows postgresql@16 not started: `brew services restart postgresql@16`. Logs: `/opt/homebrew/var/log/postgresql@16.log` |
| `password authentication failed for user "mbc"` / `role "mbc" does not exist` | Redo 1.2 (`psql postgres -c "ALTER ROLE mbc PASSWORD 'mbc_sandbox';"` if it exists) |
| `Node … is too old for Prisma 7` | `node -v`; make sure `/opt/homebrew/opt/node@22/bin` is first on PATH |
| `JWT_SECRET in your shell environment is empty or a published / placeholder value` | You exported `JWT_SECRET` somewhere. `unset JWT_SECRET` and run again |
| `EADDRINUSE` / port already in use | Another server is on that port: `lsof -i :3101`, stop it, or use `PORT=…` |
| Phone can't open the page | Started without `HOST=0.0.0.0`; or the Mac and phone are not on the same hotspot; or macOS blocked `node` (System Settings → Network → Firewall → Options) |
| "Too many login attempts" (429) | 10 wrong passwords for that login in 15 min. Wait, or restart the server |
| Every request returns 429 | More than 1000 requests in 15 min for one login. Restart the server |
| 403 "You must change your temporary password" | A temporary password; sign in again and the app shows "Choose a new password" (or the API, `SETUP.md` §3) |
| Email link to `reset-password.html` or `accept-invite.html` says it expired | Links work once and expire; ask for a new one (1.4) |
| `Failed to fetch sha256 checksum … binaries.prisma.sh` | Only happens without internet (or behind a strict proxy). `npm run migrate:deploy` still works offline |
| Backup fails: `pg_dump: error: aborting because of server version mismatch` | `pg_dump --version` must be 16; check the PATH line, or set `PG_DUMP_PATH=/opt/homebrew/opt/postgresql@16/bin/pg_dump` |
| `seed:demo` says REFUSED … trade | The database holds another trade's jobs: add `--reset`, or use a separate database (section 5) |
| `seed:demo` says `Unknown demo prospect` or refuses the path | `DEMO_PROSPECT` must be a bundled slug or the **absolute** path to your prospect JSON outside the repo (section 4) |
| `demo:check --headless`: `Chrome not found` | `export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` |
| `[CONFIG] FATAL: …` / `BrandConfigError` | The message names the variable: usually a `BRAND_*` typo (bad colour, unknown trade, time zone, tax rates or job types) |
| Docker: `port is already allocated` | Change `PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT` or `MAILPIT_UI_PORT` in `.env` |
| Docker: app keeps restarting | `docker compose logs app`; usually `DATABASE_URL` edited away from host `postgres` |
| Start completely fresh (sandbox) | `dropdb -U mbc mbc_sandbox && rm backend/.env.sandbox && npm run sandbox` (deletes the sandbox data) |

More detail: `SETUP.md` (environment variables, tests, white-label, import/export), `docs/FEATURES.md` (what works),
`backend/SECURITY_AUDIT.md` (what is and is not secured), `DEPLOYMENT.md` (client servers).
