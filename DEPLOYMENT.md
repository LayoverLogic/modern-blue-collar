# Deploying MBC for a client

One client = one small VPS (Ubuntu 24.04 LTS) running Docker Compose:

```
 internet ──► :80/:443  Caddy (automatic Let's Encrypt TLS)
                          │  compose network only
                          ▼
                        app (Node, :3001, not published) ──► postgres:16 (not published)
                          │
                          ├─ /opt/mbc/data/uploads   job photos (STORAGE_DRIVER=local)
                          └─ /opt/mbc/data/backups   nightly backup sets (local copies)
                                   │
                                   └──► S3-compatible backup bucket (Cloudflare R2 / Backblaze B2)
```

Everything is configured by environment variables. You never edit source per client.

| File | Purpose |
|---|---|
| `deploy/provision.sh` | Sets up the server (Docker, unattended upgrades, ufw, SSH hardening, swap), writes `.env` and starts the stack. Safe to re-run |
| `deploy/update.sh` | Updates to a release tag: backup first, then pull, build, migrate, restart and smoke-check |
| `deploy/clients/example.env.example` | Template for the per-client settings file `deploy/clients/<slug>.env` (gitignored) |
| `docker-compose.prod.yml` | Production stack: app + postgres:16 + Caddy. Only Caddy publishes ports |
| `deploy/Caddyfile` | Reverse proxy and TLS |
| `backend/backup.js` | Nightly backup: pg_dump + photos, encrypted, uploaded, heartbeat |
| `backend/scripts/restore.mjs` | `npm run restore`: restores a backup set into a named database |

`docker-compose.yml` remains the **local demo/dev** stack (MinIO + Mailpit, `--profile demo`). Don't use it
for clients.

---

## 1. Accounts you need (one KS Emerald account per provider, 2FA on)

| Need | Default | Notes |
|---|---|---|
| VPS | OVHcloud VPS-1 (2 vCore / 4 GB / 40 GB), US region for US clients, EU region for Irish clients | Any provider with Ubuntu 24.04 LTS works. Turn on the provider's daily backup/snapshot |
| Backup bucket | Cloudflare R2 (EU jurisdiction for Irish clients) or Backblaze B2 | Use a **different provider from the VPS**, so one outage or account problem can't take out both copies |
| Photo bucket (optional) | Same provider, a **separate bucket and a separate token** | Or use `STORAGE_DRIVER=local`: photos then sit on the VPS and are included in every backup set |
| SMTP | Amazon SES (`eu-west-1` for Irish clients) or Postmark | Used for team invites, password-reset links, and quotes / invoices staff email to customers |
| Uptime | UptimeRobot free tier | §8 |
| Backup heartbeat | Healthchecks.io free tier | §8 |

Prices and residency notes: `gtm/implementation/hosting-options.md`.

## 2. Buckets and tokens

Make two buckets per client, `mbc-<slug>-backups` and (only if `STORAGE_DRIVER=s3`) `mbc-<slug>-photos`.
Give each bucket its own token, scoped to that bucket only, with read and write access. The backup
token must not be able to touch photos, and the photo token must not be able to touch backups.

### Cloudflare R2
- Create the bucket. For an Irish client, choose the **EU jurisdiction**. This can't be changed later.
- R2 → Manage API tokens → *Object Read & Write*, limited to that one bucket. Note the Access Key ID and
  Secret Access Key.
- Settings:
  ```
  BACKUP_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com      # EU bucket: https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com
  BACKUP_S3_REGION=auto
  BACKUP_S3_BUCKET=mbc-<slug>-backups
  BACKUP_S3_ACCESS_KEY=<access key id>
  BACKUP_S3_SECRET_KEY=<secret access key>
  ```
- Retention: bucket → Settings → Object lifecycle rules → delete objects with prefix `backups/` 35 days
  after upload.

### Backblaze B2
- Create a private bucket in the right region (e.g. EU Central for Irish clients). Turn on Object Lock
  if a client wants immutable backups.
- App Keys → Add a New Application Key, limited to that bucket, Read and Write. keyID = access key,
  applicationKey = secret.
- Settings:
  ```
  BACKUP_S3_ENDPOINT=https://s3.<region>.backblazeb2.com               # e.g. https://s3.eu-central-003.backblazeb2.com
  BACKUP_S3_REGION=<region>                                           # e.g. eu-central-003
  BACKUP_S3_BUCKET=mbc-<slug>-backups
  BACKUP_S3_ACCESS_KEY=<keyID>
  BACKUP_S3_SECRET_KEY=<applicationKey>
  ```
- Retention: bucket → Lifecycle Settings → custom rule for prefix `backups/`: hide after 35 days,
  delete 1 day after hiding.

Photo buckets use the same endpoint style with the `S3_*` variables (`S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE=true`).

> The old `WASABI_*` variable names still work as a per-variable fallback for `BACKUP_S3_*`. New
> deployments should use `BACKUP_S3_*` only.

## 3. Provision a server

1. Order the VPS (Ubuntu 24.04 LTS) and add your SSH public key at order time. Log in as the
   provider's sudo user (e.g. `ubuntu`), **not root**. The SSH hardening step checks for your key
   before it turns password and root login off.
2. Get the code at the release tag, using a **read-only deploy key** for this server:
   ```bash
   sudo mkdir -p /opt/mbc && sudo chown "$USER" /opt/mbc
   git clone <repo-url> /opt/mbc/app && cd /opt/mbc/app
   git checkout vX.Y.Z
   ```
3. Write the client file and fill in every `CHANGE_ME`:
   ```bash
   cp deploy/clients/example.env.example deploy/clients/<slug>.env
   chmod 600 deploy/clients/<slug>.env && nano deploy/clients/<slug>.env
   ```
4. Ask the client's DNS contact to add `A <app-host> → <server IPv4>` (plus `AAAA` for IPv6) with a
   TTL of 300.
5. Run:
   ```bash
   sudo deploy/provision.sh deploy/clients/<slug>.env
   ```
   The script:
   - upgrades the OS and installs Docker Engine + Compose, ufw and unattended-upgrades
   - turns on automatic security upgrades. It does **not** reboot automatically; `update.sh` tells you
     when a reboot is pending
   - sets ufw to deny all incoming traffic except 22/tcp, 80/tcp and 443 (tcp+udp)
   - turns off SSH password and root login (only if your user has `~/.ssh/authorized_keys`)
   - adds a 2 GB swap file if the server has none
   - writes `/opt/mbc/app/.env` (chmod 600). It forces `NODE_ENV=production`, `DEMO_MODE=false`,
     `SANDBOX_MODE=false`, `TRUST_PROXY=1` and `APP_URL=https://<APP_DOMAIN>`, and generates
     `JWT_SECRET` (96 hex chars), `POSTGRES_PASSWORD`, `INTEGRATION_ENCRYPTION_KEY` and
     `BACKUP_ENCRYPTION_KEY`. **On a re-run, existing secrets are kept, never regenerated.**
   - creates `/opt/mbc/data/{uploads,backups}` owned by uid 1000 (the container's `node` user)
   - builds and starts the stack, then waits for `/api/health`
6. **Copy the generated secrets into the password manager now** (entry `mbc-<slug>`). Without
   `BACKUP_ENCRYPTION_KEY`, no backup of this client can ever be read.
7. Create the owner account. Leave `ADMIN_PASSWORD` blank so a one-time password is generated:
   ```bash
   docker compose exec app node seed_superadmin.js
   ```
   Send the password by a separate channel. The server makes the owner change it at first sign-in (every other
   call answers 403 `PASSWORD_CHANGE_REQUIRED`): signing in opens the "Choose a new password" screen (or use the
   API as in `SETUP.md` §3).
8. Then work through the go-live checklist in §9.

After you edit `deploy/clients/<slug>.env`, re-run `sudo deploy/provision.sh deploy/clients/<slug>.env`
to rewrite `.env` and restart. Use `--env-only` to only rewrite `.env`, or `--no-start` to skip the
restart.

`.env` sets `COMPOSE_FILE=docker-compose.prod.yml`, so in `/opt/mbc/app` the plain
`docker compose ps | logs -f app | exec app ...` commands work.

### Rules that matter
- **Never publish Postgres or the app port.** Docker-published ports bypass ufw. In
  `docker-compose.prod.yml` only Caddy has `ports:`. Check from outside:
  `nc -zv <server-ip> 5432` and `nc -zv <server-ip> 3001` must fail.
- **Never run `--profile demo`, `seed_jobs.js` or `npm run sandbox` on a client server.**
- Google OAuth, QuickBooks and Twilio credentials go in the client file as env vars. Never put them in
  source.

## 4. Backups

The backup runs every night at 03:00 in `BRAND_TIMEZONE` inside the app container. You can also run it
yourself with `docker compose exec app npm run backup:run`, or as an admin via `POST /api/backup/run`.

Each run writes one **backup set** to `/opt/mbc/data/backups`, then uploads it to
`BACKUP_S3_BUCKET/BACKUP_S3_PREFIX`:

| File | Contents |
|---|---|
| `backup_<stamp>.sql.gz.enc` | `pg_dump` (plain SQL), gzipped, AES-256-GCM encrypted |
| `backup_<stamp>.uploads.tar.gz.enc` | The photo directory. Only present when `STORAGE_DRIVER=local` |
| `backup_<stamp>.manifest.json` | Sizes, sha256s, per-table row counts, pg_dump version. Not encrypted, and uploaded **last**: a set that has a manifest is complete |

- **Failures are loud.** If `pg_dump` is missing or fails, if tar fails, or if the upload fails, the
  run fails: the API returns 500, the log says `[BACKUP] FAILED`, and the heartbeat gets a `/fail` ping.
  When only the upload failed, the local copy is kept.
- **Encryption.** `BACKUP_ENCRYPTION_KEY` (generated by provision.sh) is fed through scrypt to make an
  AES-256-GCM key, with a random salt per file. No extra binaries are needed. The key sits on the
  server (in `.env`) and in the password manager. That protects the backups if the **bucket** is
  compromised, but not if the **server** is. If the key is lost, the backups can't be read.
- **Versions.** The app image ships `pg_dump`/`psql` 16 (Dockerfile `PG_CLIENT_MAJOR`) to match
  `postgres:16`. If you ever upgrade Postgres, raise both together.
- **Local retention.** `BACKUP_KEEP` sets (default 14 in the client template). Only the newest
  `BACKUP_KEEP_UPLOADS` sets (default 3) keep their photo archive locally, because photo archives are
  large.
- **Off-site retention.** Set by the bucket lifecycle rule (35 days, §2). Monthly long-term copies are
  **not automated yet**: on the 1st of each month, copy the newest set to a `monthly/` prefix by hand
  or with a host cron (`rclone copy`).
- **Size.** Every set holds a full copy of the photo directory. Once photos grow past a few GB, either
  switch the client to `STORAGE_DRIVER=s3` (an R2 photo bucket) or plan an incremental photo sync. Files
  over 100 MB are uploaded with multipart upload, so there's no 5 GB single-PUT limit.
- **The VPS provider's daily backup** is the third copy. Keep it on.

### Backup variables

| Var | Default | Meaning |
|---|---|---|
| `BACKUP_DRIVER` | `s3` if a bucket is configured, else `local` | `local` = server only (never for a live client) |
| `BACKUP_S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY` / `_SECRET_KEY` | – (falls back to `WASABI_*`) | Backup bucket (§2) |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix |
| `BACKUP_S3_FORCE_PATH_STYLE` | `true` | |
| `BACKUP_S3_MULTIPART_MB` | `100` | Files above this size use multipart upload |
| `BACKUP_ENCRYPTION_KEY` | – (generated by provision.sh) | Turns encryption on |
| `BACKUP_HEARTBEAT_URL` | – | Pinged (GET) after each successful run |
| `BACKUP_HEARTBEAT_FAIL_URL` | `<URL>/fail` for hc-ping.com URLs | Gets a POST with the error when a run fails |
| `BACKUP_KEEP` / `BACKUP_KEEP_UPLOADS` | `30` / `3` | Local retention (sets / sets that keep photos) |
| `BACKUP_DIR` | `/data/backups` in prod | Pinned by docker-compose.prod.yml |
| `BACKUP_COOLDOWN_SECONDS` | `300` | Minimum gap between manual API runs |

## 5. Restore drill (before go-live, then quarterly)

Always restore into a **scratch database** and compare row counts:

```bash
cd /opt/mbc/app
docker compose exec app npm run restore -- --list --remote             # sets in the bucket
docker compose exec app npm run restore -- latest-remote --database restore_drill --no-uploads
```

The restore:
- first prints the target: `[restore] target: database "restore_drill" on postgres:5432 — …` (check the name
  before it goes on; `npm run backup:run` prints the database it backs up the same way)
- downloads the set
- checks each file's sha256 against the manifest
- decrypts the files. The GCM tag is checked **before** anything is used
- refuses a non-empty target database (or a non-empty photo directory) unless you pass `--force` — every check
  runs before it creates or writes anything, so a refused restore leaves no empty database behind
- restores with `psql --single-transaction` and prints per-table row counts next to the manifest's

If a row count differs, the database was being written to while the backup ran. To drill the photo
restore as well, add `--uploads-dir /data/backups/restore-drill-uploads` instead of `--no-uploads`,
then delete that directory.

Clean up afterwards:
```bash
docker compose exec postgres dropdb -U mbc restore_drill
```
Write down the date, the set's stamp, how long it took (that's the real RTO evidence) and the counts in
the instance registry.

Other forms: `npm run restore -- <local file> --database X`, `npm run restore -- s3:backups/<file> --database X`,
and `--key-file <file>` when the key isn't in the environment.

### Full disaster recovery (server lost)

1. Make a new VPS and follow §3 steps 1–4. In the client file, **paste the four secrets from the
   password manager** (`JWT_SECRET`, `POSTGRES_PASSWORD`, `INTEGRATION_ENCRYPTION_KEY`,
   `BACKUP_ENCRYPTION_KEY`). provision.sh uses them instead of generating new ones.
2. Run `sudo deploy/provision.sh deploy/clients/<slug>.env`. It starts an empty, migrated database.
3. Stop the app, restore the newest set over the empty database, then start the app again:
   ```bash
   docker compose stop app
   docker compose run --rm app npm run restore -- latest-remote --database mbc --force
   docker compose up -d app
   ```
   This also restores the photos into `/data/uploads` when the set has them.
4. Point DNS at the new IP and work through §9 again. Target: within 8 business hours.

## 6. Updates and rolling back

```bash
cd /opt/mbc/app
deploy/update.sh vX.Y.Z
```
The script runs these steps in order:
1. takes a pre-update backup (it aborts if the backup fails)
2. checks out the tag (it refuses a dirty tree)
3. runs `docker compose build --pull app` and pulls the `postgres:16` and `caddy:2` patch images
4. runs migrations in a one-off container
5. runs `up -d`
6. smoke-checks: the container is healthy, `https://<domain>/api/health` answers through Caddy with a
   valid certificate, `/api/brand` shows `demoMode:false`, and nothing listens publicly on 5432/3001

If the release adds env vars, put them in the client file and run
`sudo deploy/provision.sh deploy/clients/<slug>.env --env-only` **before** updating.

**Rolling back:** on failure, update.sh prints the commands: `git checkout <previous>`, retag
`mbc-app:previous` as `mbc-app:current`, then `docker compose up -d`. Migrations are forward-only. If
the new release had already migrated the database, also restore the pre-update backup (its file name
is printed at the start of the update):
```bash
docker compose stop app
docker compose run --rm app npm run restore -- /data/backups/<file> --database mbc --force
docker compose up -d app
```
Writes made since that backup are lost, so agree it with the client first.

## 7. Day-to-day commands (in /opt/mbc/app)

| Task | Command |
|---|---|
| Status / logs | `docker compose ps`, `docker compose logs -f app`, `docker compose logs caddy` |
| Backup now | `docker compose exec app npm run backup:run` |
| List backups | `docker compose exec app npm run restore -- --list [--remote]` |
| psql | `docker compose exec postgres psql -U mbc` |
| Restart | `docker compose restart app` |
| Reboot pending? | `ls /var/run/reboot-required` (then `sudo reboot` outside working hours; containers come back on their own) |

## 8. Uptime and backup monitoring

Both free tiers below allow commercial use. Alerts go to Alex and Paul.

**UptimeRobot (free: 50 monitors, 5-minute checks)**: is the app up?
- New monitor → HTTP(s) → `https://<app-host>/api/health`, interval 5 min.
- Turn on SSL expiry alerts if your plan has them. Caddy renews certificates by itself, so this is the
  backstop.

**Healthchecks.io (free Hobbyist: 20 checks)**: did last night's backup happen?
- New check `mbc-<slug>-backup`: schedule = cron `0 3 * * *` in the client's time zone, grace 2 hours.
- Copy the ping URL (`https://hc-ping.com/<uuid>`) into `BACKUP_HEARTBEAT_URL` in the client file,
  re-run `provision.sh --env-only` and restart the app (`docker compose up -d`).
- Successful runs ping the URL. Failed runs POST the error to `<url>/fail`, so you get alerted straight
  away. A run that never happens (app down, cron broken) alerts once the grace period ends.
- Other heartbeat services work too. Set `BACKUP_HEARTBEAT_FAIL_URL` if they have a failure endpoint.

**Disk**: the 40 GB disk holds the Postgres data, the photos and the local backup copies. Check
`df -h /` in the weekly fleet check, and act at 80%: lower `BACKUP_KEEP` or move photos to R2.

## 9. First client go-live checklist

Pre-flight
- [ ] Contract + DPA signed; region decided (US / EU) and matched by the VPS, the buckets and SES
- [ ] Release tag chosen (it passed the test suites and the demo check); instance registry row created
- [ ] Backup bucket (+ photo bucket if `STORAGE_DRIVER=s3`) created, with separate scoped tokens and the 35-day lifecycle rule

Server
- [ ] VPS ordered with an SSH key; provider daily backup on
- [ ] Repo cloned at the tag with a read-only deploy key; `deploy/clients/<slug>.env` complete
- [ ] `sudo deploy/provision.sh deploy/clients/<slug>.env` finished with "app healthy"
- [ ] Generated secrets copied to the password manager (**`BACKUP_ENCRYPTION_KEY` above all**)
- [ ] `ssh root@<ip>` and password login are refused; your key login still works
- [ ] From another machine: `nc -zv <ip> 5432` and `nc -zv <ip> 3001` fail; 80/443 succeed
- [ ] `sudo ufw status` shows only 22, 80 and 443

TLS + app
- [ ] `dig +short <app-host>` shows the server IP; `curl -I https://<app-host>` returns 200/302 with a valid certificate
- [ ] `https://<app-host>/api/health` shows the client's company name and trade
- [ ] `https://<app-host>/api/brand` shows the client's colours and `"demoMode":false`
- [ ] Login page shows the client's brand, with no "Modern Blue Collar" text and no demo text
- [ ] Owner account created with `seed_superadmin.js`; one-time password sent separately; owner changed it
- [ ] KS Emerald support account created

Mail
- [ ] Sender domain verified (DKIM, SPF, DMARC); a team invite reaches a Gmail and an Outlook inbox (not spam)

Functional smoke test (provisioning checklist §10)
- [ ] Customer → job → assign → schedule → it shows on dispatch
- [ ] Photo upload shows on the job, and the file is in `/opt/mbc/data/uploads` (or the photo bucket)
- [ ] Quote + invoice; CSV exports download
- [ ] A technician account can't reach billing/admin pages
- [ ] Smoke-test records deleted

Backups + monitoring
- [ ] `docker compose exec app npm run backup:run` → `ok: true`, `encrypted: true`, and `remote.keys` lists the dump (+ uploads) + manifest
- [ ] The set is in the bucket; `--list --remote` shows it
- [ ] **Restore drill** (§5) into `restore_drill`: counts match; time recorded; scratch DB dropped
- [ ] Healthchecks.io check turned green after the manual run; a deliberate failure (§10 step 7) turned it red
- [ ] UptimeRobot monitor green; alert contacts Alex + Paul
- [ ] Next morning: the 03:00 run appears in the bucket and Healthchecks shows it

Handover
- [ ] Registry updated (URL, IP, region, tag, buckets, monitors, DNS contact, go-live date)
- [ ] Secrets only in the password manager and the server's `.env`. Nothing in git, email or chat
- [ ] Client has the app URL, owner login steps and the support channel

## 10. First real-server test (do this once on a throwaway VPS before the first client)

The scripts and compose files are lint-checked (`bash -n`, shellcheck, `docker compose config`), and
backup/restore is covered by `npm run test:platform`. **Docker itself, Caddy/TLS, ufw and the
provisioning steps have not been run on a real server yet.** On a cheap throwaway VPS with a spare
subdomain:

1. Follow §3 with a test client file (`STORAGE_DRIVER=local`, a test R2 bucket, a Healthchecks check).
   Expected result: provision.sh ends with "app healthy". Re-run it and check nothing changes and no
   new secrets are generated.
2. `docker compose exec app pg_dump --version` → 16.x; `docker compose exec app psql --version` → 16.x.
3. Check the certificate is issued (`docker compose logs caddy`, then `curl -I https://<host>`), and
   that websockets work: open a job in two browsers and see the presence indicator.
4. Port check from outside (`nc -zv`), `sudo ufw status`, SSH root/password refused.
5. Upload a photo, then `docker compose exec app npm run backup:run`. Check the 3 files in R2, and that
   Healthchecks went green.
6. Restore drill (§5), including `--uploads-dir`. Then the disaster variant on a second throwaway VPS:
   paste the secrets, `latest-remote --database mbc --force`, and the photo you uploaded shows on the job.
7. Failure path: set `BACKUP_S3_SECRET_KEY=wrong` in `.env`, run `docker compose up -d` and then
   `backup:run`. Expect a non-zero exit, a red Healthchecks check and the local copy kept. Then put the
   correct key back.
8. `deploy/update.sh <same tag>` → "UPDATE OK". Then try a deliberately broken tag/branch and follow the
   printed rollback steps.
9. Reboot the VPS: all three containers come back and the app is healthy.
10. Demo stack on a Mac (`docker compose --profile demo up --build`): still boots, and
    `npm run backup:run` in the app container uploads to MinIO.

## Troubleshooting

| Symptom | Fix |
|---|---|
| provision.sh: "fill in these values first" | A `CHANGE_ME` is left in the client file |
| Caddy logs `challenge failed` / no certificate | DNS doesn't point at this server yet, or port 80 is blocked upstream (provider firewall). Caddy retries by itself |
| App restarts with "JWT_SECRET ..." or "DEMO_MODE=true is not allowed" | `.env` was edited by hand. Re-run provision.sh |
| Backup: `pg_dump failed: server version mismatch` | Postgres is newer than the image's client. Raise `PG_CLIENT_MAJOR` in the compose build args and rebuild |
| Backup: `upload to s3://… failed` | Wrong endpoint, region or token scope. R2 needs `BACKUP_S3_REGION=auto` and the account-specific endpoint |
| Backup: `EACCES` on /data/… | The host data dirs aren't owned by uid 1000. Re-run provision.sh (as root) |
| Restore: `REFUSED: … not empty` | Intended. Use a new `--database` name, or `--force` if you really mean to overwrite |
| Restore: `Decryption failed` | Wrong `BACKUP_ENCRYPTION_KEY` for this set (check the password manager), or the file is damaged |
