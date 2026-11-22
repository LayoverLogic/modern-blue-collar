# Security status: Modern Blue Collar

**Date:** 2026-11-21
**Code:** `mbc/sandbox-revival` at `808631f` (job activity log merged). Later merges can change this page;
re-run the suites in §5 before relying on it.
**Written by:** the MBC revival team (Compliance & Docs), from reading the code and running the test suites.
This is not an external penetration test. No production deployment of this code exists yet.

This page replaces the "Security Audit Report" dated 2026-03-24. In Phase 1 the Red Team found that report's
claims 3 (locking on all writes), 6 (JWT secret enforced), 7 (numeric id validation), 8 (CSP) and 9 (audit
trail) false or only partly true, and also its claims that every route had a role guard. Every line below
names the file that does the work and the test that shows it. A control with no test is marked as such.

Finding IDs (RT-, PLAT-, UX-, WL-, GTM-) refer to `/home/claude/mbc-team/FINDINGS.md`.

---

## 1. Test results on this commit

Run on 2026-11-21 against throwaway databases (`TEST_DATABASE_URL=.../mbc_docs_test`):

| Suite | Command | Result |
|---|---|---|
| Prisma-level API | `npm test` | 69 / 69 pass |
| Red Team | `npm run test:redteam` | 46 / 48 pass. **Failing: RT-25, RT-3** (front end, see §3) |
| Backend contract | `npm run test:backend` | 21 / 21 pass (RT-30 skips if `pg_dump` is not on PATH) |
| Job activity log | `npm run test:activity` | 16 / 16 pass |
| White-label | `npm run test:whitelabel` | 36 / 36 pass |
| Sandbox drivers | `npm run test:platform` | 12 / 12 pass (2 backup tests skip without `DATABASE_URL`) |
| UI walk | `npm run test:ui` | Inspection tool, always exits 0. Not counted here |

`npm audit --omit=dev`: 3 high, all in the `intuit-oauth` → `query-string` → `decode-uri-component` chain,
no upstream fix (PLAT-7).

---

## 2. Enforced

"Proven by" names the suite and the test title (or its ID prefix).

### 2.1 Configuration and boot

| Control | Where | Proven by |
|---|---|---|
| With `NODE_ENV=production` the server refuses to start if `JWT_SECRET` is missing, under 32 characters, low-variety, a placeholder, or any value ever published in this repo | `helpers/security.js` (`jwtSecretProblem`, `assertBootConfig`), `helpers/publishedSecrets.js`, called first in `server.js` | redteam `RT-6` |
| Outside production a missing secret gets a random per-process secret and a warning (sessions end on restart) | `helpers/security.js` (`getJwtSecret`) | backend `RT-6 outside production…` |
| `DEMO_MODE=true` with `NODE_ENV=production` refuses to start | `helpers/security.js` | redteam `RT-23` |
| `/api/brand` returns demo login details only in demo mode | `server.js` (`/api/brand`) | backend `RT-23 /api/brand exposes demoLogin only in demo mode` |
| An invalid `BRAND_*` value (unknown trade, bad colour, unsafe logo URL, unknown time zone) stops the server at boot | `helpers/brandValidate.js`, `brand.config.js` | whitelabel `WL-5…`, `WL-6…`, `WL-7…`, `brand: invalid BRAND_TIMEZONE…` |
| Twilio, QuickBooks and Google make no network call when `SANDBOX_MODE=true`, when `DEMO_MODE=true` (Twilio, QuickBooks) or when credentials are missing or placeholders; routes answer 503 | `helpers/integrations.js` | platform `integrations: …` (3 tests); redteam `[regression] QuickBooks / SMS / Google are inert in sandbox` |

### 2.2 Authentication and sessions

| Control | Where | Proven by |
|---|---|---|
| Session tokens are HS256 only and must carry an integer user id and an expiry; `alg=none` and expired tokens are refused | `helpers/security.js` (`verifyToken`) | redteam `[regression] alg=none and expired tokens are rejected` |
| On every request the user row is re-read: deactivated or deleted users are refused and the role comes from the database, not the token | `routes/auth.js` (`requireAuth`, `userFromToken`) | redteam `RT-5a`, `RT-5b`, `RT-5c` |
| Token lifetime follows `JWT_EXPIRES` (default 8h) for password and Google sign-in | `helpers/security.js` (`signToken`) | backend `PLAT-3 one-time code…` (checks a 15m expiry) |
| Passwords are stored as bcrypt hashes (cost 12 for `POST /api/users` and the super-admin seed) | `routes/users.js`, `seed_superadmin.js` | `npm test` `Password hashes correctly` |
| Login and the Google code exchange are limited to 20 requests per 15 minutes per client IP; `/api/*` to 200 | `server.js` (`authLimiter`, `apiLimiter`) | redteam `[regression] login is rate-limited` |
| Behind a proxy, `TRUST_PROXY` makes the limiter key on the real client IP; without it `X-Forwarded-For` is ignored | `server.js` (`parseTrustProxy`) | backend `RT-24` |
| Google sign-in is fail-closed: an existing active user with a verified Google email signs in; an unknown email is created only if its domain is in `GOOGLE_ALLOWED_DOMAINS` (empty = nobody); deactivated users and unverified emails are refused | `routes/googleAuth.js` (`resolveGoogleUser`) | backend `PLAT-3 Google gate…` (2 tests) |
| No JWT in any URL: Google redirects with a single-use code that expires in 60 s and is exchanged by POST; OAuth `state` is random and checked against an HttpOnly cookie | `routes/googleAuth.js` | backend `PLAT-3 one-time code…` |

### 2.3 Authorisation

Roles are `super-admin`, `admin`, `dispatcher`, `office`, `technician` (`helpers/roles.js`).

| Control | Where | Proven by |
|---|---|---|
| Nobody can raise their own role or change their own active flag; only a super-admin can create, edit or promote admins and super-admins; unknown role strings are rejected | `routes/users.js`, `routes/invites.js` | redteam `RT-1a`, `RT-1b`, `RT-1c`, `RT-7a`, `RT-7b`; backend `role matrix…` |
| Deletes of jobs, customers and communication entries are admin-only; price book, quote and invoice writes are admin-only; exports, backups and the user list are admin-only | `helpers/roles.js` groups + `requireRole` on each route | redteam `RT-8a`–`RT-8d`, `[regression] billing writes are admin-only…` |
| Technicians see only their own jobs and the customers, invoices, quotes and communications on them; they may change only status and notes on their own job (not cancel, not reschedule) and cannot create jobs | `helpers/access.js`, `routes/jobs.js`, `routes/customers.js`, `routes/invoices.js`, `routes/quotes.js`, `routes/communications.js` | redteam `RT-21`; backend `RT-21 technicians list only their own…`, `RT-8 technician may update status/notes…` |
| Only office roles send SMS, and only to a number that belongs to a customer on record | `routes/sms.js` | redteam `RT-16`; backend `RT-16 office roles can SMS a customer number on record` |
| API keys: only the bcrypt hash is stored; lookup prefix is 16 characters; a key acts as its creator with the creator's current role and stops working when the creator is deactivated; `read` scope allows GET/HEAD only, `write` the rest | `middleware/apiKeyAuth.js`, `routes/auth.js` (`requireAuth`, `scopeFor`) | redteam `RT-4`, `RT-22`, `[regression] revoked API key is rejected…`; backend `RT-22 new API keys use a 16-char prefix…` |
| API keys cannot manage users, API keys, invites, backups or QuickBooks connections (a signed-in person is required) | `routes/auth.js` (`requireSession`) on those routes | code review (redteam `RT-1c` covers a read-only key; no test uses a write-scoped key against these routes) |
| Socket.io connections need a valid token; presence identity comes from the token, never from the message; malformed events cannot crash the process; the presence REST endpoints need sign-in | `server.js` (`io.use`, `safeHandler`, `/api/presence`) | redteam `RT-2`, `RT-14a`, `RT-14b`; backend `RT-14` |
| QuickBooks connect is admin-only; the OAuth `state` is random, single-use, valid 10 minutes and bound to both the admin and their browser cookie | `routes/quickbooks.js` | backend `PLAT-4…` |

### 2.4 Input, output and data integrity

| Control | Where | Proven by |
|---|---|---|
| Quote and invoice amounts must be finite and greater than 0; invoice status is `unpaid`, `paid`, `overdue` or `void` | `helpers/validate.js`, `routes/quotes.js`, `routes/invoices.js` | redteam `RT-11a`–`RT-11d` |
| Job status is `pending`, `scheduled`, `in-progress`, `completed` or `cancelled`; reopening clears `completedAt` | `routes/jobs.js` | redteam `RT-12a`, `RT-12b` |
| A technician cannot be booked into overlapping slots (`SCHEDULE_CONFLICT`). The check runs under a per-technician Postgres advisory lock so two simultaneous bookings cannot both pass | `routes/jobs.js` | redteam `RT-13` (sequential case; the concurrent case is code review only) |
| Optimistic locking on PATCH/PUT for **jobs, customers, quotes and invoices**: `version` is required (400 `VERSION_REQUIRED`) and the write is one atomic `UPDATE … WHERE version = $n` (409 `VERSION_CONFLICT`) | `helpers/optimisticUpdate.js` | redteam `RT-9`, `[regression] stale version gets 409`; backend `RT-9…` |
| Query strings are flat strings: nested or repeated keys cannot reach Prisma as operators | `server.js` (`query parser`, query sanitiser) | backend `RT-28` |
| Errors: Prisma and multer errors are mapped to 4xx with a short message; unknown errors are a generic 500; no Prisma text, SQL or stack frames reach the client | `helpers/errorHandler.js` | redteam `RT-17a`–`RT-17d`; backend `RT-17…` |
| JSON bodies are limited to 1 MB | `server.js` (`express.json({ limit: '1mb' })`) | no dedicated test |
| Photo uploads: one file, 10 MB, type detected from the bytes (JPEG, PNG, GIF, WebP, HEIC/HEIF, AVIF); HTML and SVG are refused; storage keys cannot escape the storage root; deleting a job deletes its photo files | `routes/jobs.js`, `helpers/imageSniff.js`, `helpers/storage.js` | redteam `RT-20a`, `RT-20b`, `RT-17d`, `RT-19`, `[regression] upload filename path traversal…`; platform `storage: local driver rejects path-traversal keys` |
| CSV exports: cells starting with `= + - @`, tab or CR are prefixed so spreadsheets show them as text | `routes/exports.js` (`csvCell`) | redteam `RT-10` |
| Database access goes through Prisma; the two raw queries (`routes/sms.js`, `routes/jobs.js`) are tagged templates, so values are bound parameters | those files | code review only |

### 2.5 Headers, origins, webhooks

| Control | Where | Proven by |
|---|---|---|
| Content-Security-Policy on every response: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `connect-src 'self'` (but see §3: inline scripts allowed) | `server.js` (`helmet`) | redteam `RT-15`; backend `RT-15 CSP allows the inline pages but blocks plugins, framing and base hijack` |
| `X-Powered-By` removed; helmet's other default headers set | `server.js` | redteam `[regression] alg=none… x-powered-by hidden` |
| CORS: same-origin only unless `APP_URL` / `CORS_ORIGINS` name an origin (Express and Socket.io) | `server.js` (`allowedOrigins`) | backend `RT-27` |
| Gmail webhook: 503 until `GMAIL_WEBHOOK_SECRET` (16+ characters) is set; wrong secret 401; compared in constant time. (The handler itself is still a placeholder.) | `routes/communications.js` | redteam `RT-26`; backend `RT-26…` |
| The invites router is mounted once (`/api/invites`); the old `/api/auth/send` path is gone | `server.js`, `routes/invites.js` | backend `invites: … RT-29` |

### 2.6 Secrets and integrations at rest

| Control | Where | Proven by |
|---|---|---|
| QuickBooks tokens are stored in the `IntegrationToken` table encrypted with AES-256-GCM; the key is `INTEGRATION_ENCRYPTION_KEY` or, if unset, derived from `JWT_SECRET` (HKDF); the status endpoint never returns tokens | `helpers/secretBox.js`, `routes/quickbooks.js` | backend `PLAT-4…` |
| `npm run sandbox` replaces any placeholder or published `JWT_SECRET` in the local `.env.sandbox` with a random one | `scripts/sandbox.js` (`fillGeneratedSecrets`) | code review only |

### 2.7 Job activity log (GTM-18)

| Control | Where | Proven by |
|---|---|---|
| Every committed change to a **job** writes an entry in the same transaction: created, updated, status changed, assigned, rescheduled, note, photo added/removed, deleted. Rejected or rolled-back changes write nothing | `helpers/activity.js`, `routes/jobs.js` | activity `created…`, `status_changed…`, `assigned…`, `rescheduled…`, `note…`, `updated…`, `photo_added / photo_removed…`, `atomic…` |
| Each entry names the actor: user, API key (and its owner) or system; names survive user deletion | `helpers/activity.js` | activity `API-key actor…`, `actor names survive…` |
| Append-only through the API: no route edits or deletes entries; deleting a job keeps its history plus a tombstone | `routes/activity.js`, migration `20261121150000_job_activity` (FK `ON DELETE SET NULL`, CHECK on `type`) | activity `append-only…`, `tombstone…` (2 tests) |
| Technicians read only their own jobs' activity; office roles read all | `routes/activity.js` | activity `scoping…` |

### 2.8 Deployment shape and demo data

| Control | Where | Proven by |
|---|---|---|
| Docker Compose does not publish Postgres; MinIO and Mailpit (demo profile) bind to 127.0.0.1; the app's host bind address is `APP_BIND` | `docker-compose.yml`, `docker-compose.db-port.yml` | code review only (no Docker daemon in the team sandbox) |
| `seed:demo` refuses databases whose name lacks `demo`, `sandbox`, `test` or `wl` and refuses `NODE_ENV=production`; demo people, emails and phone numbers are fictional (reserved domains, 555-01xx, ComReg drama ranges) | `demo/lib/guard.js`, `demo/lib/dataset.js` | whitelabel `guard: only demo-named databases are seeded`, `seed data … fictional, no client names`, `prospects: reserved email domains only…` |
| The client-name denylist is kept out of git (`backend/demo/denylist.local.txt` is ignored) | `.gitignore`, `demo/lib/guard.js` | whitelabel `denylist: real list stays out of git…` |
| `npm test` and the other database suites run only against `TEST_DATABASE_URL`, refuse the app database, and (for `npm test`) require "test" in the database name | `tests/api.test.js` and suite headers | the suites refuse to start otherwise (no separate test) |

---

## 3. Partial

| Area | What is done | What is not | IDs |
|---|---|---|---|
| **Content-Security-Policy** | Policy sent on every page (§2.5) | `script-src` and `script-src-attr` include `'unsafe-inline'` because the pages use inline `<script>` blocks and `onclick` attributes. The CSP therefore does **not** stop injected script. Removing it means moving page scripts into files | RT-15 |
| **Cross-site scripting** | Server-side: uploads refuse HTML/SVG; error bodies carry no markup | Pages build HTML with `innerHTML` from stored data. **redteam `RT-3` fails on this commit.** Combined with the inline-script CSP and the session token in `localStorage`, a stored XSS can take over the session of whoever views the record. Frontend Phase 2 is rewriting the pages | RT-3 (open, High) |
| **Pages load at all** | API works end to end (see suites) | **redteam `RT-25` fails:** five pages (`index.html` login/dashboard, `customers`, `customer-detail`, `dispatch`, `quote-invoice`) have a quoting SyntaxError and do not run, so nobody can sign in through the UI on this commit | RT-25 / UX-1 / WL-1 (Critical, in progress) |
| **Audit logging** | Job changes only (§2.7) | Not logged: changes to customers, quotes, invoices, price book, users, roles, API keys; sign-ins and failed sign-ins; exports; SMS sends; backups. `quote_created` / `invoice_created` exist in the helper and the table's CHECK list but **the quote and invoice routes do not call them yet**. The customer communications log is ordinary data (admins can delete entries), not an audit trail. There is no request log: the app logs errors to the console only | GTM-18 |
| **Optimistic locking** | Jobs, customers, quotes, invoices | Price book items and users have no `version`: last write wins | RT-9 |
| **Passwords** | bcrypt; `POST /api/users` requires 10–72 characters | The length rule has no test. Seeds do not apply it (demo password `demo1234` is 8 characters). There is **no password change or reset flow** (`PATCH /api/users/:id` refuses `password`); invited users get an unusable random password and can only sign in with Google. No MFA. No per-account lockout (only the per-IP rate limit) | RT-7 (part) |
| **Sessions** | Short-lived JWT, re-checked against the user row on every request | Token is a bearer token in `localStorage` (readable by any script on the page). Logout only discards it in the browser; it stays valid until expiry unless the user is deactivated or demoted or `JWT_SECRET` is rotated (which signs everyone out and, without `INTEGRATION_ENCRYPTION_KEY`, also makes stored QuickBooks tokens unreadable) | RT-5 (part) |
| **Rate limiting** | Per IP, per process (§2.2) | Counters are in memory: they reset on restart and are not shared between processes. One office behind one IP shares the 200 / 15 min budget | UX-15 |
| **HTTPS** | helmet sends `Strict-Transport-Security`; cookies get `Secure` in production | The app does not terminate TLS. A reverse proxy (Caddy in the hosting plan) must, and `TRUST_PROXY` must then be set | – |
| **Exports** | CSV for customers, jobs, invoices; formula injection neutralised; admin-only | No export-everything (quotes, communications, photos, activity are not exported). A brand name containing a curly apostrophe breaks every export with a 500, and non-ASCII names are garbled in the filename | GTM-20, WL-14 |
| **Backups** | Nightly `pg_dump` at 03:00 (brand time zone), gzipped; fails loudly; local or S3-compatible upload; admin-only manual run with cooldown | Dumps are **not encrypted**; **photos are not backed up**; no restore script or tested restore; settings still use `WASABI_*` names. Platform is reworking this in Phase 2c (see DEPLOYMENT.md once updated) | GTM-16, GTM-12 |
| **Dependencies** | Upgraded in PLAT-7 | 3 high (no upstream fix) via `intuit-oauth`, which is only needed for QuickBooks. Decision for Alex: drop it until real QuickBooks sync is built | PLAT-7 |
| **Integrations** | Inert unless configured; QuickBooks OAuth hardened | QuickBooks invoice sync is a stub that returns success without sending anything. Gmail sync and webhook handlers are placeholders | GTM-4 |

---

## 4. Known open (design limits and work in progress)

1. **In-memory state, single process only.** Google one-time login codes (`routes/googleAuth.js`, `loginCodes`),
   QuickBooks OAuth states (`routes/quickbooks.js`, `pendingStates`), presence (`server.js`, `presence`),
   rate-limit counters and the backup running/cooldown flags (`routes/backup.js`) live in process memory. A restart
   drops them (users retry sign-in or QuickBooks connect; presence rebuilds). Running two app processes behind a
   load balancer would break Google sign-in and QuickBooks connect and split the rate limits. The hosting plan is
   one process per client, which is fine; anything else needs a shared store first.
2. **Single-tenant by design.** There is no Company model and no tenant column. Isolation between clients exists
   only because each client gets its own server, database, storage and secrets. API keys and roles are global to
   an instance. Never point two clients at one database.
3. **Money is stored as `Float`** (`Quote.amount`, `Invoice.amount`, price book `price`/`cost`, inventory and part
   costs in `prisma/schema.prisma`). Validation stops zero, negative and non-finite amounts, but binary floating
   point can still round cents. The move to `Decimal` with line items and tax is in progress on the Backend branch
   (GTM-9, RT-11 remainder) and is not on this commit.
4. **Migrations are hand-written SQL.** The team sandbox cannot run Prisma's native schema engine, so schema changes
   are written by hand and applied with `scripts/migrate-deploy.mjs` (Prisma's engine compiled to WebAssembly).
   That path goes through the `pg` driver adapter, which **splits each migration file on every `;`**
   (`@prisma/adapter-pg`, `executeScript`): no PL/pgSQL functions or triggers, and no `;` inside comments or string
   literals (PLAT-15). No drift check between `schema.prisma` and the migrations has been run yet; it needs a machine
   with the native engine (Alex's Mac, see `docs/RUN-ON-MAC.md` §1.4). The `JobActivity_jobId_fkey` foreign key is
   deliberately in the migration but not in `schema.prisma`, so a drift check is expected to report it.
5. **No retention or erasure tooling.** Deleting a customer fails (409) while jobs or communications reference it,
   so erasure is a manual, ordered delete. Activity entries keep job snapshots (title, description, notes,
   schedule, ids) after the job is deleted and have no delete route; erasing them needs direct database access.
   There is no automated purge and no "anonymise customer" action.
6. **No monitoring or alerting** in the code: `/api/health` exists for an external checker; nothing reports backup
   failures (GTM-12).
7. **Repository visibility.** The GitHub repository is public. Client branch history contains a committed
   `backend/.env` and client names (WL-16); README and `package.json` say MIT (GTM-13, see `LICENSE-PROPOSAL.md`).
   Decisions for Alex and Paul.
8. **Prospect demo env files keep a published `JWT_SECRET`** (found while writing this page; not yet in
   FINDINGS.md). `seed-demo.js --print-env` copies `JWT_SECRET=__GENERATE_ON_FIRST_RUN__` from
   `.env.sandbox.example`, and `scripts/sandbox.js` only replaces placeholder secrets when `ENV_FILE` is **not** set,
   so `ENV_FILE=.env.demo.<slug> npm run sandbox` boots (development mode, warning only) with a secret anyone can
   read in this public repo. `server.listen(PORT)` listens on all network interfaces, so anyone who can
   reach the machine (same Wi-Fi, a tunnel) could forge a super-admin token for that demo. Until fixed, put a random value in the generated file
   (`docs/RUN-ON-MAC.md` §3 shows how).
9. **Address and phone handling** are US-shaped (required city/ZIP, state default `KS`, no phone normalisation).
   Not a security issue, but missing fields currently surface as validation errors (WL-11, WL-12).

---

## 5. How to re-verify

From `backend/`, with a PostgreSQL role that can create databases (the sandbox uses `mbc` / `mbc_sandbox`):

```bash
npm install
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_verify_test?schema=public"
PGPASSWORD=mbc_sandbox createdb -h localhost -U mbc mbc_verify_test
# (npm test needs the database to exist; the node:test suites create it if missing)

npm test                    # Prisma-level suite (69). Refuses unless the DB name contains "test"
npm run test:redteam        # 48 attack tests. RT-3 needs Chrome (CHROME_PATH on a Mac)
npm run test:backend        # 21 contract tests. RT-30 needs pg_dump on PATH
npm run test:activity       # 16 activity-log tests
npm run test:whitelabel     # 36 brand / seed / demo tests (creates <db>_wl; needs CREATEDB)
DATABASE_URL="$TEST_DATABASE_URL" npm run test:platform   # 12 driver tests
npm audit --omit=dev        # production dependency advisories
```

The database suites clean up only their own rows and can share one `TEST_DATABASE_URL`. Never point them at a
database with data you want to keep.

Manual checks not covered by a suite:

- `curl -sI http://localhost:<port>/ | grep -i content-security-policy` shows the policy in §2.5.
- `NODE_ENV=production JWT_SECRET= node server.js` exits with `[CONFIG] FATAL`.
- `docker compose config` shows no `ports:` on `postgres`, and `127.0.0.1:` on MinIO and Mailpit.
- `npm run demo:check -- --port <port>` before any demo (it warns that `/api/brand` does not yet return `logoUrl` /
  `faviconUrl`, see WL-7).

When a fix lands, move its row from §3 or §4 to §2 with the test that proves it, and update the date and commit
at the top.
