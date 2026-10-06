import { ensureDefaultCampaign } from "../src/lib/default-campaign";
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
import { processTelegramJob } from "./telegram-processing";
import { queuePublication, claimPublication, recordPublicationResult } from "../src/lib/publishing-db";
import { catchUpDefaultCampaigns, inspectDefaultCampaignGaps } from "../src/lib/default-campaign-catchup";
import { syncDefaultMembership } from "../src/lib/default-campaign";

loadEnvConfig(process.cwd());
const schema = `campaign_runtime_check_${randomUUID().replaceAll("-", "")}`;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be configured.");
const admin = new Client({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
const previousWorkspace = process.env.INGEST_WORKSPACE_ID;
const previousOutput = process.env.TELEGRAM_OUTPUT_CHAT_ID;
process.env.TELEGRAM_OUTPUT_CHAT_ID = "-100999999";
const previousSecret = process.env.INGEST_READER_SECRET;
const workspaceId = "publishing-fixture";
process.env.INGEST_WORKSPACE_ID = workspaceId;
process.env.INGEST_READER_SECRET = "mock-reader-secret-only-00000000000000000";
const fixture = { prisma, userId: "publishing-user" };


type Routes = { GET: (r: Request) => Promise<Response>; POST: (r: Request) => Promise<Response> };
async function load<T>(file: string): Promise<T> {
  const result = await build({ absWorkingDir: process.cwd(), tsconfigRaw: {},
    stdin: { contents: await readFile(file, "utf8"), loader: "ts", resolveDir: process.cwd() }, bundle: true,
    platform: "node", format: "cjs", write: false, logLevel: "silent",
    plugins: [{ name: "publishing-session-fixture", setup(builder) {
      builder.onResolve({ filter: /^(@\/lib\/(prisma|access|admin)|next\/(navigation|cache)|server-only)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path === "@/lib/prisma" ? "export const prisma = globalThis.__fixture.prisma;" :
        args.path === "@/lib/admin" ? `export async function requireAdmin() {return {user:{id:"mock-admin"}};}` :
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
type SourceActions = Record<string, (form: FormData) => Promise<void>>;
async function redirected(action: Promise<void>) { await assert.rejects(action, /REDIRECT:/); }
async function snapshot() {
  const result: Record<string, unknown[]> = {};
  for (const table of ["workspace", "source_channel", "original_post", "ai_draft", "processing_job", "telegram_publication", "workspace_ai_settings", "workspace_publishing_settings", "rss_feed", "rss_item"])
    result[table] = (await admin.query(`SELECT to_jsonb(t) - 'campaignId' AS row FROM "${table}" t ORDER BY (to_jsonb(t) - 'campaignId')::text`)).rows.map(r => r.row);
  return result;
}
async function main() {
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort())
      await admin.query(await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8"));
    await prisma.user.create({ data: { id: fixture.userId, name: "Runtime fixture", email: "runtime@example.invalid", emailVerified: true } });
    const users = await load<SourceActions>("src/app/actions/users.ts");
    await redirected(users.updateUserAccess(form({ userId: fixture.userId, status: "APPROVED", rssEnabled: "on", automationEnabled: "on" })));
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { ownerId: fixture.userId } });
    process.env.INGEST_WORKSPACE_ID = workspace.id;
    const defaultCampaign = await prisma.campaign.findFirstOrThrow({ where: { workspaceId: workspace.id, isDefault: true } });
    await redirected(users.updateUserAccess(form({ userId: fixture.userId, status: "APPROVED", rssEnabled: "on", automationEnabled: "on" })));
    assert.equal(await prisma.campaign.count({ where: { workspaceId: workspace.id, isDefault: true } }), 1);
    // Force all contenders to observe absence before attempting the insert.
    await prisma.user.create({ data: { id: "foreign-user", name: "Foreign", email: "foreign-runtime@example.invalid" } });
    const foreign = await prisma.workspace.create({ data: { ownerId: "foreign-user", name: "Foreign" } });
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => prisma.$transaction(async tx => {
      assert.equal(await tx.campaign.count({ where: { workspaceId: foreign.id, isDefault: true } }), 0);
      if (++arrived === 4) release();
      await barrier;
      return ensureDefaultCampaign(tx, foreign.id);
    }, { timeout: 15000 })));
    assert.equal(new Set(concurrent.map(c => c.id)).size, 1);
    console.log("PASS: approval creates one Default; concurrent creation uses database uniqueness.");
    const sources = await load<SourceActions>("src/app/actions/sources.ts");
    await redirected(sources.addWorkspaceSource(form({ channel: "runtime_source" })));
    const source = await prisma.sourceChannel.findUniqueOrThrow({ where: { workspaceId_username: { workspaceId: workspace.id, username: "runtime_source" } } });
    const membershipWhere = { campaignId_sourceChannelId: { campaignId: defaultCampaign.id, sourceChannelId: source.id } };
    assert.equal((await prisma.campaignSource.findUniqueOrThrow({ where: membershipWhere })).telegramAutomationEnabled, false);
    await redirected(sources.addWorkspaceSource(form({ channel: "runtime_source" })));
    assert.equal(await prisma.campaignSource.count({ where: { sourceChannelId: source.id } }), 1);
    for (const enabled of [true, false, true]) {
      await redirected(sources.setSourceTelegramAutomation(form({ sourceId: source.id, enabled: String(enabled) })));
      assert.equal((await prisma.sourceChannel.findUniqueOrThrow({ where: { id: source.id } })).telegramAutomationEnabled, enabled);
      assert.equal((await prisma.campaignSource.findUniqueOrThrow({ where: membershipWhere })).telegramAutomationEnabled, enabled);
    }
    await assert.rejects(prisma.$transaction(tx => syncDefaultMembership(tx, foreign.id, source.id)));
    await prisma.campaignAiSettings.update({ where: { campaignId: defaultCampaign.id }, data: { systemPrompt: "Fixture", enabled: true, activatedAt: new Date(0) } });
    const ingestion = await load<Routes>("src/app/api/ingestion/posts/route.ts");
    const ingest = (sourceId: string, messageId: number) => ingestion.POST(new Request("http://localhost/api/ingestion/posts", { method: "POST", headers: { "x-ingest-secret": process.env.INGEST_READER_SECRET!, "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, telegramChatId: "-10012345", telegramMessageId: messageId, originalText: "Synthetic original", publishedAt: new Date().toISOString() }) }));
    assert.equal((await ingest(source.id, 1)).status, 201);
    const jobs = await prisma.processingJob.findMany({ where: { workspaceId: workspace.id } });
    assert.equal(jobs.length, 2);
    const telegram = jobs.find(j => j.type === "TELEGRAM_PREPARE")!;
    assert.equal(telegram.campaignId, defaultCampaign.id);
    assert.equal(jobs.find(j => j.type === "RSS_PREPARE")!.campaignId, null);
    const beforeDuplicate = await prisma.processingJob.findMany({ orderBy: { id: "asc" } });
    assert.equal((await ingest(source.id, 1)).status, 200);
    assert.deepEqual(await prisma.processingJob.findMany({ orderBy: { id: "asc" } }), beforeDuplicate);
    const foreignSource = await prisma.sourceChannel.create({ data: { workspaceId: foreign.id, username: "foreign_source" } });
    assert.equal((await ingest(foreignSource.id, 2)).status, 403);
    await assert.rejects(prisma.processingJob.update({ where: { id: telegram.id }, data: { campaignId: concurrent[0].id } }));
    await assert.rejects(prisma.processingJob.update({ where: { id: jobs.find(j => j.type === "RSS_PREPARE")!.id }, data: { campaignId: defaultCampaign.id } }));
    // A stale membership flag must not override the authoritative source toggle.
    await prisma.campaignSource.update({ where: membershipWhere, data: { telegramAutomationEnabled: false } });
    assert(await processTelegramJob(prisma, async () => "Synthetic generated draft"));
    const draft = await prisma.aiDraft.findUniqueOrThrow({ where: { originalPostId_workspaceId: { originalPostId: telegram.originalPostId, workspaceId: workspace.id } } });
    assert.equal(draft.campaignId, telegram.campaignId);
    await assert.rejects(prisma.aiDraft.update({ where: { id: draft.id }, data: { campaignId: concurrent[0].id } }));
    console.log("PASS: real source actions synchronize membership; ingestion assigns Telegram only; worker carries lineage; RSS and workspace constraints remain independent.");
    // Simulate old writers during compatibility, including an in-progress lease.
    const post = await prisma.originalPost.create({ data: { workspaceId: workspace.id, sourceChannelId: source.id, telegramChatId: "-10012345", telegramMessageId: 3, originalText: "Legacy original", publishedAt: new Date(0) } });
    const legacyDraft = await prisma.aiDraft.create({ data: { workspaceId: workspace.id, originalPostId: post.id, aiText: "Old", finalText: "Edited", model: "fixture", effectivePrompt: "Saved", settingsRevision: 1 } });
    await prisma.processingJob.create({ data: { workspaceId: workspace.id, originalPostId: post.id, type: "TELEGRAM_PREPARE", status: "PROCESSING", attempts: 3, lockToken: "saved-lease", lockedUntil: new Date(Date.now() + 60000), lastError: "Saved error" } });
    await prisma.processingJob.create({ data: { workspaceId: workspace.id, originalPostId: post.id, type: "RSS_PREPARE", status: "COMPLETED", attempts: 2, completedAt: new Date(0) } });
    await prisma.user.create({ data: { id: "legacy-user", name: "Legacy", email: "legacy-runtime@example.invalid" } });
    await prisma.workspace.create({ data: { ownerId: "legacy-user", name: "Legacy" } });
    const before = await snapshot();
    const membershipTimestamp = (await prisma.campaignSource.findUniqueOrThrow({ where: membershipWhere })).updatedAt;
    const caught = await catchUpDefaultCampaigns(prisma);
    assert.equal(caught.defaultsCreated, 1); assert.equal(caught.membershipsCreated, 1);
    assert.equal(caught.membershipsSynchronized, 1); assert.equal(caught.draftsAssigned, 1); assert.equal(caught.telegramJobsAssigned, 1);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await prisma.campaignSource.findUniqueOrThrow({ where: membershipWhere })).updatedAt.getTime(), membershipTimestamp.getTime());
    assert.equal((await prisma.aiDraft.findUniqueOrThrow({ where: { id: legacyDraft.id } })).campaignId, defaultCampaign.id);
    const allBefore = await prisma.campaignSource.findMany({ orderBy: { sourceChannelId: "asc" } });
    const second = await catchUpDefaultCampaigns(prisma);
    for (const count of Object.values(second.remaining)) assert.equal(count, 0);
    assert.equal(second.defaultsCreated + second.membershipsCreated + second.membershipsSynchronized + second.draftsAssigned + second.telegramJobsAssigned, 0);
    assert.deepEqual(await prisma.campaignSource.findMany({ orderBy: { sourceChannelId: "asc" } }), allBefore);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await prisma.$transaction(inspectDefaultCampaignGaps), second.remaining);
    console.log("PASS: catch-up is idempotent, preserves all original fields/timestamps/job leases and assigns only null references.");
    // Eligibility uses database time; isolate preserved lease history from the next worker checks.
    await prisma.$executeRaw`UPDATE processing_job SET "lockedUntil" = clock_timestamp() + interval '1 day' WHERE status = 'PROCESSING'`;
    const other = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: "Later campaign" } });
    const otherPost = await prisma.originalPost.create({ data: { workspaceId: workspace.id, sourceChannelId: source.id, telegramChatId: "-10012345", telegramMessageId: 4, originalText: "Other campaign original", publishedAt: new Date(0) } });
    const otherJob = await prisma.processingJob.create({ data: { workspaceId: workspace.id, originalPostId: otherPost.id, campaignId: other.id, type: "TELEGRAM_PREPARE" } });
    const otherDraft = await prisma.aiDraft.create({ data: { workspaceId: workspace.id, originalPostId: otherPost.id, campaignId: other.id, aiText: "Other", finalText: "Other", model: "fixture", effectivePrompt: "Saved", settingsRevision: 1, reviewStatus: "APPROVED" } });
    assert.equal(await processTelegramJob(prisma, async () => { throw new Error("Other campaign executed."); }), false);
    await prisma.campaignPublishingSettings.update({ where: { campaignId: defaultCampaign.id }, data: { enabled: true, destinationChatId: "-100999999", destinationUsername: "runtime_output", verifiedAt: new Date() } });
    await assert.rejects(queuePublication(prisma, workspace.id, otherDraft.id, otherDraft.editRevision), /Only Default/);
    const publication = await prisma.telegramPublication.create({ data: { workspaceId: workspace.id, draftId: otherDraft.id, draftRevision: otherDraft.editRevision, text: otherDraft.finalText, destinationChatId: "-100999999", destinationUsername: "runtime_output", destinationRevision: 1, randomId: "123456789", status: "QUEUED" } });
    assert.equal(await claimPublication(prisma, workspace.id), null);
    await prisma.telegramPublication.update({ where: { id: publication.id }, data: { status: "SENDING", lockToken: "existing-receipt", lockedUntil: new Date(Date.now() + 60000) } });
    const receipt = { id: publication.id, token: "existing-receipt", outcome: "published" as const, chatId: publication.destinationChatId, messageId: 42, publishedAt: new Date().toISOString() };
    assert(await recordPublicationResult(prisma, workspace.id, receipt));
    assert(await recordPublicationResult(prisma, workspace.id, receipt));
    // Corrupt same-workspace lineage must not silently retag an existing draft.
    await prisma.processingJob.update({ where: { id: otherJob.id }, data: { campaignId: defaultCampaign.id } });
    assert(await processTelegramJob(prisma, async () => { throw new Error("Mismatched draft was regenerated."); }));
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: otherJob.id } })).status, "FAILED");
    assert.deepEqual(await prisma.aiDraft.findUniqueOrThrow({ where: { id: otherDraft.id } }), otherDraft);
    await prisma.processingJob.update({ where: { id: otherJob.id }, data: { campaignId: null } });
    const conflictBefore = await prisma.processingJob.findUniqueOrThrow({ where: { id: otherJob.id } });
    const publicationBefore = await prisma.telegramPublication.findUniqueOrThrow({ where: { id: publication.id } });
    await assert.rejects(catchUpDefaultCampaigns(prisma), /lineage conflicts/);
    assert.deepEqual(await prisma.processingJob.findUniqueOrThrow({ where: { id: otherJob.id } }), conflictBefore);
    assert.deepEqual(await prisma.telegramPublication.findUniqueOrThrow({ where: { id: publication.id } }), publicationBefore);
    await prisma.processingJob.update({ where: { id: otherJob.id }, data: { campaignId: other.id } });
    const pinnedPost = await prisma.originalPost.create({ data: { workspaceId: workspace.id, sourceChannelId: source.id, telegramChatId: "-10012345", telegramMessageId: 5, originalText: "Pinned identity", publishedAt: new Date(0) } });
    const pinnedJob = await prisma.processingJob.create({ data: { workspaceId: workspace.id, originalPostId: pinnedPost.id, campaignId: defaultCampaign.id, type: "TELEGRAM_PREPARE" } });
    assert(await processTelegramJob(prisma, async () => {
      await prisma.processingJob.update({ where: { id: pinnedJob.id }, data: { campaignId: other.id } });
      return "Stale campaign result";
    }));
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: pinnedPost.id } }), 0);
    const foreignPost = await prisma.originalPost.create({ data: { workspaceId: foreign.id, sourceChannelId: foreignSource.id, telegramChatId: "-10033333", telegramMessageId: 1, originalText: "Foreign original", publishedAt: new Date(0) } });
    await assert.rejects(prisma.processingJob.update({ where: { id: pinnedJob.id }, data: { originalPostId: foreignPost.id } }));
    console.log("PASS: other campaigns cannot execute/send; existing receipts replay; mismatched lineage fails without retagging; catch-up rolls back conflicts; changed claim identity discards generation.");
  } finally {
    await prisma.$disconnect();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    for (const [key, value] of [["INGEST_WORKSPACE_ID", previousWorkspace], ["INGEST_READER_SECRET", previousSecret], ["TELEGRAM_OUTPUT_CHAT_ID", previousOutput]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
}
main().catch(() => { console.error("Default runtime validation failed in disposable schema; no live sends were made."); process.exitCode = 1; });
