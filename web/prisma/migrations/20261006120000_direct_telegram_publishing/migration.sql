-- CreateEnum
CREATE TYPE "TelegramPublicationStatus" AS ENUM ('QUEUED', 'SENDING', 'PUBLISHED', 'FAILED', 'DELIVERY_UNKNOWN');

-- AlterTable
ALTER TABLE "source_channel" ADD COLUMN     "telegramAutomationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "workspace_publishing_settings" (
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "destinationUsername" TEXT NOT NULL DEFAULT '',
    "destinationChatId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationError" TEXT,
    "verificationPending" BOOLEAN NOT NULL DEFAULT false,
    "floodWaitUntil" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_publishing_settings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "telegram_publication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "destinationChatId" TEXT NOT NULL,
    "destinationUsername" TEXT NOT NULL,
    "destinationRevision" INTEGER NOT NULL,
    "randomId" TEXT NOT NULL,
    "status" "TelegramPublicationStatus" NOT NULL DEFAULT 'QUEUED',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockToken" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "telegramMessageId" INTEGER,
    "confirmedChatId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "recoveryMessageId" INTEGER,
    "recoveryNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_publication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_publication_randomId_key" ON "telegram_publication"("randomId");

-- CreateIndex
CREATE INDEX "telegram_publication_workspaceId_status_availableAt_idx" ON "telegram_publication"("workspaceId", "status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_publication_draftId_draftRevision_key" ON "telegram_publication"("draftId", "draftRevision");

-- CreateIndex
CREATE UNIQUE INDEX "ai_draft_id_workspaceId_key" ON "ai_draft"("id", "workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_publishing_settings" ADD CONSTRAINT "workspace_publishing_settings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_publication" ADD CONSTRAINT "telegram_publication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_publication" ADD CONSTRAINT "telegram_publication_draftId_workspaceId_fkey" FOREIGN KEY ("draftId", "workspaceId") REFERENCES "ai_draft"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Defense against duplicate active jobs, including writes outside server actions.
CREATE UNIQUE INDEX telegram_publication_one_active_draft ON telegram_publication ("draftId")
WHERE status IN ('QUEUED', 'SENDING', 'DELIVERY_UNKNOWN', 'PUBLISHED');

-- Snapshot identity is immutable, even through administrative SQL updates.
CREATE FUNCTION protect_telegram_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId", NEW."draftId", NEW."draftRevision", NEW.text,
    NEW."destinationChatId", NEW."destinationUsername", NEW."destinationRevision", NEW."randomId")
    IS DISTINCT FROM ROW(OLD."workspaceId", OLD."draftId", OLD."draftRevision", OLD.text,
    OLD."destinationChatId", OLD."destinationUsername", OLD."destinationRevision", OLD."randomId") THEN
    RAISE EXCEPTION 'Telegram publication snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER telegram_snapshot_immutable BEFORE UPDATE ON telegram_publication
FOR EACH ROW EXECUTE FUNCTION protect_telegram_snapshot();
