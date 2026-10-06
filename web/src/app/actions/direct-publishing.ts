"use server";
import { ensureDefaultCampaign } from "@/lib/default-campaign";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { lockPublishing, queuePublication, requestPublicationRecovery } from "@/lib/publishing-db";
import { hasAiAccess } from "@/lib/ai-db";
import { connectedWorkspace } from "@/lib/ai-config";
import { destinationUsername, PublishingError } from "@/lib/publishing-config";

export type PublishingState = { success: boolean; message: string };
function refresh() {
  revalidatePath("/workspace/publishing");
  revalidatePath("/workspace/ai-drafts");
}
export async function savePublishingSettings(_: PublishingState, form: FormData): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const username = destinationUsername(form.get("destination"));
  const enabled = form.get("enabled") === "on";
  const revision = Number(form.get("revision"));
  if (!username || !Number.isSafeInteger(revision)) return { success: false, message: "Enter a public channel username or t.me channel link." };
  if (!connectedWorkspace(workspace.id)) return { success: false, message: "This workspace has no connected Telegram account." };
  try {
    await prisma.$transaction(async tx => {
      const current = await lockPublishing(tx, workspace.id);
      if (!hasAiAccess(current.workspace)) throw new PublishingError("Access is unavailable.");
      if ((current.settings?.revision ?? 1) !== revision) throw new PublishingError("Settings changed. Reload first.");
      if (await tx.sourceChannel.count({ where: { workspaceId: workspace.id, username } })) throw new PublishingError("The destination cannot also be a monitored source. Choose another channel.");
      const changed = current.settings?.destinationUsername !== username;
      const unconfigured = current.settings!.destinationUsername === "" && current.settings!.destinationChatId === null &&
        current.settings!.verifiedAt === null && current.settings!.revision === 1;
      await tx.campaignPublishingSettings.update({ where: { campaignId_workspaceId: { campaignId: current.settings!.campaignId, workspaceId: workspace.id } },
        data: { enabled, ...(changed || form.get("verify") === "yes" ? {
          destinationUsername: username, destinationChatId: null, verifiedAt: null, verificationError: null, verificationPending: true, revision: unconfigured ? 1 : { increment: 1 },
        } : {}) } });
    });
    refresh(); return { success: true, message: "Saved. The connected reader verifies requested destinations. Disabling cannot recall a send already in flight." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not save publishing settings." }; }
}
export async function publishAiDraft(_: PublishingState, form: FormData): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const id = form.get("id"); const revision = Number(form.get("revision"));
  if (typeof id !== "string" || id.length > 100 || !Number.isSafeInteger(revision) || revision < 1) return { success: false, message: "Invalid draft. Reload first." };
  try {
    const campaign = await prisma.$transaction(tx => ensureDefaultCampaign(tx, workspace.id));
    await queuePublication(prisma, workspace.id, id, revision, campaign.id); refresh();
    return { success: true, message: "Queued the exact saved, approved text and verified destination." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not queue publication. Reload to check its state." }; }
}
export async function recoverTelegramPublication(_: PublishingState, form: FormData): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  try {
    await prisma.$transaction(async tx => {
      const campaign = await ensureDefaultCampaign(tx, workspace.id);
      await requestPublicationRecovery(tx, workspace.id, campaign.id, String(form.get("id")), String(form.get("intent")), Number(form.get("messageId")), form.get("confirmed") === "on");
    });
    refresh(); return { success: true, message: "Recovery saved. Existing messages are verified by the connected service before recording publication." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not save recovery." }; }
}
