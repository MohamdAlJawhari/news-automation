import { ensureDefaultSettings } from "./campaign-settings";
import type { Prisma } from "../generated/prisma/client";

// Lock access and settings rows while making a decision. Revocation and settings
// updates serialize with draft commits; no network call occurs while locked.
export async function lockAiAccess(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$queryRaw`SELECT u.id FROM "user" u JOIN workspace w ON w."ownerId" = u.id WHERE w.id = ${workspaceId} FOR UPDATE OF u`;
  await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${workspaceId} FOR UPDATE`;
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, include: { owner: true } });
  if (!workspace) return null;
  const settings = await ensureDefaultSettings(tx, workspaceId);
  await tx.$queryRaw`SELECT "campaignId" FROM campaign_ai_settings WHERE "campaignId" = ${settings.campaign.id} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM source_channel WHERE "workspaceId" = ${workspaceId} ORDER BY id FOR UPDATE`;
  const aiSettings = await tx.campaignAiSettings.findUniqueOrThrow({ where: { campaignId_workspaceId: { campaignId: settings.campaign.id, workspaceId } } });
  return { ...workspace, aiSettings, defaultCampaign: settings.campaign };
}

export function hasAiAccess(workspace: Awaited<ReturnType<typeof lockAiAccess>>) {
  return Boolean(workspace?.automationEnabled && workspace.owner.emailVerified &&
    workspace.owner.approvalStatus === "APPROVED");
}
