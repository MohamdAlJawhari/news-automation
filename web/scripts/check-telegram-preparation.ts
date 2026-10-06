// Integration checks use a disposable PostgreSQL schema and synthetic posts.
// Generation is mocked unless --ollama is supplied. No Telegram requests occur.
import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { Client } from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { processTelegramJob } from "./telegram-processing";
import { validateOllamaResponse, PreparationError, OUTPUT_TOKENS } from "../src/lib/ai-config";
import { BASE_AI_PROMPT } from "../src/lib/ai-prompt";
import { rewriteWithOllama } from "../src/lib/ollama";
import { checkAiActions } from "./ai-action-checks";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
const schema = `ai_check_${randomUUID().replaceAll("-", "")}`;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be configured.");
const admin = new Client({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c search_path=${schema}` }, { schema }) });
const oldWorkspace = process.env.INGEST_WORKSPACE_ID;
const workspaceId = "ai-fixture-workspace";
const userId = "ai-fixture-user";
let messageId = 1;
const activation = new Date(Date.now() - 60000);
process.env.INGEST_WORKSPACE_ID = workspaceId;
const fixtureRssScript = `scripts/.${schema}-rss.ts`;

async function post(receivedAt = new Date(), publishedAt = new Date(0)) {
  const original = await prisma.originalPost.create({ data: {
    workspaceId, sourceChannelId: "ai-fixture-source", telegramChatId: "-10012345",
    telegramMessageId: messageId++, originalText: "According to the city council, the library reopened on Monday.",
    receivedAt, publishedAt,
  } });
  return prisma.processingJob.create({ data: { workspaceId, originalPostId: original.id, type: "TELEGRAM_PREPARE" } });
}
async function checkNoDraft(job: { id: string; originalPostId: string }) {
  assert.equal(await prisma.aiDraft.count({ where: { originalPostId: job.originalPostId } }), 0);
  const state = await prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(state.status, "PENDING"); assert.equal(state.attempts, 0);
}
async function runRssFixture() {
  // Execute the existing RSS worker unchanged except its adapter's test schema.
  const source = await readFile("scripts/rss-worker.ts", "utf8");
  assert(source.includes("adapter: new PrismaPg({ connectionString })"));
  await writeFile(fixtureRssScript, source.replace("adapter: new PrismaPg({ connectionString })",
    `adapter: new PrismaPg({ connectionString, options: "-c search_path=${schema}" }, { schema: "${schema}" })`));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", fixtureRssScript, "--once"], { stdio: "pipe" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error("Isolated RSS worker failed.")));
  });
}

async function main() {
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const migrations = (await readdir("prisma/migrations", { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const migration of migrations) await admin.query(await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8"));
    await prisma.user.create({ data: { id: userId, name: "AI fixture", email: "ai-fixture@example.invalid", emailVerified: true, approvalStatus: "APPROVED" } });
    await prisma.workspace.create({ data: { id: workspaceId, ownerId: userId, name: "AI fixture", automationEnabled: true, rssEnabled: true } });
    await prisma.sourceChannel.create({ data: { id: "ai-fixture-source", workspaceId, username: "ai_fixture", telegramAutomationEnabled: true } });
    const initial = await prisma.workspaceAiSettings.create({ data: { workspaceId, systemPrompt: BASE_AI_PROMPT } });
    assert.equal(initial.enabled, false); assert.equal(initial.activatedAt, null);
    await prisma.workspaceAiSettings.update({ where: { workspaceId }, data: { enabled: true, activatedAt: activation } });
    const older = await post(new Date(activation.getTime() - 1), new Date());
    assert.equal(await processTelegramJob(prisma, async () => { throw new Error("Old post was generated."); }), false);
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: older.id } })).attempts, 0);
    const fresh = await post();
    await processTelegramJob(prisma, async () => "According to the council, the library reopened Monday.");
    let draft = await prisma.aiDraft.findUniqueOrThrow({ where: { originalPostId_workspaceId: { originalPostId: fresh.originalPostId, workspaceId } } });
    assert.equal(draft.reviewStatus, "PENDING_REVIEW"); assert.equal(draft.settingsRevision, 1);
    await prisma.aiDraft.update({ where: { id: draft.id }, data: { finalText: "Manual review text", editRevision: { increment: 1 } } });
    await prisma.processingJob.update({ where: { id: fresh.id }, data: { status: "PENDING" } });
    await processTelegramJob(prisma, async () => { throw new Error("Existing draft was regenerated."); });
    draft = await prisma.aiDraft.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(draft.finalText, "Manual review text");
    assert.equal((await prisma.aiDraft.updateMany({ where: { id: draft.id, editRevision: 1 }, data: { finalText: "Stale edit" } })).count, 0);
    console.log("PASS: receivedAt boundary, one draft, retained manual edits and stale edit rejection (real PostgreSQL).");

    const concurrent = await post();
    let calls = 0;
    const generate = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 50)); return "Concurrent fixture rewrite."; };
    await Promise.all([processTelegramJob(prisma, generate), processTelegramJob(prisma, generate)]);
    assert.equal(calls, 1); assert.equal(await prisma.aiDraft.count({ where: { originalPostId: concurrent.originalPostId } }), 1);

    const expired = await post();
    let entered!: () => void; const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const staleRun = processTelegramJob(prisma, async () => { entered(); await gate; return "Expired worker result."; });
    await enteredPromise;
    await prisma.processingJob.update({ where: { id: expired.id }, data: { lockedUntil: new Date(0) } });
    await processTelegramJob(prisma, async () => "Recovered worker result.");
    release(); await staleRun;
    assert.equal((await prisma.aiDraft.findFirstOrThrow({ where: { originalPostId: expired.originalPostId } })).aiText, "Recovered worker result.");
    const crash = await post();
    await prisma.processingJob.update({ where: { id: crash.id }, data: { status: "PROCESSING", lockToken: "crashed", lockedUntil: new Date(0), attempts: 5 } });
    await processTelegramJob(prisma);
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: crash.id } })).status, "FAILED");
    console.log("PASS: atomic concurrent claims, expired lease recovery, stale worker discard and exhausted crash recovery (real PostgreSQL, mocked generation).");

    for (const kind of ["suspended", "automation", "disabled", "revision", "revision-failure"] as const) {
      const job = await post();
      await processTelegramJob(prisma, async () => {
        if (kind === "suspended") await prisma.user.update({ where: { id: userId }, data: { approvalStatus: "SUSPENDED" } });
        if (kind === "automation") await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: false } });
        if (kind === "disabled") await prisma.workspaceAiSettings.update({ where: { workspaceId }, data: { enabled: false } });
        if (kind.startsWith("revision")) await prisma.workspaceAiSettings.update({ where: { workspaceId }, data: { revision: { increment: 1 } } });
        if (kind === "revision-failure") throw new PreparationError("Synthetic transient failure.");
        return "Must be discarded.";
      });
      await checkNoDraft(job);
      await prisma.user.update({ where: { id: userId }, data: { approvalStatus: "APPROVED" } });
      await prisma.workspace.update({ where: { id: workspaceId }, data: { automationEnabled: true } });
      await prisma.workspaceAiSettings.update({ where: { workspaceId }, data: { enabled: true } });
      assert.equal((await prisma.workspaceAiSettings.findUniqueOrThrow({ where: { workspaceId } })).activatedAt?.getTime(), activation.getTime());
    }
    const blocked = await post();
    await prisma.user.update({ where: { id: userId }, data: { approvalStatus: "SUSPENDED" } });
    assert.equal(await processTelegramJob(prisma, async () => { throw new Error("Suspended generation."); }), false);
    await checkNoDraft(blocked);
    await prisma.user.update({ where: { id: userId }, data: { approvalStatus: "APPROVED" } });
    await prisma.processingJob.update({ where: { id: blocked.id }, data: { availableAt: new Date(Date.now() + 3600000) } });
    console.log("PASS: suspension, disabled automation, pause/resume boundary and settings changes discard results without consuming attempts.");

    const skipped = await post();
    await processTelegramJob(prisma, async () => validateOllamaResponse({ done: true, done_reason: "stop", message: { role: "assistant", content: "  NO_NEWS_CONTENT\n", thinking: "Never use this as news." } }));
    assert.equal(await prisma.aiDraft.count({ where: { originalPostId: skipped.originalPostId } }), 0);
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: skipped.id } })).outcome, "SKIPPED_NO_NEWS_CONTENT");
    for (const invalid of [null, { done: false }, { done: true, done_reason: "length", message: { content: "partial" } },
      { done: true, done_reason: "stop", message: { role: "assistant", content: "", thinking: "news" } },
      { done: true, done_reason: "stop", message: { role: "assistant", content: "x".repeat(20001) } },
      { done: true, done_reason: "stop", eval_count: OUTPUT_TOKENS, message: { role: "assistant", content: "partial" } }]) {
      assert.throws(() => validateOllamaResponse(invalid));
    }
    assert.equal(validateOllamaResponse({ done: true, done_reason: "stop", message: { role: "assistant", content: "Final report.", thinking: "secret" } }), "Final report.");
    const retry = await post();
    await processTelegramJob(prisma, async () => { throw new PreparationError("Synthetic timeout."); });
    const retryState = await prisma.processingJob.findUniqueOrThrow({ where: { id: retry.id } });
    assert.equal(retryState.attempts, 1); assert.equal(retryState.status, "PENDING"); assert(retryState.availableAt > new Date());
    await prisma.processingJob.update({ where: { id: retry.id }, data: { availableAt: new Date(0), attempts: 4 } });
    await processTelegramJob(prisma, async () => { throw new PreparationError("Synthetic timeout."); });
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: retry.id } })).status, "FAILED");
    console.log("PASS: terminal no-news skip, response validation, thinking exclusion and bounded retries (mocked Ollama responses, real PostgreSQL).");

    await prisma.processingJob.create({ data: { workspaceId, originalPostId: fresh.originalPostId, type: "RSS_PREPARE" } });
    await runRssFixture();
    const rss = await prisma.rssItem.findFirstOrThrow({ where: { originalPostId: fresh.originalPostId } });
    assert.equal(rss.content, "According to the city council, the library reopened on Monday.");
    await prisma.rssItem.update({ where: { id: rss.id }, data: { content: "Manual RSS text." } });
    await prisma.processingJob.updateMany({ where: { originalPostId: fresh.originalPostId, type: "RSS_PREPARE" }, data: { status: "PENDING" } });
    await runRssFixture();
    assert.equal((await prisma.rssItem.findUniqueOrThrow({ where: { id: rss.id } })).content, "Manual RSS text.");
    console.log("PASS: existing RSS worker creates an independent item and preserves manual edits in isolated PostgreSQL schema.");

    await checkAiActions(prisma, draft.id, workspaceId);
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: older.id } })).status, "PENDING");
    assert.equal((await prisma.processingJob.findUniqueOrThrow({ where: { id: older.id } })).attempts, 0);

    if (process.argv.includes("--ollama")) {
      const real = await post();
      await processTelegramJob(prisma, rewriteWithOllama);
      const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: real.id } });
      assert.equal(job.outcome, "DRAFT_CREATED", `Real Ollama check failed: ${job.lastError}`);
      assert.equal(await prisma.aiDraft.count({ where: { originalPostId: real.originalPostId } }), 1);
      console.log("PASS: real local Ollama gpt-oss:latest produced a PostgreSQL draft from synthetic news.");
    }
  } finally {
    await prisma.$disconnect();
    // Identifier is generated locally from a UUID and never comes from user input.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    await unlink(fixtureRssScript).catch(() => {});
    if (oldWorkspace === undefined) delete process.env.INGEST_WORKSPACE_ID;
    else process.env.INGEST_WORKSPACE_ID = oldWorkspace;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Integration check failed."); process.exitCode = 1; });
