import type { Prisma } from "../generated/prisma/client";
import { ensureDefaultCampaign } from "./default-campaign";
import { BASE_AI_PROMPT } from "./ai-prompt";

// Only the signed-in/server-configured workspace's Default is configurable.
// Missing post-cutover settings use safe defaults, never stale workspace copies.
export async function ensureDefaultSettings(tx: Prisma.TransactionClient, workspaceId: string) {
  const campaign = await ensureDefaultCampaign(tx, workspaceId);
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
