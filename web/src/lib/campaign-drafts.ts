import type { Prisma } from "../generated/prisma/client";
import { requireCampaign } from "./campaign-execution";

export async function listCampaignDrafts(tx: Prisma.TransactionClient, workspaceId: string, campaignId: string, page: number, options: { search?: string; sort?: string } = {}) {
  await requireCampaign(tx, workspaceId, campaignId);
  const safePage = Math.min(100000, Math.max(1, Math.trunc(page) || 1));
  const search = options.search?.trim().slice(0, 200);
  const direction = options.sort === "oldest" ? "asc" : "desc";
  const drafts = await tx.aiDraft.findMany({ where: { workspaceId, campaignId, ...(search ? { OR: [
    { finalText: { contains: search, mode: "insensitive" as const } },
    { aiText: { contains: search, mode: "insensitive" as const } },
    { originalPost: { originalText: { contains: search, mode: "insensitive" as const } } },
    { originalPost: { sourceChannel: { username: { contains: search, mode: "insensitive" as const } } } },
  ] } : {}) },
    include: { originalPost: { include: { sourceChannel: true } }, publications: { orderBy: { createdAt: "desc" } } },
    orderBy: [{ createdAt: direction }, { id: direction }], skip: (safePage - 1) * 20, take: 21 });
  const failures = await tx.processingJob.findMany({ where: { workspaceId, campaignId, type: "TELEGRAM_PREPARE", status: "FAILED" },
    select: { id: true, lastError: true }, orderBy: { updatedAt: "desc" }, take: 5 });
  return { drafts, failures };
}
