import { prisma } from "@/lib/prisma";
import { authenticateIngestReader } from "@/lib/ingest-auth";
import { authorizePublication, claimPublication, lockPublishing, recordPublicationResult, type PublicationResult } from "@/lib/publishing-db";
import { hasAiAccess } from "@/lib/ai-db";
import { connectedWorkspace } from "@/lib/ai-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = authenticateIngestReader(request); if (auth.error) return auth.error;
  try {
    const data = await prisma.$transaction(async tx => {
      const { workspace, telegramState } = await lockPublishing(tx, auth.workspaceId);
      if (!hasAiAccess(workspace) || !connectedWorkspace(auth.workspaceId)) return null;
      const recovery = await tx.telegramPublication.findFirst({ where: { workspaceId: auth.workspaceId, status: "DELIVERY_UNKNOWN", recoveryMessageId: { not: null } } });
      const verifications = await tx.campaignPublishingSettings.findMany({ where: { workspaceId: auth.workspaceId, verificationPending: true }, select: { campaignId: true, destinationUsername: true, revision: true }, orderBy: [{ updatedAt: "asc" }, { campaignId: "asc" }], take: 10 });
      return { protocolVersion: 2, verifications: verifications.map(v => ({ campaignId: v.campaignId, username: v.destinationUsername, revision: v.revision })), recovery, floodWaitUntil: telegramState?.floodWaitUntil ?? null };
    });
    return Response.json(data ?? { protocolVersion: 2, verifications: [], recovery: null }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Publishing service unavailable." }, { status: 503 }); }
}

export async function POST(request: Request) {
  const auth = authenticateIngestReader(request); if (auth.error) return auth.error;
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid request." }, { status: 400 });
  try {
    if (body.action === "claim") return Response.json({ publication: await claimPublication(prisma, auth.workspaceId) });
    if (body.action === "wait") {
      if (!Number.isSafeInteger(body.seconds) || body.seconds < 1 || body.seconds > 2147483647) return Response.json({ error: "Invalid flood wait." }, { status: 400 });
      await prisma.$transaction(async tx => {
        const { workspace, settings, telegramState } = await lockPublishing(tx, auth.workspaceId);
        if (!hasAiAccess(workspace) || !settings) return;
        const until = new Date(Date.now() + body.seconds * 1000);
        if (!telegramState?.floodWaitUntil || telegramState.floodWaitUntil < until) await tx.workspaceTelegramState.update({ where: { workspaceId: auth.workspaceId }, data: { floodWaitUntil: until } });
      });
      return Response.json({ accepted: true });
    }
    if (body.action === "verify") {
      if (typeof body.campaignId !== "string" || body.campaignId.length > 200 || !Number.isInteger(body.revision) || typeof body.username !== "string" ||
        (body.chatId !== undefined && (typeof body.chatId !== "string" || !/^-100[1-9]\d{0,15}$/.test(body.chatId)))) return Response.json({ error: "Invalid verification." }, { status: 400 });
      const accepted = await prisma.$transaction(async tx => {
        const { workspace } = await lockPublishing(tx, auth.workspaceId);
        const settings = await tx.campaignPublishingSettings.findFirst({ where: { workspaceId: auth.workspaceId, campaignId: body.campaignId } });
        if (!hasAiAccess(workspace) || !settings?.verificationPending || settings.revision !== body.revision || settings.destinationUsername !== body.username) return false;
        const conflict = body.chatId && await tx.sourceChannel.count({ where: { workspaceId: auth.workspaceId, OR: [{ username: body.username }, { telegramChatId: body.chatId }] } });
        await tx.campaignPublishingSettings.update({ where: { campaignId_workspaceId: { campaignId: settings.campaignId, workspaceId: auth.workspaceId } }, data: {
          verificationPending: false, destinationChatId: conflict ? null : body.chatId ?? null,
          verifiedAt: body.chatId && !conflict ? new Date() : null,
          verificationError: conflict ? "Destination resolves to a monitored source. Choose another channel." : body.chatId ? null : safeError(body.error),
        } });
        return true;
      });
      return Response.json({ accepted });
    }
    if (typeof body.id !== "string" || body.id.length > 100 || typeof body.token !== "string" || body.token.length > 100) return Response.json({ error: "Invalid claim." }, { status: 400 });
    if (body.action === "authorize") {
      const authorized = await prisma.$transaction(tx => authorizePublication(tx, auth.workspaceId, body.id, body.token));
      return Response.json({ authorized });
    }
    if (body.action === "result" && ["published", "failed", "unknown", "flood", "paused"].includes(body.outcome)) {
      if (body.outcome === "flood" && (!Number.isSafeInteger(body.seconds) || body.seconds < 1 || body.seconds > 2147483647)) return Response.json({ error: "Invalid flood wait." }, { status: 400 });
      const result: PublicationResult = { id: body.id, token: body.token, outcome: body.outcome, chatId: body.chatId, messageId: body.messageId, publishedAt: body.publishedAt,
        error: safeError(body.error), seconds: typeof body.seconds === "number" && Number.isFinite(body.seconds) ? body.seconds : undefined };
      return Response.json({ accepted: await recordPublicationResult(prisma, auth.workspaceId, result) });
    }
    if (body.action === "recovery-error") {
      const result = await prisma.telegramPublication.updateMany({ where: { id: body.id, workspaceId: auth.workspaceId, lockToken: body.token, status: "DELIVERY_UNKNOWN", recoveryMessageId: body.messageId }, data: { recoveryMessageId: null, lastError: safeError(body.error) } });
      return Response.json({ accepted: result.count === 1 });
    }
    return Response.json({ error: "Invalid action." }, { status: 400 });
  } catch { return Response.json({ error: "Publishing decision unavailable. Retry safely." }, { status: 503 }); }
}
function safeError(value: unknown) {
  const errors: Record<string, string> = {
    PERMISSION: "Connected account must own the broadcast channel or have permission to post.",
    DESTINATION: "Destination could not be resolved to the pinned broadcast channel.",
    REJECTED: "Telegram definitely rejected this message. Check channel permissions and text.",
    UNKNOWN: "Delivery is uncertain. Inspect Telegram and recover explicitly; no automatic resend.",
    FLOOD: "Telegram requested a flood wait. The queued snapshot will wait before retrying.",
    PAUSED: "Access, source automation or publishing settings changed before sending. Nothing was sent.",
    RECOVERY: "Existing message must be an outgoing post with exactly the snapshot text in the pinned channel.",
  };
  return typeof value === "string" && errors[value] ? errors[value] : "Telegram verification or delivery failed. Check the connected account and channel.";
}
