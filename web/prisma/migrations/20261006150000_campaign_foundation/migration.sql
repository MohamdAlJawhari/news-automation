-- Stage 1 only: additive campaign identity, with legacy writers still supported.
BEGIN;

-- Keep the workspace/source backfill coherent if ingestion is still running.
LOCK TABLE "workspace", "source_channel" IN SHARE ROW EXCLUSIVE MODE;

-- AlterTable
ALTER TABLE "ai_draft" ADD COLUMN     "campaignId" TEXT;

-- AlterTable
ALTER TABLE "processing_job" ADD COLUMN     "campaignId" TEXT;

-- CreateTable
CREATE TABLE "campaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_source" (
    "campaignId" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "telegramAutomationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_source_pkey" PRIMARY KEY ("campaignId","sourceChannelId")
);

-- CreateIndex
CREATE INDEX "campaign_workspaceId_idx" ON "campaign"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_id_workspaceId_key" ON "campaign"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "campaign_source_workspaceId_campaignId_idx" ON "campaign_source"("workspaceId", "campaignId");

-- CreateIndex
CREATE INDEX "campaign_source_sourceChannelId_workspaceId_idx" ON "campaign_source"("sourceChannelId", "workspaceId");

-- CreateIndex
CREATE INDEX "ai_draft_campaignId_workspaceId_idx" ON "ai_draft"("campaignId", "workspaceId");

-- CreateIndex
CREATE INDEX "processing_job_campaignId_workspaceId_idx" ON "processing_job"("campaignId", "workspaceId");

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_campaignId_workspaceId_fkey" FOREIGN KEY ("campaignId", "workspaceId") REFERENCES "campaign"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft" ADD CONSTRAINT "ai_draft_campaignId_workspaceId_fkey" FOREIGN KEY ("campaignId", "workspaceId") REFERENCES "campaign"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_source" ADD CONSTRAINT "campaign_source_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_source" ADD CONSTRAINT "campaign_source_campaignId_workspaceId_fkey" FOREIGN KEY ("campaignId", "workspaceId") REFERENCES "campaign"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_source" ADD CONSTRAINT "campaign_source_sourceChannelId_workspaceId_fkey" FOREIGN KEY ("sourceChannelId", "workspaceId") REFERENCES "source_channel"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one default campaign per workspace. Other campaigns are allowed.
CREATE UNIQUE INDEX "campaign_one_default_per_workspace"
ON "campaign"("workspaceId") WHERE "isDefault";

-- RSS remains independent, including after future writers adopt campaign IDs.
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_campaign_telegram_only"
CHECK ("type" = 'TELEGRAM_PREPARE' OR "campaignId" IS NULL);

-- Deterministic IDs follow the existing SQL backfill convention. New campaigns
-- created through Prisma retain the schema's normal cuid() IDs.
INSERT INTO "campaign" ("id", "workspaceId", "name", "isDefault", "createdAt", "updatedAt")
SELECT 'campaign_default_' || "id", "id", 'Default', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "workspace";

INSERT INTO "campaign_source" (
  "campaignId", "sourceChannelId", "workspaceId", "telegramAutomationEnabled", "createdAt", "updatedAt"
)
SELECT campaign."id", source."id", source."workspaceId", source."telegramAutomationEnabled",
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "source_channel" source
JOIN "campaign" campaign ON campaign."workspaceId" = source."workspaceId" AND campaign."isDefault";

-- Label all historical drafts and Telegram jobs, including paused/failed work.
-- Preserve review, text, attempts, claims, activation times and updatedAt values.
UPDATE "ai_draft" draft SET "campaignId" = campaign."id"
FROM "campaign" campaign
WHERE campaign."workspaceId" = draft."workspaceId" AND campaign."isDefault";

UPDATE "processing_job" job SET "campaignId" = campaign."id"
FROM "campaign" campaign
WHERE campaign."workspaceId" = job."workspaceId" AND campaign."isDefault"
  AND job."type" = 'TELEGRAM_PREPARE';

-- Publications derive campaign identity from their workspace-qualified draft FK.
-- Once assigned, that identity cannot move or be cleared. Null -> assigned is
-- allowed so a later runtime rollout can label records made by current writers.
CREATE FUNCTION protect_ai_draft_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."campaignId" IS NOT NULL AND NEW."campaignId" IS DISTINCT FROM OLD."campaignId" THEN
    RAISE EXCEPTION 'Assigned AI draft campaign is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_draft_campaign_immutable BEFORE UPDATE ON "ai_draft"
FOR EACH ROW EXECUTE FUNCTION protect_ai_draft_campaign();

-- Deliberately do not change telegram_publication, protect_telegram_snapshot(),
-- publication indexes, existing original/draft/job uniqueness, or RSS tables.
COMMIT;
