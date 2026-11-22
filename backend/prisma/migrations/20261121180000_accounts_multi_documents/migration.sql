-- Hand-authored (the WASM schema engine cannot diff). Phase 2d / B3.
-- Matches schema.prisma: User account columns, AuthToken (password reset +
-- invite links), PriceBookItem.sku, and more than one quote / invoice per job.
--
-- 1. User: sessionVersion (bumped to revoke every session token), mustChangePassword
--    (temporary passwords), passwordChangedAt, lastLoginAt.
-- 2. AuthToken: single-use, hashed (sha256) tokens. kind = reset | invite.
-- 3. Quote.jobId / Invoice.jobId lose their UNIQUE constraint (a plain index is kept).
--    Invoice.quoteId records the quote an invoice was made from; a partial unique
--    index allows one non-void invoice per quote. Backfilled from the activity log
--    (invoice_created entries carry fromQuoteId).
-- 4. PriceBookItem.sku: optional stable key for CSV imports (unique when set).
-- 5. Amount-only documents written with subtotal 0 (old seed:demo) get
--    subtotal = amount, taxTotal = 0, as the API contract says.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthToken_kind_check" CHECK ("kind" IN ('reset', 'invite'))
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");
CREATE INDEX "AuthToken_userId_kind_idx" ON "AuthToken"("userId", "kind");

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- More than one quote / invoice per job (GAP-8)
DROP INDEX "Quote_jobId_key";
DROP INDEX "Invoice_jobId_key";
CREATE INDEX "Quote_jobId_idx" ON "Quote"("jobId");
CREATE INDEX "Invoice_jobId_idx" ON "Invoice"("jobId");

ALTER TABLE "Invoice" ADD COLUMN "quoteId" INTEGER;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Invoice_quoteId_idx" ON "Invoice"("quoteId");

-- Backfill: invoices made by POST /api/invoices/from-quote logged fromQuoteId.
UPDATE "Invoice" AS i
   SET "quoteId" = (a."to"->>'fromQuoteId')::int
  FROM "JobActivity" AS a
 WHERE a."type" = 'invoice_created'
   AND a."to"->>'fromQuoteId' ~ '^[0-9]+$'
   AND a."to"->>'invoiceId' = i."id"::text
   AND EXISTS (SELECT 1 FROM "Quote" q WHERE q."id" = (a."to"->>'fromQuoteId')::int);

-- One live (non-void) invoice per quote; a voided one can be re-billed.
CREATE UNIQUE INDEX "Invoice_quoteId_live_key" ON "Invoice"("quoteId") WHERE "quoteId" IS NOT NULL AND "status" <> 'void';

-- Pricebook stable key for CSV import
ALTER TABLE "PriceBookItem" ADD COLUMN "sku" TEXT;
CREATE UNIQUE INDEX "PriceBookItem_sku_key" ON "PriceBookItem"("sku");

-- Amount-only documents: subtotal = amount (rows without lines whose subtotal was left at 0)
UPDATE "Quote" q SET "subtotal" = q."amount", "taxTotal" = 0
 WHERE q."subtotal" = 0 AND q."taxTotal" = 0 AND q."amount" <> 0
   AND NOT EXISTS (SELECT 1 FROM "QuoteLine" l WHERE l."quoteId" = q."id");
UPDATE "Invoice" i SET "subtotal" = i."amount", "taxTotal" = 0
 WHERE i."subtotal" = 0 AND i."taxTotal" = 0 AND i."amount" <> 0
   AND NOT EXISTS (SELECT 1 FROM "InvoiceLine" l WHERE l."invoiceId" = i."id");
