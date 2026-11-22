#!/usr/bin/env bash
# =============================================================================
# deploy/provision.sh — turn a fresh Ubuntu LTS VPS into one MBC client
# instance (Docker Compose: app + postgres + Caddy). Safe to re-run.
#
# Setup / run (on the server, as your sudo user — not as root over SSH):
#   1. Clone the repo at the release tag (read-only deploy key):
#        sudo mkdir -p /opt/mbc && sudo chown "$USER" /opt/mbc
#        git clone <repo-url> /opt/mbc/app && cd /opt/mbc/app && git checkout vX.Y.Z
#   2. Create the client file and fill in every CHANGE_ME:
#        cp deploy/clients/example.env.example deploy/clients/<slug>.env
#        nano deploy/clients/<slug>.env
#   3. Point the domain's DNS A/AAAA record at this server (Caddy needs it to
#      get the certificate; everything else works before DNS is ready).
#   4. Run:  sudo deploy/provision.sh deploy/clients/<slug>.env
#   5. Do what it prints at the end (store new secrets in the password manager,
#      create the owner account, run a first backup, set up monitoring).
#
# What it does (each step checks first, so re-running changes nothing that is
# already right):
#   - apt upgrade; installs ufw, unattended-upgrades, Docker Engine + Compose
#   - unattended security upgrades on (no automatic reboots)
#   - ufw: deny incoming except 22/tcp, 80/tcp, 443 (tcp+udp)
#   - SSH: key-only, no root login — only if your user has authorized_keys
#   - 2 GB swap file if the server has no swap
#   - writes ./.env (chmod 600) from the client file + forced production values
#     + generated secrets; existing secrets in ./.env are NEVER regenerated
#   - creates MBC_DATA_DIR/{uploads,backups} owned by uid 1000 (container user)
#   - docker compose -f docker-compose.prod.yml up -d --build, waits for health
#
# Options:
#   --env-only            only (re)write .env and the data dirs; no system
#                         changes, no start (bash 4+; root only needed to
#                         chown the data dirs)
#   --no-start            do everything except starting the stack
#   --skip-ssh-hardening  leave sshd_config alone
# =============================================================================
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_OUT="${REPO_DIR}/.env"
COMPOSE_FILE_NAME="docker-compose.prod.yml"

ENV_ONLY=false; NO_START=false; SKIP_SSH=false; CLIENT_FILE=""
for a in "$@"; do
  case "$a" in
    --env-only) ENV_ONLY=true ;;
    --no-start) NO_START=true ;;
    --skip-ssh-hardening) SKIP_SSH=true ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 64 ;;
    *) CLIENT_FILE="$a" ;;
  esac
done

log()  { printf '\033[1;34m[provision]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[provision] WARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[provision] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

[ -n "$CLIENT_FILE" ] || die "usage: sudo deploy/provision.sh deploy/clients/<slug>.env [--no-start|--env-only]"
[ -f "$CLIENT_FILE" ] || die "client file not found: $CLIENT_FILE"
[ -f "${REPO_DIR}/${COMPOSE_FILE_NAME}" ] || die "${COMPOSE_FILE_NAME} not found in ${REPO_DIR}"

# ── 1. Read + validate the client file (nothing is executed) ────────────────
declare -A CFG=()
declare -a ORDER=()

# parse_env FILE ARRAY_NAME [ORDER_NAME]: KEY=VALUE lines, values kept raw.
parse_env() {
  local file="$1" line k v n=0
  local -n _dst="$2"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      k="${BASH_REMATCH[2]}"; v="${BASH_REMATCH[3]}"
      if [ "${3:-}" = "ORDER" ] && [ -z "${_dst[$k]+x}" ]; then ORDER+=("$k"); fi
      # shellcheck disable=SC2004  # associative array (nameref), not arithmetic
      _dst[$k]="$v"
    else
      die "$file line $n is not KEY=VALUE: $line"
    fi
  done < "$file"
}

# unquote RAW → the value compose would see (quotes removed, ` # comment` cut)
unquote() {
  local v="$1"
  if [[ "$v" =~ ^\"(.*)\"[[:space:]]*(#.*)?$ ]]; then v="${BASH_REMATCH[1]}"
  elif [[ "$v" =~ ^\'(.*)\'[[:space:]]*(#.*)?$ ]]; then v="${BASH_REMATCH[1]}"
  else v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}"; fi
  printf '%s' "$v"
}

cfg() { unquote "${CFG[$1]:-}"; }

parse_env "$CLIENT_FILE" CFG ORDER

bad=()
for k in "${ORDER[@]}"; do
  if [[ "${CFG[$k]}" == *CHANGE_ME* ]]; then bad+=("$k"); fi
done
[ "${#bad[@]}" -eq 0 ] || die "fill in these values in $CLIENT_FILE first: ${bad[*]}"

SLUG="$(cfg CLIENT_SLUG)"; DOMAIN="$(cfg APP_DOMAIN)"; ACME="$(cfg ACME_EMAIL)"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "CLIENT_SLUG must be lowercase letters, digits, hyphens (got '$SLUG')"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "APP_DOMAIN must be a host name like app.example.com (got '$DOMAIN')"
[[ "$ACME" == *@*.* ]] || die "ACME_EMAIL must be an e-mail address (got '$ACME')"
[ -n "$(cfg BRAND_COMPANY_NAME)" ] || die "BRAND_COMPANY_NAME is required"
[ -n "$(cfg BRAND_TIMEZONE)" ] || die "BRAND_TIMEZONE is required (e.g. America/Chicago, Europe/Dublin)"

STORAGE="$(cfg STORAGE_DRIVER)"; STORAGE="${STORAGE:-local}"
if [ "$STORAGE" = "s3" ]; then
  for k in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do [ -n "$(cfg "$k")" ] || die "STORAGE_DRIVER=s3 needs $k"; done
  [ "$(cfg S3_BUCKET)" != "$(cfg BACKUP_S3_BUCKET)" ] || die "S3_BUCKET (photos) and BACKUP_S3_BUCKET must be different buckets"
elif [ "$STORAGE" != "local" ]; then die "STORAGE_DRIVER must be local or s3"; fi

BDRIVER="$(cfg BACKUP_DRIVER)"; BDRIVER="${BDRIVER:-s3}"
if [ "$BDRIVER" = "s3" ]; then
  for k in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY; do [ -n "$(cfg "$k")" ] || die "BACKUP_DRIVER=s3 needs $k"; done
else
  warn "BACKUP_DRIVER=$BDRIVER — backups stay on this server only. Not acceptable for a live client."
fi
[ -n "$(cfg SMTP_HOST)" ] || warn "SMTP_HOST is empty — team invites and sign-in e-mails will not be sent."
[ -n "$(cfg BACKUP_HEARTBEAT_URL)" ] || warn "BACKUP_HEARTBEAT_URL is empty — nobody is told if a nightly backup fails."

DATA_DIR="$(cfg MBC_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/opt/mbc/data}"
[[ "$DATA_DIR" == /* ]] || die "MBC_DATA_DIR must be an absolute path"

if ! $ENV_ONLY; then
  [ "$(id -u)" -eq 0 ] || die "run with sudo (or use --env-only)"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "this script supports Ubuntu LTS (and Debian); found ${PRETTY_NAME:-unknown}" ;;
  esac
fi

# ── 2. System setup ─────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a

system_setup() {
  log "apt: updating packages"
  apt-get update -q
  apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
  apt-get install -y -q ca-certificates curl gnupg ufw unattended-upgrades openssl git

  log "unattended security upgrades: on"
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
// Written by MBC deploy/provision.sh
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

  if docker compose version >/dev/null 2>&1; then
    log "docker: already installed ($(docker --version))"
  else
    log "docker: installing Docker Engine + Compose plugin from download.docker.com"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker >/dev/null
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ] && ! id -nG "$SUDO_USER" | grep -qw docker; then
    usermod -aG docker "$SUDO_USER"
    log "docker: added $SUDO_USER to the docker group (log out and back in to use docker without sudo)"
  fi

  log "firewall: ufw deny incoming; allow 22/tcp, 80/tcp, 443 tcp+udp"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
  ufw status | sed 's/^/    /'

  if ! $SKIP_SSH; then harden_ssh; fi

  if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -e /swapfile ]; then
    log "swap: creating a 2 GB /swapfile"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    log "swap: present"
  fi
}

harden_ssh() {
  local user="${SUDO_USER:-}" home keys conf=/etc/ssh/sshd_config.d/99-mbc-hardening.conf
  if [ -z "$user" ] || [ "$user" = "root" ]; then
    warn "SSH hardening skipped: run this via sudo from your own (non-root) user so it can check your SSH key first."
    return
  fi
  home="$(getent passwd "$user" | cut -d: -f6)"
  keys="${home}/.ssh/authorized_keys"
  if [ ! -s "$keys" ]; then
    warn "SSH hardening skipped: $keys is empty — add your public key first, or you would be locked out."
    return
  fi
  if [ -f "$conf" ]; then log "ssh: already hardened ($conf)"; return; fi
  log "ssh: key-only login, root login off ($conf)"
  cat > "$conf" <<'EOF'
# Written by MBC deploy/provision.sh
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  else
    rm -f "$conf"; warn "sshd rejected the hardening config; removed it"
  fi
}

# ── 3. .env (secrets generated once, then preserved) ────────────────────────
rand_hex() { openssl rand -hex "$1"; }

declare -A OLD=()
[ -f "$ENV_OUT" ] && parse_env "$ENV_OUT" OLD

NEW_SECRETS=()
SECRET_KEYS=" JWT_SECRET POSTGRES_PASSWORD INTEGRATION_ENCRYPTION_KEY BACKUP_ENCRYPTION_KEY "
# secret_into VAR KEY BYTES: existing .env value, else client file value, else
# a new random one (recorded in NEW_SECRETS so the operator is told to save it).
secret_into() {
  local -n _out="$1"
  local k="$2" bytes="$3" old given
  old="$(unquote "${OLD[$k]:-}")"; given="$(cfg "$k")"
  if [ -n "$old" ]; then
    if [ -n "$given" ] && [ "$given" != "$old" ]; then
      warn "$k in $CLIENT_FILE differs from the one already in .env — keeping the existing value (edit .env by hand to rotate)."
    fi
    _out="$old"
  elif [ -n "$given" ]; then
    _out="$given"
  else
    _out="$(rand_hex "$bytes")"
    NEW_SECRETS+=("$k")
  fi
}

# Keys provision.sh owns (never copied from the client file as-is).
FORCED_KEYS=" COMPOSE_FILE COMPOSE_PROJECT_NAME NODE_ENV DEMO_MODE SANDBOX_MODE PORT TRUST_PROXY APP_URL APP_BIND DATABASE_URL BACKUP_DIR LOCAL_STORAGE_DIR POSTGRES_USER POSTGRES_DB POSTGRES_PORT MBC_DATA_DIR "
DEMO_ONLY_KEYS=" DEFAULT_PASSWORD DEMO_PROSPECT MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_PORT MINIO_CONSOLE_PORT MAILPIT_SMTP_PORT MAILPIT_UI_PORT MAIL_DRIVER MAIL_OUTBOX_DIR "
SKIP_KEYS="${FORCED_KEYS}${SECRET_KEYS}${DEMO_ONLY_KEYS}"

write_env() {
  local tmp jwt pgpw intkey bkey k
  secret_into jwt JWT_SECRET 48
  secret_into pgpw POSTGRES_PASSWORD 24
  secret_into intkey INTEGRATION_ENCRYPTION_KEY 32
  secret_into bkey BACKUP_ENCRYPTION_KEY 32

  for k in "${ORDER[@]}"; do
    [ -n "$(cfg "$k")" ] || continue
    [ "$k" != "MBC_DATA_DIR" ] || continue
    case "$FORCED_KEYS" in *" $k "*) warn "$k in $CLIENT_FILE is ignored (provision.sh sets it)" ;; esac
    case "$DEMO_ONLY_KEYS" in *" $k "*) warn "$k is a demo-only setting — ignored" ;; esac
  done
  [ -z "$(cfg ADMIN_PASSWORD)" ] || warn "ADMIN_PASSWORD is set: remove it from $CLIENT_FILE and .env once the owner has signed in."

  tmp="$(mktemp "${ENV_OUT}.XXXXXX")"
  chmod 600 "$tmp"
  {
    echo "# Generated by deploy/provision.sh from $(basename "$CLIENT_FILE") on $(date -u +%Y-%m-%dT%H:%M:%SZ)."
    echo "# Re-run provision.sh after editing the client file; secrets below are kept."
    echo "# Secrets live ONLY here and in the password manager. chmod 600. Never commit."
    echo
    echo "# ── Compose ──"
    echo "COMPOSE_FILE=${COMPOSE_FILE_NAME}"
    echo "COMPOSE_PROJECT_NAME=mbc"
    echo "MBC_DATA_DIR=${DATA_DIR}"
    echo
    echo "# ── Forced production values (docker-compose.prod.yml pins them too) ──"
    echo "NODE_ENV=production"
    echo "DEMO_MODE=false"
    echo "SANDBOX_MODE=false"
    echo "PORT=3001"
    echo "TRUST_PROXY=1"
    echo "APP_URL=https://${DOMAIN}"
    echo "POSTGRES_USER=mbc"
    echo "POSTGRES_DB=mbc"
    echo
    echo "# ── Secrets ──"
    echo "JWT_SECRET=${jwt}"
    echo "POSTGRES_PASSWORD=${pgpw}"
    echo "INTEGRATION_ENCRYPTION_KEY=${intkey}"
    echo "BACKUP_ENCRYPTION_KEY=${bkey}"
    echo
    echo "# ── From $(basename "$CLIENT_FILE") ──"
    for k in "${ORDER[@]}"; do
      case "$SKIP_KEYS" in *" $k "*) continue ;; esac
      printf '%s=%s\n' "$k" "${CFG[$k]}"
    done
  } > "$tmp"
  mv -f "$tmp" "$ENV_OUT"
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then chown "$SUDO_USER" "$ENV_OUT" 2>/dev/null || true; fi
  log ".env written: $ENV_OUT (chmod 600)"
}

# ── 4. Data directories ─────────────────────────────────────────────────────
data_dirs() {
  mkdir -p "${DATA_DIR}/uploads" "${DATA_DIR}/backups"
  chmod 750 "${DATA_DIR}/uploads" "${DATA_DIR}/backups"
  if [ "$(id -u)" -eq 0 ]; then
    chown 1000:1000 "${DATA_DIR}/uploads" "${DATA_DIR}/backups"   # `node` user in the app image
  else
    warn "not root: could not chown ${DATA_DIR}/{uploads,backups} to uid 1000 (needed before the stack starts)"
  fi
  log "data dirs: ${DATA_DIR}/uploads, ${DATA_DIR}/backups"
}

# ── 5. Start + wait for health ──────────────────────────────────────────────
start_stack() {
  cd "$REPO_DIR"
  log "docker compose: building and starting (first build takes a few minutes)"
  docker compose --env-file .env -f "$COMPOSE_FILE_NAME" up -d --build --remove-orphans
  log "waiting for the app to report healthy"
  local _
  for _ in $(seq 1 60); do
    if docker compose --env-file .env -f "$COMPOSE_FILE_NAME" exec -T app \
         node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      log "app healthy"
      return 0
    fi
    sleep 5
  done
  docker compose --env-file .env -f "$COMPOSE_FILE_NAME" logs --tail 80 app >&2 || true
  die "app did not become healthy in 5 minutes (logs above)"
}

# ── Run ─────────────────────────────────────────────────────────────────────
log "client '${SLUG}' → https://${DOMAIN} (repo ${REPO_DIR})"
if ! $ENV_ONLY; then system_setup; fi
write_env
data_dirs
if ! $ENV_ONLY && ! $NO_START; then start_stack; fi

echo
if [ "${#NEW_SECRETS[@]}" -gt 0 ]; then
  printf '\033[1;31m%s\033[0m\n' "NEW SECRETS GENERATED: ${NEW_SECRETS[*]}"
  echo "  Copy them from ${ENV_OUT} into the password manager entry for '${SLUG}' NOW."
  echo "  BACKUP_ENCRYPTION_KEY is the only way to read this client's backups: if the"
  echo "  server is lost and the key was not saved, every backup is unreadable."
  echo
fi
cat <<EOF
Next steps for '${SLUG}':
  1. DNS: dig +short ${DOMAIN}   → this server's IP; then curl -I https://${DOMAIN}
  2. Owner account:  cd ${REPO_DIR} && docker compose exec app node seed_superadmin.js
     (prints a one-time password if ADMIN_PASSWORD is blank — send it by a separate channel)
  3. First backup:   docker compose exec app npm run backup:run
     then check the set in the bucket and run a restore drill (DEPLOYMENT.md §Restore drill)
  4. Monitoring: UptimeRobot → https://${DOMAIN}/api/health ; Healthchecks.io → BACKUP_HEARTBEAT_URL
  5. From outside the server: nc -zv <server-ip> 5432 and 3001 must FAIL
  6. Work through "First client go-live checklist" in DEPLOYMENT.md
EOF
