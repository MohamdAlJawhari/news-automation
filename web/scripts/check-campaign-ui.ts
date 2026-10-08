import { ensureDefaultCampaign } from "../src/lib/default-campaign";
import { setCampaignMembership } from "../src/lib/campaign-execution";
// Real PostgreSQL in a disposable schema; session/Next boundaries are mocked.
// No Telegram connection, credentials or network sends are used by this check.
import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { listCampaignDrafts } from "../src/lib/campaign-drafts";
import type { CampaignActionState } from "../src/app/actions/campaigns";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import path from "node:path";
import { claimPublication, recordPublicationResult } from "../src/lib/publishing-db";
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
    stdin: { contents: await readFile(file, "utf8"), loader: file.endsWith(".tsx") ? "tsx" : "ts", resolveDir: process.cwd() }, bundle: true,
    platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/jsx-runtime", "react-dom"], write: false, logLevel: "silent",
    plugins: [{ name: "publishing-session-fixture", setup(builder) {
      builder.onResolve({ filter: /^(@\/lib\/(prisma|access|auth-client|auth)|next\/(navigation|cache|link|headers)|server-only)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents:
        args.path === "@/lib/prisma" ? "export const prisma = globalThis.__fixture.prisma;" :
        args.path === "@/lib/access" ? `export async function getCurrentAccess() {
          const user = await globalThis.__fixture.prisma.user.findUnique({where:{id:globalThis.__fixture.userId},include:{workspace:true}});
          return user ? {user} : null;
        } export function getEntryDestination(access) { return access?.user.workspace?.automationEnabled ? '/workspace/campaigns' : '/workspace/sources'; }` :
        args.path === "next/navigation" ? "export function redirect(path) { throw new Error('REDIRECT:' + path); } export function notFound(){throw new Error('NOT_FOUND');} export function useRouter(){return {refresh(){},replace(){}};}" :
        args.path === "next/link" ? "import {createElement} from 'react'; export default function Link({children, ...props}) { return createElement('a', props, children); }" :
        args.path === "@/lib/auth-client" ? "export const authClient = {signOut: async()=>({})};" :
        args.path === "@/lib/auth" ? "export const auth={api:{getSession:async()=>({user:{id:globalThis.__fixture.userId}})}};" :
        args.path === "next/headers" ? "export async function headers(){return {}}" :
        args.path === "next/cache" ? "export function revalidatePath() {}" : "",
      }));
      builder.onResolve({ filter: /^(?:@\/|\.)/ }, async args => {
        const base = args.path.startsWith("@/") ? path.resolve("src", args.path.slice(2)) : path.resolve(path.dirname(args.importer), args.path);
        const extension = await stat(base + ".ts").then(() => ".ts", () => ".tsx");
        return { path: base + extension, namespace: "fixture-file" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture-file" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: args.path.endsWith(".tsx") ? "tsx" : "ts" }));
    } }],
  });
  const actionModule = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module: actionModule, exports: actionModule.exports, __fixture: fixture, process, console,
    require: createRequire(import.meta.url), Request, Response, Date, URLSearchParams });
  return actionModule.exports as T;
}
const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };
const initial = { success: false, message: "" };
type CampaignActions = Record<string, (state: CampaignActionState, form: FormData) => Promise<CampaignActionState>>;
type Page = { default: (props: { params: Promise<{ campaignId: string }>; searchParams: Promise<{ page?: string }> }) => Promise<ReactElement> };
async function main() {
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`); await admin.query(`SET search_path TO "${schema}"`);
    for (const migration of (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) await admin.query(await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8"));
    await prisma.user.create({ data: { id: fixture.userId, name: "Fixture", email: "campaign-ui@example.invalid", emailVerified: true, approvalStatus: "APPROVED", platformRole: "OWNER" } });
    await prisma.workspace.create({ data: { id: workspaceId, ownerId: fixture.userId, name: "Fixture", automationEnabled: true, rssEnabled: true } });
    const defaultCampaign = await prisma.$transaction(tx => ensureDefaultCampaign(tx, workspaceId));
    const management = await load<CampaignActions>("src/app/actions/campaigns.ts");
    const ai = await load<AiActions>("src/app/actions/ai.ts");
    const publishing = await load<Actions>("src/app/actions/direct-publishing.ts");
    const reader = await load<Routes>("src/app/api/reader/publishing/route.ts");
    const a = await management.createCampaignAction(initial, form({ name: "أخبار المدينة — حملة عربية" }));
    const b = await management.createCampaignAction(initial, form({ name: "International news" }));
    assert(a.success && b.success); const campaignA = a.campaignId!; const campaignB = b.campaignId!;
    for (const id of [campaignA, campaignB]) {
      assert.equal(await prisma.campaignSource.count({ where: { campaignId: id } }), 0);
      assert.equal((await prisma.campaignAiSettings.findUniqueOrThrow({ where: { campaignId: id } })).enabled, false);
      assert.equal((await prisma.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: id } })).enabled, false);
    }
    const deletable = (await management.createCampaignAction(initial, form({ name: "Disposable empty" }))).campaignId!;
    assert.equal((await management.deleteEmptyCampaign(initial, form({campaignId:deletable}))).success, false);
    assert.equal((await management.deleteEmptyCampaign(initial, form({campaignId:defaultCampaign.id,confirmed:"yes"}))).success, false);
    assert((await management.deleteEmptyCampaign(initial, form({campaignId:deletable,confirmed:"yes"}))).success);
    assert.equal(await prisma.campaign.count({where:{id:deletable}}),0);
    const source = await prisma.sourceChannel.create({ data: { workspaceId, username: "ui_shared_source", telegramChatId: "-10055555" } });
    assert.equal((await management.changeCampaignSource(initial, form({ campaignId: campaignA, sourceId: "forged-source", intent: "join" }))).success, false);
    assert.equal((await management.changeCampaignSource(initial, form({ campaignId: "forged-campaign", sourceId: source.id, intent: "join" }))).success, false);
    const membership = (campaignId: string) => prisma.campaignSource.findUniqueOrThrow({ where: { campaignId_sourceChannelId: { campaignId, sourceChannelId: source.id } } });
    for (const id of [campaignA, campaignB]) {
      assert((await management.changeCampaignSource(initial, form({ campaignId: id, sourceId: source.id, intent: "join" }))).success);
      assert.equal((await membership(id)).telegramAutomationEnabled, false);
    }
    const change = async (campaignId: string, intent: string, revision?: number) => management.changeCampaignSource(initial, form({ campaignId, sourceId: source.id, intent, revision: String(revision ?? (await membership(campaignId)).revision) }));
    assert.equal((await management.deleteEmptyCampaign(initial, form({campaignId:campaignA,confirmed:"yes"}))).success, false, "Membership history must survive deletion attempts");
    assert((await change(campaignA, "resume")).success); assert.equal((await membership(campaignB)).telegramAutomationEnabled, false);
    assert.equal((await change(campaignA, "pause", 1)).success, false);
    const aiForm = (campaignId: string, revision: number, enabled = true) => form({ campaignId, revision: String(revision), systemPrompt: campaignId === campaignA ? "اكتب الأخبار باللغة العربية" : "Write concise English news", editorialPerspective: "", model: "gpt-oss:latest", ...(enabled ? { enabled: "on" } : {}) });
    for (const id of [campaignA, campaignB]) assert((await ai.saveCampaignAiSettings({ ...initial, revision: 1 }, aiForm(id, 1))).success);
    assert.equal((await ai.saveCampaignAiSettings({ ...initial, revision: 1 }, aiForm(campaignA, 1))).success, false);
    const activation = (await prisma.campaignAiSettings.findUniqueOrThrow({ where: { campaignId: campaignA } })).activatedAt!.getTime();
    assert((await ai.saveCampaignAiSettings({ ...initial, revision: 2 }, aiForm(campaignA, 2, false))).success);
    assert((await ai.saveCampaignAiSettings({ ...initial, revision: 3 }, aiForm(campaignA, 3))).success);
    assert.equal((await prisma.campaignAiSettings.findUniqueOrThrow({ where: { campaignId: campaignA } })).activatedAt!.getTime(), activation);
    await new Promise(resolve => setTimeout(resolve, 10));
    const ingestion = await load<Routes>("src/app/api/ingestion/posts/route.ts");
    const ingested = await ingestion.POST(new Request("http://localhost/api/ingestion/posts", { method: "POST", headers: { "x-ingest-secret": process.env.INGEST_READER_SECRET!, "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: source.id, telegramChatId: source.telegramChatId, telegramMessageId: 1, originalText: "افتتحت المكتبة العامة أبوابها يوم الاثنين. Shared news original.", publishedAt: new Date(0).toISOString() }) }));
    assert.equal(ingested.status, 201); const originalId = (await ingested.json()).originalPostId;
    assert(await processTelegramJob(prisma, async (_text, prompt) => { assert(prompt.includes("العربية")); return "افتتحت المكتبة العامة أبوابها يوم الاثنين."; }));
    assert.equal(await processTelegramJob(prisma, async () => { throw new Error("Paused B generated"); }), false);
    assert((await change(campaignB, "resume")).success);
    assert(await processTelegramJob(prisma, async (_text, prompt) => { assert(prompt.includes("English")); return "The public library reopened Monday."; }));
    const da = (await prisma.$transaction(tx => listCampaignDrafts(tx, workspaceId, campaignA, 1))).drafts[0];
    const db = (await prisma.$transaction(tx => listCampaignDrafts(tx, workspaceId, campaignB, 1))).drafts[0];
    assert.equal(da.originalPostId, db.originalPostId); assert.equal(da.originalPostId, originalId);
    assert.equal((await ai.saveCampaignAiDraft({ ...initial, revision: 1 }, form({ campaignId: campaignB, draftId: da.id, revision: "1", intent: "approve" }))).success, false);
    assert.equal((await ai.saveAiDraft({ ...initial, revision: 1 }, form({ campaignId: campaignA, id: da.id, revision: "1", intent: "approve" }))).success, false);
    assert((await ai.saveCampaignAiDraft({ ...initial, revision: 1 }, form({ campaignId: campaignA, draftId: da.id, revision: "1", intent: "save", finalText: "نص نهائي محفوظ، جاهز للمراجعة." }))).success);
    assert.equal((await ai.saveCampaignAiDraft({ ...initial, revision: 1 }, form({ campaignId: campaignA, draftId: da.id, revision: "1", intent: "reject" }))).success, false);
    assert((await ai.saveCampaignAiDraft({ ...initial, revision: 2 }, form({ campaignId: campaignA, draftId: da.id, revision: "2", intent: "approve" }))).success);
    assert((await ai.saveCampaignAiDraft({ ...initial, revision: 1 }, form({ campaignId: campaignB, draftId: db.id, revision: "1", intent: "approve" }))).success);
    assert.equal(await prisma.telegramPublication.count(), 0, "Save and Approve must never publish");
    const configure = (campaignId: string, enabled = true) => publishing.saveCampaignPublishingSettings(initial, form({ campaignId, destination: campaignId === campaignA ? "ui_output_arabic" : "ui_output_english", revision: "1", ...(enabled ? { enabled: "on" } : {}) }));
    for (const [id, username, chatId] of [[campaignA, "ui_output_arabic", "-10011111"], [campaignB, "ui_output_english", "-10022222"]]) {
      assert((await configure(id)).success);
      const response = await reader.POST(new Request("http://localhost/api/reader/publishing", { method: "POST", headers: { "x-ingest-secret": process.env.INGEST_READER_SECRET!, "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", campaignId: id, username, chatId, revision: 1 }) }));
      assert((await response.json()).accepted);
    }
    assert.equal(await prisma.telegramPublication.count(), 0, "Settings and verification must never publish");
    // Immediate switches only write their own setting and retain snapshot revisions.
    const beforeAi = await prisma.campaignAiSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
    const switchedAi = await ai.saveCampaignAiSettings({ ...initial, revision: beforeAi.revision }, form({ campaignId: campaignA, intent: "enablement", revision: String(beforeAi.revision), enabled: "" }));
    assert(switchedAi.success); assert.equal(switchedAi.enabled, false);
    const afterAi = await prisma.campaignAiSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
    assert.equal(afterAi.systemPrompt, beforeAi.systemPrompt); assert.equal(afterAi.model, beforeAi.model); assert.deepEqual(afterAi.activatedAt, beforeAi.activatedAt);
    assert.equal((await ai.saveCampaignAiSettings({ ...initial, revision: beforeAi.revision }, form({ campaignId: campaignA, intent: "enablement", revision: String(beforeAi.revision), enabled: "on" }))).success, false);
    assert((await ai.saveCampaignAiSettings({ ...initial, revision: afterAi.revision }, form({ campaignId: campaignA, intent: "enablement", revision: String(afterAi.revision), enabled: "on" }))).success);
    const beforePublish = await prisma.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
    for (const enabled of ["", "on"]) assert((await publishing.saveCampaignPublishingSettings(initial, form({ campaignId: campaignA, intent: "enablement", revision: String(beforePublish.revision), enabled }))).success);
    const afterPublish = await prisma.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
    assert.equal(afterPublish.destinationChatId, beforePublish.destinationChatId); assert.equal(afterPublish.revision, beforePublish.revision); assert.deepEqual(afterPublish.verifiedAt, beforePublish.verifiedAt);
    assert.equal((await publishing.saveCampaignPublishingSettings(initial, form({ campaignId: campaignA, intent: "enablement", revision: "999", enabled: "" }))).success, false);
    const destinationAlias = await prisma.sourceChannel.create({ data: { workspaceId, username: "ui_destination_alias", telegramChatId: "-10011111", enabled: false } });
    assert.equal((await management.changeCampaignSource(initial, form({ campaignId: campaignB, sourceId: destinationAlias.id, intent: "join" }))).success, false);
    assert.equal(await prisma.campaignSource.count({ where: { sourceChannelId: destinationAlias.id } }), 0);
    await prisma.sourceChannel.delete({ where: { id: destinationAlias.id } });
    assert.equal((await publishing.publishCampaignAiDraft(initial, form({ campaignId: campaignB, draftId: da.id, revision: "3" }))).success, false);
    assert((await publishing.publishCampaignAiDraft(initial, form({ campaignId: campaignA, draftId: da.id, revision: "3" }))).success);
    assert((await publishing.publishCampaignAiDraft(initial, form({ campaignId: campaignB, draftId: db.id, revision: "2" }))).success);
    assert.equal((await management.deleteEmptyCampaign(initial, form({campaignId:campaignA,confirmed:"yes"}))).success, false, "Jobs, drafts and publications must survive deletion attempts");
    assert.equal((await prisma.aiDraft.findUniqueOrThrow({where:{id:da.id}})).aiText, da.aiText, "Manual edits must preserve original AI output");
    const pa = await prisma.telegramPublication.findFirstOrThrow({ where: { draftId: da.id } });
    const pb = await prisma.telegramPublication.findFirstOrThrow({ where: { draftId: db.id } });
    assert.equal(pa.destinationChatId, "-10011111"); assert.equal(pb.destinationChatId, "-10022222");
    assert((await configure(campaignA, false)).success); assert((await configure(campaignA)).success);
    const unchanged = await prisma.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
    assert.equal(unchanged.revision, pa.destinationRevision); assert.equal(unchanged.verificationPending, false); assert(unchanged.verifiedAt);
    assert.equal((await ai.saveCampaignAiDraft({ ...initial, revision: 3 }, form({ campaignId: campaignA, draftId: da.id, revision: "3", intent: "save", finalText: "blocked" }))).success, false);
    const claim = (await claimPublication(prisma, workspaceId))!;
    await recordPublicationResult(prisma, workspaceId, { id: claim.id, token: claim.lockToken!, outcome: "unknown" });
    const claimCampaign = claim.draftId === da.id ? campaignA : campaignB;
    assert.equal((await publishing.recoverCampaignTelegramPublication(initial, form({ campaignId: claimCampaign === campaignA ? campaignB : campaignA, publicationId: claim.id, intent: "existing", messageId: "42" }))).success, false);
    await prisma.campaignPublishingSettings.update({ where: { campaignId: claimCampaign }, data: { enabled: false } });
    assert((await publishing.recoverCampaignTelegramPublication(initial, form({ campaignId: claimCampaign, publicationId: claim.id, intent: "existing", messageId: "42" }))).success);
    assert(await recordPublicationResult(prisma, workspaceId, { id: claim.id, token: claim.lockToken!, outcome: "published", chatId: claim.destinationChatId, messageId: 42, publishedAt: new Date().toISOString() }));
    const originalCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignA } });
    assert((await management.renameCampaign(initial, form({ campaignId: campaignA, name: "أخبار المدينة", updatedAt: originalCampaign.updatedAt.toISOString() }))).success);
    assert.equal((await management.renameCampaign(initial, form({ campaignId: campaignA, name: "stale overwrite", updatedAt: originalCampaign.updatedAt.toISOString() }))).success, false);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: defaultCampaign.id } })).isDefault, true);
    console.log("PASS: real campaign actions create disabled workflows, join paused, independently resume, scope drafts, reject stale revisions, preserve snapshots and recover after disablement.");

    const props = (campaignId: string) => ({ params: Promise.resolve({ campaignId }), searchParams: Promise.resolve({}) });
    const html = async (file: string, campaignId = campaignA, query = {}) => renderToStaticMarkup(await (await load<Page>(file)).default({...props(campaignId),searchParams:Promise.resolve(query)}));
    const settingsPath = "src/app/workspace/campaigns/[campaignId]/settings/page.tsx";
    for (const enabled of [false, true]) {
      const currentAi = await prisma.campaignAiSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
      assert((await ai.saveCampaignAiSettings({ ...initial, revision: currentAi.revision }, form({ campaignId: campaignA, intent: "enablement", revision: String(currentAi.revision), enabled: enabled ? "on" : "" }))).success);
      assert((await html(settingsPath)).includes(`aria-label="Enable AI preparation" title="Enable AI preparation" aria-checked="${enabled}"`));
      const currentPub = await prisma.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: campaignA } });
      assert((await publishing.saveCampaignPublishingSettings(initial, form({ campaignId: campaignA, intent: "enablement", revision: String(currentPub.revision), enabled: enabled ? "on" : "" }))).success);
      assert((await html(settingsPath)).includes(`aria-label="Enable Telegram publishing" title="Enable Telegram publishing" aria-checked="${enabled}"`));
    }
    const pendingPost = await prisma.originalPost.create({ data: { workspaceId, sourceChannelId: source.id, telegramChatId: source.telegramChatId!, telegramMessageId: 2, originalText: "Another synthetic original", publishedAt: new Date(0) } });
    await prisma.aiDraft.create({ data: { workspaceId, campaignId: campaignB, originalPostId: pendingPost.id, aiText: "B only pending review fixture", finalText: "B only pending review fixture", model: "mock", effectivePrompt: "B prompt", settingsRevision: 1 } });
    // Search covers all matching data before pagination, including later pages.
    const searchPost = await prisma.originalPost.create({data:{workspaceId,sourceChannelId:source.id,telegramChatId:source.telegramChatId!,telegramMessageId:900,originalText:"Unique original search needle",publishedAt:new Date(0)}});
    const searchDraft = await prisma.aiDraft.create({data:{workspaceId,campaignId:campaignB,originalPostId:searchPost.id,aiText:"Original AI search needle",finalText:"Final search needle",model:"mock",effectivePrompt:"B",settingsRevision:1,createdAt:new Date(1)}});
    const morePosts = [];
    for (let i=0;i<21;i++) morePosts.push(await prisma.originalPost.create({data:{workspaceId,sourceChannelId:source.id,telegramChatId:source.telegramChatId!,telegramMessageId:901+i,originalText:`Page filler ${i}`,publishedAt:new Date(0)}}));
    for (const post of morePosts) await prisma.aiDraft.create({data:{workspaceId,campaignId:campaignB,originalPostId:post.id,aiText:"Filler",finalText:"Filler",model:"mock",effectivePrompt:"B",settingsRevision:1,reviewStatus:"REJECTED"}});
    const searched = await prisma.$transaction(tx=>listCampaignDrafts(tx,workspaceId,campaignB,1,{search:"Unique original search needle"}));
    assert.deepEqual(searched.drafts.map(d=>d.id),[searchDraft.id]);
    assert.equal((await prisma.$transaction(tx=>listCampaignDrafts(tx,workspaceId,campaignB,1,{sort:"oldest"}))).drafts[0].id,searchDraft.id);
    assert.equal((await prisma.$transaction(tx=>listCampaignDrafts(tx,workspaceId,campaignA,1,{search:"Final search needle"}))).drafts.length,0);
    await prisma.aiDraft.update({where:{id:searchDraft.id},data:{reviewStatus:"REJECTED"}});
    const filteredOverview = await html("src/app/workspace/campaigns/[campaignId]/page.tsx", campaignA, {q:"foreign_source",sort:"oldest",view:"list"});
    assert(!filteredOverview.includes("@ui_shared_source") && filteredOverview.includes("No sources match your search."));
    assert(filteredOverview.includes("participation-flow"));
    assert(!filteredOverview.includes('aria-label="Auto-send"') && !filteredOverview.includes("Enable Telegram publishing"), "Overview must only manage sources and destination");
    const dashboard = await html("src/app/workspace/campaigns/page.tsx");
    assert(dashboard.includes("أخبار المدينة") && dashboard.includes("International news"));
    assert(dashboard.split("</article>").some(article => article.includes("International news") && article.includes("1 pending review")));
    assert(!dashboard.includes('>Apply</button>') && !dashboard.includes('name="sort"') && dashboard.includes('sort-control'));
    assert(!dashboard.includes("News Review")); assert(dashboard.includes("Users"));
    const pageA = await html("src/app/workspace/campaigns/[campaignId]/drafts/page.tsx");
    const pageB = await html("src/app/workspace/campaigns/[campaignId]/drafts/page.tsx", campaignB, {sort:"oldest"});
    assert(pageA.includes("نص نهائي محفوظ") && !pageA.includes("The public library reopened"));
    assert(pageB.includes("Save draft") && pageB.includes('aria-label="Reject draft"') && !pageB.includes("Approve &amp; send"));
    assert(pageB.includes("The public library reopened") && !pageB.includes("نص نهائي محفوظ"));
    const publishingPage = await html("src/app/workspace/campaigns/[campaignId]/page.tsx");
    assert(publishingPage.includes("Verified") && publishingPage.includes("ui_output_arabic"));
    await prisma.campaignPublishingSettings.update({ where: { campaignId: campaignA }, data: { verificationPending: true } });
    assert((await html("src/app/workspace/campaigns/[campaignId]/page.tsx")).includes("Pending"));
    await prisma.campaignPublishingSettings.update({ where: { campaignId: campaignA }, data: { verificationPending: false, verificationError: "Mock account cannot post here" } });
    assert((await html("src/app/workspace/campaigns/[campaignId]/page.tsx")).includes("Mock account cannot post here"));
    await prisma.campaignPublishingSettings.update({ where: { campaignId: campaignA }, data: { verificationError: null } });
    const sourcesPage = await html("src/app/workspace/campaigns/[campaignId]/page.tsx");
    assert(sourcesPage.includes("Workspace monitoring") && sourcesPage.includes("participation"));
    for (const [path, target] of [["ai-drafts", "/drafts"], ["ai-settings", "/settings"], ["publishing", ""]]) await assert.rejects(html(`src/app/workspace/${path}/page.tsx`), new RegExp(`REDIRECT:/workspace/campaigns/${defaultCampaign.id}${target}$`));
    for (const [path, target] of [["ai-drafts", "/drafts"], ["ai-settings", "/settings"], ["sources", ""], ["publishing", ""]]) await assert.rejects(html(`src/app/workspace/campaigns/[campaignId]/${path}/page.tsx`), new RegExp(`REDIRECT:/workspace/campaigns/${campaignA}${target}$`));
    await assert.rejects(html("src/app/workspace/campaigns/[campaignId]/page.tsx", "forged-id"), /NOT_FOUND/);
    await prisma.user.create({ data: { id: "foreign-user", name: "Foreign", email: "foreign-ui@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
    await prisma.workspace.create({ data: { id: "foreign-ui", ownerId: "foreign-user", name: "Foreign", automationEnabled: true, rssEnabled: true } });
    const foreignSource = await prisma.sourceChannel.create({ data: { workspaceId: "foreign-ui", username: "foreign_source" } });
    assert.equal((await management.changeCampaignSource(initial, form({ campaignId: campaignA, sourceId: foreignSource.id, intent: "join" }))).success, false);
    fixture.userId = "foreign-user";
    assert.equal((await management.deleteEmptyCampaign(initial, form({campaignId:campaignA,confirmed:"yes"}))).success, false);
    assert.equal((await management.changeCampaignSource(initial, form({ campaignId: campaignA, sourceId: source.id, intent: "resume", revision: "1" }))).success, false);
    assert.equal((await management.renameCampaign(initial, form({ campaignId: campaignA, name: "foreign", updatedAt: originalCampaign.updatedAt.toISOString() }))).success, false);
    assert.equal((await publishing.saveCampaignPublishingSettings(initial, form({ campaignId: campaignA, revision: "1", destination: "foreign_output", enabled: "on" }))).success, false);
    assert.equal((await publishing.recoverCampaignTelegramPublication(initial, form({ campaignId: campaignA, publicationId: claim.id, intent: "existing", messageId: "42" }))).success, false);
    await assert.rejects(html("src/app/workspace/campaigns/[campaignId]/page.tsx", campaignA), /NOT_FOUND/);
    assert(!(await html("src/app/workspace/campaigns/page.tsx")).includes("أخبار المدينة"));
    fixture.userId = "publishing-user";
    const entry = await load<{getCurrentAccess: () => Promise<unknown>; getEntryDestination: (access: unknown) => string}>("src/lib/access.ts");
    assert.equal(entry.getEntryDestination(await entry.getCurrentAccess()), "/workspace/campaigns");
    assert.equal(entry.getEntryDestination(null), "/login");
    const deniedForms = [
      () => management.createCampaignAction(initial, form({ name: "Denied" })),
      () => management.deleteEmptyCampaign(initial, form({campaignId:campaignA,confirmed:"yes"})),
      () => change(campaignA, "pause"),
      () => ai.saveCampaignAiSettings({ ...initial, revision: 4 }, aiForm(campaignA, 4)),
      () => publishing.recoverCampaignTelegramPublication(initial, form({ campaignId: claimCampaign, publicationId: claim.id, intent: "existing", messageId: "42" })),
    ];
    await prisma.user.update({ where: { id: fixture.userId }, data: { approvalStatus: "SUSPENDED" } });
    assert.equal(entry.getEntryDestination(await entry.getCurrentAccess()), "/account-status");
    for (const action of deniedForms) await assert.rejects(action(), /REDIRECT:\/account-status/);
    await assert.rejects(html("src/app/workspace/campaigns/page.tsx"), /REDIRECT:\/account-status/);
    await prisma.user.update({ where: { id: fixture.userId }, data: { approvalStatus: "APPROVED" } });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: false } });
    assert.equal(entry.getEntryDestination(await entry.getCurrentAccess()), "/workspace/sources");
    for (const action of deniedForms) await assert.rejects(action(), /REDIRECT:\/workspace\/sources/);
    await assert.rejects(html("src/app/workspace/campaigns/page.tsx"), /REDIRECT:\/workspace\/sources/);
    await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: true } });
    console.log("PASS: dashboard/pages scope data, legacy GET redirects preserve Default, foreign/forged IDs fail, suspended and RSS-only users cannot mutate campaigns.");
    await mkdir(".campaign-ui-validation", { recursive: true });
    const document = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>${body}</body></html>`;
    assert(pageA.includes('readOnly=""') && pageA.includes("View published message"), "Published drafts must be read-only with the confirmed link");
    const pages = { dashboard, drafts: pageA,
      "dashboard-list": await html("src/app/workspace/campaigns/page.tsx",campaignA,{view:"list"}),
      compare: await html("src/app/workspace/campaigns/[campaignId]/drafts/page.tsx",campaignA,{view:"compare"}),
      overview: await html("src/app/workspace/campaigns/[campaignId]/page.tsx"),
      settings: await html("src/app/workspace/campaigns/[campaignId]/settings/page.tsx"),
      empty: await html("src/app/workspace/campaigns/[campaignId]/drafts/page.tsx", defaultCampaign.id) };
    const manySources = await prisma.sourceChannel.createManyAndReturn({ data: Array.from({ length: 35 }, (_, i) => ({ workspaceId, username: `many_source_${i}`, title: i % 2 ? `مصدر الأخبار ${i}` : `News source ${i}` })) });
    for (let i = 0; i < manySources.length; i++) await prisma.$transaction(tx => setCampaignMembership(tx, workspaceId, campaignA, manySources[i].id, i % 2 === 0));
    const manyOverview = await html("src/app/workspace/campaigns/[campaignId]/page.tsx");
    const emptyOverview = await html("src/app/workspace/campaigns/[campaignId]/page.tsx", campaignA, { q: "no_match_source" });
    for (const [name, body] of Object.entries({ ...pages, "overview-many": manyOverview, "overview-empty": emptyOverview })) await writeFile(`.campaign-ui-validation/${name}.html`, document(body));
    const raceCampaign = (await management.createCampaignAction(initial,form({name:"Concurrent fixture"}))).campaignId!;
    const racePost = await prisma.originalPost.create({data:{workspaceId,sourceChannelId:source.id,telegramChatId:source.telegramChatId!,telegramMessageId:999,originalText:"Concurrent ingestion fixture",publishedAt:new Date(0)}});
    const concurrent = new Client({connectionString}); await concurrent.connect();
    try {
      await concurrent.query(`SET search_path TO "${schema}"`);
      await concurrent.query("BEGIN");
      await concurrent.query('SELECT id FROM workspace WHERE id = $1 FOR UPDATE',[workspaceId]);
      // Start the actual deletion action while ingestion holds the shared workspace lock.
      let finished = false;
      const deletion = management.deleteEmptyCampaign(initial,form({campaignId:raceCampaign,confirmed:"yes"})).then(result=>{finished=true;return result;});
      await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(finished,false);
      await concurrent.query(`INSERT INTO processing_job (id,"workspaceId","originalPostId",type,"campaignId","updatedAt") VALUES ($1,$2,$3,'TELEGRAM_PREPARE',$4,now())`,["race-job",workspaceId,racePost.id,raceCampaign]);
      await concurrent.query("COMMIT");
      assert.equal((await deletion).success,false);
      assert.equal(await prisma.processingJob.count({where:{campaignId:raceCampaign}}),1);
      assert.equal(await prisma.campaign.count({where:{id:raceCampaign}}),1);
    } finally { await concurrent.query("ROLLBACK"); await concurrent.end(); }
    const emptyRace = (await management.createCampaignAction(initial,form({name:"Concurrent empty"}))).campaignId!;
    const results = await Promise.all([management.deleteEmptyCampaign(initial,form({campaignId:emptyRace,confirmed:"yes"})),management.changeCampaignSource(initial,form({campaignId:emptyRace,sourceId:source.id,intent:"join"}))]);
    assert.equal(results.filter(r=>r.success).length,1,"Concurrent deletion and participation cannot both succeed");
    console.log("PASS: empty-only deletion, Default/history/ownership protection, search before pagination and concurrent ingestion/membership serialization.");
    console.log("PASS: actual page rendering, Arabic drafts, empty states and feedback surfaces; synthetic HTML fixtures prepared for browser checks.");
  } finally {
    await prisma.$disconnect(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
    if (previousWorkspace === undefined) delete process.env.INGEST_WORKSPACE_ID; else process.env.INGEST_WORKSPACE_ID = previousWorkspace;
    if (previousSecret === undefined) delete process.env.INGEST_READER_SECRET; else process.env.INGEST_READER_SECRET = previousSecret;
  }
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : "Campaign UI check failed; disposable data only."); if (error && typeof error === "object" && "message" in error) console.error(String(error.message)); console.error(error instanceof Error ? error.stack?.split("\n").filter(line => line.trim().startsWith("at ")).join("\n") : ""); process.exitCode = 1; });
