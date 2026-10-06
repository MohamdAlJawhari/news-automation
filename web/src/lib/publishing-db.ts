import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client";
import { lockAiAccess, hasAiAccess } from "./ai-db";
import { connectedWorkspace } from "./ai-config";
import { BLOCKING_PUBLICATIONS, MAX_TELEGRAM_TEXT, PublishingError } from "./publishing-config";

export async function lockPublishing(tx: Prisma.TransactionClient, workspaceId: string) {
  const workspace = await lockAiAccess(tx, workspaceId);
  await tx.$queryRaw`SELECT "workspaceId" FROM workspace_publishing_settings WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  const settings = await tx.workspacePublishingSettings.findUnique({ where: { workspaceId } });
  return { workspace, settings };
}

export async function queuePublication(db: PrismaClient, workspaceId: string, draftId: string, revision: number) {
  return db.$transaction(async tx => {
    const { workspace, settings } = await lockPublishing(tx, workspaceId);
    if (!connectedWorkspace(workspaceId) || !hasAiAccess(workspace)) throw new PublishingError("Connected, approved automation access is required.");
    if (!settings?.enabled || !settings.verifiedAt || !settings.destinationChatId || settings.verificationPending)
      throw new PublishingError("Enable publishing and verify the destination first.");
    const draft = await tx.aiDraft.findFirst({ where: { id: draftId, workspaceId }, include: { originalPost: { include: { sourceChannel: true } }, publications: true } });
    if (!draft || draft.editRevision !== revision || draft.reviewStatus !== "APPROVED") throw new PublishingError("Reload and approve the saved draft before publishing.");
    if (!draft.originalPost.sourceChannel.enabled || !draft.originalPost.sourceChannel.telegramAutomationEnabled)
      throw new PublishingError("Enable source monitoring and Telegram automation for this source first.");
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
    const { workspace, settings } = await lockPublishing(tx, workspaceId);
    // Expiry never authorizes a resend. Keep the token so a late durable receipt can settle it.
    await tx.telegramPublication.updateMany({ where: { workspaceId, status: "SENDING", lockedUntil: { lte: new Date() } },
      data: { status: "DELIVERY_UNKNOWN", lastError: "Sending lease expired. Inspect Telegram and recover explicitly." } });
    if (!connectedWorkspace(workspaceId) || !hasAiAccess(workspace) || !settings?.enabled || !settings.verifiedAt || settings.verificationPending) return null;
    if (settings.floodWaitUntil && settings.floodWaitUntil > new Date()) return null;
    // One outstanding send per workspace, including uncertain sends.
    if (await tx.telegramPublication.count({ where: { workspaceId, status: { in: ["SENDING", "DELIVERY_UNKNOWN"] } } })) return null;
    const candidates = await tx.telegramPublication.findMany({ where: { workspaceId, status: "QUEUED", availableAt: { lte: new Date() },
      OR: [{ destinationRevision: { not: settings.revision } }, { draft: { originalPost: { sourceChannel: { enabled: true, telegramAutomationEnabled: true } } } }] },
      include: { draft: { include: { originalPost: { include: { sourceChannel: true } } } } }, orderBy: { createdAt: "asc" }, take: 50 });
    for (const p of candidates) {
      if (p.destinationRevision !== settings.revision || p.destinationChatId !== settings.destinationChatId) {
        await tx.telegramPublication.update({ where: { id: p.id }, data: { status: "FAILED", lastError: "Destination settings changed. This snapshot was not redirected or sent." } });
        continue;
      }
      const source = p.draft.originalPost.sourceChannel;
      if (!source.enabled || !source.telegramAutomationEnabled) continue;
      if (p.draft.reviewStatus !== "APPROVED" || p.draft.editRevision !== p.draftRevision || p.text !== p.draft.finalText || p.text.length > MAX_TELEGRAM_TEXT) {
        await tx.telegramPublication.update({ where: { id: p.id }, data: { status: "FAILED", lastError: "Draft approval or snapshot is no longer eligible." } });
        continue;
      }
      return tx.telegramPublication.update({ where: { id: p.id }, data: { status: "SENDING", lockToken: randomUUID(), lockedUntil: new Date(Date.now() + 120000), dispatchedAt: new Date(), lastError: null } });
    }
    return null;
  });
}

export type PublicationResult = { id: string; token: string; outcome: "published" | "failed" | "unknown" | "flood"; chatId?: string; messageId?: number; publishedAt?: string; error?: string; seconds?: number };
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
      const status = result.outcome === "flood" ? "QUEUED" : result.outcome === "failed" ? "FAILED" : "DELIVERY_UNKNOWN";
      const availableAt = new Date(Date.now() + Math.max(1, result.seconds || 1) * 1000);
      if (result.outcome === "flood") await tx.workspacePublishingSettings.update({ where: { workspaceId }, data: { floodWaitUntil: availableAt } });
      await tx.telegramPublication.update({ where: { id: p.id }, data: { status, lockedUntil: null,
        availableAt,
        lastError: result.error || "Delivery requires recovery.", ...(status === "DELIVERY_UNKNOWN" ? {} : { lockToken: null }) } });
    }
    return true;
  });
}
