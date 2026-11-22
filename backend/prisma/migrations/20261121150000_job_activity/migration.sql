-- Hand-authored (the WASM schema engine cannot diff). Matches model
-- JobActivity in schema.prisma. GTM-18: an append-only activity log per job,
-- written by helpers/activity.js in the same transaction as the change.
--
-- jobId: FK to Job.id with ON DELETE SET NULL, so deleting a job keeps its
--   history. Every row (including the "deleted" tombstone) keeps the job id
--   in jobRef.
-- actorUserId / actorApiKeyId: no FK on purpose. An audit row must outlive
--   the user or key that made it (names are resolved at read time).
-- Append-only: the API has no update or delete route. A plpgsql trigger is
--   not possible here because the pg driver adapter used by
--   scripts/migrate-deploy.mjs splits migration scripts on every semicolon
--   (so this file must not contain one except as statement terminators).

-- CreateTable
CREATE TABLE "JobActivity" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER,
    "jobRef" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "actorApiKeyId" INTEGER,
    "type" TEXT NOT NULL,
    "from" JSONB,
    "to" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobActivity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JobActivity_type_check" CHECK ("type" IN (
        'created', 'updated', 'status_changed', 'assigned', 'rescheduled', 'note',
        'photo_added', 'photo_removed', 'quote_created', 'invoice_created', 'deleted'
    ))
);

-- CreateIndex
CREATE INDEX "JobActivity_jobId_createdAt_idx" ON "JobActivity"("jobId", "createdAt");
CREATE INDEX "JobActivity_jobRef_idx" ON "JobActivity"("jobRef");
CREATE INDEX "JobActivity_createdAt_idx" ON "JobActivity"("createdAt");

-- AddForeignKey
ALTER TABLE "JobActivity" ADD CONSTRAINT "JobActivity_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
