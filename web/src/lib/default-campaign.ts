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
  await tx.sourceChannel.findUniqueOrThrow({ where: { id_workspaceId: { id: sourceId, workspaceId } } });
  const campaign = await ensureDefaultCampaign(tx, workspaceId);
  // Compatibility name: ensure an off-by-default membership only. Never copy
  // the retired source flag or overwrite an existing campaign choice.
  await tx.campaignSource.createMany({ data: [{ campaignId: campaign.id, sourceChannelId: sourceId, workspaceId }], skipDuplicates: true });
  return campaign;
}

export async function isDefaultCampaign(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string | null) {
  return campaignId !== null && Boolean(await tx.campaign.findFirst({ where: { id: campaignId, workspaceId, isDefault: true }, select: { id: true } }));
}
