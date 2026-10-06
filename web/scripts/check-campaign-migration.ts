// Apply historical migrations, seed legacy history, then apply only the new
// campaign migration in a disposable schema. Never migrate the main schema.
import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { processTelegramJob } from "./telegram-processing";
import { claimPublication, queuePublication, recordPublicationResult } from "../src/lib/publishing-db";

loadEnvConfig(process.cwd());
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be configured.");
const schema = `campaign_check_${randomUUID().replaceAll("-", "")}`;
const migrationName = "20261006150000_campaign_foundation";
const admin = new Client({ connectionString });
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
const previousWorkspace = process.env.INGEST_WORKSPACE_ID;
const workspaceId = "campaign-workspace-a";
const tables = ["user", "workspace", "source_channel", "original_post", "processing_job", "ai_draft", "telegram_publication", "workspace_ai_settings", "workspace_publishing_settings", "rss_feed", "rss_item"];
let sequence = 1;
let campaignsApplied = false;
type LegacyDraft = { id: string; workspaceId: string; originalPostId: string; finalText: string; editRevision: number };
type Row = Record<string, unknown>;
async function snapshot() {
  const result: Record<string, Row[]> = {};
  for (const table of tables) result[table] = (await admin.query<{ row: Row }>(`SELECT to_jsonb(t) - 'campaignId' AS row FROM "${table}" t ORDER BY (to_jsonb(t) - 'campaignId')::text`)).rows.map(r => r.row);
  return result;
}
async function protections() {
  const indexes = await admin.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'telegram_publication' ORDER BY indexname`, [schema]);
  const triggers = await admin.query(`SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition, pg_get_functiondef(p.oid) AS function
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid WHERE n.nspname = $1 AND c.relname = 'telegram_publication' AND NOT t.tgisinternal ORDER BY t.tgname`, [schema]);
  return { indexes: indexes.rows, triggers: triggers.rows };
}
async function rejectSql(sql: string, values: unknown[], code: string) {
  await assert.rejects(admin.query(sql, values), e => Boolean(e && typeof e === "object" && "code" in e && e.code === code));
}
async function original(sourceChannelId = "campaign-source-on", ws = workspaceId) {
  return db.originalPost.create({ data: { workspaceId: ws, sourceChannelId, telegramChatId: "-10055555", telegramMessageId: sequence++, originalText: "Synthetic original", publishedAt: new Date(0), receivedAt: new Date() } });
}
async function draft(sourceChannelId = "campaign-source-on", ws = workspaceId) {
  const post = await original(sourceChannelId, ws);
  if (campaignsApplied) return db.aiDraft.create({ data: { workspaceId: ws, originalPostId: post.id, aiText: "Synthetic rewrite", finalText: "Saved approved synthetic text", model: "fixture", effectivePrompt: "Fixture prompt", settingsRevision: 7, editRevision: 3, reviewStatus: "APPROVED" } });
  // Raw legacy inserts also work if the operator already generated a newer
  // client that would otherwise SELECT the not-yet-created campaignId column.
  return (await admin.query<LegacyDraft>(`INSERT INTO ai_draft (id, "workspaceId", "originalPostId", "aiText", "finalText", model, "effectivePrompt", "settingsRevision", "editRevision", "reviewStatus")
    VALUES ($1, $2, $3, 'Synthetic rewrite', 'Saved approved synthetic text', 'fixture', 'Fixture prompt', 7, 3, 'APPROVED') RETURNING *`, [randomUUID(), ws, post.id])).rows[0];
}
async function main() {
  await admin.connect();
  let created = false;
  try {
    const mainBefore = (await admin.query(`SELECT to_regclass('public.campaign')::text AS campaign,
      (SELECT jsonb_agg(migration_name ORDER BY migration_name) FROM public._prisma_migrations) AS migrations`)).rows;
    await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
    await admin.query(`SET search_path TO "${schema}"`);
    const migrations = (await readdir("prisma/migrations", { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
    assert.equal(migrations.at(-1), migrationName, "Update this staged check before adding a subsequent migration.");
    for (const name of migrations.filter(name => name !== migrationName)) await admin.query(await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"));
    for (const [suffix, approval] of [["a", "APPROVED"], ["b", "SUSPENDED"], ["empty", "PENDING"]] as const) {
      await db.user.create({ data: { id: `campaign-user-${suffix}`, name: "Campaign fixture", email: `campaign-${suffix}@example.invalid`, emailVerified: true, approvalStatus: approval } });
      await db.workspace.create({ data: { id: `campaign-workspace-${suffix}`, name: "Campaign fixture", ownerId: `campaign-user-${suffix}`, automationEnabled: suffix === "a", rssEnabled: suffix !== "empty" } });
    }
    for (const [id, ws, automation, monitoring] of [
      ["campaign-source-on", workspaceId, true, true], ["campaign-source-paused", workspaceId, true, false],
      ["campaign-source-off", workspaceId, false, true], ["campaign-source-foreign", "campaign-workspace-b", false, true],
    ] as const) await db.sourceChannel.create({ data: { id, workspaceId: ws, username: id.replaceAll("-", "_"), telegramAutomationEnabled: automation, enabled: monitoring } });
    await db.workspaceAiSettings.create({ data: { workspaceId, enabled: true, systemPrompt: "Existing fixture prompt", editorialPerspective: "Saved perspective", revision: 7, activatedAt: new Date(0) } });
    await db.workspacePublishingSettings.create({ data: { workspaceId, enabled: true, destinationUsername: "campaign_output", destinationChatId: "-10099999", revision: 9, verifiedAt: new Date(0) } });
    await db.rssFeed.create({ data: { id: "campaign-rss-feed", workspaceId, sourceChannelId: "campaign-source-on", enabled: true, tokenHash: "synthetic-rss-hash", headerText: "Existing RSS header", removeKeywords: ["fixture"] } });
    const history = [];
    for (const status of ["QUEUED", "SENDING", "PUBLISHED", "FAILED", "DELIVERY_UNKNOWN"] as const) {
      const d = await draft();
      const p = await db.telegramPublication.create({ data: { workspaceId, draftId: d.id, draftRevision: 3, text: d.finalText,
        destinationChatId: "-10099999", destinationUsername: "campaign_output", destinationRevision: 9, randomId: String(100000 + sequence), status,
        lockToken: `synthetic-${status}`, lockedUntil: new Date(Date.now() + 120000), dispatchedAt: new Date(0),
        ...(status === "PUBLISHED" ? { confirmedChatId: "-10099999", telegramMessageId: 42, publishedAt: new Date(1000) } : {}),
        ...(status === "DELIVERY_UNKNOWN" ? { recoveryMessageId: 43, recoveryNote: "Existing recovery request", lastError: "Synthetic uncertainty" } : {}) } });
      history.push(p);
    }
    // Previous failed revision followed by a published revision on the same draft.
    const published = history.find(p => p.status === "PUBLISHED")!;
    await db.telegramPublication.create({ data: { workspaceId, draftId: published.draftId, draftRevision: 1, text: "Earlier saved snapshot", destinationChatId: "-10088888", destinationUsername: "old_output", destinationRevision: 2, randomId: "99999", status: "FAILED", lastError: "Existing failure" } });
    for (const status of ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"] as const) {
      const post = await original(status === "CANCELLED" ? "campaign-source-off" : "campaign-source-on");
      for (const type of ["TELEGRAM_PREPARE", "RSS_PREPARE"] as const) await admin.query(`INSERT INTO processing_job (id, "workspaceId", "originalPostId", type, status, attempts, "lockToken", "lockedUntil", outcome, "lastError")
        VALUES ($1, $2, $3, $4, $5, 2, $6, $7, $8, 'Saved job history')`, [randomUUID(), workspaceId, post.id, type, status, `synthetic-${type}-${status}`, new Date(1000), status === "COMPLETED" ? "DRAFT_CREATED" : null]);
      if (status === "COMPLETED") await admin.query(`INSERT INTO ai_draft (id, "workspaceId", "originalPostId", "aiText", "finalText", "reviewStatus", model, "effectivePrompt", "settingsRevision")
        VALUES ($1, $2, $3, 'Old AI text', 'Manually edited final text', 'REJECTED', 'fixture', 'Original prompt', 7)`, [randomUUID(), workspaceId, post.id]);
    }
    const foreign = await draft("campaign-source-foreign", "campaign-workspace-b");
    for (const type of ["TELEGRAM_PREPARE", "RSS_PREPARE"] as const) await admin.query(`INSERT INTO processing_job (id, "workspaceId", "originalPostId", type)
      VALUES ($1, $2, $3, $4)`, [randomUUID(), foreign.workspaceId, foreign.originalPostId, type]);
    const pending = await draft("campaign-source-paused");
    await admin.query(`UPDATE ai_draft SET "reviewStatus" = 'PENDING_REVIEW' WHERE id = $1`, [pending.id]);
    const publishedOriginal = (await admin.query<{ originalPostId: string }>(`SELECT "originalPostId" FROM ai_draft WHERE id = $1`, [published.draftId])).rows[0].originalPostId;
    await db.rssItem.create({ data: { workspaceId, feedId: "campaign-rss-feed", originalPostId: publishedOriginal, title: "Saved RSS title", content: "Edited RSS history", publishedAt: new Date(0), visible: false } });
    const before = await snapshot(); const priorProtections = await protections();
    await admin.query(await readFile(`prisma/migrations/${migrationName}/migration.sql`, "utf8"));
    campaignsApplied = true;
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await protections(), priorProtections);
    const campaigns = (await admin.query(`SELECT * FROM campaign ORDER BY "workspaceId"`)).rows;
    assert.equal(campaigns.length, 3);
    for (const campaign of campaigns) { assert.equal(campaign.name, "Default"); assert.equal(campaign.isDefault, true); assert.equal(campaign.id, `campaign_default_${campaign.workspaceId}`); }
    const memberships = (await admin.query(`SELECT c."workspaceId", c."sourceChannelId", c."telegramAutomationEnabled", s."telegramAutomationEnabled" AS original
      FROM campaign_source c JOIN source_channel s ON s.id = c."sourceChannelId" ORDER BY s.id`)).rows;
    assert.equal(memberships.length, 4); for (const membership of memberships) assert.equal(membership.telegramAutomationEnabled, membership.original);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM ai_draft d JOIN campaign c ON (c.id, c."workspaceId") = (d."campaignId", d."workspaceId") WHERE c."isDefault"`)).rows[0].count, before.ai_draft.length);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM processing_job WHERE type = 'TELEGRAM_PREPARE' AND "campaignId" IS NULL`)).rows[0].count, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM processing_job j JOIN campaign c ON (c.id, c."workspaceId") = (j."campaignId", j."workspaceId") WHERE j.type = 'TELEGRAM_PREPARE' AND c."isDefault"`)).rows[0].count, before.processing_job.filter(j => j.type === "TELEGRAM_PREPARE").length);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM processing_job WHERE type = 'RSS_PREPARE' AND "campaignId" IS NOT NULL`)).rows[0].count, 0);
    console.log("PASS: populated legacy migration preserves every prior field, all publication states/receipts/settings/RSS, and publication indexes/triggers; Default/membership/draft/Telegram-job backfill is correct.");

    const defaultId = `campaign_default_${workspaceId}`;
    const foreignId = "campaign_default_campaign-workspace-b";
    await admin.query(`INSERT INTO campaign (id, "workspaceId", name) VALUES ('second-campaign', $1, 'Second')`, [workspaceId]);
    await admin.query(`INSERT INTO campaign_source ("campaignId", "sourceChannelId", "workspaceId") VALUES ('second-campaign', 'campaign-source-on', $1)`, [workspaceId]);
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM campaign_source WHERE "sourceChannelId" = 'campaign-source-on'`)).rows[0].count, 2);
    await rejectSql(`INSERT INTO campaign (id, "workspaceId", name, "isDefault") VALUES ('duplicate-default', $1, 'Default', true)`, [workspaceId], "23505");
    await rejectSql(`INSERT INTO campaign (id, "workspaceId", name) VALUES ('orphan-campaign', 'missing-workspace', 'Invalid')`, [], "23503");
    await rejectSql(`INSERT INTO campaign_source ("campaignId", "sourceChannelId", "workspaceId") VALUES ($1, 'campaign-source-on', $2)`, [defaultId, workspaceId], "23505");
    await rejectSql(`INSERT INTO campaign_source ("campaignId", "sourceChannelId", "workspaceId") VALUES ($1, 'campaign-source-on', $2)`, [foreignId, workspaceId], "23503");
    await rejectSql(`INSERT INTO campaign_source ("campaignId", "sourceChannelId", "workspaceId") VALUES ($1, 'campaign-source-foreign', $2)`, [defaultId, workspaceId], "23503");
    await rejectSql(`UPDATE ai_draft SET "campaignId" = 'second-campaign' WHERE id = $1`, [published.draftId], "P0001");
    await rejectSql(`UPDATE ai_draft SET "campaignId" = NULL WHERE id = $1`, [foreign.id], "P0001");
    await rejectSql(`UPDATE processing_job SET "campaignId" = $1 WHERE "workspaceId" = $2 AND type = 'TELEGRAM_PREPARE'`, [foreignId, workspaceId], "23503");
    await rejectSql(`UPDATE processing_job SET "campaignId" = $1 WHERE type = 'RSS_PREPARE'`, [defaultId], "23514");
    await rejectSql(`DELETE FROM campaign WHERE id = $1`, [defaultId], "23503");
    await rejectSql(`UPDATE telegram_publication SET text = 'Changed snapshot' WHERE id = $1`, [published.id], "P0001");
    await rejectSql(`UPDATE telegram_publication SET "randomId" = 'changed-request' WHERE id = $1`, [published.id], "P0001");
    await rejectSql(`INSERT INTO telegram_publication (id, "workspaceId", "draftId", "draftRevision", text, "destinationChatId", "destinationUsername", "destinationRevision", "randomId", status)
      SELECT 'duplicate-publication', "workspaceId", "draftId", 100, text, "destinationChatId", "destinationUsername", "destinationRevision", '123456789', 'QUEUED' FROM telegram_publication WHERE id = $1`, [published.id], "23505");
    await rejectSql(`INSERT INTO telegram_publication (id, "workspaceId", "draftId", "draftRevision", text, "destinationChatId", "destinationUsername", "destinationRevision", "randomId", status)
      SELECT 'duplicate-random', "workspaceId", "draftId", 101, text, "destinationChatId", "destinationUsername", "destinationRevision", "randomId", 'FAILED' FROM telegram_publication WHERE id = $1`, [published.id], "23505");
    await rejectSql(`INSERT INTO telegram_publication (id, "workspaceId", "draftId", "draftRevision", text, "destinationChatId", "destinationUsername", "destinationRevision", "randomId", status)
      SELECT 'duplicate-revision', "workspaceId", "draftId", "draftRevision", text, "destinationChatId", "destinationUsername", "destinationRevision", '987654321', 'FAILED' FROM telegram_publication WHERE id = $1`, [published.id], "23505");
    console.log("PASS: multiple same-workspace memberships, default/pair uniqueness, workspace foreign keys, RSS exclusion, immutable campaign lineage and all existing publication protections.");

    // Current application writers omit campaignId. They must still work.
    const legacyDraft = await draft();
    const legacyPost = await original();
    const legacyJob = await db.processingJob.create({ data: { workspaceId, originalPostId: legacyPost.id, type: "TELEGRAM_PREPARE" } });
    await db.processingJob.create({ data: { workspaceId, originalPostId: legacyPost.id, type: "RSS_PREPARE" } });
    assert.equal((await admin.query(`SELECT "campaignId" FROM ai_draft WHERE id = $1`, [legacyDraft.id])).rows[0].campaignId, null);
    assert.equal((await admin.query(`SELECT "campaignId" FROM processing_job WHERE id = $1`, [legacyJob.id])).rows[0].campaignId, null);
    await rejectSql(`UPDATE ai_draft SET "campaignId" = $1 WHERE id = $2`, [foreignId, legacyDraft.id], "23503");
    await admin.query(`UPDATE ai_draft SET "campaignId" = $1 WHERE id = $2`, [defaultId, legacyDraft.id]);
    await rejectSql(`INSERT INTO ai_draft (id, "workspaceId", "originalPostId", "campaignId", "aiText", "finalText", model, "effectivePrompt", "settingsRevision")
      SELECT 'duplicate-draft', "workspaceId", "originalPostId", 'second-campaign', "aiText", "finalText", model, "effectivePrompt", "settingsRevision" FROM ai_draft WHERE id = $1`, [legacyDraft.id], "23505");
    await rejectSql(`INSERT INTO processing_job (id, "workspaceId", "originalPostId", "campaignId", type)
      SELECT 'duplicate-job', "workspaceId", "originalPostId", 'second-campaign', type FROM processing_job WHERE id = $1`, [legacyJob.id], "23505");
    await db.processingJob.updateMany({ where: { type: "TELEGRAM_PREPARE", originalPostId: { not: legacyPost.id }, status: { in: ["PENDING", "PROCESSING"] } }, data: { availableAt: new Date(Date.now() + 86400000), lockedUntil: new Date(Date.now() + 86400000) } });
    process.env.INGEST_WORKSPACE_ID = workspaceId;
    await admin.query(`UPDATE campaign_source SET "telegramAutomationEnabled" = false WHERE "sourceChannelId" = 'campaign-source-on'`);
    assert(await processTelegramJob(db, async () => "Current runtime still prepares one synthetic draft."));
    const prepared = await db.aiDraft.findFirstOrThrow({ where: { originalPostId: legacyPost.id } });
    assert.equal((await admin.query(`SELECT "campaignId" FROM ai_draft WHERE id = $1`, [prepared.id])).rows[0].campaignId, null);
    await db.aiDraft.update({ where: { id: prepared.id }, data: { reviewStatus: "APPROVED" } });
    // Retained historical sending/unknown rows correctly prevent new dispatch.
    const queuedId = await queuePublication(db, workspaceId, prepared.id, prepared.editRevision);
    assert.equal(await claimPublication(db, workspaceId), null);
    const unknown = history.find(p => p.status === "DELIVERY_UNKNOWN")!;
    assert(await recordPublicationResult(db, workspaceId, { id: unknown.id, token: unknown.lockToken!, outcome: "published", chatId: unknown.destinationChatId, messageId: 43, publishedAt: new Date(2000).toISOString() }));
    const sending = history.find(p => p.status === "SENDING")!;
    assert(await recordPublicationResult(db, workspaceId, { id: sending.id, token: sending.lockToken!, outcome: "failed", error: "Synthetic definite rejection" }));
    const claimed = await claimPublication(db, workspaceId); assert(claimed);
    assert(await recordPublicationResult(db, workspaceId, { id: claimed.id, token: claimed.lockToken!, outcome: "published", chatId: claimed.destinationChatId, messageId: 44, publishedAt: new Date(3000).toISOString() }));
    assert.equal((await db.telegramPublication.findUniqueOrThrow({ where: { id: queuedId } })).status, "QUEUED");
    await db.user.create({ data: { id: "post-migration-user", name: "Legacy writer", email: "post-migration@example.invalid" } });
    await db.workspace.create({ data: { id: "post-migration-workspace", name: "Legacy writer", ownerId: "post-migration-user" } });
    await db.sourceChannel.create({ data: { workspaceId: "post-migration-workspace", username: "post_migration_source" } });
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM campaign WHERE "workspaceId" = 'post-migration-workspace'`)).rows[0].count, 0);
    console.log("PASS: unchanged runtime writers/AI preparation/publishing/receipt recording work with nullable references; old draft/job uniqueness remains; new workspace/source creation needs no campaign yet.");
    const mainAfter = (await admin.query(`SELECT to_regclass('public.campaign')::text AS campaign,
      (SELECT jsonb_agg(migration_name ORDER BY migration_name) FROM public._prisma_migrations) AS migrations`)).rows;
    assert.deepEqual(mainAfter, mainBefore);
    console.log("PASS: main schema campaign table/migration history unchanged; no Telegram calls or live receipt files accessed.");
  } finally {
    await admin.query("ROLLBACK"); // Clear a failed migration transaction before cleanup.
    await db.$disconnect();
    if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    if (previousWorkspace === undefined) delete process.env.INGEST_WORKSPACE_ID;
    else process.env.INGEST_WORKSPACE_ID = previousWorkspace;
  }
}
main().catch(() => { console.error("Campaign migration validation failed; main schema was not migrated."); process.exitCode = 1; });
