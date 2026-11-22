# DRAFT — not legal advice — for review by counsel (Paul Mikols / KS Emerald)

# Legal templates and the product facts behind them

Drafted 2026-11-21 against `mbc/sandbox-revival` at `808631f`. Background and open questions:
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
the same change. Re-check the whole table before each client signs.

## Claim → feature map

| Claim (template § ) | Supported by | Status on 808631f |
|---|---|---|
| Staff sign in with email + password; passwords stored as one-way hashes (PP §5, ToS §2.2, DPA A2) | `routes/auth.js` login; bcrypt in `routes/users.js`, `seed_superadmin.js` | True |
| Google sign-in only for invited users or allow-listed domains; Google password not shared (PP §5, ToS §2.2, DPA A2) | `routes/googleAuth.js` `resolveGoogleUser`, `GOOGLE_ALLOWED_DOMAINS`; OAuth scopes `profile`, `email` | True when Google is configured. Invited users get an unusable random password, so **for them Google is the only way in**; there is no password set/reset flow |
| No MFA claim is made (DPA A2 lists it as a gap) | – | MFA not built |
| Sessions last up to `JWT_EXPIRES` (default 8 h) (PP §5) | `helpers/security.js` `jwtExpires` | True |
| Deactivated accounts stop working immediately, including open sessions (ToS §2.4, DPA A2) | `routes/auth.js` `userFromToken` re-reads the user | True, tested (redteam RT-5a/b/c) |
| Access by role; field staff see only their assigned jobs and those customers (PP §8, ToS §2.3, DPA A2) | `helpers/roles.js`, `helpers/access.js`, route guards | True, tested (redteam RT-8, RT-21; backend RT-21) |
| Each change to a **job** is recorded with who and when; records cannot be edited through the System (PP §8, ToS §5, DPA A1/A2) | `helpers/activity.js`, `routes/jobs.js`, `routes/activity.js`, migration `20261121150000_job_activity` | True for jobs, tested (activity suite). **Not** for customers, quotes, invoices, users or sign-ins — do not widen the claim. Entries can be removed by direct database access (needed for erasure) |
| Job change history is kept after a job is deleted (PP §7, DPA A1) | tombstone entries, `jobRef` | True; this means erasure requests need a database-level step (DPA §10.1) |
| Separate installation per client; no other business's data in it (PP §8, DPA A2) | Single-tenant code (no Company model) + one server/DB/storage per client in the hosting plan | True only if provisioning follows `gtm/implementation/provisioning-checklist.md`. The code itself would mix clients if two were pointed at one database |
| Sign-in attempts are rate-limited (PP §8, DPA A2) | `server.js` `authLimiter` (20 / 15 min / IP) | True, tested. Per process, in memory |
| HTTPS (PP §8, DPA A2) | Not in the app; reverse proxy (Caddy) per hosting plan | **Confirm per instance** |
| Backups nightly; rolling retention (PP §7–8, DPA §9.2, A2) | `backup.js` cron 03:00, `BACKUP_KEEP` (default 30 local copies) | Nightly dump true. Retention beyond the local 30 copies, encryption and photo backup are **not** in the code (GTM-16). Do not say "encrypted backups" |
| No payment-card or bank details stored (PP §3, DPA A1) | No such fields in `prisma/schema.prisma`; payments not built | True by design; relies on staff not typing them into notes (ToS §3) |
| Photos stored as taken, including embedded metadata (PP §3, DPA A1) | `routes/jobs.js` stores the uploaded bytes; no EXIF stripping | True. Stripping location metadata would be a small product improvement |
| Uploads are image files only (ToS §3, DPA A2) | `helpers/imageSniff.js`, `routes/jobs.js` | True, tested (redteam RT-20a/b) |
| No advertising or analytics trackers; no third-party scripts (PP §8–9) | CSP `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `connect-src 'self'` in `server.js`; pages load nothing external | True on this commit (`npm run test:ui` also records external hosts). Re-check if a map or font CDN is added |
| Local storage keeps staff signed in; short-lived cookies only during Google / QuickBooks sign-in (PP §9) | `localStorage.token` in `public/*.html`; `mbc_google_state`, `mbc_qbo_state` HttpOnly cookies (`helpers/cookies.js`) | True. If the cookie-based session from the Kraft port lands, rewrite PP §9 |
| System emails are staff invitations (PP §6) | `routes/invites.js` is the only caller of `helpers/mailer.js` | True. If quote/invoice email is added (GTM-9), add "quotes and invoices you asked us to email" |
| Appointment texts only if SMS is enabled, to customer numbers on record (PP §4, §6, ToS §3) | `routes/sms.js` (office roles only; recipient must be a customer number; Twilio inert unless configured) | True, tested (redteam RT-16, backend RT-16). **The text has no STOP / opt-out line** — needed before US SMS use (TCPA / 10DLC, compliance.md §9) |
| Export of client data on exit (DPA §9.1) | `routes/exports.js`: customers, jobs, invoices CSV (admin only) | Partial. Quotes, communications, photos and change history are not exported by the System; the Provider exports them from the database and storage. Export-everything is backlog (GTM-20) |
| Data-subject access/correction/erasure handled by the client in the System, the rest by the Provider (PP §10, DPA §10.1) | View/edit screens; admin deletes for customers, jobs, communications | Partial. Customer delete is refused (409) while jobs or communications reference the customer; erasure is an ordered manual delete. No "anonymise customer" action, no retention purge |
| Retention periods applied on request, not automatically (PP §7) | – | True: no automated retention in the code |
| QuickBooks tokens encrypted by the application (DPA A2) | `helpers/secretBox.js` AES-256-GCM | True, tested (backend PLAT-4) |
| API keys hashed, scoped, revoked with their creator (ToS §4, DPA A2) | `middleware/apiKeyAuth.js` | True, tested (redteam RT-4, RT-22) |
| Sub-processors listed per client; DigitalOcean and Wasabi not used (PP §6, DPA A3) | Hosting plan (`gtm/GTM-PLAN.md` §6) | **Placeholder.** The code still names `WASABI_*` variables for S3-compatible backup storage; that is a variable name, not a provider choice |
| Breach notice to the client within 48 hours (DPA §6.1) | Process: compliance.md §5.3 runbook | Contract commitment; no product feature. No alerting in the code (GTM-12) |
| Staff confidentiality (DPA §4) | Process | Contract commitment |

## Placeholders used

`{{CLIENT_LEGAL_NAME}}`, `{{CLIENT_TRADING_NAME}}` (= `BRAND_COMPANY_NAME`), `{{CLIENT_POSTAL_ADDRESS}}`,
`{{TECHNICIAN_LABEL}}` (= `BRAND_TECH_LABEL` or the trade default), `{{PROCESSOR_NAME}}` / `{{PROVIDER_LEGAL_NAME}}`,
`{{HOSTING_PROVIDER}}`, `{{STORAGE_PROVIDER}}`, `{{EMAIL_PROVIDER}}`, `{{SMS_PROVIDER}}`, `{{REGION}}`,
`{{TRANSFER_MECHANISM}}`, `{{SUBPROCESSOR_LIST_URL_OR_ANNEX}}`, `{{GOOGLE_ALLOWED_DOMAINS}}`, retention values, dates
and contacts. The templates are Markdown, not yet rendered from env like the rest of the white-label (compliance.md
§8 item 1 suggests doing that later).
