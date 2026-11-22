# deploy/

Scripts for running one MBC client per VPS (Ubuntu 24.04 LTS, Docker Compose, Caddy, S3-compatible
off-site backups). The full guide, including the go-live checklist and monitoring, is
[../DEPLOYMENT.md](../DEPLOYMENT.md).

| File | What it is |
|---|---|
| `provision.sh` | First-time server setup **and** re-configuration. Safe to re-run. `sudo deploy/provision.sh deploy/clients/<slug>.env` |
| `update.sh` | Updates to a release tag: backup, pull, build, migrate, restart, smoke check. `deploy/update.sh vX.Y.Z` |
| `clients/example.env.example` | Template for a client's settings. Copy it to `clients/<slug>.env`, which is gitignored |
| `Caddyfile` | TLS reverse proxy used by `../docker-compose.prod.yml` |

Quick start on a new server:

```bash
sudo mkdir -p /opt/mbc && sudo chown "$USER" /opt/mbc
git clone <repo-url> /opt/mbc/app && cd /opt/mbc/app && git checkout vX.Y.Z
cp deploy/clients/example.env.example deploy/clients/<slug>.env && nano deploy/clients/<slug>.env
sudo deploy/provision.sh deploy/clients/<slug>.env
# store the printed new secrets in the password manager, then:
docker compose exec app node seed_superadmin.js
docker compose exec app npm run backup:run
docker compose exec app npm run restore -- latest-remote --database restore_drill --no-uploads
```

Rules:
- `clients/<slug>.env` and the repo-root `.env` hold credentials. Keep them on the server and in the
  password manager only. Never commit them.
- Re-running `provision.sh` never regenerates existing secrets in `.env`. When rebuilding a lost
  server, paste the secrets from the password manager into the client file first.
- Nothing but Caddy publishes a port. Don't add `ports:` to `app` or `postgres`.

`provision.sh --env-only` only rewrites `.env` and the data dirs: no system changes and no restart.
It needs bash 4+, so run it on the Linux server, not with macOS's built-in bash.
