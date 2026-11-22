# Security status: Modern Blue Collar

**Date:** 2026-11-21
**Code:** `mbc/sandbox-revival` at `0cc0953` plus backend fix round B4 (branch `mbc/backend5`: the findings of
Independent Verifier #1 — M1–M5, L1–L4, L6–L9, L11, L12, the export-scope item and GAP-16 server side). Later
merges can change this page; re-run the suites in §5 before relying on it.
**Written by:** the MBC revival team (Compliance & Docs), from reading the code and running every suite.
This is not an external penetration test. **No production deployment of this code exists yet**, and the
Docker / VPS path (`DEPLOYMENT.md`) has not been run on a real server (§4.8).

This page replaces the "Security Audit Report" dated 2026-03-24, whose claims of locking on all writes, an
enforced JWT secret, numeric id validation, a strict CSP, an audit trail and a role guard on every route the Red
Team found false or only partly true in Phase 1. Every row below names the file that does the work and the
test that shows it. A control with no test says so.

Finding IDs (RT-, PLAT-, UX-, WL-, GTM-, GAP-, DOC-) refer to `/home/claude/mbc-team/FINDINGS.md`.

---

## 1. Test results on this commit

Run on 2026-11-21 (B4) against throwaway databases (`TEST_DATABASE_URL=.../mbc_backend5_test`), Chrome and
`pg_dump` 16 available, so nothing was skipped:

| Suite | Command | Result |
|---|---|---|
| Prisma-level API | `npm test` | 69 / 69 pass |
| Red Team | `npm run test:redteam` | 48 / 48 pass (RT-3 stored XSS and RT-25 pages now pass) |
| Backend contract | `npm run test:backend` | 45 / 45 pass |
| Job activity log | `npm run test:activity` | 18 / 18 pass |
| Line-item documents, money, locale | `npm run test:documents` | 22 / 22 pass |
| Imports, exports, Xero, QuickBooks | `npm run test:integrations` | 21 / 21 pass (QuickBooks against a local stub; the payment sync-back test is now deterministic, L11) |
| Accounts (passwords, leavers, invites) | `npm run test:accounts` | 25 / 25 pass |
| White-label | `npm run test:whitelabel` | 48 / 48 pass |
| Platform drivers, backup and restore | `npm run test:platform` | 23 / 23 pass |
| UI walk (headless Chrome) | `npm run test:ui` | **exits 1**: 102 / 102 page captures clean (no console, page or HTTP errors, no placeholder text), XSS segment all pass, main flow 53 / 54 (see §1.1) |

`npm audit --omit=dev`: **0 vulnerabilities** (the `intuit-oauth` chain behind PLAT-7 was removed; QuickBooks now
uses `fetch`). `npm audit` including dev dependencies: **0** as well — nodemon 3.1.14 (the latest) still asks for
`minimatch ^10`, inside GHSA-g3hv-75wg-m249, so `package.json` overrides it for nodemon only to `^11.0.1`
(watch, ignore and restart checked by hand; L12).

### 1.1 UI walk

`UI_PORT=3146 npm run test:ui` against a fresh sandbox database (B4). The one failing flow step is **6g.
Reverse charge**: the walk runs the US demo with sales tax and creates a reverse-charge invoice, which the server
now refuses on purpose (GAP-16: reverse charge exists for VAT, not US sales tax). With `BRAND_REVERSE_CHARGE=true`
the flow is 54 / 54. Fix belongs in the walk (gate the step on `locale.reverseChargeAvailable`). On `6d63a31` the
failing step was 7 (invite link), fixed by Frontend F3.

---

## 2. Enforced

"Proven by" names the suite and the test title (or its ID prefix).

### 2.1 Configuration and boot

| Control | Where | Proven by |
|---|---|---|
| With `NODE_ENV=production` the server refuses to start if `JWT_SECRET` is missing, under 32 characters, low-variety, a placeholder, or any value ever published in this repo | `helpers/security.js` (`jwtSecretProblem`, `assertBootConfig`), `helpers/publishedSecrets.js`, first thing in `server.js` | redteam `RT-6`; backend `M1 the B4 whitelabel literal is refused in production…` |
| **The published list stays complete** (M1): a test scans every tracked file (tests, docs, env examples, scripts) and the git history for JWT-secret-like literals (`JWT_SECRET=…`, `JWT_SECRET: '…'`, `|| '…'` fallbacks, `jwt.sign(…, '…')`, `const …SECRET = '…'`) and fails unless each one is refused. Test suites generate their secrets with `crypto.randomBytes` | `helpers/publishedSecrets.js` | backend `M1 every JWT-secret literal in the repo (tree + git history) is rejected as published` |
| `NODE_ENV` is read case-insensitively: `Production`, ` PRODUCTION ` get every production check (normalised to `production` with a warning, so Express agrees) (L7) | `helpers/loadEnv.js`, `helpers/security.js` (`isProduction`), `demo/lib/guard.js` | backend `L7 NODE_ENV is case-insensitive…` |
| Outside production a **published or placeholder** secret also stops the server, unless `SANDBOX_MODE=true` (then a random per-process secret is used, with a warning). A missing secret gets a random per-process secret | `helpers/security.js` | backend `2c non-production refuses a published / placeholder JWT_SECRET…`, `RT-6 outside production…` |
| `npm run sandbox` writes a fresh random `JWT_SECRET` into whichever env file it uses (including `ENV_FILE=.env.demo.<slug>`) and refuses a known secret from the shell; `seed-demo --print-env` writes a fresh random secret (file mode 0600). Fixes DOC-1 | `scripts/sandbox.js` (`fillGeneratedSecrets`), `scripts/seed-demo.js` | backend `2c sandbox.js writes a random JWT_SECRET…`, `2c seed-demo --print-env: fresh random JWT_SECRET…` |
| `npm run sandbox` listens on `127.0.0.1` unless `HOST` is set. `server.js` honours `HOST` (unset = all interfaces, for Docker) | `scripts/sandbox.js`, `server.js` | backend `2c sandbox.js serves on 127.0.0.1 by default (HOST env to override)` |
| The sandbox env file (it holds `JWT_SECRET`) is created mode 0600 and an existing one readable by group / others is tightened (L8); a localhost `APP_URL` follows `PORT` unless set in the shell (D1) | `scripts/sandbox.js` | backend `L8 / D1 sandbox.js keeps the env file private (0600)…` |
| `DEMO_MODE=true` with `NODE_ENV=production` refuses to start; `/api/brand` returns the demo login only in demo mode | `helpers/security.js`, `server.js` | redteam `RT-23`; backend `RT-23 /api/brand exposes demoLogin only in demo mode` |
| Invalid `BRAND_*` values (unknown trade, bad colour, unsafe logo URL, unknown time zone, bad locale / tax / job-type settings) stop the server at boot | `helpers/brandValidate.js`, `helpers/locale.js`, `brand.config.js` | whitelabel `WL-5…`, `WL-6…`, `WL-7…`, `B3 job types: BRAND_JOB_TYPES…`; documents `locale: … bad config fails fast` |
| `TECH_VISIBILITY` other than `own` / `all` falls back to `own` with a boot warning | `server.js`, `helpers/access.js` | code review (the two valid values are tested, §2.3) |
| Twilio, QuickBooks and Google make no network call when `SANDBOX_MODE=true`, when `DEMO_MODE=true` (Twilio, QuickBooks) or with missing / placeholder credentials; routes answer 503 | `helpers/integrations.js`, `helpers/qbo.js` | platform `integrations: …` (3 tests); redteam `[regression] QuickBooks / SMS / Google are inert in sandbox`; integrations `qbo: intuit-oauth is gone; sandbox server answers 503…` |
| QuickBooks endpoint overrides (`QBO_AUTHORIZE_URL`, `QBO_TOKEN_URL`, `QBO_API_BASE`, used by the test stub) must be `https` in production | `helpers/qbo.js` | code review |

### 2.2 Authentication, passwords and sessions

| Control | Where | Proven by |
|---|---|---|
| Session tokens are HS256 only, carry an integer user id, an expiry and the user's `sessionVersion` (`sv`); `alg=none`, expired and stale-`sv` tokens are refused | `helpers/security.js` (`signToken`, `verifyToken`), `routes/auth.js` (`userFromToken`) | redteam `[regression] alg=none and expired tokens are rejected…`; accounts `password change: … revokes OTHER sessions…` |
| The user row is re-read on every request: deactivated or deleted users are refused, the role comes from the database, not the token | `routes/auth.js` (`requireAuth`) | redteam `RT-5a`, `RT-5b`, `RT-5c` |
| **Session revocation**: password change, password reset, admin reset and deactivation bump `sessionVersion`, so every older token answers 401. Deactivation, deletion or a role change also disconnects the user's live sockets | `routes/auth.js`, `routes/users.js`, `server.js` (socket handshake) | accounts `password change…`, `admin reset: temporary password…`, `leavers: deactivate ends sessions and sockets at once…`; backend `2c sockets: deactivating, demoting or deleting a user disconnects their live sockets` |
| Passwords: bcrypt (cost 12); rule ≥ `PASSWORD_MIN_LENGTH` (default 10, never below 8) and ≤ 72 bytes on every path that sets one (change, reset, accept-invite, `POST /api/users`). Closes DOC-6 | `helpers/authTokens.js` (`checkPassword`, `hashPassword`) | accounts `password change: current + new, min length…`; `npm test` `Password hashes correctly` |
| **Password change** needs the current password; failures are rate-limited per user (`LOGIN_MAX_PER_EMAIL`); API keys are refused | `routes/users.js` (`PATCH /api/users/me/password`), `server.js` (`passwordChangeLimiter`) | accounts `password change: …`, `password change: API keys are refused…` |
| **Forced password change**: a generated super-admin password (`seed_superadmin.js`), users created by `POST /api/users` (default) and an admin "temporary password" reset set `mustChangePassword`; until it is changed every API call except `/me`, change password and logout answers 403 `PASSWORD_CHANGE_REQUIRED` (server-side) | `routes/auth.js` (`PASSWORD_CHANGE_ALLOWED`), `seed_superadmin.js`, `routes/users.js` | accounts `temporary password gate…`, `seed_superadmin: a generated password is temporary…` |
| **Forgot / reset password**: `POST /api/auth/forgot` always answers the same 200 (no account enumeration); the link is single-use, expires after `RESET_TOKEN_TTL_MINUTES` (30), only its sha256 is stored, at most 3 mails per account per 15 min, `RESET_RATE_MAX` (20) requests per IP per 15 min | `routes/auth.js`, `helpers/authTokens.js`, `server.js` (`resetLimiter`) | accounts `forgot password: always 200…`, `forgot / reset are rate limited per IP…` |
| **Admin reset** (temporary password shown once, or a reset link) follows the role matrix: admin / super-admin targets need a super-admin, not yourself, not a deactivated user | `routes/users.js` (`POST /api/users/:id/reset-password`) | accounts `admin reset: temporary password…; role matrix`, `admin reset: link mode…` |
| **Invites**: a new email gets a user plus a single-use accept-invite link (`INVITE_TTL_HOURS`, default 168) in one transaction; accepting sets a password and signs in; re-inviting replaces the link; a mail failure never leaves a half-done state | `routes/invites.js`, `helpers/authTokens.js` | accounts `invites: …` (3 tests), `invite accept / validate are rate limited per IP` |
| **Login limiter counts failures only**: `LOGIN_MAX_PER_EMAIL` (10) per IP + email and `LOGIN_MAX_PER_IP` (50) per IP, per 15 min; successful sign-ins never count (an office on one IP is not locked out). Google code exchange: `LOGIN_MAX_PER_IP` failures per IP | `server.js` (`loginPerEmailLimiter`, `loginPerIpLimiter`, `exchangeLimiter`) | accounts `login limiter: successful sign-ins never count…`; redteam `[regression] login is rate-limited` (title still says 20; it checks a 429 after 21 failures) |
| Other API calls: `RATE_LIMIT_USER_MAX` (1000) per signed-in user or API key and `RATE_LIMIT_IP_MAX` (300) per IP for anonymous calls, per 15 min. **Not counted** (M2): `GET /api/brand` (loaded without a token by every page, the sign-in page included) and the sign-in, Google exchange, forgot / reset and invite routes, which have their own limiters — an office behind one IP can always sign in | `server.js` (`apiLimiter`, `API_LIMITER_EXEMPT`) | documents `UX-15 the API limiter counts signed-in users separately…`; backend `M2 a busy office IP: 320 page loads … never block a correct sign-in`, `M2 the anonymous limiter still counts other anonymous /api calls…` |
| Behind a proxy, `TRUST_PROXY` makes the limiters key on the real client IP; without it `X-Forwarded-For` is ignored | `server.js` (`parseTrustProxy`) | backend `RT-24` |
| Google sign-in is fail-closed: an existing active user with a **verified** Google email signs in (a missing `email_verified` is refused); an unknown email is created only if its domain is in `GOOGLE_ALLOWED_DOMAINS` (empty = nobody); deactivated users are refused | `routes/googleAuth.js` (`resolveGoogleUser`) | backend `PLAT-3 Google gate…` (2 tests); documents `Google sign-in requires a positive email_verified` |
| No JWT in any URL: Google redirects with a single-use code (60 s) exchanged by POST; OAuth `state` is random and checked against an HttpOnly cookie | `routes/googleAuth.js`, `helpers/cookies.js` | backend `PLAT-3 one-time code…` |
| The last active super-admin can never be deactivated, demoted or deleted | `routes/users.js` | accounts `leavers: the last active super-admin…` |

### 2.3 Authorisation

Roles are `super-admin`, `admin`, `dispatcher`, `office`, `technician` (`helpers/roles.js`).

| Control | Where | Proven by |
|---|---|---|
| Nobody can raise their own role, change their own active flag or deactivate themselves; only a super-admin can create, edit, promote, reset, deactivate or re-invite admins and super-admins; unknown roles are rejected | `routes/users.js`, `routes/invites.js` | redteam `RT-1a`–`RT-1c`, `RT-7a`, `RT-7b`; backend `role matrix…`; accounts `leavers: role change follows the matrix…` |
| Deletes of jobs, customers and communication entries are admin-only; price book, quote and invoice writes, document email, imports, exports, backups and the user list are admin-only | `helpers/roles.js` groups + `requireRole` on each route | redteam `RT-8a`–`RT-8d`, `[regression] billing writes are admin-only…`; documents `roles: only admin roles write, email or invoice-from-quote…`; integrations `import: admin only…`, `exports: … admin only` |
| **`TECH_VISIBILITY=own`** (default): technicians see only their own jobs and the customers, quotes, invoices, photos, activity and communications on them. **`all`**: technicians may READ every job and customer (schedule, detail, photos, activity); quotes / invoices of other people's jobs are null and other customers' communications are empty; writes stay own-job only. Either way they may change only status and notes (not cancel, not reschedule) and cannot create jobs or send SMS | `helpers/access.js`, `routes/jobs.js`, `routes/customers.js`, `helpers/documentRoutes.js`, `routes/communications.js` | backend `2c TECH_VISIBILITY=own…`, `2c TECH_VISIBILITY=all…`, `RT-21…`, `RT-8 technician may update status/notes…`; redteam `RT-21` |
| A technician may delete only photos they uploaded, on their own jobs (`NOT_OWNER`); office roles any photo | `routes/jobs.js` | backend `2c photos: … a technician may delete only photos they uploaded` |
| **Presence follows `TECH_VISIBILITY`** (L1): with `own` a technician gets presence (REST `GET /api/presence`, `/api/presence/:jobId` → 403) and can join a job's presence room (socket `viewing-job` → `presence-denied`) only for their own jobs | `server.js` | backend `L1 presence honours TECH_VISIBILITY=own…` |
| Price book **cost** is returned to pricing roles (admin, super-admin) only; technicians and dispatchers get items without it (L2). `GET /api/users/technicians` as a technician lists only active technicians' names — no admins, emails or phones (L3) | `routes/pricebook.js`, `routes/users.js` | backend `L2 price book cost is for pricing roles only; L3 technicians get technician names only` |
| Only office roles send SMS, and only to a number that belongs to a customer on record (matched on E.164) | `routes/sms.js` | redteam `RT-16`; backend `RT-16…`, `2c WL-12 customers and users store E.164…; SMS goes to E.164` |
| API keys: `GET /api/exports/all` (every table at once) needs the `export` or `write` scope on top of `read`; a read-only key gets 403 `SCOPE_REQUIRED` (Verifier #1 info item) | `routes/exports.js`, `middleware/apiKeyAuth.js` (`requireAnyScope`), `routes/apiKeys.js` | integrations `Info: an API key needs the export (or write) scope…` |
| API keys: only the bcrypt hash is stored; 16-character lookup prefix; a key acts as its creator with the creator's current role and stops working when the creator is deactivated; `read` scope allows GET/HEAD only | `middleware/apiKeyAuth.js`, `routes/auth.js` | redteam `RT-4`, `RT-22`, `[regression] revoked API key is rejected…`; backend `RT-22…` |
| A signed-in person (not an API key) is required to manage users, API keys, invites, backups, QuickBooks, to change a password, and to commit an import | `routes/auth.js` (`requireSession`) on those routes | accounts `password change: API keys are refused`; integrations `import: … real run refused for API keys`; other routes code review (redteam `RT-1c` covers a read-only key) |
| Socket.io needs a valid token at the handshake (re-checked on reconnect); presence identity comes from the token, never from the message; malformed events cannot crash the process; the presence REST endpoints need sign-in | `server.js` (`io.use`, `safeHandler`, `/api/presence`) | redteam `RT-2`, `RT-14a`, `RT-14b`; backend `RT-14` |
| QuickBooks connect is admin-only; the OAuth `state` is random, single-use, valid 10 minutes and bound to both the admin and their browser cookie | `routes/quickbooks.js` | backend `PLAT-4…`; integrations `qbo OAuth: … state single-use` |

### 2.4 Input, money and data integrity

| Control | Where | Proven by |
|---|---|---|
| **Money is `Decimal(12,2)`** in the database (quantities `Decimal(12,3)`, tax rates `Decimal(6,3)`); totals are computed with decimal arithmetic, half-up per line and per tax rate; client-sent totals are ignored when lines are sent | `prisma/schema.prisma`, migration `20261121140000_documents_locale`, `helpers/documents.js`, `helpers/prisma.js` | documents `totals: per-line half-up rounding to cents, Decimal (not float) arithmetic`, `totals: 13.5 % and 23 % VAT…`, `IE quote with lines: server computes totals…` |
| Quote / invoice numbers are unique and gap-free under concurrency; a failed create uses no number | SQL function `mbc_next_document_number`, `helpers/documentRoutes.js` | documents `numbers: unique and gap-free under 20 concurrent creates…` |
| A sent quote or a sent / paid / overdue / void invoice is locked: only its status may change (409 `DOCUMENT_LOCKED`); locked documents cannot be deleted | `helpers/documents.js`, `helpers/documentRoutes.js` | documents `immutability: a sent quote / paid invoice only accepts status changes` |
| One live (non-void) invoice per quote (partial unique index); a job may have several quotes and invoices | migration `20261121180000_accounts_multi_documents`, `routes/invoices.js` | accounts `documents: a job may have several quotes and invoices; one live invoice per quote…`; redteam `RT-17a` |
| Amounts must be finite and > 0 (invoices) / ≥ 0 (quotes); statuses are fixed lists; reopening a job clears `completedAt` | `helpers/validate.js`, `routes/jobs.js`, `helpers/documentRoutes.js` | redteam `RT-11a`–`RT-11d`, `RT-12a`, `RT-12b` |
| A technician cannot be double-booked (`SCHEDULE_CONFLICT`), checked under a per-technician Postgres advisory lock | `routes/jobs.js` | redteam `RT-13` (sequential case; the concurrent case is code review only) |
| Optimistic locking on PATCH/PUT for jobs, customers, quotes and invoices: `version` required, one atomic `UPDATE … WHERE version = $n` (409 `VERSION_CONFLICT`) | `helpers/optimisticUpdate.js` | redteam `RT-9`, `[regression] stale version gets 409`; backend `RT-9…` |
| **Phone numbers are normalised to E.164** for customers (by the customer's country, else the brand country), users and invites; invalid numbers are 400 `INVALID_PHONE`; SMS always goes to the E.164 number | `helpers/phone.js`, `routes/customers.js`, `routes/users.js`, `routes/invites.js`, `routes/sms.js` | backend `2c WL-12 helpers/phone…`, `2c WL-12 customers and users store E.164…`, `2c WL-12 on an IE brand…` |
| Addresses validated by locale (IE: line 1, town, county required, Eircode normalised; US ZIP format); never a 500 | `helpers/locale.js`, `routes/customers.js` | documents `addresses: IE requires line 1 / town / county…` |
| Query strings are flat strings (no Prisma operators); JSON bodies ≤ 1 MB | `server.js` | backend `RT-28`; body limit has no dedicated test |
| Errors are mapped to 4xx with a short message and a code; no Prisma text, SQL or stack frames reach the client | `helpers/errorHandler.js` | redteam `RT-17a`–`RT-17d`; backend `RT-17…` |
| Photo uploads: one file, 10 MB, type detected from the bytes (JPEG, PNG, GIF, WebP, HEIC/HEIF, AVIF); HTML and SVG refused; storage keys cannot escape the storage root; deleting a job deletes its photo files | `routes/jobs.js`, `helpers/imageSniff.js`, `helpers/storage.js` | redteam `RT-20a`, `RT-20b`, `RT-17d`, `RT-19`, `[regression] upload filename path traversal…`; platform `storage: local driver rejects path-traversal keys` |
| Imports: dry run by default (writes nothing); one transaction per batch, a failing batch rolls back; file size ≤ `IMPORT_MAX_BYTES`; a sha256 guard so the committed file is the one that was reviewed; undo | `routes/imports.js`, `helpers/importer.js`, `routes/pricebook.js`, `helpers/pricebookImport.js` | integrations `import dry run…`, `import commit…` (2 tests); accounts `pricebook import: …` |
| CSV exports: cells starting with `= + - @`, tab or CR are prefixed so spreadsheets show them as text — except values that can only be numbers (`^\+[0-9 ]+$` phones, `^-[0-9]+(\.[0-9]+)?$` amounts; L9: no function, reference or DDE target possible; Apache Superset exempts negative numbers likewise; LibreOffice Calc checked); RFC 5987 file names | `helpers/csv.js`, `routes/exports.js` | redteam `RT-10`; integrations `L9 csv: + / - cells that can only be numbers…`, `exports: … formula escaping kept`; documents `WL-14…` |
| **Reverse charge only where it exists** (GAP-16): `locale.reverseChargeAvailable` (VAT countries with tax rates, `BRAND_RCT_NOTE`, or `BRAND_REVERSE_CHARGE`); otherwise `reverseCharge: true` → 400 `REVERSE_CHARGE_UNAVAILABLE` (US sales tax) | `helpers/locale.js`, `helpers/documentRoutes.js` | documents `GAP-16 reverse charge…` |
| Database access goes through Prisma; raw queries are tagged templates (bound parameters), except one fixed SQL string with a bound time-zone parameter at boot | `routes/sms.js`, `routes/jobs.js`, `server.js`, `helpers/calendarDate.js` | code review only |

### 2.5 Headers, origins, pages

| Control | Where | Proven by |
|---|---|---|
| **Strict Content-Security-Policy**: `script-src 'self'`, `script-src-attr 'none'`, `style-src 'self'` (no `'unsafe-inline'` anywhere), `img-src 'self' data: blob:` (+ the https origin of an external logo), `connect-src 'self'` + same-host ws/wss, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. No page uses inline `<script>`, `on*` attributes, `style=""` or `<style>` | `server.js` (`helmet`), `helpers/csp.js`, `backend/public/` | backend `RT-15 CSP: scripts and styles from self only…`, `2c CSP static check: no inline <script>, on* handler, style attribute or <style> in public/`, `2c CSP in a real browser: every page in public/ loads with zero violations (signed out, admin, technician)`; redteam `RT-15` |
| **Stored XSS**: customer and job data is rendered as text | `backend/public/js/` (text nodes / escaping) | redteam `RT-3` (headless Chrome); `test:ui` XSS segment |
| Every page parses and runs (RT-25 / UX-1 fixed) | `backend/public/` | redteam `RT-25`; `demo:check --headless` |
| HTML is served `Cache-Control: no-store`; `X-Powered-By` removed; helmet's other headers (HSTS, nosniff, …) set | `server.js` | documents `/api/brand: … HTML is no-store`; redteam `[regression] … x-powered-by hidden` |
| CORS: same-origin only unless `APP_URL` / `CORS_ORIGINS` name an origin (Express and Socket.io) | `server.js` (`allowedOrigins`) | backend `RT-27` |
| Gmail webhook: 503 until `GMAIL_WEBHOOK_SECRET` (16+ characters) is set; wrong secret 401; constant-time compare. (The handler itself is still a placeholder.) | `routes/communications.js` | redteam `RT-26`; backend `RT-26…` |

### 2.6 Secrets, backups and exports

| Control | Where | Proven by |
|---|---|---|
| QuickBooks tokens are stored AES-256-GCM encrypted (`INTEGRATION_ENCRYPTION_KEY`, else derived from `JWT_SECRET`); refresh tokens rotate and are persisted before use; status endpoints never return tokens | `helpers/secretBox.js`, `helpers/qbo.js`, `routes/quickbooks.js` | backend `PLAT-4…`; integrations `qbo OAuth: … tokens encrypted…`, `qbo tokens: expired access token is refreshed…` |
| **Backups**: nightly at 03:00 (brand time zone) and on demand: `pg_dump` + the photo folder (`STORAGE_DRIVER=local`) + a manifest with sha256s and row counts. With `BACKUP_ENCRYPTION_KEY` set, dump and photo archive are AES-256-GCM encrypted before they touch disk (provision.sh generates the key). A failing dump, archive or upload fails the run loudly; optional heartbeat ping | `backup.js`, `scripts/backup-run.js` | platform `backup: local driver…`, `backup: a failing pg_dump fails the backup…`, `backup: uploads (STORAGE_DRIVER=local) are archived and restored byte-identical`, `backup: heartbeat…`, `backup: BACKUP_DRIVER=s3 without a bucket fails loudly` |
| **Restore**: `npm run restore` names its target first (database, server, where `DATABASE_URL` came from; D5), verifies sha256s, decrypts (tag checked before anything is written; wrong key or tampering refused), refuses a non-empty database or uploads dir without `--force` — before it creates the target database (L6) —, restores in one transaction and compares row counts; local or S3. `backup:run` names its database too | `scripts/restore.mjs` | platform `restore: plain backup → scratch DB has identical row counts…`, `restore: encrypted round trip…`, `backup: S3 driver uploads the whole set…; restore latest-remote round-trips it` |
| **Export everything** (`GET /api/exports/all`, admin): a zip of every table as CSV plus the photos, a manifest and `SHA256SUMS`. Password hashes, API keys, integration tokens and auth tokens are never exported | `routes/exports.js`, `helpers/zip.js` | integrations `exports/all: zip of every table + photos, manifest row counts and sha256 verify, secrets never exported` |
| Backup run responses never include a server path; manual runs have a cooldown (`BACKUP_COOLDOWN_SECONDS`) | `routes/backup.js` | backend `RT-30…` |

### 2.7 Activity log (audit trail scope: jobs and documents)

| Control | Where | Proven by |
|---|---|---|
| Every committed change to a **job** writes an entry in the same transaction: created, updated, status changed, assigned, rescheduled, note, photo added / removed, deleted. Rejected or rolled-back changes write nothing | `helpers/activity.js`, `routes/jobs.js` | activity `created…`, `status_changed…`, `assigned…`, `rescheduled…`, `note…`, `updated…`, `photo_added / photo_removed…`, `atomic…` |
| **Documents**: creating a quote or invoice (including invoice-from-quote) logs `quote_created` / `invoice_created`; a quote or invoice **status** change (including a quote marked sent by email) logs `updated` with from / to status, on the job's log | `helpers/documentRoutes.js`, `routes/invoices.js` | activity `documents: POST /api/quotes logs quote_created…`, `documents: POST /api/invoices logs invoice_created…` |
| Each entry names the actor (user, API key and its owner, or system); names survive user deletion | `helpers/activity.js` | activity `API-key actor…`, `actor names survive…` |
| Append-only through the API; deleting a job keeps its history plus a tombstone | `routes/activity.js`, migration `20261121150000_job_activity` (FK `ON DELETE SET NULL`, CHECK on `type`) | activity `append-only…`, `tombstone…` (2 tests) |
| Technicians read activity only for jobs they can see (per `TECH_VISIBILITY`); office roles read all, including deleted jobs | `routes/activity.js` | activity `scoping…`; backend `2c TECH_VISIBILITY…` |

### 2.8 Deployment shape and demo data

| Control | Where | Proven by |
|---|---|---|
| Production compose: only Caddy publishes ports (80/443); app and Postgres 16 are not published. Local demo compose: Postgres not published, MinIO and Mailpit on 127.0.0.1, app bind `APP_BIND` | `docker-compose.prod.yml`, `docker-compose.yml`, `docker-compose.db-port.yml` | code review only (no Docker daemon in the team sandbox; §4.8) |
| `deploy/provision.sh` forces `NODE_ENV=production`, `DEMO_MODE=false`, `SANDBOX_MODE=false`, `TRUST_PROXY=1` and generates `JWT_SECRET`, `POSTGRES_PASSWORD`, `INTEGRATION_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY` | `deploy/provision.sh` | lint only (`bash -n`, shellcheck); not run on a server |
| Demo data fits the instance (M3–M5, L4): the demo locale follows `BRAND_COUNTRY` (a prospect for another country is refused); documents carry the brand's tax on line items; phones are stored in E.164; `demo:check` FAILs untaxed documents on a taxed brand (`db.tax`) and addresses of another country (`db.addresses`) | `demo/index.js` (`resolveDemoLocale`), `demo/lib/dataset.js`, `demo/lib/seed.js`, `demo/lib/checks.js` | whitelabel `M3 / M5 the default prospect follows the brand country…`, `M4 seeded documents carry the brand tax…`, `M4 / M5 demo:check FAILs…`, `M3 env-only BRAND_COUNTRY=IE…`, `M4 a US instance with sales tax…` |
| `seed:demo` refuses databases whose name lacks `demo`, `sandbox`, `test` or `wl` and refuses `NODE_ENV=production`; demo people, emails and phone numbers are fictional | `demo/lib/guard.js`, `demo/lib/dataset.js` | whitelabel `guard: only demo-named databases are seeded`, `seed data … fictional, no client names`, `prospects: reserved email domains only…` |
| Real prospect files can live outside the repo: `DEMO_PROSPECT` / `--prospect` take an absolute path; a path inside the repo other than `demo/prospects/` is refused. Fixes DOC-2 | `helpers/prospectPath.js` | backend `2c seed-demo --print-env: … external prospect file by absolute path` |
| The client-name denylist is kept out of git | `.gitignore`, `demo/lib/guard.js` | whitelabel `denylist: real list stays out of git…` |
| Database test suites run only against `TEST_DATABASE_URL`, refuse the app database, and require "test" in the database name | suite headers | the suites refuse to start otherwise (no separate test) |

---

## 3. Partial

| Area | What is done | What is not | IDs |
|---|---|---|---|
| **Password reset and invites, end to end** | API complete and tested (§2.2): reset and invite mails carry links to `reset-password.html` and `accept-invite.html`; since Frontend F3 both pages exist (token read from the URL fragment and stripped at once), with "Forgot password?" on the sign-in page, the forced "choose a new password" screen (`change-password.html`), Change password in the profile menu and Team-page deactivate / role / reset buttons; the UI walk covers each | Nothing missing in the browser for these flows | GAP-1, GAP-2, GAP-4 |
| **Audit logging** | Jobs and documents (§2.7) | Not logged: edits to a draft document's lines / amount / notes, deletes of draft documents, customer changes, price book, users, roles, password resets, API keys, sign-ins and failed sign-ins, imports, exports, SMS sends, backups. The communications log is ordinary data (admins can delete entries), not an audit trail. There is no request log: the app logs errors to the console only | GTM-18 |
| **Optimistic locking** | Jobs, customers, quotes, invoices | Price book items and users have no `version`: last write wins | RT-9, DOC-7 |
| **Sessions** | Short JWT, re-checked against the user row and `sessionVersion` on every request; revoked by password change / reset / deactivation | Token is a bearer token in `localStorage` (readable by any script on the page; the strict CSP makes injecting one much harder). **Logout only discards it in the browser**: it stays valid until it expires (`JWT_EXPIRES`, 8 h) unless one of the revoking events happens. No MFA | RT-5 (part) |
| **Rate limiting** | Per user / key / IP, failures-only on login (§2.2) | In memory (§4.1): reset by a restart, not shared between processes. After `LOGIN_MAX_PER_EMAIL` failures the **correct** password is also refused (429) from that IP for up to 15 minutes, which an attacker can use to lock a known email out from their own IP only | UX-15, GAP-3 |
| **HTTPS** | HSTS header; cookies `Secure` in production; Caddy terminates TLS in the production compose | The app does not terminate TLS; `TRUST_PROXY` must be set behind a proxy (provision.sh does). Not yet seen working on a real server | – |
| **Backups** | Encrypted (when the key is set) dumps and local photos, upload, heartbeat, tested restore (§2.6) | Encryption is **optional in the code**: without `BACKUP_ENCRYPTION_KEY` (sandbox, Docker demo, hand-written `.env`) dumps are plain gzip. With `STORAGE_DRIVER=s3` the app does **not** back up the photo bucket (the bucket's own versioning / lifecycle must). Monthly long-term copies are manual (DEPLOYMENT.md §4) | GTM-16, GTM-12 |
| **Integrations** | QuickBooks invoice push, payment sync-back and token refresh are real code, tested against a local stub; Xero export follows the published template | **Neither has been used against a real Intuit or Xero company.** Tax code ids, item id and Xero tax-rate names are per-client settings that must be confirmed (`X-MBC-Xero-Unmapped-Tax` warns on placeholders). Gmail sync and webhook handlers are placeholders. Twilio and SMTP have only been exercised in sandbox mode (outbox, suppressed SMS) | GTM-4 |
| **Erasure / retention** | Admin deletes for customers, jobs, communications; export everything (§2.6) | No per-person export. Deleting a customer fails (409) while jobs or communications reference it, so erasure is an ordered manual delete. Activity entries keep job snapshots after the job is deleted and have no delete route. No automated purge, no "anonymise customer" action | – |
| **Photo metadata (DOC-4)** | Type checked from bytes | Photos are stored **exactly as uploaded**, including EXIF (time, device and **GPS location**). No stripping on upload | DOC-4 |
| **SMS opt-out (DOC-5)** | Office roles only, customer numbers only, inert in sandbox | The confirmation and reminder texts (`routes/sms.js`) have **no "Reply STOP to opt out" line** and there is no opt-out list. Needed before US SMS use (TCPA / 10DLC) | DOC-5 |

---

## 4. Known open (design limits and work in progress)

1. **In-memory state, single process only.** These live in process memory and reset on restart: all rate-limit
   counters (API, login, reset, password change) and the 3-mails-per-account reset throttle (`routes/auth.js`
   `resetsByUser`); Google one-time login codes (`routes/googleAuth.js` `loginCodes`); QuickBooks OAuth states
   (`routes/quickbooks.js` `pendingStates`); presence (`server.js` `presence`); the "one at a time" locks for
   backups (plus the cooldown), imports (`IMPORT_RUNNING`) and export-everything (`EXPORT_RUNNING`), and the
   QuickBooks token-refresh serialisation. A restart makes users retry sign-in or QuickBooks connect and clears
   lockouts. Two app processes behind a load balancer would break Google sign-in and QuickBooks connect, split the
   limits and allow concurrent imports. The hosting plan is one process per client, which is fine; anything else
   needs a shared store first. (Reset and invite **links** are in the database and survive restarts.)
2. **Single-tenant by design.** No Company model, no tenant column. Isolation between clients exists only because
   each client gets its own server, database, storage and secrets. Never point two clients at one database.
3. **Migrations are hand-written SQL**, applied by Prisma's engine compiled to WebAssembly
   (`scripts/migrate-deploy.mjs`), because the team sandbox cannot run the native engine. The statement splitter
   now respects quotes, dollar-quoting and comments (PLAT-15 fixed; platform `sql-split: …` and
   `migrate-deploy: applies a migration with a PL/pgSQL body…`). **No drift check against `schema.prisma` has been
   run yet**: it needs the native engine (Alex's Mac, `docs/RUN-ON-MAC.md` §1.4, which lists the deliberate
   differences: the `JobActivity_jobId_fkey` foreign key and the partial unique index `Invoice_quoteId_live_key`
   are in SQL only).
4. **No MFA**, no session list or "sign out everywhere" button (a password change does sign out everywhere).
5. **No monitoring in the code** beyond `/api/health` and the backup heartbeat (GTM-12).
6. **Repository visibility.** The GitHub repository is public; client branch history contains a committed
   `backend/.env` and client names (WL-16; Verifier #1 H1: also real staff and customer rows and emails in
   history). The **tree** no longer names the fork's client (backend `H1 no client name from the fork left in
   tracked files`); the **history** needs the repository made private or rewritten. README and `package.json`
   say MIT (GTM-13, `LICENSE-PROPOSAL.md`). Decisions for Alex and Paul.
7. **Demo instances advertise their login.** `DEMO_MODE=true` returns the admin email and password from
   `/api/brand`. Safe on `127.0.0.1` (the sandbox default); with `HOST=0.0.0.0` anyone on the same network can sign
   in. Use it only on a network you control (RUN-ON-MAC §1.5).
8. **Docker / VPS path not run on a real server.** `docker-compose.prod.yml`, Caddy/TLS, ufw, `provision.sh` and
   `update.sh` are lint-checked only; the team sandbox has no Docker daemon. The first real-server test is
   `DEPLOYMENT.md` §10. Until it has passed, nothing on this page about the production shape is proven.

---

## 5. How to re-verify

From `backend/`, with a PostgreSQL role that can create databases (the sandbox uses `mbc` / `mbc_sandbox`):

```bash
npm install
export TEST_DATABASE_URL="postgresql://mbc:mbc_sandbox@localhost:5432/mbc_verify_test?schema=public"
PGPASSWORD=mbc_sandbox createdb -h localhost -U mbc mbc_verify_test   # npm test needs it to exist

npm test                     # 69. Refuses unless the DB name contains "test"
npm run test:redteam         # 48. RT-3 needs Chrome (CHROME_PATH on a Mac)
npm run test:backend         # 45. CSP browser test needs Chrome; RT-30 needs pg_dump
npm run test:activity        # 18
npm run test:documents       # 22 (creates/drops a scratch <db>_mig_<run> database)
npm run test:integrations    # 21 (QuickBooks against a local stub)
npm run test:accounts        # 25
npm run test:whitelabel      # 48 (creates <db>_wl; needs CREATEDB)
npm run test:platform        # 23 (backup/restore tests need pg_dump, psql and tar)
npm audit --omit=dev         # production dependency advisories (0 on B4; npm audit with dev: 0 too)
```

`npm run test:ui` needs a sandbox database and Chrome; see `SETUP.md` §5.

Manual checks not covered by a suite:

- `curl -sI http://127.0.0.1:<port>/ | grep -i content-security-policy` shows the policy in §2.5.
- `NODE_ENV=production JWT_SECRET= node server.js` exits with `[CONFIG] FATAL`.
- `docker compose -f docker-compose.prod.yml config` shows `ports:` on `caddy` only.
- `npm run demo:check -- --port <port> --headless` says `READY` before any demo.

When a fix lands, move its row from §3 or §4 to §2 with the test that proves it, and update the date and commit
at the top.
