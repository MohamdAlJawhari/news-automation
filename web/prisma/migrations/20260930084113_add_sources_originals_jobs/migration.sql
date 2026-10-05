-- CreateEnum
CREATE TYPE "ProcessingJobType" AS ENUM ('RSS_PREPARE', 'TELEGRAM_PREPARE');

-- CreateEnum
CREATE TYPE "ProcessingJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "source_channel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "telegramChatId" TEXT,
    "title" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "original_post" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "telegramMessageId" INTEGER NOT NULL,
    "sourceUrl" TEXT,
    "originalText" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "original_post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_job" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "originalPostId" TEXT NOT NULL,
    "type" "ProcessingJobType" NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lockToken" TEXT,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_channel_workspaceId_enabled_idx" ON "source_channel"("workspaceId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "source_channel_id_workspaceId_key" ON "source_channel"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "source_channel_workspaceId_username_key" ON "source_channel"("workspaceId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "source_channel_workspaceId_telegramChatId_key" ON "source_channel"("workspaceId", "telegramChatId");

-- CreateIndex
CREATE INDEX "original_post_workspaceId_publishedAt_idx" ON "original_post"("workspaceId", "publishedAt");

-- CreateIndex
CREATE INDEX "original_post_sourceChannelId_workspaceId_idx" ON "original_post"("sourceChannelId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "original_post_id_workspaceId_key" ON "original_post"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "original_post_workspaceId_telegramChatId_telegramMessageId_key" ON "original_post"("workspaceId", "telegramChatId", "telegramMessageId");

-- CreateIndex
CREATE INDEX "processing_job_status_availableAt_idx" ON "processing_job"("status", "availableAt");

-- CreateIndex
CREATE INDEX "processing_job_status_lockedUntil_idx" ON "processing_job"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "processing_job_workspaceId_status_idx" ON "processing_job"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "processing_job_originalPostId_workspaceId_idx" ON "processing_job"("originalPostId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "processing_job_originalPostId_type_key" ON "processing_job"("originalPostId", "type");

-- AddForeignKey
ALTER TABLE "source_channel" ADD CONSTRAINT "source_channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "original_post" ADD CONSTRAINT "original_post_sourceChannelId_workspaceId_fkey" FOREIGN KEY ("sourceChannelId", "workspaceId") REFERENCES "source_channel"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_job" ADD CONSTRAINT "processing_job_originalPostId_workspaceId_fkey" FOREIGN KEY ("originalPostId", "workspaceId") REFERENCES "original_post"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
