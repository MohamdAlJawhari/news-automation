"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { setAutoSend } from "@/lib/auto-send";

export async function changeAutoSend(_: { success: boolean; message: string }, form: FormData) {
  const { workspace } = await requireWorkspaceAccess("automation");
  const campaignId = form.get("campaignId");
  if (typeof campaignId !== "string" || !campaignId || campaignId.length > 200) return { success: false, message: "Invalid campaign." };
  try {
    const campaign = await prisma.$transaction(tx => setAutoSend(tx, workspace.id, campaignId, form.get("enabled") === "yes", Number(form.get("revision")), Number(form.get("destinationRevision")), String(form.get("destinationChatId") || ""), form.get("confirmed") === "yes"));
    revalidatePath("/workspace/campaigns", "layout");
    return { success: true, enabled: campaign.autoSendEnabled, revision: campaign.autoSendRevision, message: campaign.autoSendEnabled ? "Auto-send enabled for future eligible posts." : "Auto-send disabled. Undispatched automatic publications require manual publishing. An authorized or in-flight send cannot be recalled." };
  } catch (error) {
    const confirmed = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId: workspace.id }, select: { autoSendEnabled: true, autoSendRevision: true } }).catch(() => null);
    return { success: false, ...(confirmed ? { enabled: confirmed.autoSendEnabled, revision: confirmed.autoSendRevision } : {}), message: error instanceof Error && !('code' in error) ? error.message : "Auto-send could not be changed. Reload and check access." };
  }
}
