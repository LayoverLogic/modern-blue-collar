-- Hand-authored (the WASM schema engine cannot diff). Matches schema.prisma.
-- Phase 2b / B1: line-item documents, Decimal money, locale foundation.
--
--   * Money columns: DOUBLE PRECISION -> DECIMAL(12,2) (rounded half-up to cents).
--   * Quote / Invoice: number (unique, sequential per type), currency, subtotal,
--     taxTotal, reverseCharge, issuedAt, sentAt. `amount` stays the document
--     total. Existing rows: subtotal = amount, taxTotal = 0, issuedAt = createdAt,
--     numbers assigned in id order (Q-0001..., INV-0001...).
--   * QuoteLine / InvoiceLine tables (cascade-deleted with their document).
--   * Document numbers come from "DocumentCounter" through
--     mbc_next_document_number(type, prefix). The app calls it inside the
--     create transaction with the BRAND_*_PREFIX prefix, and the column DEFAULT
--     calls it too (stored prefix), so a direct insert (seed, test) still gets a
--     number. The counter row is locked by the UPDATE until the inserting
--     transaction ends, so numbers are unique, ordered and gap-free on rollback.
--   * Customer: city / zip / state nullable, no 'KS' default for state, new
--     country, addressLine2, company, taxNumber. Customer + Job: sourceSystem /
--     sourceId (unique pair) for a later import tool.
--   * PriceBookItem.taxRateKey.

-- ── Money: Float -> Decimal(12,2) ──────────────────────────────────────────
ALTER TABLE "Quote"         ALTER COLUMN "amount"   TYPE DECIMAL(12,2) USING round("amount"::numeric, 2);
ALTER TABLE "Invoice"       ALTER COLUMN "amount"   TYPE DECIMAL(12,2) USING round("amount"::numeric, 2);
ALTER TABLE "InventoryItem" ALTER COLUMN "unitCost" TYPE DECIMAL(12,2) USING round("unitCost"::numeric, 2);
ALTER TABLE "JobPart"       ALTER COLUMN "unitCost" TYPE DECIMAL(12,2) USING round("unitCost"::numeric, 2);
ALTER TABLE "PriceBookItem" ALTER COLUMN "price"    TYPE DECIMAL(12,2) USING round("price"::numeric, 2);
ALTER TABLE "PriceBookItem" ALTER COLUMN "cost"     TYPE DECIMAL(12,2) USING round("cost"::numeric, 2);

-- ── PriceBookItem ──────────────────────────────────────────────────────────
ALTER TABLE "PriceBookItem" ADD COLUMN "taxRateKey" TEXT;

-- ── Customer ───────────────────────────────────────────────────────────────
ALTER TABLE "Customer" ALTER COLUMN "city"  DROP NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "zip"   DROP NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "state" DROP NOT NULL;
ALTER TABLE "Customer" ALTER COLUMN "state" DROP DEFAULT;
ALTER TABLE "Customer" ADD COLUMN "addressLine2" TEXT;
ALTER TABLE "Customer" ADD COLUMN "country" TEXT;
ALTER TABLE "Customer" ADD COLUMN "company" TEXT;
ALTER TABLE "Customer" ADD COLUMN "taxNumber" TEXT;
ALTER TABLE "Customer" ADD COLUMN "sourceSystem" TEXT;
ALTER TABLE "Customer" ADD COLUMN "sourceId" TEXT;
CREATE UNIQUE INDEX "Customer_sourceSystem_sourceId_key" ON "Customer"("sourceSystem", "sourceId");

-- ── Job ────────────────────────────────────────────────────────────────────
ALTER TABLE "Job" ADD COLUMN "sourceSystem" TEXT;
ALTER TABLE "Job" ADD COLUMN "sourceId" TEXT;
CREATE UNIQUE INDEX "Job_sourceSystem_sourceId_key" ON "Job"("sourceSystem", "sourceId");

-- ── Document numbering ─────────────────────────────────────────────────────
CREATE TABLE "DocumentCounter" (
    "type" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentCounter_pkey" PRIMARY KEY ("type")
);

-- Allocates the next number for doc_type ('quote' | 'invoice'). A non-NULL
-- doc_prefix also becomes the stored prefix (used by the column DEFAULT).
-- Format: prefix || zero-padded sequence (at least 4 digits). An unknown type
-- returns NULL (and the NOT NULL column rejects the insert).
-- NOTE: written as a single-statement SQL function on purpose. The pg driver
-- adapter used by scripts/migrate-deploy.mjs splits migration scripts on every
-- semicolon, so no semicolon may appear inside a statement (or a comment) here.
CREATE OR REPLACE FUNCTION mbc_next_document_number(doc_type TEXT, doc_prefix TEXT)
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $fn$
  UPDATE "DocumentCounter"
     SET "next" = "next" + 1,
         "prefix" = COALESCE(doc_prefix, "prefix")
   WHERE "type" = doc_type
  RETURNING "prefix" || lpad(("next" - 1)::text, GREATEST(4, length(("next" - 1)::text)), '0')
$fn$;

-- ── Quote ──────────────────────────────────────────────────────────────────
ALTER TABLE "Quote" ADD COLUMN "number" TEXT;
ALTER TABLE "Quote" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Quote" ADD COLUMN "subtotal" DECIMAL(12,2);
ALTER TABLE "Quote" ADD COLUMN "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN "reverseCharge" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Quote" ADD COLUMN "issuedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN "sentAt" TIMESTAMP(3);

UPDATE "Quote" SET "subtotal" = "amount", "issuedAt" = "createdAt";
UPDATE "Quote" q SET "number" = 'Q-' || lpad(r.n::text, GREATEST(4, length(r.n::text)), '0')
  FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS n FROM "Quote") r
 WHERE q."id" = r."id";
INSERT INTO "DocumentCounter" ("type", "prefix", "next")
  SELECT 'quote', 'Q-', COUNT(*) + 1 FROM "Quote";

ALTER TABLE "Quote" ALTER COLUMN "subtotal" SET NOT NULL;
ALTER TABLE "Quote" ALTER COLUMN "subtotal" SET DEFAULT 0;
ALTER TABLE "Quote" ALTER COLUMN "issuedAt" SET NOT NULL;
ALTER TABLE "Quote" ALTER COLUMN "issuedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Quote" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "Quote" ALTER COLUMN "number" SET DEFAULT mbc_next_document_number('quote'::text, NULL::text);
CREATE UNIQUE INDEX "Quote_number_key" ON "Quote"("number");

-- ── Invoice ────────────────────────────────────────────────────────────────
ALTER TABLE "Invoice" ADD COLUMN "number" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Invoice" ADD COLUMN "subtotal" DECIMAL(12,2);
ALTER TABLE "Invoice" ADD COLUMN "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "reverseCharge" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Invoice" ADD COLUMN "issuedAt" TIMESTAMP(3);
ALTER TABLE "Invoice" ADD COLUMN "sentAt" TIMESTAMP(3);

UPDATE "Invoice" SET "subtotal" = "amount", "issuedAt" = "createdAt";
UPDATE "Invoice" i SET "number" = 'INV-' || lpad(r.n::text, GREATEST(4, length(r.n::text)), '0')
  FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS n FROM "Invoice") r
 WHERE i."id" = r."id";
INSERT INTO "DocumentCounter" ("type", "prefix", "next")
  SELECT 'invoice', 'INV-', COUNT(*) + 1 FROM "Invoice";

ALTER TABLE "Invoice" ALTER COLUMN "subtotal" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "subtotal" SET DEFAULT 0;
ALTER TABLE "Invoice" ALTER COLUMN "issuedAt" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "issuedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Invoice" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "number" SET DEFAULT mbc_next_document_number('invoice'::text, NULL::text);
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- ── Line items ─────────────────────────────────────────────────────────────
CREATE TABLE "QuoteLine" (
    "id" SERIAL NOT NULL,
    "quoteId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxRateKey" TEXT,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "pricebookItemId" INTEGER,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuoteLine_quoteId_position_key" ON "QuoteLine"("quoteId", "position");
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_pricebookItemId_fkey" FOREIGN KEY ("pricebookItemId") REFERENCES "PriceBookItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "InvoiceLine" (
    "id" SERIAL NOT NULL,
    "invoiceId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxRateKey" TEXT,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "pricebookItemId" INTEGER,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON "InvoiceLine"("invoiceId", "position");
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_pricebookItemId_fkey" FOREIGN KEY ("pricebookItemId") REFERENCES "PriceBookItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
