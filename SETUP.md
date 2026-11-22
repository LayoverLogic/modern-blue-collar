# SETUP.md — Local Development

This guide walks you through spinning up **Modern Blue Collar** on your local machine for the first time.

---

## Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| Node.js | 18.x LTS | https://nodejs.org |
| npm | 9.x | (bundled with Node) |
| Git | any recent | https://git-scm.com |

> SQLite is used by default (no extra database server needed).

---

## 1. Clone the repo

```bash
git clone https://github.com/AlexJ2804/modern-blue-collar.git
cd modern-blue-collar/backend
```

---

## 2. Install dependencies

```bash
npm install
```

---

## 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in at minimum:

```
JWT_SECRET=<random 32+ char string>
BRAND_COMPANY_NAME=Your Company LLC
BRAND_TRADE_TYPE=electrical   # or: plumbing | hvac | plumbing-hvac | contracting
```

All `BRAND_*` keys are optional — defaults come from the trade (see **White-label** below).
An unknown trade, a malformed colour or URL, or an unknown time zone stops the server at boot.

---

## 4. Set up the database

```bash
# Run migrations (creates prisma/dev.db)
npm run migrate

# Generate Prisma client
npm run generate
```

---

## 5. Seed initial data

**Super-admin account:**

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=YourSecurePass! npm run seed:admin
```

**Starter pricebook (trade-aware):**

```bash
npm run seed:prices
```

The pricebook seed reads `BRAND_TRADE_TYPE` from `.env` and inserts the starter items for that trade (electrical, plumbing, HVAC, plumbing & HVAC, or contracting). Re-running never duplicates items.

---

## 6. Start the dev server

```bash
npm run dev
```

The server starts on **http://localhost:3001** (or the `PORT` value in `.env`).

Open your browser to http://localhost:3001 — the dashboard login page should load.

---

## 7. (Optional) Inspect the database

```bash
npm run studio
```

Prisma Studio opens at http://localhost:5555 so you can browse and edit records visually.

---

## White-label

The white-label promise: **a client or trade is configured with `BRAND_*`
environment variables only — no source edits.** `brand.config.js` (repo root) is a
thin wrapper over `backend/helpers/brandValidate.js`; you never edit either per client.

### Variables

| Variable | Default | Notes |
|---|---|---|
| `BRAND_TRADE_TYPE` | `electrical` | `electrical` \| `plumbing` \| `hvac` \| `plumbing-hvac` \| `contracting`. Case-insensitive; `Plumbing & HVAC`, `HVAC`, `General Contracting`, `GC` also accepted. **Anything else stops the server at boot** with a message naming the variable and the valid values. |
| `BRAND_COMPANY_NAME` / `_SLOGAN` / `_PHONE` / `_EMAIL` / `_ADDRESS` | Modern Blue Collar | Shown in the nav, page titles, login screen, emails. |
| `BRAND_TECH_LABEL`, `BRAND_INDUSTRY_LABEL` | from the trade | e.g. `Engineer` for an Irish heating firm. The industry label is what the pricebook is filtered by. |
| `BRAND_COLOR_PRIMARY`, `_SECONDARY`, `_ACCENT`, `_NAV_BG`, `_NAV_TEXT`, `_HEADER_BG`, `_HEADER_TEXT` | the trade's palette | Hex (`#rgb`/`#rrggbb`), quoted in `.env`. Invalid values stop the boot. |
| `BRAND_COLOR_PRIMARY_DARK` | derived | Hover/active shade, 18% darker than primary unless set. |
| `BRAND_LOGO_URL`, `BRAND_FAVICON_URL` | none | `https://` URL, same-origin path (`/brand/logo.svg`) or `data:image/...;base64`. Favicon defaults to the logo. Pages render them once the front end reads `logoUrl` / `faviconUrl` from `/api/brand`. |
| `BRAND_DEFAULT_STATE` | `KS` | Default for US address forms. |
| `BRAND_TIMEZONE` | `America/Chicago` | IANA zone; used for "today", demo dates, backups. Invalid zones stop the boot. |

Trade palettes when no colour is set: electrical yellow `#f5a623`, plumbing blue `#1e6fd9`,
hvac teal `#0d9488`, plumbing-hvac blue `#2563eb`, contracting orange `#ea580c`.

| `BRAND_TRADE_TYPE` | Technician label | Industry label | Job types |
|---|---|---|---|
| `electrical` | Electrician | Electrical | Panel Upgrade, Outlet / Switch, Lighting, EV Charger, Generator, Inspection, Troubleshooting, Other |
| `plumbing` | Plumber | Plumbing | Leak Repair, Drain Cleaning, Water Heater, Fixture Install, Sewer Line, Inspection, Troubleshooting, Other |
| `hvac` | HVAC Technician | HVAC | AC Install, Furnace Install, AC Repair, Furnace Repair, Duct Work, Tune-Up, Inspection, Other |
| `plumbing-hvac` | Technician | Plumbing & HVAC | the plumbing and HVAC lists combined |
| `contracting` | Contractor | General Contracting | Framing, Drywall, Flooring, Roofing, Painting, Demo, General Repair, Other |

### New client

1. Copy `backend/.env.example` to `backend/.env` and set the `BRAND_*` block.
2. `npm run seed:prices` — starter pricebook for **that** trade (electrical gets
   electrical items; `plumbing-hvac` gets both), stamped with the industry label.
   Prices are 2026 US ballparks; the client edits them on the Pricebook page.
3. Do **not** run `seed_jobs.js` / `seed:demo` for a real client — they create fictional
   customers and are refused outside demo databases / `DEMO_MODE=true`.

### Demo per prospect (`seed:demo`, `demo:check`)

Demo data comes from `backend/demo/`:

```
demo/prospects/<slug>.json        default (generic "Anytown", US), ks-plumbing-example, ie-heating-example
demo/fixtures/trades/<trade>.json pricebook, inventory and job templates per trade (+ Irish variants)
demo/fixtures/locales/US.json, IE.json   names, streets, phone / postcode formats, invoice terms
```

```bash
cd backend
node scripts/seed-demo.js --list                                  # available prospects
node scripts/seed-demo.js --prospect ks-plumbing-example --print-env  # → .env.demo.ks-plumbing-example (gitignored)
ENV_FILE=.env.demo.ks-plumbing-example npm run sandbox             # own DB mbc_demo_<slug>, seeded, started
ENV_FILE=.env.demo.ks-plumbing-example npm run seed:demo -- --reset   # fresh dates before every demo
ENV_FILE=.env.demo.ks-plumbing-example npm run demo:check -- --port 3101 --headless
```

What the seed guarantees: job types from the trade's list; pricebook items for the trade;
quote/invoice amounts are the sum of real pricebook lines (> 0); dates relative to
**today in `BRAND_TIMEZONE`** (finished work with paid / unpaid / overdue invoices, three
jobs today, the next days booked, two pending quotes); fictional people only — reserved
domains (`demo.test`, `*.example`, `example.com`), US `555-01xx` numbers, Irish
ComReg drama ranges (`020 91x xxxx`, `089 011 0xxx`); deterministic for a given day.
Team logins: `office@`, `dispatch@`, `tech1@`–`tech3@` + the prospect's `emailDomain`
(default `demo.test`), password `DEFAULT_PASSWORD` (required, no fallback).

Safety: `seed:demo` refuses a database whose name lacks `demo`, `sandbox`, `test` or `wl`
(override: `--allow-db <name>`, e.g. Docker's `mbc`) and refuses `NODE_ENV=production`.

`demo:check` prints PASS / WARN / FAIL per check and exits 1 on any FAIL:
client names (denylist), `undefined`/`NaN` text, job types and trade, amounts > 0,
another trade's pricebook items, duplicate items, real email domains, stale calendar;
with `--port`, `/api/brand` and every list endpoint; with `--headless`, the main pages in
Chrome (JS errors, "undefined" on screen, client names).

**Denylist:** the real list of client names lives in `backend/demo/denylist.local.txt`
(**gitignored** — this repository is public, so client names must not be committed) or in
any file named by `DEMO_DENYLIST_FILE`. `backend/demo/denylist.example.txt` shows the format.

### Switching trade on an existing database

Environment-only for everything the server computes (labels, job types, colours, the
pricebook filter). The **data** does not move with it: jobs keep their old `tradeType`
and type, and the pricebook keeps the old industry's items (hidden by the filter).

- Demo / sandbox DB: `npm run seed:demo -- --reset` (refuses to mix trades without it;
  `seed_jobs.js` prints a warning and skips so boot is never blocked).
- Real client changing trade (rare): run `npm run seed:prices` to add the new trade's
  starter items; existing jobs and items stay as they were.

---

## Project Structure

                        ```
                        modern-blue-collar/
                        ├── brand.config.js          # White-label config — reads BRAND_* env vars (no per-client edits)
                        ├── SETUP.md                 # This file
                        ├── DEPLOYMENT.md            # Production deployment guide
                        └── backend/
                            ├── server.js            # Express app entry point
                                ├── package.json
                                    ├── .env.example         # Environment variable template
                                        ├── .gitignore
                                            ├── seed_superadmin.js   # Admin account seeder
                                                ├── seed_pricebook.js    # Trade-aware pricebook seeder
                                                    ├── backup.js            # Backup utility
                                                        ├── prisma/
                                                            │   └── schema.prisma    # Database schema
                                                                ├── routes/              # API route handlers
                                                                    │   ├── auth.js
                                                                        │   ├── backup.js
                                                                            │   ├── customers.js
                                                                                │   ├── exports.js
                                                                                    │   ├── invites.js
                                                                                        │   ├── invoices.js
                                                                                            │   ├── jobs.js
                                                                                                │   ├── pricebook.js
                                                                                                    │   ├── quickbooks.js
                                                                                                        │   ├── quotes.js
                                                                                                            │   ├── sms.js
                                                                                                                │   └── users.js
                                                                                                                    └── public/              # Frontend (HTML / JS / CSS)
                                                                                                                            ├── index.html       # Dashboard
                                                                                                                                    ├── customers.html
                                                                                                                                            ├── dispatch.html
                                                                                                                                                    ├── job.html
                                                                                                                                                            ├── schedule.html
                                                                                                                                                                    ├── team.html
                                                                                                                                                                            ├── pricebook.html
                                                                                                                                                                                    └── quote-invoice.html
                                                                                                                                                                                    ```
                                                                                                                                                                                    
                                                                                                                                                                                    ---
                                                                                                                                                                                    
                                                                                                                                                                                    ## Troubleshooting
                                                                                                                                                                                    
                                                                                                                                                                                    **`Cannot find module '../brand.config'`**
                                                                                                                                                                                    Make sure you run the server from `backend/` — the config file lives one directory up.
                                                                                                                                                                                    
                                                                                                                                                                                    **Prisma migration errors**
                                                                                                                                                                                    Delete `prisma/dev.db` and `prisma/migrations/` then re-run `npm run migrate`.
                                                                                                                                                                                    
                                                                                                                                                                                    **Port already in use**
                                                                                                                                                                                    Change `PORT=3001` in `.env` to another value.
                                                                                                                                                                                    
