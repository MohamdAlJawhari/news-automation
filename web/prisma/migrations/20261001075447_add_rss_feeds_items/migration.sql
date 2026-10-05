-- CreateTable
CREATE TABLE "rss_feed" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'News feed',
    "description" TEXT NOT NULL DEFAULT 'Latest news from selected sources.',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT,
    "headerText" TEXT NOT NULL DEFAULT '',
    "footerText" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rss_feed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rss_item" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "feedId" TEXT NOT NULL,
    "originalPostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rss_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rss_feed_workspaceId_key" ON "rss_feed"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "rss_feed_tokenHash_key" ON "rss_feed"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "rss_feed_id_workspaceId_key" ON "rss_feed"("id", "workspaceId");

-- CreateIndex
CREATE INDEX "rss_item_feedId_workspaceId_visible_publishedAt_idx" ON "rss_item"("feedId", "workspaceId", "visible", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "rss_item_originalPostId_workspaceId_key" ON "rss_item"("originalPostId", "workspaceId");

-- AddForeignKey
ALTER TABLE "rss_feed" ADD CONSTRAINT "rss_feed_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rss_item" ADD CONSTRAINT "rss_item_feedId_workspaceId_fkey" FOREIGN KEY ("feedId", "workspaceId") REFERENCES "rss_feed"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rss_item" ADD CONSTRAINT "rss_item_originalPostId_workspaceId_fkey" FOREIGN KEY ("originalPostId", "workspaceId") REFERENCES "original_post"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
