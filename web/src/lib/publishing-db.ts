import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { lockAiAccess, hasAiAccess } from "./ai-db";
import { membershipFor } from "./campaign-execution";
import { connectedWorkspace } from "./ai-config";
import { BLOCKING_PUBLICATIONS, MAX_TELEGRAM_TEXT, PublishingError } from "./publishing-config";

export async function lockPublishing(tx: Prisma.TransactionClient, workspaceId: string, campaignId?: string) {
  const workspace = await lockAiAccess(tx, workspaceId, campaignId);
  if (!workspace) return { workspace: null, settings: null, telegramState: null };
  const selectedCampaignId = workspace.campaign.id;
  await tx.$queryRaw`SELECT "campaignId" FROM campaign_publishing_settings WHERE "campaignId" = ${selectedCampaignId} AND "workspaceId" = ${workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "workspaceId" FROM workspace_telegram_state WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  const settings = await tx.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId_workspaceId: { campaignId: selectedCampaignId, workspaceId } } });
  const telegramState = await tx.workspaceTelegramState.findUniqueOrThrow({ where: { workspaceId } });
  return { workspace, settings, telegramState };
}

export async function queuePublication(db: PrismaClient, workspaceId: string, draftId: string, revision: number, expectedCampaignId?: string) {
  return db.$transaction(async tx => {
    const workspace = await lockAiAccess(tx, workspaceId);
    if (!connectedWorkspace(workspaceId) || !hasAiAccess(workspace)) throw new PublishingError("Connected, approved automation access is required.");
    const draft = await tx.aiDraft.findFirst({ where: { id: draftId, workspaceId, ...(expectedCampaignId ? { campaignId: expectedCampaignId } : {}) }, include: { originalPost: { include: { sourceChannel: true } }, publications: true, campaign: true } });
    if (!draft || draft.editRevision !== revision || draft.reviewStatus !== "APPROVED") throw new PublishingError("Reload and approve the saved draft before publishing.");
    const { settings } = await lockPublishing(tx, workspaceId, draft.campaignId);
    if (!settings?.enabled || !settings.verifiedAt || !settings.destinationChatId || settings.verificationPending)
      throw new PublishingError("Enable publishing and verify the campaign destination first.");
    const membership = await membershipFor(tx, workspaceId, draft.campaignId, draft.originalPost.sourceChannelId);
    if (!draft.originalPost.sourceChannel.enabled || !membership?.telegramAutomationEnabled)
      throw new PublishingError("Enable source monitoring and eligible Telegram participation in this campaign first.");
    if (!draft.finalText.trim() || draft.finalText.length > MAX_TELEGRAM_TEXT) throw new PublishingError("Telegram plain text must contain 1–4,096 UTF-16 characters. Edit, save and approve shorter text.");
    if (draft.publications.some(p => BLOCKING_PUBLICATIONS.includes(p.status as typeof BLOCKING_PUBLICATIONS[number])))
      throw new PublishingError("This draft already has a queued, sending, uncertain or published publication.");
    const previous = draft.publications.find(p => p.draftRevision === revision);
    if (previous) {
      if (previous.destinationChatId !== settings.destinationChatId || previous.destinationRevision !== settings.revision)
        throw new PublishingError("The destination changed. Save and approve a new draft revision before publishing there.");
      await tx.telegramPublication.update({ where: { id: previous.id }, data: { status: "QUEUED", availableAt: new Date(), lastError: null, lockToken: null, lockedUntil: null } });
      return previous.id;
    }
    return (await tx.telegramPublication.create({ data: {
      workspaceId, draftId, draftRevision: revision, text: draft.finalText,
      destinationChatId: settings.destinationChatId, destinationUsername: settings.destinationUsername,
      destinationRevision: settings.revision, randomId: (randomBytes(8).readBigUInt64BE() & (BigInt(2) ** BigInt(63) - BigInt(1)) || BigInt(1)).toString(),
    } })).id;
  });
}

export async function claimPublication(db: PrismaClient, workspaceId: string) {
  return db.$transaction(async tx => {
    const { workspace, telegramState } = await lockPublishing(tx, workspaceId);
    // Never resend after expiry; preserve the token for late durable receipts.
    await tx.telegramPublication.updateMany({ where: { workspaceId, status: "SENDING", lockedUntil: { lte: new Date() } },
      data: { status: "DELIVERY_UNKNOWN", lastError: "Sending lease expired. Inspect Telegram and recover explicitly." } });
    if (!connectedWorkspace(workspaceId) || !hasAiAccess(workspace) || !telegramState ||
        (telegramState.floodWaitUntil && telegramState.floodWaitUntil > new Date())) return null;
    if (await tx.telegramPublication.count({ where: { workspaceId, status: { in: ["SENDING", "DELIVERY_UNKNOWN"] } } })) return null;
    // SQL eligibility filters prevent a paused campaign's queue from starving others.
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT p.id FROM telegram_publication p
      JOIN ai_draft d ON d.id = p."draftId" AND d."workspaceId" = p."workspaceId"
      JOIN original_post o ON o.id = d."originalPostId" AND o."workspaceId" = d."workspaceId"
      JOIN source_channel s ON s.id = o."sourceChannelId" AND s."workspaceId" = o."workspaceId"
      JOIN campaign c ON c.id = d."campaignId" AND c."workspaceId" = d."workspaceId"
      JOIN campaign_source m ON m."campaignId" = c.id AND m."workspaceId" = c."workspaceId" AND m."sourceChannelId" = s.id
      JOIN campaign_publishing_settings cfg ON cfg."campaignId" = c.id AND cfg."workspaceId" = c."workspaceId"
      WHERE p."workspaceId" = ${workspaceId} AND p.status = 'QUEUED' AND p."availableAt" <= ${new Date()}
        AND s.enabled AND m."telegramAutomationEnabled" AND cfg.enabled AND cfg."verifiedAt" IS NOT NULL AND NOT cfg."verificationPending"
      ORDER BY p."createdAt", p.id LIMIT 50`;
    for (const { id } of ids) {
      const p = await tx.telegramPublication.findUniqueOrThrow({ where: { id }, include: { draft: { include: { campaign: { include: { publishingSettings: true } } } } } });
      const settings = p.draft.campaign.publishingSettings!;
      if (p.destinationRevision !== settings.revision || p.destinationChatId !== settings.destinationChatId) {
        await tx.telegramPublication.update({ where: { id }, data: { status: "FAILED", lastError: "Campaign destination settings changed. This snapshot was not redirected or sent." } });
        continue;
      }
      if (p.draft.reviewStatus !== "APPROVED" || p.draft.editRevision !== p.draftRevision || p.text !== p.draft.finalText || p.text.length > MAX_TELEGRAM_TEXT) {
        await tx.telegramPublication.update({ where: { id }, data: { status: "FAILED", lastError: "Draft approval or snapshot is no longer eligible." } });
        continue;
      }
      return tx.telegramPublication.update({ where: { id }, data: { status: "SENDING", lockToken: randomUUID(), lockedUntil: new Date(Date.now() + 120000), dispatchedAt: new Date(), lastError: null } });
    }
    return null;
  });
}

export async function authorizePublication(tx: Prisma.TransactionClient, workspaceId: string, id: string, token: string) {
  const { workspace, telegramState } = await lockPublishing(tx, workspaceId);
  const p = await tx.telegramPublication.findFirst({ where: { id, workspaceId, lockToken: token, status: "SENDING", lockedUntil: { gt: new Date() } },
    include: { draft: { include: { campaign: { include: { publishingSettings: true } }, originalPost: { include: { sourceChannel: true } } } } } });
  if (!p) return false;
  const settings = p.draft.campaign.publishingSettings;
  const membership = await membershipFor(tx, workspaceId, p.draft.campaignId, p.draft.originalPost.sourceChannelId);
  return Boolean(connectedWorkspace(workspaceId) && hasAiAccess(workspace) && settings?.enabled && settings.verifiedAt && !settings.verificationPending &&
    (!telegramState?.floodWaitUntil || telegramState.floodWaitUntil <= new Date()) &&
    settings.revision === p.destinationRevision && settings.destinationChatId === p.destinationChatId &&
    p.draft.reviewStatus === "APPROVED" && p.draft.editRevision === p.draftRevision && p.text === p.draft.finalText && p.text.length <= MAX_TELEGRAM_TEXT &&
    p.draft.originalPost.sourceChannel.enabled && membership?.telegramAutomationEnabled);
}

export type PublicationResult = { id: string; token: string; outcome: "published" | "failed" | "unknown" | "flood" | "paused"; chatId?: string; messageId?: number; publishedAt?: string; error?: string; seconds?: number };
// Reusable recovery boundary for a later campaign UI. Disabling campaign
// settings never prevents an owner from recording an existing delivery.
export async function requestPublicationRecovery(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string, id: string, intent: string, messageId: number, confirmed: boolean) {
  const access = await lockPublishing(tx, workspaceId, campaignId);
  if (!hasAiAccess(access.workspace)) throw new PublishingError("Access is unavailable.");
  const p = await tx.telegramPublication.findFirst({ where: { id, workspaceId, draft: { campaignId }, status: "DELIVERY_UNKNOWN" } });
  if (!p) throw new PublishingError("This publication no longer needs recovery. Reload.");
  if (intent === "existing") {
    if (!Number.isInteger(messageId) || messageId < 1 || messageId > 2147483647) throw new PublishingError("Enter the existing message's numeric ID.");
    await tx.telegramPublication.update({ where: { id: p.id }, data: { recoveryMessageId: messageId, recoveryNote: "Owner requested verification of an existing message." } });
  } else if (intent === "none" && confirmed) {
    if (!p.dispatchedAt || Date.now() - p.dispatchedAt.getTime() < 600000) throw new PublishingError("Wait at least ten minutes after dispatch, stop the reader, then inspect Telegram before confirming nothing was sent.");
    await tx.telegramPublication.update({ where: { id: p.id }, data: { status: "FAILED", lockedUntil: null, lockToken: null, recoveryMessageId: null, recoveryNote: "Owner confirmed reader stopped and no message sent.", lastError: "Confirmed not sent. Publish can retry this snapshot with the same Telegram random ID." } });
  } else throw new PublishingError("Confirm that the reader is stopped and Telegram contains no matching message.");
}
export async function recordPublicationResult(db: PrismaClient, workspaceId: string, result: PublicationResult) {
  return db.$transaction(async tx => {
    await lockPublishing(tx, workspaceId); // Receipts remain writable after access is revoked.
    const p = await tx.telegramPublication.findFirst({ where: { id: result.id, workspaceId } });
    if (!p) return false;
    if (p.lockToken !== result.token) return result.outcome !== "published"; // Obsolete non-receipts cannot change delivery.
    if (p.status === "PUBLISHED") return result.outcome !== "published" || (p.confirmedChatId === result.chatId && p.telegramMessageId === result.messageId);
    if (!["SENDING", "DELIVERY_UNKNOWN"].includes(p.status)) return false;
    if (result.outcome === "published") {
      if (result.chatId !== p.destinationChatId || !Number.isInteger(result.messageId) || !result.messageId || result.messageId < 1 || result.messageId > 2147483647 || !result.publishedAt || !Number.isFinite(Date.parse(result.publishedAt))) return false;
      await tx.telegramPublication.update({ where: { id: p.id }, data: { status: "PUBLISHED", confirmedChatId: result.chatId, telegramMessageId: result.messageId, publishedAt: new Date(result.publishedAt), lockedUntil: null, lastError: null, recoveryMessageId: null } });
    } else {
      const status = ["flood", "paused"].includes(result.outcome) ? "QUEUED" : result.outcome === "failed" ? "FAILED" : "DELIVERY_UNKNOWN";
      const availableAt = new Date(Date.now() + Math.max(1, result.seconds || 1) * 1000);
      if (result.outcome === "flood") await tx.$executeRaw`UPDATE workspace_telegram_state
        SET "floodWaitUntil" = GREATEST("floodWaitUntil", ${availableAt}), "updatedAt" = clock_timestamp()
        WHERE "workspaceId" = ${workspaceId}`;
      await tx.telegramPublication.update({ where: { id: p.id }, data: { status, lockedUntil: null,
        availableAt,
        lastError: result.error || "Delivery requires recovery.", ...(status === "DELIVERY_UNKNOWN" ? {} : { lockToken: null }) } });
    }
    return true;
  });
}
