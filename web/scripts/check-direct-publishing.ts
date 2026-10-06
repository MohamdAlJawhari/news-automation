// Real PostgreSQL in a disposable schema; session/Next boundaries are mocked.
// No Telegram connection, credentials or network sends are used by this check.
import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import path from "node:path";
import { queuePublication, claimPublication, recordPublicationResult } from "../src/lib/publishing-db";
import { processTelegramJob } from "./telegram-processing";
import type { PublishingState } from "../src/app/actions/direct-publishing";
import type { AiActionState } from "../src/app/actions/ai";

loadEnvConfig(process.cwd());
const schema = `publishing_check_${randomUUID().replaceAll("-", "")}`;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be configured.");
const admin = new Client({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
const previousWorkspace = process.env.INGEST_WORKSPACE_ID;
const previousSecret = process.env.INGEST_READER_SECRET;
const workspaceId = "publishing-fixture";
process.env.INGEST_WORKSPACE_ID = workspaceId;
process.env.INGEST_READER_SECRET = "mock-reader-secret-only-00000000000000000";
const fixture = { prisma, userId: "publishing-user" };
type Actions = Record<string, (state: PublishingState, form: FormData) => Promise<PublishingState>>;
type AiActions = Record<string, (state: AiActionState, form: FormData) => Promise<AiActionState>>;
type Routes = { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
async function load<T>(file: string): Promise<T> {
  const result = await build({ absWorkingDir: process.cwd(), tsconfigRaw: {},
    stdin: { contents: await readFile(file, "utf8"), loader: "ts", resolveDir: process.cwd() }, bundle: true,
    platform: "node", format: "cjs", write: false, logLevel: "silent",
    plugins: [{ name: "publishing-session-fixture", setup(builder) {
      builder.onResolve({ filter: /^(@\/lib\/(prisma|access)|next\/(navigation|cache)|server-only)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path === "@/lib/prisma" ? "export const prisma = globalThis.__fixture.prisma;" :
        args.path === "@/lib/access" ? `export async function getCurrentAccess() {
          const user = await globalThis.__fixture.prisma.user.findUnique({where:{id:globalThis.__fixture.userId},include:{workspace:true}});
          return user ? {user} : null;
        } export function getEntryDestination() { return '/workspace/sources'; }` :
        args.path === "next/navigation" ? "export function redirect(path) { throw new Error('REDIRECT:' + path); }" :
        args.path === "next/cache" ? "export function revalidatePath() {}" : "",
      }));
      builder.onResolve({ filter: /^(?:@\/|\.)/ }, args => ({ path: (args.path.startsWith("@/") ? path.resolve("src", args.path.slice(2)) : path.resolve(path.dirname(args.importer), args.path)) + ".ts", namespace: "fixture-file" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-file" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "ts" }));
    } }],
  });
  const actionModule = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module: actionModule, exports: actionModule.exports, __fixture: fixture, process, console,
    require: createRequire(import.meta.url), Request, Response, Date });
  return actionModule.exports as T;
}
const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const initial = { success: false, message: "" };
let sequence = 1;
async function draft() {
  const original = await prisma.originalPost.create({ data: { workspaceId, sourceChannelId: "publishing-source", telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Synthetic original", publishedAt: new Date(), receivedAt: new Date() } });
  return prisma.aiDraft.create({ data: { workspaceId, originalPostId: original.id, aiText: "Synthetic rewrite", finalText: "Exact saved text *literal*", model: "mock", effectivePrompt: "fixture", settingsRevision: 1, reviewStatus: "APPROVED" } });
}
async function main() {
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort())
      await admin.query(await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8"));
    await prisma.user.create({ data: { id: fixture.userId, name: "Publishing fixture", email: "publishing@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
    await prisma.workspace.create({ data: { id: workspaceId, ownerId: fixture.userId, name: "Publishing fixture", automationEnabled: true, rssEnabled: true } });
    await prisma.sourceChannel.create({ data: { id: "publishing-source", workspaceId, username: "publishing_source" } });
    await prisma.workspaceAiSettings.create({ data: { workspaceId, systemPrompt: "fixture", enabled: true, activatedAt: new Date(0) } });
    const actions = await load<Actions>("src/app/actions/direct-publishing.ts");
    const ai = await load<AiActions>("src/app/actions/ai.ts");
    const sources = await load<Record<string, (form: FormData) => Promise<void>>>("src/app/actions/sources.ts");
    const routes = await load<Routes>("src/app/api/reader/publishing/route.ts");
    const api = async (body: Record<string, unknown>, secret = process.env.INGEST_READER_SECRET) => routes.POST(new Request("http://localhost/api/reader/publishing", { method: "POST", headers: { "x-ingest-secret": secret || "", "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    const json = async (body: Record<string, unknown>) => (await api(body)).json();
    assert.equal((await api({ action: "claim" }, "wrong")).status, 401);
    const d = await draft();
    assert.equal((await actions.publishAiDraft(initial, form({ id: d.id, revision: "1" }))).success, false);
    assert.equal((await prisma.sourceChannel.findUniqueOrThrow({ where: { id: "publishing-source" } })).telegramAutomationEnabled, false);
    const settingsFields = { destination: "@news_output_test", revision: "1", enabled: "on" };
    assert((await actions.savePublishingSettings(initial, form(settingsFields))).success);
    let settings = await prisma.workspacePublishingSettings.findUniqueOrThrow({ where: { workspaceId } });
    assert.equal(settings.verifiedAt, null);
    assert.equal((await json({ action: "verify", username: "news_output_test", revision: 99, chatId: "-10012345" })).accepted, false);
    assert((await json({ action: "verify", username: "news_output_test", revision: settings.revision, error: "PERMISSION" })).accepted);
    assert.match((await prisma.workspacePublishingSettings.findUniqueOrThrow({ where: { workspaceId } })).verificationError!, /permission/);
    assert((await actions.savePublishingSettings(initial, form({ ...settingsFields, verify: "yes" }))).success);
    settings = await prisma.workspacePublishingSettings.findUniqueOrThrow({ where: { workspaceId } });
    assert((await json({ action: "verify", username: "news_output_test", revision: settings.revision, chatId: "-10012345" })).accepted);
    assert.equal((await actions.savePublishingSettings(initial, form({ ...settingsFields, revision: String(settings.revision), destination: "publishing_source" }))).success, false);
    await assert.rejects(sources.addWorkspaceSource(form({ channel: "news_output_test" })), /REDIRECT:.*publishing%20destination/);
    assert.equal(await prisma.sourceChannel.count({ where: { username: "news_output_test" } }), 0);
    await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: true } });
    const clicks = await Promise.all([actions.publishAiDraft(initial, form({ id: d.id, revision: "1" })), actions.publishAiDraft(initial, form({ id: d.id, revision: "1" }))]);
    assert.equal(clicks.filter(c => c.success).length, 1);
    const snapshot = await prisma.telegramPublication.findFirstOrThrow({ where: { draftId: d.id } });
    assert.equal(snapshot.text, d.finalText); assert.equal(snapshot.destinationChatId, "-10012345");
    assert.equal((await ai.saveAiDraft({ ...initial, revision: 1 }, form({ id: d.id, revision: "1", intent: "save", finalText: "blocked" }))).success, false);
    for (const status of ["QUEUED", "SENDING", "DELIVERY_UNKNOWN"] as const) {
      await prisma.telegramPublication.update({ where: { id: snapshot.id }, data: { status } });
      assert.equal((await ai.saveAiDraft({ ...initial, revision: 1 }, form({ id: d.id, revision: "1", intent: "reject" }))).success, false);
    }
    await prisma.telegramPublication.update({ where: { id: snapshot.id }, data: { status: "QUEUED" } });
    await assert.rejects(prisma.telegramPublication.update({ where: { id: snapshot.id }, data: { text: "mutate" } }));
    for (const kind of ["suspended", "unverified", "automation", "publishing", "source", "monitoring"] as const) {
      if (kind === "suspended") await prisma.user.update({ where: { id: fixture.userId }, data: { approvalStatus: "SUSPENDED" } });
      if (kind === "unverified") await prisma.user.update({ where: { id: fixture.userId }, data: { emailVerified: false } });
      if (kind === "automation") await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: false } });
      if (kind === "publishing") await prisma.workspacePublishingSettings.update({ where: { workspaceId }, data: { enabled: false } });
      if (kind === "source") await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: false } });
      if (kind === "monitoring") await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { enabled: false } });
      assert.equal(await claimPublication(prisma, workspaceId), null);
      if (["suspended", "unverified", "automation"].includes(kind)) await assert.rejects(actions.publishAiDraft(initial, form({ id: d.id, revision: "1" })), /REDIRECT:/);
      await prisma.user.update({ where: { id: fixture.userId }, data: { emailVerified: true, approvalStatus: "APPROVED" } });
      await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: true } });
      await prisma.workspacePublishingSettings.update({ where: { workspaceId }, data: { enabled: true } });
      await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { enabled: true, telegramAutomationEnabled: true } });
    }
    const claims = await Promise.all([claimPublication(prisma, workspaceId), claimPublication(prisma, workspaceId)]);
    const claimed = claims.find(Boolean)!; assert.equal(claims.filter(Boolean).length, 1);
    const claimFields = { id: claimed.id, token: claimed.lockToken! };
    assert((await json({ action: "authorize", ...claimFields })).authorized);
    await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: false } });
    assert.equal((await json({ action: "authorize", ...claimFields })).authorized, false);
    await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: true } });
    await prisma.telegramPublication.update({ where: { id: claimed.id }, data: { lockedUntil: new Date(0) } });
    assert.equal(await claimPublication(prisma, workspaceId), null);
    assert.equal((await prisma.telegramPublication.findUniqueOrThrow({ where: { id: claimed.id } })).status, "DELIVERY_UNKNOWN");
    assert.equal((await json({ action: "authorize", ...claimFields })).authorized, false);
    assert.equal((await actions.recoverTelegramPublication(initial, form({ id: claimed.id, intent: "none", confirmed: "on" }))).success, false);
    assert((await actions.recoverTelegramPublication(initial, form({ id: claimed.id, intent: "existing", messageId: "42" }))).success);
    // Recording late confirmed delivery remains allowed after suspension.
    await prisma.user.update({ where: { id: fixture.userId }, data: { approvalStatus: "SUSPENDED" } });
    const result = { ...claimFields, outcome: "published" as const, chatId: "-10012345", messageId: 42, publishedAt: new Date().toISOString() };
    assert.equal(await recordPublicationResult(prisma, "foreign", result), false);
    assert(await recordPublicationResult(prisma, workspaceId, result)); assert(await recordPublicationResult(prisma, workspaceId, result));
    assert(await recordPublicationResult(prisma, workspaceId, { ...claimFields, outcome: "unknown" }));
    assert.equal((await prisma.telegramPublication.findUniqueOrThrow({ where: { id: claimed.id } })).status, "PUBLISHED");
    await prisma.user.update({ where: { id: fixture.userId }, data: { approvalStatus: "APPROVED" } });
    assert.equal((await actions.publishAiDraft(initial, form({ id: d.id, revision: "1" }))).success, false);
    console.log("PASS: authenticated endpoints, immutable snapshots, double clicks/concurrent claims, access/source pauses, locked editing, uncertain expiry and idempotent late receipts.");

    const changed = await draft(); await queuePublication(prisma, workspaceId, changed.id, 1);
    assert((await actions.savePublishingSettings(initial, form({ destination: "another_output", revision: String(settings.revision), enabled: "on" }))).success);
    settings = await prisma.workspacePublishingSettings.findUniqueOrThrow({ where: { workspaceId } });
    assert((await json({ action: "verify", username: "another_output", revision: settings.revision, chatId: "-10099999" })).accepted);
    assert.equal(await claimPublication(prisma, workspaceId), null);
    const oldSnapshot = await prisma.telegramPublication.findFirstOrThrow({ where: { draftId: changed.id } });
    assert.equal(oldSnapshot.status, "FAILED"); assert.equal(oldSnapshot.destinationChatId, "-10012345");
    assert.equal((await actions.publishAiDraft(initial, form({ id: changed.id, revision: "1" }))).success, false);
    const overlong = await draft(); await prisma.aiDraft.update({ where: { id: overlong.id }, data: { finalText: "x".repeat(4097) } });
    assert.equal((await actions.publishAiDraft(initial, form({ id: overlong.id, revision: "1" }))).success, false);
    const flood = await draft(); await queuePublication(prisma, workspaceId, flood.id, 1);
    const floodClaim = (await claimPublication(prisma, workspaceId))!;
    assert(await recordPublicationResult(prisma, workspaceId, { id: floodClaim.id, token: floodClaim.lockToken!, outcome: "flood", seconds: 3600, error: "FLOOD" }));
    const next = await draft(); await queuePublication(prisma, workspaceId, next.id, 1);
    assert.equal(await claimPublication(prisma, workspaceId), null);
    console.log("PASS: destination changes never redirect snapshots, overlong text rejected, flood waits block all workspace sends.");

    await prisma.workspacePublishingSettings.update({ where: { workspaceId }, data: { floodWaitUntil: null } });
    const recoveryClaim = (await claimPublication(prisma, workspaceId))!;
    assert.equal(recoveryClaim.draftId, next.id);
    await recordPublicationResult(prisma, workspaceId, { id: recoveryClaim.id, token: recoveryClaim.lockToken!, outcome: "unknown" });
    await prisma.telegramPublication.update({ where: { id: recoveryClaim.id }, data: { dispatchedAt: new Date(Date.now() - 660000) } });
    assert.equal((await actions.recoverTelegramPublication(initial, form({ id: recoveryClaim.id, intent: "none" }))).success, false);
    assert((await actions.recoverTelegramPublication(initial, form({ id: recoveryClaim.id, intent: "none", confirmed: "on" }))).success);
    assert((await actions.publishAiDraft(initial, form({ id: next.id, revision: "1" }))).success);
    const retried = await prisma.telegramPublication.findUniqueOrThrow({ where: { id: recoveryClaim.id } });
    assert.equal(retried.randomId, recoveryClaim.randomId); assert.equal(retried.text, recoveryClaim.text);
    const rejectionClaim = (await claimPublication(prisma, workspaceId))!;
    assert(await recordPublicationResult(prisma, workspaceId, { id: rejectionClaim.id, token: rejectionClaim.lockToken!, outcome: "failed", error: "REJECTED" }));
    assert.equal((await prisma.telegramPublication.findUniqueOrThrow({ where: { id: rejectionClaim.id } })).status, "FAILED");
    await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramChatId: "-10055555" } });
    assert((await actions.savePublishingSettings(initial, form({ destination: "another_output", revision: String(settings.revision), enabled: "on", verify: "yes" }))).success);
    settings = await prisma.workspacePublishingSettings.findUniqueOrThrow({ where: { workspaceId } });
    assert((await json({ action: "verify", username: "another_output", revision: settings.revision, chatId: "-10055555" })).accepted);
    assert.equal((await prisma.workspacePublishingSettings.findUniqueOrThrow({ where: { workspaceId } })).verifiedAt, null);
    console.log("PASS: explicit no-send recovery, same random ID on retry, definite rejection and stable destination/source identity exclusion.");

    fixture.userId = "foreign-user";
    await prisma.user.create({ data: { id: fixture.userId, name: "Foreign", email: "foreign-publishing@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
    await prisma.workspace.create({ data: { id: "foreign", ownerId: fixture.userId, name: "Foreign", automationEnabled: true } });
    assert.equal((await actions.publishAiDraft(initial, form({ id: next.id, revision: "1" }))).success, false);
    assert.equal((await actions.savePublishingSettings(initial, form(settingsFields))).success, false);
    assert.equal((await actions.recoverTelegramPublication(initial, form({ id: claimed.id, intent: "existing", messageId: "42" }))).success, false);
    assert.equal(await claimPublication(prisma, "foreign"), null);
    fixture.userId = "publishing-user";
    // Source off prevents generation; switching it off during generation discards the result.
    const original = (await draft()).originalPostId;
    await prisma.processingJob.create({ data: { workspaceId, originalPostId: original, type: "TELEGRAM_PREPARE" } });
    await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: false } });
    assert.equal(await processTelegramJob(prisma, async () => { throw new Error("must not generate"); }), false);
    // Use a separate original with no existing draft for the commit-time pause test.
    const fresh = await prisma.originalPost.create({ data: { workspaceId, sourceChannelId: "publishing-source", telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Synthetic", publishedAt: new Date() } });
    await prisma.processingJob.create({ data: { workspaceId, originalPostId: fresh.id, type: "TELEGRAM_PREPARE" } });
    await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: true } });
    await processTelegramJob(prisma, async () => "unused existing draft");
    await processTelegramJob(prisma, async () => { await prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: false } }); return "must discard"; });
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: fresh.id } }), 0);
    assert.equal((await prisma.processingJob.findFirstOrThrow({ where: { originalPostId: fresh.id } })).attempts, 0);
    console.log("PASS: workspace isolation and source automation pause before generation and draft commit; originals/drafts retained.");
  } finally {
    await prisma.$disconnect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
    if (previousWorkspace === undefined) delete process.env.INGEST_WORKSPACE_ID; else process.env.INGEST_WORKSPACE_ID = previousWorkspace;
    if (previousSecret === undefined) delete process.env.INGEST_READER_SECRET; else process.env.INGEST_READER_SECRET = previousSecret;
  }
}
main().catch(() => { console.error("Direct publishing integration check failed (no application jobs or Telegram messages were sent)."); process.exitCode = 1; });
