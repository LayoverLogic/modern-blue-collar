# MBC features — what is real today

Plain list for sales and marketing. Checked against the code and by running it on 2026-11-21
(`mbc/sandbox-revival` at `6d63a31`). Nothing here has run for a paying client yet.

**Status key**
- **Working in sandbox** — built and tested end to end on the team's local sandbox (no paid services).
- **Built, not yet tested live** — the code exists and passes its tests against stand-ins, but has never talked
  to the real service or run on a real server. Do not promise it to a client before it has.
- **Not built.**

"**No screen yet**" in the notes means the feature works through the API only on this commit (the Frontend team is
building the screens). Do not demo or sell those as finished.

| Feature | Status | Notes |
|---|---|---|
| **Jobs and scheduling** | | |
| Customers (homes and businesses, company name, tax number, search) | Working in sandbox | US and Irish address rules (Eircodes); phone numbers stored in international format |
| Jobs with status, priority and trade-specific job types | Working in sandbox | Job types in US or Irish wording, or the client's own list |
| Dispatch board and schedule calendar | Working in sandbox | A technician cannot be double-booked |
| Technician "Today" view on a phone | Working in sandbox | Big Navigate / Call / Text / On My Way buttons, status, notes, photo upload. A mobile web page, not an app-store app |
| Job photos | Working in sandbox | Images only, 10 MB. Location data inside photos is kept as taken |
| "Who else is viewing this job" | Working in sandbox | Live, across devices |
| Job activity history (who changed what, when) | Working in sandbox | Covers job changes and quote / invoice creation and status changes; kept after a job is deleted |
| Communications timeline per customer | Working in sandbox | Calls, emails, texts and notes logged by staff; document emails logged automatically |
| Recurring jobs / maintenance plans | Not built | |
| Inventory / stock control | Not built | Parts can be attached to a job in the data, but there is no inventory screen |
| Timesheets / clock in and out | Not built | |
| Route optimisation, maps inside the app | Not built | Navigate opens the phone's own maps app |
| Offline mode | Not built | Needs a connection |
| **Quotes, invoices, money** | | |
| Price book per trade, with starter prices | Working in sandbox | Starter prices are 2026 US ballparks; client edits them |
| Price book import from CSV | Working in sandbox | **No screen yet.** Dry run first, then import |
| Quotes and invoices with line items, discounts and tax | Working in sandbox | US sales tax or Irish VAT rates (incl. 13.5 % / 23 %), reverse charge; exact decimal money; numbered Q-0001 / INV-0001 |
| Several quotes and invoices per job; invoice from a quote | Working in sandbox | One live invoice per quote |
| Sent quotes and invoices are locked | Working in sandbox | Only the status can change after sending |
| Print / save as PDF | Working in sandbox | Browser print, A4 or Letter; "VAT Invoice" title for Irish VAT invoices |
| Email a quote or invoice to the customer | Working in sandbox | Sandbox writes it to a folder; real email delivery (SMTP) not yet tested live |
| Online card payments, customer portal, online quote approval | Not built | |
| **Accounting and data** | | |
| CSV exports (customers, jobs, quotes, invoices) | Working in sandbox | Buttons on Customers, Dispatch, Quotes & Invoices; quote export and per-line view via API |
| "Export everything" (all data + photos in one zip) | Working in sandbox | **No screen yet.** The client's exit / data-ownership guarantee |
| Customer import from Housecall Pro, Jobber or a spreadsheet | Working in sandbox | **No screen yet** (also a command-line tool). Dry run with a full report, duplicate review, undo. Jobs import not built |
| Xero invoice export (Xero's import file) | Working in sandbox | **No screen yet.** File generated; not yet imported into a real Xero company. Tax-rate names must be set per client |
| QuickBooks Online: connect, push invoices, pull payments | Built, not yet tested live | **No screen yet.** Tested against a stand-in only; needs a run in an Intuit test company first |
| Gmail sync of customer emails | Not built | Placeholder only |
| **Team and sign-in** | | |
| Roles: owner, admin, dispatcher, office, technician | Working in sandbox | Technicians see only their own jobs, or (client's choice) read the whole schedule but change only their own |
| Email + password sign-in, lockout after repeated failures | Working in sandbox | |
| Add a team member with a temporary password | Working in sandbox | Server forces a password change at first sign-in, but **no screen yet** to change it, so the new person cannot get in through the app today |
| Invite a team member by email | Working in sandbox | **No screen yet** for the invitation page the email links to |
| Forgot / reset password by email | Working in sandbox | **No screen yet** for the reset page or the "Forgot password" link |
| Change own password; signs out everywhere | Working in sandbox | **No screen yet** |
| Deactivate a leaver, change a role, admin password reset | Working in sandbox | **No screen yet.** Deactivation cuts access immediately |
| Sign in with Google | Built, not yet tested live | Invited people or the client's own domain only; hidden in the sandbox |
| Two-factor sign-in (MFA) | Not built | Only through Google accounts that enforce it |
| API keys for integrations | Working in sandbox | Read or read/write; stop working when their creator leaves |
| **Texts** | | |
| Appointment confirmation texts (Twilio) | Built, not yet tested live | Office staff only, to customer numbers on record. No "reply STOP" line yet: needed before US use |
| **White-label** | | |
| Client's name, logo, colours, labels set by configuration only | Working in sandbox | No code changes per client; bad settings stop the server at start-up |
| Five trades: electrical, plumbing, HVAC, plumbing & HVAC, general contracting | Working in sandbox | Own job types, labels, colours and starter price book each |
| United States and Ireland (currency, tax, addresses, phone and date formats) | Working in sandbox | Other countries (UK, Canada…) not built |
| Branded demo per prospect, with a pre-demo safety check | Working in sandbox | Prospect details kept outside the code repository |
| Languages other than English | Not built | |
| **Hosting and safety** | | |
| One private server per client (no shared database) | Built, not yet tested live | Set-up script, automatic HTTPS, firewall, one-command updates with rollback. Never run on a real server yet |
| Nightly backups, encrypted, including photos, off-site | Working in sandbox | Upload to a real backup bucket (Cloudflare R2 / Backblaze B2) not yet tested live |
| Tested restore from backup | Working in sandbox | A restore drill per client server is part of go-live |
| Security hardening (strict browser security policy, rate limits, role checks) | Working in sandbox | Details and open items: `backend/SECURITY_AUDIT.md`. Not an external penetration test |
| Uptime and backup alerts | Built, not yet tested live | External monitors (UptimeRobot, Healthchecks.io) plus a backup "heartbeat" |
| Local demo with Docker | Built, not yet tested live | The team had no Docker to try it; the no-Docker sandbox is what has been used |
