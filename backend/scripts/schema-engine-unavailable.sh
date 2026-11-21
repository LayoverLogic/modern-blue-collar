#!/bin/sh
# Stub used as PRISMA_SCHEMA_ENGINE_BINARY by scripts/prisma-generate.js so
# `prisma generate` does not try to download the native schema engine.
# If you see this message, a command needed the real native engine.
echo "Native Prisma schema engine is not installed in this environment." >&2
echo "Use 'npm run migrate:deploy' (WASM schema engine) for migrations," >&2
echo "or run 'npx prisma ...' on a machine that can reach binaries.prisma.sh." >&2
exit 1
