-- Hand-authored (the WASM schema engine cannot diff). Matches model
-- IntegrationLink in schema.prisma. Maps MBC rows to rows in another system
-- (QuickBooks Online customer / invoice / payment ids, import source ids that
-- were merged into an existing customer). New table only - no existing table
-- is changed. NOTE: scripts/migrate-deploy.mjs splits on every semicolon, so
-- this file has none except at the end of statements.

-- CreateTable
CREATE TABLE "IntegrationLink" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "localId" INTEGER,
    "remoteId" TEXT NOT NULL,
    "syncToken" TEXT,
    "data" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationLink_provider_entity_remoteId_key" ON "IntegrationLink"("provider", "entity", "remoteId");

-- CreateIndex
CREATE INDEX "IntegrationLink_provider_entity_localId_idx" ON "IntegrationLink"("provider", "entity", "localId");
