-- CreateEnum
CREATE TYPE "AiReviewStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "processing_job" ADD COLUMN     "outcome" TEXT;

-- CreateTable
CREATE TABLE "workspace_ai_settings" (
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "systemPrompt" TEXT NOT NULL,
    "editorialPerspective" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT 'gpt-oss:latest',
    "activatedAt" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_ai_settings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "ai_draft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "originalPostId" TEXT NOT NULL,
    "aiText" TEXT NOT NULL,
    "finalText" TEXT NOT NULL,
    "reviewStatus" "AiReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "model" TEXT NOT NULL,
    "effectivePrompt" TEXT NOT NULL,
    "settingsRevision" INTEGER NOT NULL,
    "editRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_draft_workspaceId_createdAt_idx" ON "ai_draft"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_draft_originalPostId_workspaceId_key" ON "ai_draft"("originalPostId", "workspaceId");

-- AddForeignKey
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft" ADD CONSTRAINT "ai_draft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft" ADD CONSTRAINT "ai_draft_originalPostId_workspaceId_fkey" FOREIGN KEY ("originalPostId", "workspaceId") REFERENCES "original_post"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
