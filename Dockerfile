# ─────────────────────────────────────────────────────────────────────────────
# Modern Blue Collar — production-capable Node image.
# The build context is the repo ROOT, because the backend requires
# ../brand.config.js (white-label config that lives at the repo root).
#
# Prisma 7: the client is Rust-free (WASM query compiler + `pg` driver adapter)
# and migrations run through Prisma's WASM schema engine
# (backend/scripts/migrate-deploy.mjs), so no Prisma engine binary is needed at
# build or run time, on any CPU architecture (Apple Silicon included).
# ─────────────────────────────────────────────────────────────────────────────
# Node 22 LTS (Prisma 7 needs ^20.19 || ^22.12 || >=24).
FROM node:22-bookworm-slim

# PostgreSQL client tools (pg_dump for the nightly backup, psql for
# scripts/restore.mjs) from the PostgreSQL project's apt repo, so the client
# major version is chosen here instead of whatever Debian ships (bookworm = 15).
# pg_dump must be >= the server's major version: 16 serves the production
# compose file (postgres:16) and the demo compose file (postgres:15) alike.
# Override with --build-arg PG_CLIENT_MAJOR=17 if the server is ever upgraded.
ARG PG_CLIENT_MAJOR=16
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && pg_dump --version | grep -q " ${PG_CLIENT_MAJOR}\." \
 && psql --version

WORKDIR /app/backend

# 1) Install dependencies first for better layer caching. Everything the
#    postinstall (`node scripts/prisma-generate.js` → `prisma generate`) reads
#    is copied before `npm ci`: schema, prisma.config.js, scripts/, and the
#    env loader that prisma.config.js requires.
COPY backend/package.json backend/package-lock.json ./
COPY backend/prisma ./prisma
COPY backend/prisma.config.js ./prisma.config.js
COPY backend/scripts ./scripts
COPY backend/helpers/loadEnv.js ./helpers/loadEnv.js
RUN npm ci --omit=dev

# 2) Copy application source. node_modules is excluded via .dockerignore, so the
#    image's installed dependencies (and generated client) are preserved.
WORKDIR /app
COPY brand.config.js ./brand.config.js
COPY backend ./backend

WORKDIR /app/backend
RUN npm run generate

# Runtime dirs (backups, local uploads) exist in the image and belong to
# `node`, so a fresh named volume mounted there is writable. Production mounts
# host dirs at /data/* instead (deploy/provision.sh chowns them to uid 1000).
RUN mkdir -p /app/backend/backups /app/backend/storage /data/backups /data/uploads \
 && chown -R node:node /app /data

# Drop privileges.
USER node

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
