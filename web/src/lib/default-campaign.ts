import type { Prisma } from "../generated/prisma/client";

// The partial unique index is authoritative, including when two transactions
// both observe a missing Default. ON CONFLICT waits for the winning insert.
export async function ensureDefaultCampaign(tx: Prisma.TransactionClient, workspaceId: string) {
  const existing = await tx.campaign.findFirst({ where: { workspaceId, isDefault: true } });
  if (existing) return existing;
  await tx.campaign.createMany({ data: [{ workspaceId, name: "Default", isDefault: true }], skipDuplicates: true });
  return tx.campaign.findFirstOrThrow({ where: { workspaceId, isDefault: true } });
}

export async function syncDefaultMembership(tx: Prisma.TransactionClient, workspaceId: string, sourceId: string) {
  // Serialize synchronization with source toggle changes; never trust a caller's flag.
  const sources = await tx.$queryRaw<{ telegramAutomationEnabled: boolean }[]>`
    SELECT "telegramAutomationEnabled" FROM source_channel
    WHERE id = ${sourceId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  if (!sources[0]) throw new Error("Source is unavailable in this workspace.");
  const campaign = await ensureDefaultCampaign(tx, workspaceId);
  await tx.$executeRaw`INSERT INTO campaign_source
    ("campaignId", "sourceChannelId", "workspaceId", "telegramAutomationEnabled")
    VALUES (${campaign.id}, ${sourceId}, ${workspaceId}, ${sources[0].telegramAutomationEnabled})
    ON CONFLICT ("campaignId", "sourceChannelId") DO UPDATE
      SET "telegramAutomationEnabled" = EXCLUDED."telegramAutomationEnabled", "updatedAt" = clock_timestamp()
      WHERE campaign_source."telegramAutomationEnabled" IS DISTINCT FROM EXCLUDED."telegramAutomationEnabled"`;
  return campaign;
}

export async function isDefaultCampaign(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string | null) {
  return campaignId !== null && Boolean(await tx.campaign.findFirst({ where: { id: campaignId, workspaceId, isDefault: true }, select: { id: true } }));
}
