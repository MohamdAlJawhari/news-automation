const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Api } = require("teleproto");
const bigInt = require("big-integer");
const { createPublisher, resolveDestination, rejection } = require("./publisher.cjs");

const job = { id: "test-publication", lockToken: "test-token", randomId: "123456", text: "Exact saved plain text *literal*", destinationUsername: "news_output_test", destinationChatId: "-10012345" };
function updates() { return new Api.Updates({ updates: [new Api.UpdateMessageID({ id: 42, randomId: bigInt(job.randomId) })], users: [], chats: [], date: 1700000000, seq: 1 }); }
const entity = { broadcast: true, creator: true, left: false };
const config = { publishingUrl: "http://localhost/api/reader/publishing", configSecret: "mock-only" };
function client(invoke) { return { getEntity: async () => entity, getPeerId: async () => job.destinationChatId, invoke }; }

test("success receipt survives failed acknowledgement and service restart without resending", async () => {
    const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-test-"));
    let sends = 0, claims = 0, failAck = true, reports = 0;
    const fetch = async (_, options) => {
        const body = options.body && JSON.parse(options.body);
        if (body?.action === "result") { reports++; if (failAck) throw new Error("mock ack failure"); assert.equal(body.messageId, 42); return Response.json({ accepted: true }); }
        if (body?.action === "authorize") return Response.json({ authorized: true });
        if (body?.action === "claim") return Response.json({ publication: claims++ === 0 ? job : null });
        return Response.json({ verification: null, recovery: null });
    };
    try {
        const c = client(async request => {
            sends++; assert(request instanceof Api.messages.SendMessage);
            assert.equal(String(request.randomId), job.randomId); assert.equal(request.message, job.text);
            assert.equal(request.entities, undefined); assert.equal(request.noWebpage, true);
            return updates();
        });
        const publisher = createPublisher(c, config, () => false, { journalDir, fetch });
        await assert.rejects(publisher.tick()); assert.equal(sends, 1);
        const stored = JSON.parse(await fs.readFile(path.join(journalDir, (await fs.readdir(journalDir))[0]), "utf8")); assert.equal(stored.outcome, "published");
        await assert.rejects(publisher.tick()); assert.equal(claims, 1); assert.equal(sends, 1);
        failAck = false;
        const restarted = createPublisher(c, config, () => false, { journalDir, fetch });
        await restarted.tick(); assert.equal(sends, 1); assert(reports >= 3); assert.deepEqual(await fs.readdir(journalDir), []);
    } finally { await fs.rm(journalDir, { recursive: true, force: true }); }
});
test("permission errors and pinned identity changes prevent send", async () => {
    await assert.rejects(resolveDestination({ getEntity: async () => ({ broadcast: true }), getPeerId: async () => job.destinationChatId }, job.destinationUsername), /PERMISSION/);
    await assert.rejects(resolveDestination(client(async () => { throw new Error("must not send"); }), job.destinationUsername, "-10099999"), /DESTINATION/);
});
test("deadline is uncertain; late successful receipt is preserved without another send", async () => {
    const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-timeout-"));
    let resolveSend, sends = 0; const reported = [];
    const fetch = async (_, options) => {
        const body = options.body && JSON.parse(options.body);
        if (body?.action === "result") { reported.push(body.outcome); return Response.json({ accepted: true }); }
        if (body?.action === "authorize") return Response.json({ authorized: true });
        if (body?.action === "claim") return Response.json({ publication: sends ? null : job });
        return Response.json({});
    };
    try {
        const p = createPublisher(client(() => { sends++; return new Promise(resolve => { resolveSend = resolve; }); }), config, () => false, { journalDir, fetch, sendTimeoutMs: 5 });
        await p.tick(); assert.deepEqual(reported, ["unknown"]);
        await p.tick(); assert.equal(sends, 1);
        resolveSend(updates());
        for (let i = 0; i < 20 && !(await fs.readdir(journalDir)).some(name => name.endsWith(".json")); i++) await new Promise(resolve => setTimeout(resolve, 5));
        await p.tick(); assert.deepEqual(reported, ["unknown", "published"]); assert.equal(sends, 1);
    } finally { await fs.rm(journalDir, { recursive: true, force: true }); }
});
test("flood wait and definite RPC rejection are distinct from uncertain delivery", () => {
    assert.equal(rejection({ code: 420, errorMessage: "FLOOD_WAIT", seconds: 3600 }).outcome, "flood");
    assert.equal(rejection({ code: 403, errorMessage: "CHAT_WRITE_FORBIDDEN" }).outcome, "failed");
    for (const error of [{ code: 500 }, new Error("timeout"), { code: 500, errorMessage: "RANDOM_ID_DUPLICATE" }]) assert.equal(rejection(error).outcome, "unknown");
});
test("fresh dispatch authorization failure does not invoke Telegram", async () => {
    const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-pause-"));
    let sends = 0;
    const fetch = async (_, options) => {
        const body = options.body && JSON.parse(options.body);
        if (body?.action === "claim") return Response.json({ publication: job });
        if (body?.action === "authorize") return Response.json({ authorized: false });
        if (body?.action === "result") { assert.equal(body.outcome, "failed"); assert.equal(body.error, "PAUSED"); return Response.json({ accepted: true }); }
        return Response.json({});
    };
    try { await createPublisher(client(async () => { sends++; return updates(); }), config, () => false, { journalDir, fetch }).tick(); assert.equal(sends, 0); }
    finally { await fs.rm(journalDir, { recursive: true, force: true }); }
});

test("recovery verifies exact outgoing text and stable channel without sending", async () => {
    for (const valid of [true, false]) {
        const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-recovery-"));
        let reports = 0;
        const fetch = async (_, options) => {
            const body = options.body && JSON.parse(options.body);
            if (body?.action === "result") { assert(valid); assert.equal(body.messageId, 42); reports++; return Response.json({ accepted: true }); }
            if (body?.action === "recovery-error") { assert(!valid); reports++; return Response.json({ accepted: true }); }
            assert(!body, "Recovery must not claim a send job.");
            return Response.json({ recovery: { ...job, recoveryMessageId: 42 } });
        };
        const c = { ...client(async () => { throw new Error("Recovery must not send."); }), getMessages: async () => [{ id: 42, out: true, message: valid ? job.text : "Wrong message", peerId: { channelId: bigInt("12345") }, date: 1700000000 }] };
        try { await createPublisher(c, config, () => false, { journalDir, fetch }).tick(); assert.equal(reports, 1); }
        finally { await fs.rm(journalDir, { recursive: true, force: true }); }
    }
});

test("durable workspace flood wait prevents Telegram resolution on restart", async () => {
    const journalDir = await fs.mkdtemp(path.join(os.tmpdir(), "publisher-flood-"));
    const c = { getEntity: async () => { throw new Error("Flood wait must prevent resolution."); } };
    const fetch = async () => Response.json({ floodWaitUntil: new Date(Date.now() + 60000).toISOString(), verification: { username: "news_output_test", revision: 1 } });
    try { await createPublisher(c, config, () => false, { journalDir, fetch }).tick(); }
    finally { await fs.rm(journalDir, { recursive: true, force: true }); }
});
