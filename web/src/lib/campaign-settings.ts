import type { Prisma } from "../generated/prisma/client";
import { ensureDefaultCampaign } from "./default-campaign";
import { BASE_AI_PROMPT } from "./ai-prompt";

// Current pages configure Default; workers resolve explicit campaign ownership.
// Missing post-cutover settings use safe defaults, never stale workspace copies.
export async function ensureCampaignSettings(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string) {
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id_workspaceId: { id: campaignId, workspaceId } } });
  await tx.campaignAiSettings.createMany({ data: [{ workspaceId, campaignId: campaign.id, systemPrompt: BASE_AI_PROMPT }], skipDuplicates: true });
  await tx.campaignPublishingSettings.createMany({ data: [{ workspaceId, campaignId: campaign.id }], skipDuplicates: true });
  await tx.workspaceTelegramState.createMany({ data: [{ workspaceId }], skipDuplicates: true });
  const where = { campaignId_workspaceId: { campaignId: campaign.id, workspaceId } };
  return {
    campaign,
    aiSettings: await tx.campaignAiSettings.findUniqueOrThrow({ where }),
    publishingSettings: await tx.campaignPublishingSettings.findUniqueOrThrow({ where }),
    telegramState: await tx.workspaceTelegramState.findUniqueOrThrow({ where: { workspaceId } }),
  };
}

export async function ensureDefaultSettings(tx: Prisma.TransactionClient, workspaceId: string) {
  const campaign = await ensureDefaultCampaign(tx, workspaceId);
  return ensureCampaignSettings(tx, workspaceId, campaign.id);
}

// Trusted server helper; callers obtain approved workspace access first.
export async function createCampaign(tx: Prisma.TransactionClient, workspaceId: string, name: string) {
  await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (!name.trim() || name.length > 100) throw new Error("Campaign name must contain 1?100 characters.");
  const campaign = await tx.campaign.create({ data: { workspaceId, name: name.trim() } });
  return ensureCampaignSettings(tx, workspaceId, campaign.id);
}
