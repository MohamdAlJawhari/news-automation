BEGIN;

-- Allow several feeds in the same workspace.
DROP INDEX "rss_feed_workspaceId_key";

-- Create one feed per existing source channel.
-- Copy existing workspace settings, but revoke access during the switch.
INSERT INTO "rss_feed" (
    "id",
    "workspaceId",
    "sourceChannelId",
    "title",
    "description",
    "enabled",
    "tokenHash",
    "headerText",
    "footerText",
    "removeKeywords",
    "replaceRules",
    "createdAt",
    "updatedAt"
)
SELECT
    'rss_channel_' || source."id",
    source."workspaceId",
    source."id",
    '@' || source."username" || ' — News',
    COALESCE(
        legacy."description",
        'Latest news from this source channel.'
    ),
    false,
    NULL,
    COALESCE(legacy."headerText", ''),
    COALESCE(legacy."footerText", ''),
    COALESCE(legacy."removeKeywords", ARRAY[]::TEXT[]),
    COALESCE(legacy."replaceRules", '[]'::JSONB),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "source_channel" AS source
LEFT JOIN "rss_feed" AS legacy
    ON legacy."workspaceId" = source."workspaceId"
    AND legacy."sourceChannelId" IS NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM "rss_feed" AS existing
    WHERE existing."sourceChannelId" = source."id"
);

-- Move each saved item to the feed for its original source.
-- Item IDs, text, visibility and publication dates are preserved.
UPDATE "rss_item" AS item
SET
    "feedId" = feed."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "original_post" AS original
JOIN "rss_feed" AS feed
    ON feed."sourceChannelId" = original."sourceChannelId"
    AND feed."workspaceId" = original."workspaceId"
WHERE item."originalPostId" = original."id"
    AND item."workspaceId" = original."workspaceId"
    AND item."feedId" <> feed."id";

-- Abort rather than delete a legacy feed that still contains items.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "rss_item" AS item
        JOIN "rss_feed" AS feed ON feed."id" = item."feedId"
        WHERE feed."sourceChannelId" IS NULL
    ) THEN
        RAISE EXCEPTION
            'Some RSS items were not reassigned. Migration cancelled.';
    END IF;
END $$;

-- Remove obsolete workspace-only feeds.
-- Their settings were copied to their source-channel feeds above.
DELETE FROM "rss_feed"
WHERE "sourceChannelId" IS NULL;

ALTER TABLE "rss_feed"
    ALTER COLUMN "sourceChannelId" SET NOT NULL;

CREATE INDEX "rss_feed_workspaceId_idx"
    ON "rss_feed"("workspaceId");

COMMIT;