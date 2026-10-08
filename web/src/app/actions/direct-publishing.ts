"use server";
import { ensureDefaultCampaign } from "@/lib/default-campaign";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { lockPublishing, queuePublication, requestPublicationRecovery } from "@/lib/publishing-db";
import { hasAiAccess } from "@/lib/ai-db";
import { connectedWorkspace } from "@/lib/ai-config";
import { destinationUsername, PublishingError } from "@/lib/publishing-config";

export type PublishingState = { success: boolean; message: string; revision?: number; enabled?: boolean };
function refresh() {
  revalidatePath("/workspace/publishing");
  revalidatePath("/workspace/ai-drafts");
  revalidatePath("/workspace/campaigns", "layout");
}
async function saveSettings(_: PublishingState, form: FormData, campaignId?: string): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const username = destinationUsername(form.get("destination"));
  const enabled = form.get("enabled") === "on";
  const enablementOnly = form.get("intent") === "enablement";
  const revision = Number(form.get("revision"));
  if ((!enablementOnly && !username) || !Number.isSafeInteger(revision) || revision < 1) return { success: false, message: "Enter a public channel username or t.me channel link." };
  if (!connectedWorkspace(workspace.id)) return { success: false, message: "This workspace has no connected Telegram account." };
  let confirmed: { enabled: boolean; revision: number } | undefined;
  try {
    const savedRevision = await prisma.$transaction(async tx => {
      const current = await lockPublishing(tx, workspace.id, campaignId);
      if (!hasAiAccess(current.workspace)) throw new PublishingError("Access is unavailable.");
      confirmed = { enabled: current.settings!.enabled, revision: current.settings!.revision };
      if ((current.settings?.revision ?? 1) !== revision) throw new PublishingError("Settings changed. Reload first.");
      if (!enablementOnly && await tx.sourceChannel.count({ where: { workspaceId: workspace.id, username: username! } })) throw new PublishingError("The destination cannot also be a monitored source. Choose another channel.");
      if (enablementOnly && enabled && !current.settings?.destinationUsername) throw new PublishingError("Configure a destination in Overview first.");
      const changed = !enablementOnly && current.settings?.destinationUsername !== username;
      const unconfigured = current.settings!.destinationUsername === "" && current.settings!.destinationChatId === null &&
        current.settings!.verifiedAt === null && current.settings!.revision === 1;
      const updated = await tx.campaignPublishingSettings.update({ where: { campaignId_workspaceId: { campaignId: current.settings!.campaignId, workspaceId: workspace.id } },
        data: { enabled: form.get("intent") === "destination" ? current.settings!.enabled : enabled, ...(!enablementOnly && (changed || form.get("verify") === "yes") ? {
          destinationUsername: username!, destinationChatId: null, verifiedAt: null, verificationError: null, verificationPending: true, revision: unconfigured ? 1 : { increment: 1 },
        } : {}) } });
      return { revision: updated.revision, enabled: updated.enabled };
    });
    refresh(); return { success: true, ...savedRevision, message: enablementOnly ? savedRevision.enabled ? "Publishing enabled." : "Publishing paused. An authorized or in-flight send cannot be recalled." : "Saved. The connected reader verifies requested destinations. Disabling cannot recall a send already in flight." };
  } catch (e) { return { success: false, ...confirmed, message: e instanceof PublishingError ? e.message : "Could not save publishing settings." }; }
}
async function publishDraft(_: PublishingState, form: FormData, campaignId?: string): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const id = form.get("draftId") ?? form.get("id"); const revision = Number(form.get("revision"));
  if (typeof id !== "string" || id.length > 100 || !Number.isSafeInteger(revision) || revision < 1) return { success: false, message: "Invalid draft. Reload first." };
  try {
    const selectedId = campaignId ?? (await prisma.$transaction(tx => ensureDefaultCampaign(tx, workspace.id))).id;
    await queuePublication(prisma, workspace.id, id, revision, selectedId); refresh();
    return { success: true, message: "Queued the exact saved, approved text and verified destination." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not queue publication. Reload to check its state." }; }
}
async function recoverPublication(_: PublishingState, form: FormData, campaignId?: string): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  try {
    await prisma.$transaction(async tx => {
      const selectedId = campaignId ?? (await ensureDefaultCampaign(tx, workspace.id)).id;
      await requestPublicationRecovery(tx, workspace.id, selectedId, String(form.get("publicationId") ?? form.get("id")), String(form.get("intent")), Number(form.get("messageId")), form.get("confirmed") === "on");
    });
    refresh(); return { success: true, message: "Recovery saved. Existing messages are verified by the connected service before recording publication." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not save recovery." }; }
}

export async function savePublishingSettings(previous: PublishingState, form: FormData) { return saveSettings(previous, form); }
export async function publishAiDraft(previous: PublishingState, form: FormData) { return publishDraft(previous, form); }
export async function recoverTelegramPublication(previous: PublishingState, form: FormData) { return recoverPublication(previous, form); }
function campaignId(form: FormData) {
  const id = form.get("campaignId");
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
}
export async function saveCampaignPublishingSettings(previous: PublishingState, form: FormData): Promise<PublishingState> {
  const id = campaignId(form); return id ? saveSettings(previous, form, id) : { success: false, message: "Invalid campaign. Reload first." };
}
export async function publishCampaignAiDraft(previous: PublishingState, form: FormData): Promise<PublishingState> {
  const id = campaignId(form); return id ? publishDraft(previous, form, id) : { success: false, message: "Invalid campaign. Reload first." };
}
export async function recoverCampaignTelegramPublication(previous: PublishingState, form: FormData): Promise<PublishingState> {
  const id = campaignId(form); return id ? recoverPublication(previous, form, id) : { success: false, message: "Invalid campaign. Reload first." };
}
