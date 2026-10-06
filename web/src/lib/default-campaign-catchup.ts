import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { ensureDefaultCampaign } from "./default-campaign";

export async function inspectDefaultCampaignGaps(tx: Prisma.TransactionClient) {
  const [counts] = await tx.$queryRaw<{
    defaultsMissing: number; membershipsMissing: number; membershipFlagsDifferent: number;
    draftsUnassigned: number; telegramJobsUnassigned: number; lineageConflicts: number;
  }[]>`SELECT
    (SELECT count(*)::int FROM workspace w WHERE NOT EXISTS (SELECT 1 FROM campaign c WHERE c."workspaceId" = w.id AND c."isDefault")) AS "defaultsMissing",
    (SELECT count(*)::int FROM source_channel s WHERE NOT EXISTS (SELECT 1 FROM campaign_source m JOIN campaign c ON c.id = m."campaignId" AND c."workspaceId" = m."workspaceId" WHERE c."isDefault" AND m."sourceChannelId" = s.id AND m."workspaceId" = s."workspaceId")) AS "membershipsMissing",
    (SELECT count(*)::int FROM campaign_source m JOIN campaign c ON c.id = m."campaignId" AND c."workspaceId" = m."workspaceId" JOIN source_channel s ON s.id = m."sourceChannelId" AND s."workspaceId" = m."workspaceId" WHERE c."isDefault" AND m."telegramAutomationEnabled" IS DISTINCT FROM s."telegramAutomationEnabled") AS "membershipFlagsDifferent",
    (SELECT count(*)::int FROM ai_draft WHERE "campaignId" IS NULL) AS "draftsUnassigned",
    (SELECT count(*)::int FROM processing_job WHERE type = 'TELEGRAM_PREPARE' AND "campaignId" IS NULL) AS "telegramJobsUnassigned",
    (SELECT count(*)::int FROM processing_job j JOIN ai_draft d ON d."originalPostId" = j."originalPostId" AND d."workspaceId" = j."workspaceId"
      WHERE j.type = 'TELEGRAM_PREPARE' AND j."campaignId" IS NOT NULL AND d."campaignId" IS NOT NULL AND j."campaignId" <> d."campaignId") AS "lineageConflicts"`;
  return counts;
}

// Run only with workers and website writers stopped. No attempt/status/lease,
// activation time, existing lineage, publication, or historical timestamp changes.
export async function catchUpDefaultCampaigns(prisma: PrismaClient) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`;
    await tx.$executeRaw`LOCK TABLE workspace, source_channel, campaign, campaign_source, original_post, ai_draft, processing_job IN SHARE ROW EXCLUSIVE MODE`;
    const before = await inspectDefaultCampaignGaps(tx);
    for (const workspace of await tx.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" } })) {
      await ensureDefaultCampaign(tx, workspace.id);
    }
    const membershipsCreated = await tx.$executeRaw`INSERT INTO campaign_source
      ("campaignId", "sourceChannelId", "workspaceId", "telegramAutomationEnabled", "createdAt", "updatedAt")
      SELECT c.id, s.id, s."workspaceId", s."telegramAutomationEnabled", s."createdAt", s."updatedAt"
      FROM source_channel s JOIN campaign c ON c."workspaceId" = s."workspaceId" AND c."isDefault"
      ON CONFLICT ("campaignId", "sourceChannelId") DO NOTHING`;
    const membershipsSynchronized = await tx.$executeRaw`UPDATE campaign_source m
      SET "telegramAutomationEnabled" = s."telegramAutomationEnabled"
      FROM source_channel s, campaign c WHERE m."campaignId" = c.id AND m."workspaceId" = c."workspaceId" AND c."isDefault"
        AND m."sourceChannelId" = s.id AND m."workspaceId" = s."workspaceId"
        AND m."telegramAutomationEnabled" IS DISTINCT FROM s."telegramAutomationEnabled"`;
    const draftsAssigned = await tx.$executeRaw`UPDATE ai_draft d SET "campaignId" = c.id
      FROM campaign c WHERE d."workspaceId" = c."workspaceId" AND c."isDefault" AND d."campaignId" IS NULL`;
    const telegramJobsAssigned = await tx.$executeRaw`UPDATE processing_job j SET "campaignId" = c.id
      FROM campaign c WHERE j."workspaceId" = c."workspaceId" AND c."isDefault" AND j.type = 'TELEGRAM_PREPARE' AND j."campaignId" IS NULL`;
    const after = await inspectDefaultCampaignGaps(tx);
    if (after.lineageConflicts) throw new Error("Campaign lineage conflicts require investigation; catch-up rolled back.");
    return { defaultsCreated: before.defaultsMissing, membershipsCreated, membershipsSynchronized, draftsAssigned, telegramJobsAssigned, remaining: after };
  }, { timeout: 60000 });
}
