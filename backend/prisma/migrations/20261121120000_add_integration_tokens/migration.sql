-- Hand-authored (the WASM schema engine cannot diff). Matches model
-- IntegrationToken in schema.prisma. PLAT-4: QuickBooks tokens persisted
-- (encrypted at rest by helpers/secretBox.js) instead of process memory.

-- CreateTable
CREATE TABLE "IntegrationToken" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "realmId" TEXT,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenType" TEXT,
    "expiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "connectedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationToken_provider_key" ON "IntegrationToken"("provider");
