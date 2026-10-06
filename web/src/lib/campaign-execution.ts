import type { Prisma } from "../generated/prisma/client";

export async function requireCampaign(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string) {
  return tx.campaign.findUniqueOrThrow({ where: { id_workspaceId: { id: campaignId, workspaceId } } });
}

export async function setCampaignMembership(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string, sourceId: string, enabled: boolean) {
  await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${workspaceId} FOR UPDATE`;
  await requireCampaign(tx, workspaceId, campaignId);
  await tx.sourceChannel.findUniqueOrThrow({ where: { id_workspaceId: { id: sourceId, workspaceId } } });
  await tx.$executeRaw`SELECT set_config('app.campaign_membership_writer', 'campaign-execution', true)`;
  // PostgreSQL assigns a permanent future-only boundary on creation. The SQL
  // trigger advances revision on participation changes, including off/on cycles.
  return tx.campaignSource.upsert({
    where: { campaignId_sourceChannelId: { campaignId, sourceChannelId: sourceId } },
    create: { workspaceId, campaignId, sourceChannelId: sourceId, telegramAutomationEnabled: enabled },
    update: { telegramAutomationEnabled: enabled },
  });
}

export async function membershipFor(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string, sourceId: string) {
  return tx.campaignSource.findFirst({ where: { workspaceId, campaignId, sourceChannelId: sourceId } });
}

export function withinBoundary(receivedAt: Date, campaign: { executionStartsAt: Date }, membership: { eligibleAfter: Date } | null, settings: { activatedAt: Date | null } | null) {
  return Boolean(membership && settings?.activatedAt && receivedAt > settings.activatedAt &&
    receivedAt > campaign.executionStartsAt && receivedAt > membership.eligibleAfter);
}

export async function destinationConflict(tx: Prisma.TransactionClient, workspaceId: string, username: string, chatId?: string | null) {
  return Boolean(await tx.campaignPublishingSettings.count({ where: { workspaceId,
    OR: [{ destinationUsername: username }, ...(chatId ? [{ destinationChatId: chatId }] : [])] } }));
}

export async function sourceConflict(tx: Prisma.TransactionClient, workspaceId: string, username: string, chatId?: string) {
  return Boolean(await tx.sourceChannel.count({ where: { workspaceId,
    OR: [{ username }, ...(chatId ? [{ telegramChatId: chatId }] : [])] } }));
}
