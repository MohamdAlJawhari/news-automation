/*
  Warnings:

  - A unique constraint covering the columns `[sourceChannelId]` on the table `rss_feed` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[sourceChannelId,workspaceId]` on the table `rss_feed` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "rss_feed" ADD COLUMN     "removeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "replaceRules" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sourceChannelId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "rss_feed_sourceChannelId_key" ON "rss_feed"("sourceChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "rss_feed_sourceChannelId_workspaceId_key" ON "rss_feed"("sourceChannelId", "workspaceId");

-- AddForeignKey
ALTER TABLE "rss_feed" ADD CONSTRAINT "rss_feed_sourceChannelId_workspaceId_fkey" FOREIGN KEY ("sourceChannelId", "workspaceId") REFERENCES "source_channel"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
