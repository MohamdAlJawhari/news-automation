import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "../src/generated/prisma/client";
import type { AiActionState } from "../src/app/actions/ai";

// Execute the real server actions and workspace guard. Only the session boundary
// and Next's redirect/revalidation adapters are mocked; all writes use PostgreSQL.
export async function checkAiActions(prisma: PrismaClient, draftId: string, workspaceId: string) {
  const fixture = { prisma, userId: "ai-fixture-user", invalidations: [] as string[] };
  const built = await build({ absWorkingDir: process.cwd(), tsconfigRaw: {},
    stdin: { contents: await readFile("src/app/actions/ai.ts", "utf8"), loader: "ts", resolveDir: process.cwd() }, bundle: true,
    platform: "node", format: "cjs", write: false, logLevel: "silent",
    plugins: [{ name: "fixture-session", setup(builder) {
      builder.onResolve({ filter: /^(@\/lib\/(prisma|access)|next\/(navigation|cache)|server-only)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path === "@/lib/prisma" ? "export const prisma = globalThis.__fixture.prisma;" :
        args.path === "@/lib/access" ? `export async function getCurrentAccess() {
          const user = await globalThis.__fixture.prisma.user.findUnique({where:{id:globalThis.__fixture.userId},include:{workspace:true}});
          return user ? {user} : null;
        } export function getEntryDestination() { return '/workspace/sources'; }` :
        args.path === "next/navigation" ? "export function redirect(path) { throw new Error('REDIRECT:' + path); }" :
        args.path === "next/cache" ? "export function revalidatePath(path) { globalThis.__fixture.invalidations.push(path); }" : "",
      }));
      // Read through Node: native esbuild cannot traverse sandboxed Windows ancestors.
      builder.onResolve({ filter: /^(?:@\/|\.)/ }, args => ({
        path: (args.path.startsWith("@/") ? path.resolve("src", args.path.slice(2)) : path.resolve(path.dirname(args.importer), args.path)) + ".ts",
        namespace: "fixture-file",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-file" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "ts" }));
    } }],
  });
  const actionModule = { exports: {} as Record<string, (state: AiActionState, form: FormData) => Promise<AiActionState>> };
  runInNewContext(built.outputFiles[0].text, { module: actionModule, exports: actionModule.exports, __fixture: fixture, process, console });
  const actions = actionModule.exports;
  const form = (fields: Record<string, string>) => {
    const data = new FormData(); for (const [key, value] of Object.entries(fields)) data.set(key, value); return data;
  };
  const initial = { success: false, message: "", revision: 1 };
  let draft = await prisma.aiDraft.findUniqueOrThrow({ where: { id: draftId } });
  const saved = await actions.saveAiDraft(initial, form({ id: draft.id, revision: String(draft.editRevision), finalText: "Saved final review text.", intent: "save" }));
  assert(saved.success);
  const approved = await actions.saveAiDraft(saved, form({ id: draft.id, revision: String(saved.revision), finalText: "Unsaved malicious submission.", intent: "approve" }));
  assert(approved.success);
  draft = await prisma.aiDraft.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(draft.finalText, "Saved final review text."); assert.equal(draft.reviewStatus, "APPROVED");
  assert.equal((await actions.saveAiDraft(saved, form({ id: draft.id, revision: String(saved.revision), intent: "reject" }))).success, false);
  const rejected = await actions.saveAiDraft(approved, form({ id: draft.id, revision: String(approved.revision), intent: "reject" }));
  assert(rejected.success); assert.equal((await prisma.aiDraft.findUniqueOrThrow({ where: { id: draft.id } })).reviewStatus, "REJECTED");

  const settings = await prisma.workspaceAiSettings.findUniqueOrThrow({ where: { workspaceId } });
  const settingFields = { revision: String(settings.revision), systemPrompt: settings.systemPrompt, editorialPerspective: "", model: settings.model, enabled: "on" };
  const settingSaved = await actions.saveAiSettings(initial, form(settingFields));
  assert(settingSaved.success);
  assert.equal((await prisma.workspaceAiSettings.findUniqueOrThrow({ where: { workspaceId } })).activatedAt?.getTime(), settings.activatedAt?.getTime());
  assert.equal((await actions.saveAiSettings(initial, form(settingFields))).success, false);
  assert.equal((await actions.saveAiSettings(initial, form({ ...settingFields, revision: String(settingSaved.revision), model: "unapproved:latest" }))).success, false);

  for (const kind of ["suspended", "unverified", "automation"] as const) {
    if (kind === "suspended") await prisma.user.update({ where: { id: fixture.userId }, data: { approvalStatus: "SUSPENDED" } });
    if (kind === "unverified") await prisma.user.update({ where: { id: fixture.userId }, data: { emailVerified: false } });
    if (kind === "automation") await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: false } });
    await assert.rejects(actions.saveAiDraft(rejected, form({ id: draft.id, revision: String(rejected.revision), intent: "approve" })), /REDIRECT:/);
    await assert.rejects(actions.saveAiSettings(initial, form({ ...settingFields, revision: String(settingSaved.revision) })), /REDIRECT:/);
    await prisma.user.update({ where: { id: fixture.userId }, data: { emailVerified: true, approvalStatus: "APPROVED" } });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: true } });
  }
  fixture.userId = "foreign-fixture-user";
  await prisma.user.create({ data: { id: fixture.userId, name: "Foreign fixture", email: "foreign-ai@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
  await prisma.workspace.create({ data: { id: "foreign-fixture-workspace", name: "Foreign fixture", ownerId: fixture.userId, automationEnabled: true } });
  assert.equal((await actions.saveAiDraft(rejected, form({ id: draft.id, revision: String(rejected.revision), intent: "approve" }))).success, false);
  assert.equal((await actions.saveAiSettings(initial, form(settingFields))).success, false);
  assert.equal((await prisma.aiDraft.findUniqueOrThrow({ where: { id: draft.id } })).reviewStatus, "REJECTED");
  // First activation is server-timed, and subsequent pause/resume preserves it.
  await prisma.workspaceAiSettings.create({ data: { workspaceId: "foreign-fixture-workspace", systemPrompt: settings.systemPrompt } });
  const oldConnection = process.env.INGEST_WORKSPACE_ID;
  process.env.INGEST_WORKSPACE_ID = "foreign-fixture-workspace";
  try {
    const first = await actions.saveAiSettings(initial, form({ ...settingFields, revision: "1" }));
    assert(first.success);
    const boundary = (await prisma.workspaceAiSettings.findUniqueOrThrow({ where: { workspaceId: "foreign-fixture-workspace" } })).activatedAt;
    assert(boundary);
    const pause = await actions.saveAiSettings(first, form({ ...settingFields, revision: String(first.revision), enabled: "" }));
    assert(pause.success);
    const resumed = await actions.saveAiSettings(pause, form({ ...settingFields, revision: String(pause.revision) }));
    assert(resumed.success);
    assert.equal((await prisma.workspaceAiSettings.findUniqueOrThrow({ where: { workspaceId: "foreign-fixture-workspace" } })).activatedAt?.getTime(), boundary.getTime());
  } finally { process.env.INGEST_WORKSPACE_ID = oldConnection; }
  assert(fixture.invalidations.includes("/workspace/ai-drafts"));
  console.log("PASS: real AI actions/guard enforce access, foreign-workspace rejection, stale edits/settings, status-only approval, model allowlist and one-time activation (mocked session/Next adapters, real PostgreSQL).");
}
