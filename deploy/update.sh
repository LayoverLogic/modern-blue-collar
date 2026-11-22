#!/usr/bin/env bash
# =============================================================================
# deploy/update.sh — update one MBC client instance to a new release.
#
# Setup / run (on the server, in the repo checkout, as the deploy user who is
# in the `docker` group — provision.sh adds the sudo user to it):
#   1. Read the release notes for the tag (migrations? new env vars?). New env
#      vars go into deploy/clients/<slug>.env, then re-run provision.sh --env-only
#      (sudo) BEFORE updating.
#   2. cd /opt/mbc/app && deploy/update.sh vX.Y.Z
#      (no tag = fast-forward the current branch; tags are what clients run)
#   3. Watch for "UPDATE OK". On failure it prints how to roll back.
#
# Steps:
#   1. pre-update backup (npm run backup:run in the running app container;
#      aborts the update if it fails, unless --skip-backup)
#   2. git fetch + checkout the tag (refuses a dirty working tree)
#   3. docker compose build app (--pull: fresh base image security updates);
#      pull the postgres:16 / caddy:2 images (patch releases)
#   4. migrate: one-off container runs scripts/migrate-deploy.mjs
#   5. restart: docker compose up -d
#   6. smoke check: container healthy, https://APP_DOMAIN/api/health through
#      Caddy with a valid certificate, /api/brand says demoMode false, and
#      nothing listens publicly on 5432/3001
#
# Options:  --skip-backup   --no-pull (use the checked-out code as is)
# =============================================================================
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

REF=""; SKIP_BACKUP=false; NO_PULL=false
for a in "$@"; do
  case "$a" in
    --skip-backup) SKIP_BACKUP=true ;;
    --no-pull) NO_PULL=true ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 64 ;;
    *) REF="$a" ;;
  esac
done

log()  { printf '\033[1;34m[update]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[update] WARNING:\033[0m %s\n' "$*" >&2; }
PREV_REF="$(git rev-parse --short HEAD)"
PREV_DESC="$(git describe --tags --always 2>/dev/null || echo "$PREV_REF")"
STAGE="start"
on_fail() {
  printf '\033[1;31m[update] FAILED during: %s (line %s: %s)\033[0m\n' "$STAGE" "$1" "$2" >&2
  cat >&2 <<EOF

Roll back to ${PREV_DESC}:
  git checkout ${PREV_REF}
  docker image inspect mbc-app:previous >/dev/null && docker tag mbc-app:previous mbc-app:current
  docker compose up -d
If the failure came AFTER the migrate step, the database schema may already be
newer than ${PREV_DESC}. Migrations are forward-only: restore the pre-update
backup (named above) with
  docker compose stop app
  docker compose run --rm app npm run restore -- /data/backups/<backup file> --database mbc --force
  docker compose up -d app
(DEPLOYMENT.md §6 "Rolling back"). Agree it with the client first: later writes are lost.
EOF
  exit 1
}
trap 'on_fail "$LINENO" "$BASH_COMMAND"' ERR

[ -f .env ] || { echo "No .env in $REPO_DIR — run deploy/provision.sh first." >&2; exit 1; }
DC=(docker compose --env-file .env -f docker-compose.prod.yml)
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' ; }
DOMAIN="$(env_get APP_DOMAIN)"
[ -n "$DOMAIN" ] || { echo "APP_DOMAIN missing from .env" >&2; exit 1; }

health_in_container() {
  "${DC[@]}" exec -T app node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null
}

# 1. Pre-update backup
STAGE="pre-update backup"
if $SKIP_BACKUP; then
  warn "--skip-backup: no pre-update backup taken"
elif [ -n "$("${DC[@]}" ps -q app 2>/dev/null)" ]; then
  log "pre-update backup"
  "${DC[@]}" exec -T app npm run -s backup:run | tee /tmp/mbc-pre-update-backup.json
  log "pre-update backup: $(grep -m1 '"filename"' /tmp/mbc-pre-update-backup.json | tr -d ' ,')"
else
  warn "app is not running — no pre-update backup possible"
fi

# 2. Code
STAGE="git checkout"
if ! $NO_PULL; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Working tree has local changes — commit/stash them or use --no-pull." >&2; exit 1; }
  git fetch --tags --prune --quiet
  if [ -n "$REF" ]; then git checkout --quiet --detach "$REF"; else git pull --ff-only --quiet; fi
fi
NEW_DESC="$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)"
log "code: ${PREV_DESC} → ${NEW_DESC}"

# 3. Build + pull
STAGE="build"
if docker image inspect mbc-app:current >/dev/null 2>&1; then docker tag mbc-app:current mbc-app:previous; fi
"${DC[@]}" build --pull app
"${DC[@]}" pull --quiet postgres caddy

# 4. Migrate (database first, then a one-off app container)
STAGE="migrate"
"${DC[@]}" up -d --wait postgres
"${DC[@]}" run --rm --no-deps -T app node scripts/migrate-deploy.mjs

# 5. Restart
STAGE="restart"
"${DC[@]}" up -d --remove-orphans

# 6. Smoke check
STAGE="smoke check"
ok=false
for _ in $(seq 1 36); do
  if health_in_container; then ok=true; break; fi
  sleep 5
done
$ok || { "${DC[@]}" logs --tail 80 app >&2; false; }
log "app healthy inside the container"

# Through Caddy, on this host, with real TLS verification (no DNS needed).
curl -fsS --max-time 20 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/health" >/dev/null \
  || { echo "Caddy/TLS check failed. The app itself is healthy: check that DNS for ${DOMAIN} points here and that the certificate was issued (docker compose logs caddy)." >&2; false; }
log "https://${DOMAIN}/api/health OK through Caddy (certificate valid)"
curl -fsS --max-time 20 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/brand" | grep -q '"demoMode":false'
log "/api/brand: demoMode false"

if command -v ss >/dev/null 2>&1; then
  exposed="$(ss -Hltn 2>/dev/null | awk '{print $4}' | grep -E '(^|[^0-9])(5432|3001)$' | grep -vE '^(127\.|\[::1\])' || true)"
  if [ -n "$exposed" ]; then echo "Postgres/app port listening publicly: $exposed" >&2; false; fi
  log "ports 5432/3001 not listening on public interfaces"
fi

trap - ERR
docker image prune -f >/dev/null 2>&1 || true
[ ! -f /var/run/reboot-required ] || warn "the OS asks for a reboot (kernel/security update): plan one outside working hours (sudo reboot; containers restart by themselves)"
log "UPDATE OK: ${PREV_DESC} → ${NEW_DESC}"
