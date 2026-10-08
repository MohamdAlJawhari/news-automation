import { setCampaignMembership } from "../src/lib/campaign-execution";
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
import { queuePublication, claimPublication, recordPublicationResult, requestPublicationRecovery } from "../src/lib/publishing-db";
import { processTelegramJob } from "./telegram-processing";
import { catchUpDefaultCampaigns, inspectDefaultCampaignGaps } from "../src/lib/default-campaign-catchup";
import { listCampaignDrafts } from "../src/lib/campaign-drafts";
import { withinBoundary } from "../src/lib/campaign-execution";
import { createCampaign, ensureCampaignSettings } from "../src/lib/campaign-settings";
import { pathToFileURL } from "node:url";
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
async function main() {
  await admin.connect();
  let legacy: PrismaClient | undefined;
  try {
    const mainHistory = (await admin.query(`SELECT migration_name, finished_at FROM public._prisma_migrations ORDER BY migration_name`)).rows;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const migrations = (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    const executionIndex = migrations.indexOf("20261006220000_multi_campaign_execution");
    assert(executionIndex >= 0);
    const migration = await readFile(`prisma/migrations/${migrations[executionIndex]}/migration.sql`, "utf8");
    for (const m of migrations.slice(0, executionIndex)) await admin.query(await readFile(`prisma/migrations/${m}/migration.sql`, "utf8"));
    const legacyPath = pathToFileURL(path.resolve(".campaign-settings-validation/legacy-client/client.ts")).href;
    const LegacyClient = (await import(legacyPath)).PrismaClient as typeof PrismaClient;
    legacy = new LegacyClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
    await legacy.user.create({ data: { id: fixture.userId, name: "Fixture", email: "multi@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
    await legacy.workspace.create({ data: { id: workspaceId, ownerId: fixture.userId, name: "Fixture", automationEnabled: true, rssEnabled: true } });
    await legacy.sourceChannel.create({ data: { id: "publishing-source", workspaceId, username: "fixture_source", telegramChatId: "-10055555", telegramAutomationEnabled: true } });
    const defaultId = "historical-default";
    await legacy.campaign.create({ data: { id: defaultId, workspaceId, isDefault: true, name: "Default" } });
    await legacy.campaignSource.create({ data: { campaignId: defaultId, workspaceId, sourceChannelId: "publishing-source", telegramAutomationEnabled: true } });
    await legacy.campaignAiSettings.create({ data: { campaignId: defaultId, workspaceId, enabled: true, activatedAt: new Date(0), systemPrompt: "Default prompt", revision: 7 } });
    await legacy.campaignPublishingSettings.create({ data: { campaignId: defaultId, workspaceId, enabled: true, destinationUsername: "default_output", destinationChatId: "-10011111", verifiedAt: new Date(0), revision: 9 } });
    const history = [];
    for (const status of ["QUEUED", "PUBLISHED", "DELIVERY_UNKNOWN"] as const) {
      const post = await legacy.originalPost.create({ data: { workspaceId, sourceChannelId: "publishing-source", telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Historical original", publishedAt: new Date(0) } });
      const d = await legacy.aiDraft.create({ data: { workspaceId, campaignId: defaultId, originalPostId: post.id, aiText: "Old rewrite", finalText: "Saved historical text", model: "mock", effectivePrompt: "Saved prompt", settingsRevision: 7, editRevision: 3, reviewStatus: "APPROVED" } });
      history.push(await legacy.telegramPublication.create({ data: { workspaceId, draftId: d.id, draftRevision: 3, text: d.finalText, destinationChatId: "-10011111", destinationUsername: "default_output", destinationRevision: 9, randomId: String(90000 + sequence), status, ...(status !== "QUEUED" ? { lockToken: `saved-${status}`, dispatchedAt: new Date(0) } : {}), ...(status === "PUBLISHED" ? { telegramMessageId: 42, confirmedChatId: "-10011111", publishedAt: new Date(0) } : {}) } }));
    }
    // A pre-existing non-Default approved snapshot must remain publishable even
    // when its original precedes newly enforced AI eligibility boundaries.
    const priorCampaign = await legacy.campaign.create({ data: { workspaceId, name: "Previously configured", createdAt: new Date("2001-01-01T00:00:00Z") } });
    await legacy.campaignSource.create({ data: { workspaceId, campaignId: priorCampaign.id, sourceChannelId: "publishing-source", telegramAutomationEnabled: true, createdAt: new Date("2001-01-01T00:00:00Z") } });
    await legacy.campaignAiSettings.create({ data: { workspaceId, campaignId: priorCampaign.id, systemPrompt: "Prior settings" } });
    await legacy.campaignPublishingSettings.create({ data: { workspaceId, campaignId: priorCampaign.id, destinationUsername: "prior_output", destinationChatId: "-10033333", verifiedAt: new Date(0), revision: 6 } });
    const priorPost = await legacy.originalPost.create({ data: { workspaceId, sourceChannelId: "publishing-source", telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Approved older original", publishedAt: new Date(0), receivedAt: new Date(0) } });
    const priorDraft = await legacy.aiDraft.create({ data: { workspaceId, originalPostId: priorPost.id, campaignId: priorCampaign.id, aiText: "Retained", finalText: "Retained prior snapshot", model: "mock", effectivePrompt: "Retained", settingsRevision: 1, reviewStatus: "APPROVED" } });
    const priorPublication = await legacy.telegramPublication.create({ data: { workspaceId, draftId: priorDraft.id, draftRevision: 1, text: priorDraft.finalText, destinationChatId: "-10033333", destinationUsername: "prior_output", destinationRevision: 6, randomId: "88001" } });
    const nullPost = await legacy.originalPost.create({ data: { workspaceId, sourceChannelId: "publishing-source", telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Compatibility record", publishedAt: new Date(0) } });
    await admin.query(`INSERT INTO ai_draft (id,"workspaceId","originalPostId","aiText","finalText",model,"effectivePrompt","settingsRevision") VALUES ('null-draft',$1,$2,'saved','saved','mock','saved',7)`, [workspaceId, nullPost.id]);
    await legacy.processingJob.create({ data: { workspaceId, originalPostId: nullPost.id, type: "TELEGRAM_PREPARE", status: "PROCESSING", attempts: 3, lockToken: "old-lease", lockedUntil: new Date(Date.now() + 60000) } });
    await assert.rejects(admin.query(migration)); await admin.query("ROLLBACK");
    assert.equal((await catchUpDefaultCampaigns(prisma)).draftsAssigned, 1);
    assert.equal((await catchUpDefaultCampaigns(prisma)).draftsAssigned, 0);
    const snapshots = await legacy.telegramPublication.findMany({ orderBy: { id: "asc" } });
    const protections = async () => ({
      indexes: (await admin.query(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='telegram_publication' ORDER BY indexname`, [schema])).rows,
      triggers: (await admin.query(`SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition, pg_get_functiondef(p.oid) AS function FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=$1 AND c.relname='telegram_publication' AND NOT t.tgisinternal ORDER BY t.tgname`, [schema])).rows,
    });
    const before = await protections();
    await admin.query(migration);
    for (const m of migrations.slice(executionIndex + 1)) await admin.query(await readFile(`prisma/migrations/${m}/migration.sql`, "utf8"));
    assert.deepEqual((await prisma.telegramPublication.findMany({ orderBy: { id: "asc" } })).map(({ deliveryMode, queuedAutomatically, autoSendGeneration, ...p }) => {
      assert.equal(deliveryMode, "MANUAL"); assert.equal(queuedAutomatically, false); assert.equal(autoSendGeneration, null); return p;
    }), snapshots);
    const after = await protections();
    assert.deepEqual(after.indexes, before.indexes);
    assert.deepEqual(after.triggers.filter(t => t.tgname !== "protect_auto_publication_origin"), before.triggers);
    assert.equal((await prisma.processingJob.findFirstOrThrow({ where: { originalPostId: nullPost.id } })).lockToken, "old-lease");
    await assert.rejects(catchUpDefaultCampaigns(prisma), /retired/);
    await assert.rejects(prisma.sourceChannel.update({ where: { id: "publishing-source" }, data: { telegramAutomationEnabled: false } }));
    const toggle = (campaignId: string, enabled: boolean) => prisma.$transaction(tx => setCampaignMembership(tx, workspaceId, campaignId, "publishing-source", enabled));
    await toggle(defaultId, false);
    await assert.rejects(admin.query(`UPDATE campaign_source m SET "telegramAutomationEnabled"=s."telegramAutomationEnabled" FROM source_channel s WHERE m."sourceChannelId"=s.id`));
    assert.equal((await prisma.$transaction(inspectDefaultCampaignGaps)).membershipFlagsDifferent, 0);
    await toggle(defaultId, true);
    console.log("PASS: populated transition, checked catch-up, immutable history/protections and retired legacy authority.");
    await prisma.campaignPublishingSettings.update({ where: { campaignId: defaultId }, data: { enabled: false } });
    assert.equal(await claimPublication(prisma, workspaceId), null);
    for (const p of history.filter(p => p.status !== "QUEUED")) {
      const receipt = { id: p.id, token: p.lockToken!, outcome: "published" as const, chatId: p.destinationChatId, messageId: 42, publishedAt: new Date(0).toISOString() };
      assert(await recordPublicationResult(prisma, workspaceId, receipt)); assert(await recordPublicationResult(prisma, workspaceId, receipt));
    }
    await prisma.campaignPublishingSettings.update({ where: { campaignId: defaultId }, data: { enabled: true } });
    const oldQueued = (await claimPublication(prisma, workspaceId))!; assert.equal(oldQueued.id, history[0].id);
    await recordPublicationResult(prisma, workspaceId, { id: oldQueued.id, token: oldQueued.lockToken!, outcome: "published", chatId: oldQueued.destinationChatId, messageId: 43, publishedAt: new Date().toISOString() });
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: priorCampaign.id } })).executionStartsAt.getTime(), priorCampaign.createdAt.getTime());
    await prisma.campaignPublishingSettings.update({ where: { campaignId: priorCampaign.id }, data: { enabled: true } });
    const priorClaim = (await claimPublication(prisma, workspaceId))!; assert.equal(priorClaim.id, priorPublication.id);
    await recordPublicationResult(prisma, workspaceId, { id: priorClaim.id, token: priorClaim.lockToken!, outcome: "published", chatId: priorClaim.destinationChatId, messageId: 44, publishedAt: new Date().toISOString() });
    await prisma.processingJob.updateMany({ where: { originalPostId: nullPost.id }, data: { status: "COMPLETED" } });
    const second = await prisma.$transaction(async tx => {
      const c = await tx.campaign.create({ data: { workspaceId, name: "Second" } });
      const settings = await ensureCampaignSettings(tx, workspaceId, c.id);
      assert.equal(settings.aiSettings.enabled, false); assert.equal(settings.publishingSettings.enabled, false); return c;
    });
    await prisma.campaignAiSettings.update({ where: { campaignId: second.id }, data: { enabled: true, activatedAt: new Date(0), systemPrompt: "Second distinct prompt", revision: 4 } });
    await prisma.campaignPublishingSettings.update({ where: { campaignId: second.id }, data: { enabled: true, destinationUsername: "second_output", destinationChatId: "-10022222", verifiedAt: new Date(), revision: 5 } });
    const ingestion = await load<Routes>("src/app/api/ingestion/posts/route.ts");
    const ingest = (message: number, sourceId = "publishing-source", chatId = "-10055555") => ingestion.POST(new Request("http://localhost/api/ingestion/posts", { method: "POST", headers: { "x-ingest-secret": process.env.INGEST_READER_SECRET!, "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, telegramChatId: chatId, telegramMessageId: message, originalText: "Shared original", publishedAt: new Date(0).toISOString() }) }));
    const older = await (await ingest(sequence++)).json();
    assert.equal(await prisma.processingJob.count({ where: { originalPostId: older.originalPostId } }), 2);
    await toggle(second.id, true);
    // Timestamp(3) boundaries deliberately exclude equal timestamps.
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await (await ingest(sequence - 1)).json()).duplicate, true);
    assert.equal(await prisma.processingJob.count({ where: { originalPostId: older.originalPostId, campaignId: second.id } }), 0);
    const concurrent = await Promise.all([ingest(sequence), ingest(sequence)]); sequence++;
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 201]);
    const shared = (await concurrent[0].json()).originalPostId;
    const jobs = await prisma.processingJob.findMany({ where: { originalPostId: shared } });
    assert.equal(jobs.length, 3);
    await assert.rejects(prisma.processingJob.update({ where: { id: jobs.find(j => j.campaignId === second.id)!.id }, data: { campaignId: defaultId } })); assert.equal(jobs.find(j => j.type === "RSS_PREPARE")!.campaignId, null);
    await assert.rejects(prisma.processingJob.create({ data: { workspaceId, originalPostId: shared, type: "RSS_PREPARE" } }));
    await assert.rejects(prisma.processingJob.create({ data: { workspaceId, originalPostId: shared, type: "TELEGRAM_PREPARE" } }));
    await assert.rejects(prisma.processingJob.create({ data: { workspaceId, originalPostId: shared, campaignId: second.id, type: "TELEGRAM_PREPARE" } }));
    const prompts: string[] = [];
    while (await processTelegramJob(prisma, async (_text, prompt) => { prompts.push(prompt); return prompt.includes("Second distinct") ? "Second rewrite" : "Default rewrite"; })) { /* synthetic drain */ }
    assert(prompts.some(p => p.includes("Second distinct"))); assert(prompts.some(p => p.includes("Default prompt")));
    const drafts = await prisma.aiDraft.findMany({ where: { originalPostId: shared } }); assert.equal(drafts.length, 2);
    const otherDraft = drafts.find(d => d.campaignId === second.id)!; assert.equal(otherDraft.aiText, "Second rewrite");
    await assert.rejects(prisma.aiDraft.update({ where: { id: otherDraft.id }, data: { campaignId: defaultId } }));
    const ai = await load<AiActions>("src/app/actions/ai.ts");
    const actions = await load<Actions>("src/app/actions/direct-publishing.ts");
    assert.equal((await ai.saveAiDraft({ ...initial, revision: 1 }, form({ id: otherDraft.id, revision: "1", intent: "approve" }))).success, false);
    await prisma.aiDraft.updateMany({ where: { originalPostId: shared }, data: { reviewStatus: "APPROVED" } });
    assert.equal((await actions.publishAiDraft(initial, form({ id: otherDraft.id, revision: "1" }))).success, false);
    for (const d of drafts) await queuePublication(prisma, workspaceId, d.id, 1);
    const pubs = await prisma.telegramPublication.findMany({ where: { draftId: { in: drafts.map(d => d.id) } } });
    assert.equal(pubs.find(p => p.draftId === otherDraft.id)!.destinationChatId, "-10022222");
    await prisma.campaignPublishingSettings.update({ where: { campaignId: defaultId }, data: { enabled: false } });
    let c = (await claimPublication(prisma, workspaceId))!; assert.equal(c.draftId, otherDraft.id);
    assert.equal(await claimPublication(prisma, workspaceId), null);
    const stableRequestId = c.randomId;
    assert(await recordPublicationResult(prisma, workspaceId, { id: c.id, token: c.lockToken!, outcome: "paused", error: "PAUSED" }));
    assert.equal((await prisma.telegramPublication.findUniqueOrThrow({ where: { id: c.id } })).status, "QUEUED");
    await prisma.telegramPublication.update({ where: { id: c.id }, data: { availableAt: new Date(0) } });
    c = (await claimPublication(prisma, workspaceId))!; assert.equal(c.randomId, stableRequestId);
    await prisma.campaignPublishingSettings.update({ where: { campaignId: second.id }, data: { enabled: false } });
    assert(await recordPublicationResult(prisma, workspaceId, { id: c.id, token: c.lockToken!, outcome: "unknown" }));
    assert.equal((await actions.recoverTelegramPublication(initial, form({ id: c.id, intent: "existing", messageId: "77" }))).success, false);
    await prisma.$transaction(tx => requestPublicationRecovery(tx, workspaceId, second.id, c.id, "existing", 77, false));
    assert.equal((await prisma.telegramPublication.findUniqueOrThrow({ where: { id: c.id } })).recoveryMessageId, 77);
    const receipt = { id: c.id, token: c.lockToken!, outcome: "published" as const, chatId: "-10022222", messageId: 77, publishedAt: new Date().toISOString() };
    assert(await recordPublicationResult(prisma, workspaceId, receipt)); assert(await recordPublicationResult(prisma, workspaceId, receipt));
    await prisma.campaignPublishingSettings.update({ where: { campaignId: defaultId }, data: { enabled: true } });
    const dc = (await claimPublication(prisma, workspaceId))!;
    await recordPublicationResult(prisma, workspaceId, { id: dc.id, token: dc.lockToken!, outcome: "published", chatId: dc.destinationChatId, messageId: 78, publishedAt: new Date().toISOString() });
    console.log("PASS: two prompts/destinations, one original, duplicate ingestion, future memberships, Default mutation isolation, shared sends and receipt replay.");
    await prisma.campaignAiSettings.update({ where: { campaignId: defaultId }, data: { enabled: false } });
    const paused = (await (await ingest(sequence++)).json()).originalPostId;
    await processTelegramJob(prisma, async () => "Second while Default paused");
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: paused, campaignId: defaultId } }), 0);
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: paused, campaignId: second.id } }), 1);
    await prisma.campaignAiSettings.update({ where: { campaignId: defaultId }, data: { enabled: true } });
    await processTelegramJob(prisma, async () => "Default resumed"); assert.equal(await prisma.aiDraft.count({ where: { originalPostId: paused } }), 2);
    await prisma.campaignAiSettings.update({ where: { campaignId: defaultId }, data: { enabled: false } });
    const changed = (await (await ingest(sequence++)).json()).originalPostId;
    await processTelegramJob(prisma, async () => { await prisma.campaignAiSettings.update({ where: { campaignId: second.id }, data: { revision: { increment: 1 } } }); return "Discard stale settings"; });
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: changed } }), 0);
    await prisma.processingJob.updateMany({ where: { originalPostId: changed }, data: { availableAt: new Date(0) } });
    await processTelegramJob(prisma, async () => { await toggle(second.id, false); await toggle(second.id, true); return "Discard ABA"; });
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: changed } }), 0);
    await prisma.processingJob.updateMany({ where: { originalPostId: changed }, data: { availableAt: new Date(0) } });
    await processTelegramJob(prisma, async () => "Retried correctly"); assert.equal(await prisma.aiDraft.count({ where: { originalPostId: changed, campaignId: second.id } }), 1);
    await prisma.user.create({ data: { id: "other-owner", name: "Other", email: "other@example.invalid" } });
    await prisma.workspace.create({ data: { id: "other-workspace", ownerId: "other-owner", name: "Other" } });
    const foreignDefaults = await Promise.all(Array.from({ length: 6 }, () => prisma.$transaction(tx => ensureDefaultCampaign(tx, "other-workspace"))));
    const foreign = foreignDefaults[0];
    assert(foreignDefaults.every(c => c.id === foreign.id));
    assert.equal(await prisma.campaign.count({ where: { workspaceId: "other-workspace", isDefault: true } }), 1);
    await assert.rejects(toggle(foreign.id, true));
    await assert.rejects(prisma.campaignSource.create({ data: { workspaceId: "other-workspace", campaignId: foreign.id, sourceChannelId: "publishing-source" } }));
    await assert.rejects(prisma.processingJob.create({ data: { workspaceId, originalPostId: changed, campaignId: foreign.id, type: "TELEGRAM_PREPARE" } }));
    await assert.rejects(prisma.aiDraft.create({ data: { workspaceId, originalPostId: changed, campaignId: foreign.id, aiText: "No", finalText: "No", model: "mock", effectivePrompt: "No", settingsRevision: 1 } }));
    console.log("PASS: independent pause/resume, settings/membership revision discard and cross-workspace constraints.");
    const routes = await load<Routes>("src/app/api/reader/publishing/route.ts");
    await prisma.campaignPublishingSettings.updateMany({ where: { workspaceId, campaignId: { in: [defaultId, second.id] } }, data: { verificationPending: true } });
    const get = await routes.GET(new Request("http://localhost/api/reader/publishing", { headers: { "x-ingest-secret": process.env.INGEST_READER_SECRET! } }));
    const protocol = await get.json(); assert.equal(protocol.verifications.length, 2); assert.equal(protocol.protocolVersion, 2);
    const verify = async (campaignId: string, revision: number) => (await routes.POST(new Request("http://localhost/api/reader/publishing", { method: "POST", headers: { "x-ingest-secret": process.env.INGEST_READER_SECRET!, "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", campaignId, revision, username: "second_output", chatId: "-10022222" }) }))).json();
    assert.equal((await verify(foreign.id, 5)).accepted, false); assert.equal((await verify(second.id, 1)).accepted, false); assert.equal((await verify(second.id, 5)).accepted, true);
    const alias = await prisma.sourceChannel.create({ data: { workspaceId, username: "destination_alias" } });
    assert.equal((await ingest(sequence++, alias.id, "-10022222")).status, 409);
    await toggle(second.id, false);
    const held = (await (await ingest(sequence++)).json()).originalPostId;
    assert.equal(await prisma.processingJob.count({ where: { originalPostId: held, campaignId: second.id } }), 1);
    assert.equal(await processTelegramJob(prisma, async () => { throw new Error("Paused membership generated"); }), false);
    await toggle(second.id, true); await processTelegramJob(prisma, async () => "Membership resumed");
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: held, campaignId: second.id } }), 1);
    const sourceActions = await load<Record<string, (form: FormData) => Promise<void>>>("src/app/actions/sources.ts");
    await assert.rejects(sourceActions.setSourceTelegramAutomation(form({ sourceId: "publishing-source", enabled: "false" })), /REDIRECT:/);
    assert.equal((await prisma.campaignSource.findUniqueOrThrow({ where: { campaignId_sourceChannelId: { campaignId: second.id, sourceChannelId: "publishing-source" } } })).telegramAutomationEnabled, true);
    assert.equal((await prisma.sourceChannel.findUniqueOrThrow({ where: { id: "publishing-source" } })).telegramAutomationEnabled, true);
    await assert.rejects(sourceActions.addWorkspaceSource(form({ channel: "new_fixture_source" })), /REDIRECT:/);
    const added = await prisma.sourceChannel.findUniqueOrThrow({ where: { workspaceId_username: { workspaceId, username: "new_fixture_source" } } });
    assert.equal((await prisma.campaignSource.findUniqueOrThrow({ where: { campaignId_sourceChannelId: { campaignId: defaultId, sourceChannelId: added.id } } })).telegramAutomationEnabled, false);
    const scoped = await prisma.$transaction(tx => listCampaignDrafts(tx, workspaceId, defaultId, 1));
    assert(scoped.drafts.every(d => d.campaignId === defaultId));
    await assert.rejects(prisma.$transaction(tx => listCampaignDrafts(tx, workspaceId, foreign.id, 1)));
    const concurrentDefaults = await Promise.all(Array.from({ length: 6 }, () => prisma.$transaction(tx => ensureDefaultCampaign(tx, "other-workspace"))));
    assert(concurrentDefaults.every(c => c.id === foreign.id));
    const fresh = await prisma.$transaction(tx => createCampaign(tx, workspaceId, "New disabled workflow"));
    assert.equal(fresh.aiSettings.enabled, false); assert.equal(fresh.publishingSettings.enabled, false);
    assert.equal(withinBoundary(new Date(0), fresh.campaign, { eligibleAfter: new Date(0) }, { activatedAt: new Date(0) }), false);
    await assert.rejects(prisma.campaign.update({ where: { id: fresh.campaign.id }, data: { executionStartsAt: new Date(0) } }));
    await assert.rejects(prisma.campaignSource.update({ where: { campaignId_sourceChannelId: { campaignId: second.id, sourceChannelId: "publishing-source" } }, data: { eligibleAfter: new Date(0) } }));
    assert.deepEqual((await admin.query(`SELECT migration_name, finished_at FROM public._prisma_migrations ORDER BY migration_name`)).rows, mainHistory);
    console.log("PASS: campaign/revision-scoped verification and stable destination alias exclusion.");
  } finally {
    await legacy?.$disconnect(); await prisma.$disconnect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
    if (previousWorkspace === undefined) delete process.env.INGEST_WORKSPACE_ID; else process.env.INGEST_WORKSPACE_ID = previousWorkspace;
    if (previousSecret === undefined) delete process.env.INGEST_READER_SECRET; else process.env.INGEST_READER_SECRET = previousSecret;
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : "Multi-campaign disposable check failed; no live sends or main migration."); console.error(error instanceof Error ? error.stack?.split("\n").filter(line => line.trim().startsWith("at ")).join("\n") : ""); process.exitCode = 1; });
