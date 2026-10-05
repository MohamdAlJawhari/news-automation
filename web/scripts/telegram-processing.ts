import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { connectedWorkspace, effectivePrompt, LEASE_MS, MAX_ATTEMPTS, PreparationError } from "../src/lib/ai-config";
import { hasAiAccess, lockAiAccess } from "../src/lib/ai-db";
import { rewriteWithOllama } from "../src/lib/ollama";

type Claim = { id: string; workspaceId: string; originalPostId: string; lockToken: string; attempts: number };
type Generator = typeof rewriteWithOllama;

async function ownsClaim(tx: Prisma.TransactionClient, claim: Claim) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM processing_job
    WHERE id = ${claim.id} AND type = 'TELEGRAM_PREPARE' AND status = 'PROCESSING'
      AND "lockToken" = ${claim.lockToken} AND "lockedUntil" > clock_timestamp() FOR UPDATE`;
  return rows.length === 1;
}

async function pause(tx: Prisma.TransactionClient, claim: Claim, reason: string, refund: boolean) {
  await tx.processingJob.updateMany({
    where: { id: claim.id, lockToken: claim.lockToken, status: "PROCESSING" },
    data: { status: "PENDING", availableAt: new Date(Date.now() + 60000),
      lockToken: null, lockedUntil: null, lastError: reason,
      ...(refund ? { attempts: { decrement: 1 } } : {}),
    },
  });
}

export async function processTelegramJob(prisma: PrismaClient, generate: Generator = rewriteWithOllama) {
  const workspaceId = process.env.INGEST_WORKSPACE_ID?.trim();
  if (!workspaceId) return false;
  // Exhausted crashed claims must reach a terminal state, even while access is paused.
  await prisma.$executeRaw`UPDATE processing_job j SET status = 'FAILED',
    "lockToken" = NULL, "lockedUntil" = NULL, "completedAt" = clock_timestamp(),
    "updatedAt" = clock_timestamp(), "lastError" = 'Generation attempts exhausted (including expired claims).'
    FROM original_post o, workspace_ai_settings s
    WHERE j."workspaceId" = ${workspaceId} AND s."workspaceId" = j."workspaceId"
      AND o.id = j."originalPostId" AND o."workspaceId" = j."workspaceId"
      AND o."receivedAt" > s."activatedAt" AND j.type = 'TELEGRAM_PREPARE'
      AND j.attempts >= ${MAX_ATTEMPTS}
      AND (j.status = 'PENDING' OR (j.status = 'PROCESSING' AND (j."lockedUntil" IS NULL OR j."lockedUntil" <= clock_timestamp())))`;
  const token = randomUUID();
  // A single SQL statement selects and claims; competing workers skip locked jobs.
  const rows = await prisma.$queryRaw<Claim[]>`WITH candidate AS (
    SELECT j.id FROM processing_job j
    JOIN original_post o ON o.id = j."originalPostId" AND o."workspaceId" = j."workspaceId"
    JOIN workspace w ON w.id = j."workspaceId"
    JOIN "user" u ON u.id = w."ownerId"
    JOIN workspace_ai_settings s ON s."workspaceId" = w.id
    WHERE w.id = ${workspaceId} AND w."automationEnabled" AND u."emailVerified"
      AND u."approvalStatus" = 'APPROVED' AND s.enabled AND o."receivedAt" > s."activatedAt"
      AND j.type = 'TELEGRAM_PREPARE' AND j.attempts < ${MAX_ATTEMPTS}
      AND ((j.status = 'PENDING' AND j."availableAt" <= clock_timestamp())
        OR (j.status = 'PROCESSING' AND (j."lockedUntil" IS NULL OR j."lockedUntil" <= clock_timestamp())))
    ORDER BY j."availableAt", j."createdAt", j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
  ) UPDATE processing_job j SET status = 'PROCESSING', "lockToken" = ${token},
      "lockedUntil" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond', "updatedAt" = clock_timestamp()
    FROM candidate c WHERE j.id = c.id
    RETURNING j.id, j."workspaceId", j."originalPostId", j."lockToken", j.attempts`;
  const claim = rows[0];
  if (!claim) return false;
  let attempted = false;
  let generationRevision: number | undefined;
  try {
    const prepared = await prisma.$transaction(async (tx) => {
      const workspace = await lockAiAccess(tx, claim.workspaceId);
      if (!await ownsClaim(tx, claim)) return null;
      const settings = workspace?.aiSettings;
      const original = await tx.originalPost.findUniqueOrThrow({
        where: { id_workspaceId: { id: claim.originalPostId, workspaceId: claim.workspaceId } },
      });
      if (!connectedWorkspace(claim.workspaceId) || !hasAiAccess(workspace) || !settings?.enabled ||
          !settings.activatedAt || original.receivedAt <= settings.activatedAt) {
        await pause(tx, claim, "Waiting for enabled AI settings and approved automation access.", false);
        return null;
      }
      const existing = await tx.aiDraft.findUnique({ where: {
        originalPostId_workspaceId: { originalPostId: claim.originalPostId, workspaceId: claim.workspaceId },
      } });
      if (existing) {
        await tx.processingJob.update({ where: { id: claim.id }, data: {
          status: "COMPLETED", outcome: "DRAFT_EXISTS", completedAt: new Date(),
          lockToken: null, lockedUntil: null, lastError: null,
        } });
        return null;
      }
      await tx.processingJob.update({ where: { id: claim.id }, data: { attempts: { increment: 1 } } });
      return { revision: settings.revision, model: settings.model,
        prompt: effectivePrompt(settings), originalText: original.originalText };
    }, { timeout: 10000 });
    if (!prepared) return true;
    attempted = true;
    generationRevision = prepared.revision;
    const text = await generate(prepared.model, prepared.prompt, prepared.originalText);
    const outcome = await prisma.$transaction(async (tx) => {
      const workspace = await lockAiAccess(tx, claim.workspaceId);
      if (!await ownsClaim(tx, claim)) return "Claim expired or superseded; result discarded.";
      if (!connectedWorkspace(claim.workspaceId) || !hasAiAccess(workspace) || !workspace?.aiSettings?.enabled ||
          workspace.aiSettings.revision !== prepared.revision) {
        await pause(tx, claim, "Access or AI settings changed; stale result discarded.", true);
        return "Access or settings changed; result discarded.";
      }
      // Hold the claim row until commit; unique constraint and no-op update preserve edits.
      if (text !== null) await tx.aiDraft.upsert({
        where: { originalPostId_workspaceId: { originalPostId: claim.originalPostId, workspaceId: claim.workspaceId } },
        create: { workspaceId: claim.workspaceId, originalPostId: claim.originalPostId,
          aiText: text, finalText: text, model: prepared.model,
          effectivePrompt: prepared.prompt, settingsRevision: prepared.revision },
        update: {},
      });
      if (!await ownsClaim(tx, claim)) throw new PreparationError("Claim expired before commit.");
      const completed = await tx.processingJob.updateMany({
        where: { id: claim.id, lockToken: claim.lockToken, status: "PROCESSING" },
        data: { status: "COMPLETED", outcome: text === null ? "SKIPPED_NO_NEWS_CONTENT" : "DRAFT_CREATED",
          completedAt: new Date(), lastError: null, lockToken: null, lockedUntil: null },
      });
      if (completed.count !== 1) throw new PreparationError("Claim expired before commit.");
      return text === null ? "Skipped: no substantive news content." : "AI draft ready for review.";
    }, { timeout: 10000 });
    console.log(`[${claim.id}] ${outcome}`);
  } catch (error) {
    // Never persist arbitrary exception messages: provider/DB errors may contain input.
    const safe = error instanceof PreparationError ? error.message : "Database processing failed.";
    await prisma.$transaction(async (tx) => {
      const workspace = await lockAiAccess(tx, claim.workspaceId);
      if (!await ownsClaim(tx, claim)) return;
      if (!connectedWorkspace(claim.workspaceId) || !hasAiAccess(workspace) || !workspace?.aiSettings?.enabled ||
          (generationRevision !== undefined && workspace.aiSettings.revision !== generationRevision)) {
        await pause(tx, claim, "Access or AI settings changed; waiting for current settings.", attempted);
        return;
      }
      const count = claim.attempts + (attempted ? 1 : 0);
      const failed = count >= MAX_ATTEMPTS || (error instanceof PreparationError && !error.retryable);
      await tx.processingJob.updateMany({
        where: { id: claim.id, lockToken: claim.lockToken, status: "PROCESSING" },
        data: { status: failed ? "FAILED" : "PENDING", lastError: safe,
          availableAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.max(0, count - 1))),
          completedAt: failed ? new Date() : null, lockToken: null, lockedUntil: null },
      });
    }, { timeout: 10000 });
    console.error(`[${claim.id}] ${safe}`);
  }
  return true;
}
