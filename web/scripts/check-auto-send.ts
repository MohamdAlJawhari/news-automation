// All writes are restricted to a randomly named disposable PostgreSQL schema.
import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createCampaign } from "../src/lib/campaign-settings";
import { setCampaignMembership } from "../src/lib/campaign-execution";
import { setAutoSend } from "../src/lib/auto-send";
import { processTelegramJob } from "./telegram-processing";
import { claimPublication, authorizePublication, queuePublication, recordPublicationResult, requestPublicationRecovery } from "../src/lib/publishing-db";

loadEnvConfig(process.cwd());
const schema = `auto_send_check_${randomUUID().replaceAll("-", "")}`;
const connectionString = process.env.DATABASE_URL!;
const admin = new Client({ connectionString });
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
const wid = "auto-workspace";
const prior = process.env.INGEST_WORKSPACE_ID;
process.env.INGEST_WORKSPACE_ID = wid;
let sequence = 1;
async function post(campaigns: string[], receivedAt?: Date) {
  // Strict future-only comparison excludes equal millisecond timestamps. Choose
  // fixture receipt times explicitly after activation rather than racing the clock.
  if (!receivedAt) receivedAt = (await db.$queryRaw<{ now: Date }[]>`SELECT GREATEST(timezone('UTC', clock_timestamp()),
    COALESCE(MAX("autoSendActivatedAt"), '1970-01-01'::timestamp) + interval '1 millisecond') AS now
    FROM campaign WHERE "workspaceId" = ${wid}`)[0].now;
  const original = await db.originalPost.create({ data: { workspaceId: wid, sourceChannelId: "source", telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Mock source", publishedAt: new Date(), receivedAt } });
  for (const campaignId of campaigns) await db.processingJob.create({ data: { workspaceId: wid, campaignId, originalPostId: original.id, type: "TELEGRAM_PREPARE" } });
  return original;
}
async function toggle(id: string, enabled: boolean, confirmed = true) {
  const c = await db.campaign.findUniqueOrThrow({ where: { id } });
  const s = await db.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: id } });
  return db.$transaction(tx => setAutoSend(tx, wid, id, enabled, c.autoSendRevision, s.revision, s.destinationChatId!, confirmed));
}
async function prepare(generate: () => Promise<string | null> = async () => "Mock rewrite") {
  assert(await processTelegramJob(db, generate));
}
async function draft(originalId: string, campaignId: string) {
  return db.aiDraft.findUniqueOrThrow({ where: { originalPostId_campaignId: { originalPostId: originalId, campaignId } }, include: { publications: true } });
}
async function main() {
  await admin.connect();
  try {
    const history = (await admin.query('SELECT migration_name, finished_at FROM public._prisma_migrations ORDER BY migration_name')).rows;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const m of (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort()) await admin.query(await readFile(`prisma/migrations/${m}/migration.sql`, "utf8"));
    await db.user.create({ data: { id: "owner", name: "Fixture", email: "auto@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
    await db.workspace.create({ data: { id: wid, ownerId: "owner", name: "Fixture", automationEnabled: true, rssEnabled: true } });
    await db.sourceChannel.create({ data: { id: "source", workspaceId: wid, username: "news_source_test" } });
    const ids: string[] = [];
    for (const name of ["Manual", "Automatic"]) {
      const c = await db.$transaction(tx => createCampaign(tx, wid, name)); ids.push(c.campaign.id);
      assert.equal(c.campaign.autoSendEnabled, false);
      await db.$transaction(tx => setCampaignMembership(tx, wid, c.campaign.id, "source", true));
      await db.campaignAiSettings.update({ where: { campaignId: c.campaign.id }, data: { enabled: true, activatedAt: new Date(0) } });
      await db.campaignPublishingSettings.update({ where: { campaignId: c.campaign.id }, data: { enabled: true, destinationUsername: "news_output_test", destinationChatId: "-10012345", verifiedAt: new Date() } });
    }
    const [manual, automatic] = ids;
    const existingManual = await post([automatic]); await prepare();
    const old = await post([automatic]);
    await assert.rejects(toggle(automatic, true, false));
    await db.campaignAiSettings.update({ where: { campaignId: automatic }, data: { enabled: false } });
    await assert.rejects(toggle(automatic, true));
    await db.campaignAiSettings.update({ where: { campaignId: automatic }, data: { enabled: true } });
    await db.campaignPublishingSettings.update({ where: { campaignId: automatic }, data: { enabled: false } });
    await assert.rejects(toggle(automatic, true));
    await db.campaignPublishingSettings.update({ where: { campaignId: automatic }, data: { enabled: true, verificationPending: true } });
    await assert.rejects(toggle(automatic, true));
    await db.campaignPublishingSettings.update({ where: { campaignId: automatic }, data: { verificationPending: false } });
    const first = await toggle(automatic, true);
    assert.equal((await draft(existingManual.id, automatic)).publications.length, 0);
    await prepare(); assert.equal((await draft(old.id, automatic)).publications.length, 0);
    const historical = await post([automatic], new Date(first.autoSendActivatedAt!.getTime() - 1));
    await prepare(); assert.equal((await draft(historical.id, automatic)).publications.length, 0);
    const shared = await post(ids);
    await Promise.all([prepare(), prepare()]);
    assert.equal((await draft(shared.id, manual)).reviewStatus, "PENDING_REVIEW");
    const auto = await draft(shared.id, automatic);
    assert.equal(auto.approvalMode, "AUTOMATIC"); assert.equal(auto.publications.length, 1);
    assert.equal(auto.publications[0].deliveryMode, "AUTOMATIC");
    assert.equal(await processTelegramJob(db, async () => { throw new Error("Unexpected duplicate generation"); }), false);
    await toggle(automatic, false);
    assert.equal((await draft(shared.id, automatic)).publications[0].status, "FAILED");
    assert.equal(await claimPublication(db, wid), null);
    // Deliberate manual retry preserves the exact snapshot and random ID.
    await queuePublication(db, wid, auto.id, 1, automatic);
    const manualClaim = await claimPublication(db, wid); assert(manualClaim);
    assert.equal(manualClaim.randomId, auto.publications[0].randomId); assert.equal(manualClaim.deliveryMode, "MANUAL");
    assert(await db.$transaction(tx => authorizePublication(tx, wid, manualClaim.id, manualClaim.lockToken!)));
    await recordPublicationResult(db, wid, { id: manualClaim.id, token: manualClaim.lockToken!, outcome: "published", chatId: manualClaim.destinationChatId, messageId: 1, publishedAt: new Date().toISOString() });
    const second = await toggle(automatic, true); assert(second.autoSendGeneration > first.autoSendGeneration);
    // OFF -> ON during a network generation must preserve a manual draft.
    const stale = await post([automatic]);
    await prepare(async () => { await toggle(automatic, false); await toggle(automatic, true); return "Stale rewrite"; });
    assert.equal((await draft(stale.id, automatic)).publications.length, 0);
    assert.match((await draft(stale.id, automatic)).manualAttentionReason!, /earlier/);
    const disabled = await post([automatic]);
    await prepare(async () => { await toggle(automatic, false); return "Prepared while disabled"; });
    assert.equal((await draft(disabled.id, automatic)).reviewStatus, "PENDING_REVIEW");
    await toggle(automatic, true);
    const changedDestination = await post([automatic]);
    await prepare(async () => { await db.campaignPublishingSettings.update({ where: { campaignId: automatic }, data: { revision: { increment: 1 }, destinationChatId: "-10098765" } }); return "Changed destination"; });
    assert.match((await draft(changedDestination.id, automatic)).manualAttentionReason!, /destination/);
    const claimedPost = await post([automatic]); await prepare();
    const claimed = await claimPublication(db, wid); assert(claimed);
    await toggle(automatic, false);
    assert.equal(await db.$transaction(tx => authorizePublication(tx, wid, claimed.id, claimed.lockToken!)), false);
    await recordPublicationResult(db, wid, { id: claimed.id, token: claimed.lockToken!, outcome: "paused" });
    await toggle(automatic, true);
    assert.equal(await claimPublication(db, wid), null);
    // Human edits and decisions introduced during generation are never overwritten.
    const edited = await post([automatic]);
    await prepare(async () => { await db.aiDraft.create({ data: { workspaceId: wid, campaignId: automatic, originalPostId: edited.id, aiText: "Human fixture", finalText: "Human edit", model: "mock", effectivePrompt: "mock", settingsRevision: 1, editRevision: 2, reviewStatus: "REJECTED" } }); return "Do not overwrite"; });
    assert.equal((await draft(edited.id, automatic)).finalText, "Human edit"); assert.equal((await draft(edited.id, automatic)).reviewStatus, "REJECTED");
    // Access/membership revocation before dispatch pauses authorization.
    const accessPost = await post([automatic]); await prepare();
    const accessClaim = await claimPublication(db, wid); assert(accessClaim);
    await db.workspace.update({ where: { id: wid }, data: { automationEnabled: false } });
    assert.equal(await db.$transaction(tx => authorizePublication(tx, wid, accessClaim.id, accessClaim.lockToken!)), false);
    await db.workspace.update({ where: { id: wid }, data: { automationEnabled: true } });
    await db.$transaction(tx => setCampaignMembership(tx, wid, automatic, "source", false));
    assert.equal(await db.$transaction(tx => authorizePublication(tx, wid, accessClaim.id, accessClaim.lockToken!)), false);
    await db.$transaction(tx => setCampaignMembership(tx, wid, automatic, "source", true));
    await db.user.update({ where: { id: "owner" }, data: { approvalStatus: "SUSPENDED" } });
    assert.equal(await db.$transaction(tx => authorizePublication(tx, wid, accessClaim.id, accessClaim.lockToken!)), false);
    await db.user.update({ where: { id: "owner" }, data: { approvalStatus: "APPROVED" } });
    assert(await db.$transaction(tx => authorizePublication(tx, wid, accessClaim.id, accessClaim.lockToken!)));
    await toggle(automatic, false);
    await recordPublicationResult(db, wid, { id: accessClaim.id, token: accessClaim.lockToken!, outcome: "unknown" });
    assert.equal(await claimPublication(db, wid), null);
    await db.$transaction(tx => requestPublicationRecovery(tx, wid, automatic, accessClaim.id, "existing", 8, false));
    const receipt = { id: accessClaim.id, token: accessClaim.lockToken!, outcome: "published" as const, chatId: accessClaim.destinationChatId, messageId: 8, publishedAt: new Date().toISOString() };
    assert(await recordPublicationResult(db, wid, receipt)); assert(await recordPublicationResult(db, wid, receipt));
    assert.equal((await draft(accessPost.id, automatic)).publications[0].status, "PUBLISHED");
    // Optimistic revision guards reject concurrent double clicks.
    const c = await db.campaign.findUniqueOrThrow({ where: { id: automatic } });
    const s = await db.campaignPublishingSettings.findUniqueOrThrow({ where: { campaignId: automatic } });
    const clicks = await Promise.allSettled([1, 2].map(() => db.$transaction(tx => setAutoSend(tx, wid, automatic, true, c.autoSendRevision, s.revision, s.destinationChatId!, true))));
    assert.equal(clicks.filter(x => x.status === "fulfilled").length, 1);
    // Manual queues in another campaign survive Auto-send disablement.
    const manualDraft = await draft(shared.id, manual);
    await db.aiDraft.update({ where: { id: manualDraft.id }, data: { reviewStatus: "APPROVED", approvalMode: "MANUAL" } });
    const manualId = await queuePublication(db, wid, manualDraft.id, 1, manual);
    await toggle(automatic, false);
    assert.equal((await db.telegramPublication.findUniqueOrThrow({ where: { id: manualId } })).status, "QUEUED");
    const otherClaim = await claimPublication(db, wid); assert.equal(otherClaim!.id, manualId);
    await recordPublicationResult(db, wid, { id: otherClaim!.id, token: otherClaim!.lockToken!, outcome: "published", chatId: otherClaim!.destinationChatId, messageId: 9, publishedAt: new Date().toISOString() });
    // Database failure at queue creation rolls approval and draft insertion back.
    await toggle(automatic, true);
    const retryPost = await post([automatic]);
    await admin.query(`CREATE FUNCTION fail_fixture_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Mock queue failure'; END $$; CREATE TRIGGER fail_fixture_queue BEFORE INSERT ON telegram_publication FOR EACH ROW EXECUTE FUNCTION fail_fixture_queue()`);
    await prepare();
    assert.equal(await db.aiDraft.count({ where: { originalPostId: retryPost.id } }), 0);
    await admin.query('DROP TRIGGER fail_fixture_queue ON telegram_publication; DROP FUNCTION fail_fixture_queue()');
    await db.processingJob.updateMany({ where: { originalPostId: retryPost.id }, data: { availableAt: new Date() } });
    await prepare();
    assert.equal((await draft(retryPost.id, automatic)).publications.length, 1);
    assert.deepEqual((await admin.query('SELECT migration_name, finished_at FROM public._prisma_migrations ORDER BY migration_name')).rows, history);
    assert.equal((await draft(claimedPost.id, automatic)).publications[0].status, "FAILED");
    console.log("PASS: Auto-send future boundaries, generations, mixed campaigns, atomic queue, manual retry, stale results, edits, revocation, receipts and recovery.");
  } finally {
    process.env.INGEST_WORKSPACE_ID = prior;
    await db.$disconnect(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
