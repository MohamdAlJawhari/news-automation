"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { lockPublishing, queuePublication } from "@/lib/publishing-db";
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
      await tx.workspacePublishingSettings.upsert({ where: { workspaceId: workspace.id },
        create: { workspaceId: workspace.id, destinationUsername: username, enabled, verificationPending: true },
        update: { enabled, ...(changed || form.get("verify") === "yes" ? {
          destinationUsername: username, destinationChatId: null, verifiedAt: null, verificationError: null, verificationPending: true, revision: { increment: 1 },
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
    await queuePublication(prisma, workspace.id, id, revision); refresh();
    return { success: true, message: "Queued the exact saved, approved text and verified destination." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not queue publication. Reload to check its state." }; }
}
export async function recoverTelegramPublication(_: PublishingState, form: FormData): Promise<PublishingState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  try {
    await prisma.$transaction(async tx => {
      const access = await lockPublishing(tx, workspace.id);
      if (!hasAiAccess(access.workspace)) throw new PublishingError("Access is unavailable.");
      const p = await tx.telegramPublication.findFirst({ where: { id: String(form.get("id")), workspaceId: workspace.id, status: "DELIVERY_UNKNOWN" } });
      if (!p) throw new PublishingError("This publication no longer needs recovery. Reload.");
      if (form.get("intent") === "existing") {
        const messageId = Number(form.get("messageId"));
        if (!Number.isInteger(messageId) || messageId < 1 || messageId > 2147483647) throw new PublishingError("Enter the existing message's numeric ID.");
        await tx.telegramPublication.update({ where: { id: p.id }, data: { recoveryMessageId: messageId, recoveryNote: "Owner requested verification of an existing message." } });
      } else if (form.get("intent") === "none" && form.get("confirmed") === "on") {
        if (!p.dispatchedAt || Date.now() - p.dispatchedAt.getTime() < 600000) throw new PublishingError("Wait at least ten minutes after dispatch, stop the reader, then inspect Telegram before confirming nothing was sent.");
        await tx.telegramPublication.update({ where: { id: p.id }, data: { status: "FAILED", lockedUntil: null, lockToken: null, recoveryMessageId: null, recoveryNote: "Owner confirmed reader stopped and no message sent.", lastError: "Confirmed not sent. Publish can retry this snapshot with the same Telegram random ID." } });
      } else throw new PublishingError("Confirm that the reader is stopped and Telegram contains no matching message.");
    });
    refresh(); return { success: true, message: "Recovery saved. Existing messages are verified by the connected service before recording publication." };
  } catch (e) { return { success: false, message: e instanceof PublishingError ? e.message : "Could not save recovery." }; }
}
