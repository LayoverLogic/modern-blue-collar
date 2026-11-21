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

# postgresql-client: provides pg_dump for the nightly DB backup job
# (bookworm ships v15, matching the postgres:15 compose service).
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

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

# Drop privileges.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
