"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { connectedWorkspace, LOCAL_MODELS, MAX_AI_TEXT } from "@/lib/ai-config";
import { BASE_AI_PROMPT } from "@/lib/ai-prompt";
import { hasAiAccess, lockAiAccess } from "@/lib/ai-db";

export type AiActionState = { success: boolean; message: string; revision: number };

export async function saveAiSettings(previous: AiActionState, form: FormData): Promise<AiActionState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const fail = (message: string) => ({ ...previous, success: false, message });
  const systemPrompt = form.get("systemPrompt");
  const editorialPerspective = form.get("editorialPerspective");
  const model = form.get("model");
  const revision = Number(form.get("revision"));
  const enabled = form.get("enabled") === "on";
  if (typeof systemPrompt !== "string" || !systemPrompt.trim() || systemPrompt.length > 20000 ||
      typeof editorialPerspective !== "string" || editorialPerspective.length > 2000 ||
      typeof model !== "string" || !LOCAL_MODELS.some((allowed) => allowed === model) ||
      !Number.isSafeInteger(revision) || revision < 1) return fail("Check the prompt, perspective, model and settings version.");
  if (enabled && !connectedWorkspace(workspace.id)) return fail("This workspace has no connected Telegram reader. Activation is available only for the server-configured ingestion workspace.");
  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await lockAiAccess(tx, workspace.id);
      if (!hasAiAccess(current)) return null;
      const settings = await tx.workspaceAiSettings.upsert({
        where: { workspaceId: workspace.id },
        create: { workspaceId: workspace.id, systemPrompt: BASE_AI_PROMPT }, update: {},
      });
      if (settings.revision !== revision) return null;
      // PostgreSQL clock establishes the one-time boundary; saves/resume preserve it.
      const times = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const changed = await tx.workspaceAiSettings.update({
        where: { workspaceId: workspace.id },
        data: { systemPrompt: systemPrompt.trim(), editorialPerspective: editorialPerspective.trim(), model,
          enabled, revision: { increment: 1 },
          activatedAt: settings.activatedAt ?? (enabled ? times[0].now : null) },
      });
      return changed.revision;
    });
    if (!result) return fail("Access or settings changed. Copy unsaved text and reload the page.");
    revalidatePath("/workspace/ai-settings");
    return { success: true, message: enabled ? "Saved. New posts received after first activation are eligible." : "Saved. AI preparation is paused.", revision: result };
  } catch { return fail("Could not save AI settings. Please try again."); }
}

export async function saveAiDraft(previous: AiActionState, form: FormData): Promise<AiActionState> {
  const { workspace } = await requireWorkspaceAccess("automation");
  const fail = (message: string) => ({ ...previous, success: false, message });
  const id = form.get("id");
  const finalText = form.get("finalText");
  const revision = Number(form.get("revision"));
  const intent = form.get("intent");
  if (typeof id !== "string" || !id || id.length > 100 || !Number.isSafeInteger(revision) || revision < 1 ||
      !["save", "approve", "reject"].includes(String(intent))) return fail("Invalid draft or review action. Reload the page.");
  if (intent === "save" && (typeof finalText !== "string" || !finalText.trim() || finalText.length > MAX_AI_TEXT)) {
    return fail("Enter nonempty final text up to 20,000 characters.");
  }
  try {
    const count = await prisma.$transaction(async (tx) => {
      if (!hasAiAccess(await lockAiAccess(tx, workspace.id))) return 0;
      const result = await tx.aiDraft.updateMany({
        where: { id, workspaceId: workspace.id, editRevision: revision },
        data: { ...(intent === "save" ? { finalText: (finalText as string).trim() } : {}), editRevision: { increment: 1 },
          reviewStatus: intent === "approve" ? "APPROVED" : intent === "reject" ? "REJECTED" : "PENDING_REVIEW" },
      });
      return result.count;
    });
    if (count !== 1) return fail("This draft changed or access is unavailable. Copy unsaved text, then reload.");
    revalidatePath("/workspace/ai-drafts");
    return { success: true, revision: revision + 1, message: intent === "approve" ? "Approved for review records. Nothing was sent to Telegram." : intent === "reject" ? "Draft rejected." : "Final text saved; pending review." };
  } catch { return fail("Could not save the draft. Please try again."); }
}
