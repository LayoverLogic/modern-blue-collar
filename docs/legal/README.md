# DRAFT — not legal advice — for review by counsel (Paul Mikols / KS Emerald)

# Legal templates and the product facts behind them

Drafted 2026-11-21 against `mbc/sandbox-revival` at `808631f`; claims re-checked against `6d63a31` the same day
(accounts, encrypted backups, export-everything, QuickBooks / Xero merged). Rows changed by the account / data
screens (Frontend F3, `0cc0953`) and backend fix round B4 were updated afterwards; the column says which. Background and open questions:
`/home/claude/mbc-team/gtm/implementation/compliance.md`. Security detail: `backend/SECURITY_AUDIT.md`.

| File | What it is | Who signs / publishes |
|---|---|---|
| [privacy-policy-template.md](privacy-policy-template.md) | Privacy notice a client publishes for its customers and staff (US and EU/IE blocks) | The client (controller) |
| [terms-of-service-template.md](terms-of-service-template.md) | Terms of use for the client's staff on their instance | The client |
| [data-processing-agreement-template.md](data-processing-agreement-template.md) | GDPR Art. 28 DPA, annex to the MSA, with processing description, TOMs and sub-processor annexes | PEJR LLC (KS Emerald) and the client |

Not drafted here (Paul → counsel): the Master Subscription & Services Agreement, order form, SLA schedule, and the
public sub-processor page. The licence question is in [`../../LICENSE-PROPOSAL.md`](../../LICENSE-PROPOSAL.md).

## Rule for editing

Every product statement in the templates is listed below with the code that supports it. If you add or reword a
statement, add a row. If a row's status changes (a gap is fixed, or a feature is removed), update the templates in
the same change. Re-check the whole table before each client signs, and **confirm per instance** every row marked
so (it depends on how that server was set up, not on the code).

## Claim → feature map

| Claim (template § ) | Supported by | Status on 6d63a31 (F3 / B4 where marked) |
|---|---|---|
| Staff sign in with email + password; passwords stored as one-way hashes (PP §5, ToS §2.2, DPA A2) | `routes/auth.js` login; bcrypt in `helpers/authTokens.js`, `seed_superadmin.js` | True, tested |
| Passwords at least 10 characters (PP §5 if stated, DPA A2) | `helpers/authTokens.js` `PASSWORD_MIN_LENGTH` (default 10, never below 8) | True, tested (accounts suite). Configurable per instance: state the instance's value |
| New staff set their own password from an invitation link, or get a temporary password they must change at first sign-in (PP §5, ToS §2.1–2.2) | `routes/invites.js` (accept-invite link, 7 days, single use), `routes/users.js` + `routes/auth.js` (`mustChangePassword` gate) | True, tested. **F3:** the accept-invite page and the change-password screen exist (`accept-invite.html`, `change-password.html`) |
| Forgotten passwords are reset by an emailed single-use link (PP §5, ToS §2.2, DPA A2) | `routes/auth.js` forgot / reset, `helpers/authTokens.js` (30 min, sha256 stored, rate-limited, no account enumeration) | True, tested. **F3:** the reset page and the \"Forgot password?\" link exist. Needs working email on the instance |
| A password change or reset signs the person out everywhere (PP §5 if stated, DPA A2) | `User.sessionVersion`, `routes/auth.js` | True, tested |
| Google sign-in only for invited users or allow-listed domains, with a verified Google email; Google password not shared (PP §5, ToS §2.2, DPA A2) | `routes/googleAuth.js` `resolveGoogleUser`, `GOOGLE_ALLOWED_DOMAINS`; OAuth scopes `profile`, `email` | True when Google is configured (tested with a stubbed profile; **not yet used against Google**). Shown only when configured and not in sandbox mode |
| No MFA claim is made (DPA A2 lists it as a gap) | – | MFA not built (only via Google accounts that enforce it) |
| Sessions last up to `JWT_EXPIRES` (default 8 h) (PP §5) | `helpers/security.js` | True. Logging out discards the session in the browser only; it stays valid until expiry. Do not claim "logout ends the session on the server" |
| Deactivated accounts stop working immediately, including open sessions and live connections (ToS §2.4, DPA A2) | `routes/auth.js` re-reads the user; `sessionVersion`; socket disconnect in `server.js` | True, tested (redteam RT-5a/b/c, accounts `leavers…`, backend `2c sockets…`). **F3:** Team-page deactivate button |
| Access by role; field staff see only their assigned jobs and those customers (PP §8, ToS §2.3, DPA A2) | `helpers/roles.js`, `helpers/access.js`, route guards | True, tested, **when `TECH_VISIBILITY=own`** (the default; **B4:** also for live presence, and field staff never see price book cost or other staff's contact details). With `TECH_VISIBILITY=all` field staff can read every job and customer (not other jobs' quotes, invoices or communications). **Confirm per instance** and use the matching wording (both are in the templates) |
| Changes to **jobs**, and the creation and status changes of **quotes and invoices**, are recorded with who and when; records cannot be edited through the System (PP §8, ToS §5, DPA A1/A2) | `helpers/activity.js`, `routes/jobs.js`, `helpers/documentRoutes.js`, `routes/activity.js`, migration `20261121150000_job_activity` | True, tested (activity suite). **Not** recorded: edits to draft quote/invoice lines, deletes of drafts, customer changes, price book, users, roles, sign-ins, exports, imports. Do not widen the claim. Entries can be removed by direct database access (needed for erasure) |
| Job change history is kept after a job is deleted (PP §7, DPA A1) | tombstone entries, `jobRef` | True; erasure requests need a database-level step (DPA §10.1) |
| Separate installation per client; no other business's data in it (PP §8, DPA A2) | Single-tenant code (no Company model) + one server/DB/storage per client (`DEPLOYMENT.md`) | True only if provisioning follows `DEPLOYMENT.md`. The code itself would mix clients if two were pointed at one database |
| Sign-in attempts are rate-limited (PP §8, DPA A2) | `server.js` login limiters: failed attempts only, 10 per IP + email and 50 per IP per 15 min | True, tested. Per process, in memory (reset by a restart). **B4:** page loads and successful sign-ins never count towards the general per-IP limit (M2) |
| HTTPS (PP §8, DPA A2) | Not in the app; Caddy with Let's Encrypt in `docker-compose.prod.yml` | **Confirm per instance.** Not yet run on a real server (`DEPLOYMENT.md` §10) |
| Backups nightly, encrypted, including photos; rolling retention (PP §7–8, DPA §9.2, A2) | `backup.js` (03:00, AES-256-GCM when `BACKUP_ENCRYPTION_KEY` is set, photo archive when `STORAGE_DRIVER=local`), `scripts/restore.mjs`, bucket lifecycle rule (35 days, `DEPLOYMENT.md` §2) | True in code, tested (platform backup/restore suite). Encryption is optional in the code: provision.sh generates the key. **Confirm per instance** that the key is set, photos are local (or the photo bucket has its own backup), and the restore drill was done. Monthly long-term copies are manual |
| No payment-card or bank details stored (PP §3, DPA A1) | No such fields in `prisma/schema.prisma`; payments not built | True by design; relies on staff not typing them into notes (ToS §3) |
| Photos stored as taken, including embedded metadata such as location (PP §3, DPA A1) | `routes/jobs.js` stores the uploaded bytes; no EXIF stripping | True (DOC-4). Stripping location metadata would be a small product improvement |
| Uploads are image files only (ToS §3, DPA A2) | `helpers/imageSniff.js`, `routes/jobs.js` | True, tested (redteam RT-20a/b) |
| No advertising or analytics trackers; no third-party scripts (PP §8–9) | CSP `script-src 'self'`, `style-src 'self'`, `connect-src 'self'` (+ same-host websocket) in `server.js`; pages load nothing external | True, tested (backend CSP browser test; `test:ui` records external hosts). An external `BRAND_LOGO_URL` host is the only allowed outside image source. Re-check if a map or font CDN is added |
| Local storage keeps staff signed in; short-lived cookies only during Google / QuickBooks sign-in (PP §9) | `localStorage.token` in `public/js/api.js`; `mbc_google_state`, `mbc_qbo_state` HttpOnly cookies (`helpers/cookies.js`) | True |
| System emails: staff invitations, password-reset links, and quotes / invoices staff choose to email to a customer (PP §6, DPA A1) | `routes/invites.js`, `routes/auth.js`, `routes/users.js`, `helpers/documentRoutes.js` → `helpers/mailer.js` | True. Customer emails are sent only when a staff member presses Send; each is logged on the customer's timeline |
| Appointment texts only if SMS is enabled, to customer numbers on record (PP §4, §6, ToS §3) | `routes/sms.js` (office roles only; recipient must be a customer number; Twilio inert unless configured) | True, tested (redteam RT-16, backend RT-16). **The text has no STOP / opt-out line** (DOC-5) — needed before US SMS use (TCPA / 10DLC). Not yet used against Twilio |
| Export of all client data on exit, including photos (DPA §9.1) | `routes/exports.js` `GET /api/exports/all`: every table as CSV, the photos, manifest and checksums (admin only); plus CSV exports per list | True, tested (integrations suite). **F3:** Settings → Data → Export everything. **B4:** an API key needs the `export` (or `write`) scope for it. Password hashes, API keys and integration tokens are deliberately left out |
| Data-subject access / correction / erasure handled by the client in the System, the rest by the Provider (PP §10, DPA §10.1) | View/edit screens; admin deletes for customers, jobs, communications | Partial. Customer delete is refused (409) while jobs or communications reference the customer; erasure is an ordered manual delete. No per-person export, no "anonymise customer" action, no retention purge |
| Retention periods applied on request, not automatically (PP §7) | – | True: no automated retention in the code |
| QuickBooks tokens encrypted by the application (DPA A2) | `helpers/secretBox.js` AES-256-GCM | True, tested (backend PLAT-4, integrations) |
| Customer and invoice details are sent to the client's QuickBooks company only when staff push an invoice (PP §6 accounting row, DPA A1, §7.4) | `helpers/qbo.js`, `routes/quickbooks.js` (`POST /sync-invoice/:id`, payment sync) | Code true, tested against a local stub only; **not yet used against Intuit**. The client's own QuickBooks account (DPA §7.4) |
| API keys hashed, scoped, revoked with their creator (ToS §4, DPA A2) | `middleware/apiKeyAuth.js` | True, tested (redteam RT-4, RT-22) |
| Sub-processors listed per client; DigitalOcean and Wasabi not used (PP §6, DPA A3) | Hosting plan (`DEPLOYMENT.md` §1: VPS, R2 / B2, SES / Postmark, UptimeRobot, Healthchecks.io) | **Placeholder.** Fill per client from the provisioning record. `WASABI_*` survive only as legacy variable names |
| Breach notice to the client within 48 hours (DPA §6.1) | Process: compliance.md §5.3 runbook | Contract commitment; no product feature. Uptime / backup monitoring is external (`DEPLOYMENT.md` §8) |
| Staff confidentiality (DPA §4) | Process | Contract commitment |
| Dependency audit before each release (DPA A2) | `npm audit --omit=dev` | 0 production advisories on 6d63a31; **B4:** 0 including dev dependencies |

## Placeholders used

`{{CLIENT_LEGAL_NAME}}`, `{{CLIENT_TRADING_NAME}}` (= `BRAND_COMPANY_NAME`), `{{CLIENT_POSTAL_ADDRESS}}`,
`{{TECHNICIAN_LABEL}}` (= `BRAND_TECH_LABEL` or the trade default), `{{PROCESSOR_NAME}}` / `{{PROVIDER_LEGAL_NAME}}`,
`{{HOSTING_PROVIDER}}`, `{{STORAGE_PROVIDER}}`, `{{EMAIL_PROVIDER}}`, `{{SMS_PROVIDER}}`, `{{REGION}}`,
`{{TRANSFER_MECHANISM}}`, `{{SUBPROCESSOR_LIST_URL_OR_ANNEX}}`, `{{GOOGLE_ALLOWED_DOMAINS}}`, retention values, dates
and contacts. The templates are Markdown, not yet rendered from env like the rest of the white-label (compliance.md
§8 item 1 suggests doing that later).
