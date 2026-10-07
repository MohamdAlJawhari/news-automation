import "server-only";
import { notFound } from "next/navigation";
import { requireWorkspaceAccess } from "./workspace-access";
import { prisma } from "@/lib/prisma";
import { ensureCampaignSettings } from "./campaign-settings";

export async function campaignPage(params: Promise<{ campaignId: string }>) {
  const access = await requireWorkspaceAccess("automation");
  const { campaignId } = await params;
  // Check before initialization: forged IDs must neither reveal another
  // workspace's campaign nor initialize its settings.
  if (!campaignId || campaignId.length > 200 || !await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId: access.workspace.id }, select: { id: true } })) notFound();
  const settings = await prisma.$transaction(tx => ensureCampaignSettings(tx, access.workspace.id, campaignId));
  return { ...access, ...settings };
}
