import type { Prisma } from "../generated/prisma/client";
import { connectedWorkspace } from "./ai-config";
import { hasAiAccess } from "./ai-db";
import { lockPublishing, queuePublicationInTransaction } from "./publishing-db";
import { MAX_TELEGRAM_TEXT } from "./publishing-config";
import { membershipFor } from "./campaign-execution";

export async function setAutoSend(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string, enabled: boolean, revision: number, destinationRevision: number, destinationChatId: string, confirmed: boolean) {
  const { workspace, settings } = await lockPublishing(tx, workspaceId, campaignId);
  if (!hasAiAccess(workspace)) throw new Error("Approved automation access is required.");
  const campaign = workspace!.campaign;
  if (!Number.isSafeInteger(campaign.autoSendRevision) || campaign.autoSendRevision < 1) throw new Error("Auto-send is unavailable until the migration and matching Prisma client are deployed. Ask the administrator to complete rollout.");
  if (campaign.autoSendRevision !== revision) throw new Error("Auto-send changed. Reload before trying again.");
  if (enabled && (!confirmed || !connectedWorkspace(workspaceId) || !workspace!.aiSettings.enabled ||
      !settings?.enabled || !settings.verifiedAt || settings.verificationPending || !settings.destinationChatId ||
      settings.revision !== destinationRevision || settings.destinationChatId !== destinationChatId))
    throw new Error("Confirm the current verified destination with AI and publishing enabled.");
  await tx.campaign.update({ where: { id: campaignId }, data: { autoSendEnabled: enabled } });
  if (!enabled) {
    const reason = "Auto-send was disabled. Review and publish manually.";
    const queued = await tx.telegramPublication.findMany({ where: { workspaceId, draft: { campaignId }, deliveryMode: "AUTOMATIC", status: "QUEUED" } });
    await tx.telegramPublication.updateMany({ where: { id: { in: queued.map(p => p.id) } }, data: { status: "FAILED", lastError: reason } });
    await tx.aiDraft.updateMany({ where: { id: { in: queued.map(p => p.draftId) } }, data: { manualAttentionReason: reason } });
  }
  return tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
}

// Only the freshly inserted draft is passed here, in the worker's commit transaction.
// Existing drafts are never auto-reviewed, even after retries or reactivation.
export async function automaticallyQueueDraft(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string, draftId: string, generation: number | null, destinationRevision: number) {
  const { workspace, settings } = await lockPublishing(tx, workspaceId, campaignId);
  const draft = await tx.aiDraft.findUniqueOrThrow({ where: { id: draftId }, include: { originalPost: { include: { sourceChannel: true } }, publications: true } });
  const membership = await membershipFor(tx, workspaceId, campaignId, draft.originalPost.sourceChannelId);
  const c = workspace!.campaign;
  let reason: string | null = null;
  if (!c.autoSendEnabled) reason = "Auto-send is off. Review manually.";
  else if (generation === null || generation !== c.autoSendGeneration || !c.autoSendActivatedAt || draft.originalPost.receivedAt <= c.autoSendActivatedAt) reason = "Post belongs to an earlier Auto-send activation or was received before activation. Review manually.";
  else if (!hasAiAccess(workspace) || !connectedWorkspace(workspaceId) || !workspace!.aiSettings.enabled || !draft.originalPost.sourceChannel.enabled || !membership?.telegramAutomationEnabled) reason = "Automation access, AI or source participation is unavailable. Review manually.";
  else if (!settings?.enabled || !settings.verifiedAt || !settings.destinationChatId || settings.verificationPending || settings.revision !== destinationRevision) reason = "Publishing or verified destination changed during preparation. Review manually.";
  else if (!draft.finalText.trim() || draft.finalText.length > MAX_TELEGRAM_TEXT) reason = "Prepared text exceeds Telegram's publishing limit. Edit and review manually.";
  else if (draft.reviewStatus !== "PENDING_REVIEW" || draft.editRevision !== 1 || draft.finalText !== draft.aiText || draft.publications.length) return;
  if (reason) {
    await tx.aiDraft.update({ where: { id: draftId }, data: { manualAttentionReason: reason } });
    return;
  }
  await tx.aiDraft.update({ where: { id: draftId }, data: { reviewStatus: "APPROVED", approvalMode: "AUTOMATIC", autoSendGeneration: generation, manualAttentionReason: null } });
  await queuePublicationInTransaction(tx, workspaceId, draftId, 1, campaignId, generation!);
}
