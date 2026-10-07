"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { hasAiAccess, lockAiAccess } from "@/lib/ai-db";
import { createCampaign } from "@/lib/campaign-settings";
import { destinationConflict, membershipFor, setCampaignMembership } from "@/lib/campaign-execution";

export type CampaignActionState = { success: boolean; message: string; campaignId?: string; updatedAt?: string };
function refresh() { revalidatePath("/workspace/campaigns", "layout"); revalidatePath("/workspace/sources"); }
function id(form: FormData, key: string) {
  const value = form.get(key); return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}
export async function deleteEmptyCampaign(_: CampaignActionState, form: FormData): Promise<CampaignActionState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const campaignId = id(form, "campaignId");
  if (!campaignId || form.get("confirmed") !== "yes") return { success: false, message: "Confirm deletion of this empty campaign first." };
  try {
    const message = await prisma.$transaction(async tx => {
      // Same owner/workspace lock order as ingestion, workers and settings actions.
      // The campaign row lock also blocks FK insertions by any concurrent writer.
      if (!hasAiAccess(await lockAiAccess(tx, workspace.id, campaignId))) throw new Error("Access unavailable");
      await tx.$queryRaw`SELECT id FROM campaign WHERE id = ${campaignId} AND "workspaceId" = ${workspace.id} FOR UPDATE`;
      const campaign = await tx.campaign.findUniqueOrThrow({ where: { id_workspaceId: { id: campaignId, workspaceId: workspace.id } } });
      if (campaign.isDefault) return "Default cannot be deleted.";
      const scope = { workspaceId: workspace.id, campaignId };
      const records = await tx.processingJob.count({ where: scope }) + await tx.aiDraft.count({ where: scope }) +
        await tx.telegramPublication.count({ where: { workspaceId: workspace.id, draft: { campaignId } } }) +
        await tx.campaignSource.count({ where: scope });
      if (records) return "Only empty campaigns can be deleted. Source membership history, jobs, drafts and publications must be preserved.";
      // Explicit configuration cleanup only. Historical rows are never deleted;
      // restrictive foreign keys remain the final guard for concurrent inserts.
      await tx.campaignAiSettings.deleteMany({ where: scope });
      await tx.campaignPublishingSettings.deleteMany({ where: scope });
      await tx.campaign.delete({ where: { id_workspaceId: { id: campaignId, workspaceId: workspace.id } } });
      return "Campaign deleted.";
    });
    refresh(); return { success: message === "Campaign deleted.", message };
  } catch { return { success: false, message: "Campaign is unavailable or has concurrent work. Reload before trying again." }; }
}
export async function createCampaignAction(_: CampaignActionState, form: FormData): Promise<CampaignActionState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const name = form.get("name");
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) return { success: false, message: "Enter a campaign name up to 100 characters." };
  try {
    const campaign = await prisma.$transaction(async tx => {
      if (!hasAiAccess(await lockAiAccess(tx, workspace.id))) throw new Error("Access unavailable");
      return (await createCampaign(tx, workspace.id, name)).campaign;
    });
    refresh(); return { success: true, message: "Campaign created. Choose sources and settings before enabling it.", campaignId: campaign.id };
  } catch { return { success: false, message: "Could not create campaign. Check access and try again." }; }
}
export async function renameCampaign(_: CampaignActionState, form: FormData): Promise<CampaignActionState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const campaignId = id(form, "campaignId"); const name = form.get("name"); const version = form.get("updatedAt");
  if (!campaignId || typeof name !== "string" || !name.trim() || name.trim().length > 100 || typeof version !== "string" || !Number.isFinite(Date.parse(version))) return { success: false, message: "Check the name and reload this campaign." };
  try {
    const renamed = await prisma.$transaction(async tx => {
      if (!hasAiAccess(await lockAiAccess(tx, workspace.id, campaignId))) return null;
      const changed = await tx.campaign.updateMany({ where: { id: campaignId, workspaceId: workspace.id, updatedAt: new Date(version) }, data: { name: name.trim() } });
      return changed.count ? tx.campaign.findUniqueOrThrow({ where: { id_workspaceId: { id: campaignId, workspaceId: workspace.id } } }) : null;
    });
    if (!renamed) return { success: false, message: "Campaign changed or is unavailable. Copy your name and reload." };
    refresh(); return { success: true, message: "Campaign renamed.", updatedAt: renamed.updatedAt.toISOString() };
  } catch { return { success: false, message: "Campaign is unavailable in your workspace." }; }
}
export async function changeCampaignSource(_: CampaignActionState, form: FormData): Promise<CampaignActionState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const campaignId = id(form, "campaignId"); const sourceId = id(form, "sourceId"); const intent = form.get("intent");
  if (!campaignId || !sourceId || !["join", "pause", "resume"].includes(String(intent))) return { success: false, message: "Invalid campaign source. Reload first." };
  try {
    const message = await prisma.$transaction(async tx => {
      if (!hasAiAccess(await lockAiAccess(tx, workspace.id, campaignId))) throw new Error("Access unavailable");
      const source = await tx.sourceChannel.findUniqueOrThrow({ where: { id_workspaceId: { id: sourceId, workspaceId: workspace.id } } });
      if (intent !== "pause" && await destinationConflict(tx, workspace.id, source.username, source.telegramChatId)) return "A configured publishing destination cannot participate as a source.";
      const membership = await membershipFor(tx, workspace.id, campaignId, sourceId);
      if (intent === "join") {
        if (membership) return "This source has already joined. Reload to see its participation state.";
        await setCampaignMembership(tx, workspace.id, campaignId, sourceId, false);
        return "Source joined with participation paused. Older posts will not be imported.";
      }
      if (!membership || membership.revision !== Number(form.get("revision"))) return "Participation changed or is unavailable. Reload first.";
      await setCampaignMembership(tx, workspace.id, campaignId, sourceId, intent === "resume");
      return intent === "resume" ? "Participation resumed. Retained eligible pending jobs can now run." : "Participation paused. Originals, drafts, queued work and RSS are preserved.";
    });
    const success = message.startsWith("Source joined") || message.startsWith("Participation paused") || message.startsWith("Participation resumed");
    refresh(); return { success, message };
  } catch { return { success: false, message: "Campaign or source is unavailable in your workspace." }; }
}
