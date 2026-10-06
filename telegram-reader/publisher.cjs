const { Api } = require("teleproto");
const bigInt = require("big-integer");
const fs = require("node:fs/promises");
const path = require("node:path");

function deadline(promise, ms = 30000) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DEADLINE")), ms);
    })]).finally(() => clearTimeout(timer));
}
async function resolveDestination(client, username, pinnedId) {
    let entity;
    if (pinnedId) {
        try { entity = await deadline(client.getEntity(pinnedId)); }
        catch (e) { if (e.seconds > 0) throw e; }
    }
    if (!entity) {
        try { entity = await deadline(client.getEntity(username)); }
        catch (e) { if (!pinnedId || e.seconds > 0) throw e; }
    }
    if (pinnedId && (!entity || String(await client.getPeerId(entity, true)) !== pinnedId) && client.iterDialogs) {
        // StringSession does not persist entity access hashes. Recover a renamed
        // pinned channel from this account's dialogs, without trusting its old handle.
        entity = await deadline((async () => {
            for await (const dialog of client.iterDialogs({ limit: 500 })) {
                if (String(dialog.id) === pinnedId) return client.getEntity(dialog.entity);
            }
            throw new Error("DESTINATION");
        })());
    }
    if (!entity) throw new Error("DESTINATION");
    const chatId = String(await client.getPeerId(entity, true));
    if (!entity.broadcast || !/^-100[1-9]\d{0,15}$/.test(chatId) || (pinnedId && pinnedId !== chatId)) throw new Error("DESTINATION");
    if (entity.left || !(entity.creator || entity.adminRights?.postMessages)) throw new Error("PERMISSION");
    return { entity, chatId };
}
function receipt(updates, job) {
    const mapping = updates.updates?.find(u => u instanceof Api.UpdateMessageID && String(u.randomId) === job.randomId);
    const message = updates.updates?.find(u => u instanceof Api.UpdateNewChannelMessage &&
        String(u.message.peerId?.channelId) === job.destinationChatId.slice(4) &&
        (mapping ? u.message.id === mapping.id : u.message.message === job.text))?.message;
    const messageId = mapping?.id ?? message?.id ?? (updates instanceof Api.UpdateShortSentMessage ? updates.id : null);
    const date = message?.date ?? updates.date;
    if (!Number.isInteger(messageId) || messageId <= 0 || !Number.isInteger(date)) throw new Error("UNKNOWN");
    return { id: job.id, token: job.lockToken, outcome: "published", chatId: job.destinationChatId, messageId, publishedAt: new Date(date * 1000).toISOString() };
}
function rejection(error) {
    if (/^FLOOD(?:_PREMIUM)?_WAIT/.test(error.errorMessage || "") && Number.isFinite(error.seconds) && error.seconds > 0)
        return { outcome: "flood", error: "FLOOD", seconds: error.seconds };
    // Only explicit RPC rejection is safe to retry. Server/network/timeouts and
    // RANDOM_ID_DUPLICATE may follow a successful send and remain uncertain.
    if ([400, 401, 403, 406].includes(error.code) && error.errorMessage && error.errorMessage !== "RANDOM_ID_DUPLICATE")
        return { outcome: "failed", error: "REJECTED" };
    return { outcome: "unknown", error: "UNKNOWN" };
}

function createPublisher(client, config, isStopped, options = {}) {
    const journalDir = options.journalDir || path.join(__dirname, "publication-receipts");
    const fetcher = options.fetch || fetch;
    let timer, task = Promise.resolve(), stopped = false, unresolvedSend = false;
    let journalWrites = Promise.resolve();
    let nextTelegramAt = 0;
    const stopping = () => stopped || isStopped();
    async function api(body) {
        const response = await fetcher(config.publishingUrl, {
            method: body ? "POST" : "GET", headers: { "x-ingest-secret": config.configSecret, ...(body ? { "Content-Type": "application/json" } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store",
        });
        if (!response.ok) throw new Error("API_UNAVAILABLE");
        return response.json();
    }
    async function store(result) {
        // Serialize atomic renames, including late receipts after a timeout.
        journalWrites = journalWrites.catch(() => {}).then(async () => {
            await fs.mkdir(journalDir, { recursive: true });
            // Outcomes use separate files: acknowledging an earlier unknown
            // report can never delete a later successful send receipt.
            const file = path.join(journalDir, `${result.id}-${result.token}-${result.outcome}${result.messageId ? `-${result.messageId}` : ""}.json`);
            const handle = await fs.open(`${file}.tmp`, "w", 0o600);
            try { await handle.writeFile(JSON.stringify(result)); await handle.sync(); } finally { await handle.close(); }
            await fs.rename(`${file}.tmp`, file);
        });
        await journalWrites;
    }
    async function flush() {
        await journalWrites;
        await fs.mkdir(journalDir, { recursive: true });
        for (const name of await fs.readdir(journalDir)) {
            if (!name.endsWith(".json")) continue;
            const file = path.join(journalDir, name);
            const raw = await fs.readFile(file, "utf8");
            const result = JSON.parse(raw);
            if (!(await api({ action: "result", ...result })).accepted) throw new Error("RECEIPT_NOT_ACKNOWLEDGED");
            journalWrites = journalWrites.catch(() => {}).then(async () => {
                if (await fs.readFile(file, "utf8") === raw) await fs.unlink(file);
            });
            await journalWrites;
        }
    }
    async function tick() {
        await flush(); // Never claim new work while a receipt is unacknowledged.
        if (stopping() || unresolvedSend || Date.now() < nextTelegramAt) return;
        const tasks = await api();
        if (tasks.floodWaitUntil && Date.parse(tasks.floodWaitUntil) > Date.now()) {
            nextTelegramAt = Date.parse(tasks.floodWaitUntil); return;
        }
        if (tasks.verification) {
            const v = tasks.verification;
            try {
                const resolved = await resolveDestination(client, v.username);
                await api({ action: "verify", ...v, chatId: resolved.chatId });
            } catch (e) {
                if (Number.isFinite(e.seconds) && e.seconds > 0) { nextTelegramAt = Date.now() + e.seconds * 1000; await api({ action: "wait", seconds: e.seconds }); return; }
                await api({ action: "verify", ...v, error: e.message === "PERMISSION" ? "PERMISSION" : "DESTINATION" });
            }
        }
        if (stopping()) return;
        if (tasks.recovery) {
            const p = tasks.recovery;
            try {
                const { entity } = await resolveDestination(client, p.destinationUsername, p.destinationChatId);
                const messages = await deadline(client.getMessages(entity, { ids: [p.recoveryMessageId] }));
                const message = messages[0];
                if (!message || !message.out || message.id !== p.recoveryMessageId || message.message !== p.text ||
                    String(message.peerId?.channelId) !== p.destinationChatId.slice(4)) throw new Error("RECOVERY");
                await store({ id: p.id, token: p.lockToken, outcome: "published", chatId: p.destinationChatId, messageId: message.id, publishedAt: new Date(message.date * 1000).toISOString() });
                await flush();
            } catch (e) {
                if (Number.isFinite(e.seconds) && e.seconds > 0) { nextTelegramAt = Date.now() + e.seconds * 1000; await api({ action: "wait", seconds: e.seconds }); return; }
                await api({ action: "recovery-error", id: p.id, token: p.lockToken, messageId: p.recoveryMessageId, error: "RECOVERY" });
            }
            return;
        }
        const { publication: p } = await api({ action: "claim" });
        if (!p) return;
        let entity;
        try {
            ({ entity } = await resolveDestination(client, p.destinationUsername, p.destinationChatId));
            if (stopping() || !p.text.trim() || p.text.length > 4096 || !(await api({ action: "authorize", id: p.id, token: p.lockToken })).authorized) throw new Error("PAUSED");
            if (stopping()) throw new Error("PAUSED");
        } catch (e) {
            if (Number.isFinite(e.seconds) && e.seconds > 0) {
                nextTelegramAt = Date.now() + e.seconds * 1000;
                await store({ id: p.id, token: p.lockToken, outcome: "flood", error: "FLOOD", seconds: e.seconds });
                await flush(); return;
            }
            await store({ id: p.id, token: p.lockToken, outcome: "failed", error: ["PERMISSION", "DESTINATION"].includes(e.message) ? e.message : "PAUSED" });
            await flush(); return;
        }
        // Raw installed teleproto API supports a durable randomId; no formatting
        // parser, splitting, forwarding, or bot is involved.
        unresolvedSend = true;
        const send = client.invoke(new Api.messages.SendMessage({ peer: entity, message: p.text, randomId: bigInt(p.randomId), noWebpage: true }));
        let timedOut = false;
        const settled = send.then(async updates => {
            const result = receipt(updates, p);
            if (timedOut) await store(result);
            return result;
        }, async error => {
            const result = { id: p.id, token: p.lockToken, ...rejection(error) };
            // Once a deadline passed, a later rejection does not prove that no
            // earlier transport attempt succeeded. Only a receipt settles it.
            return timedOut ? { id: p.id, token: p.lockToken, outcome: "unknown", error: "UNKNOWN" } : result;
        }).finally(() => { unresolvedSend = false; });
        try { await store(await deadline(settled, options.sendTimeoutMs || 60000)); }
        catch { timedOut = true; await store({ id: p.id, token: p.lockToken, outcome: "unknown", error: "UNKNOWN" }); }
        settled.catch(() => {});
        await flush();
    }
    function start() {
        async function loop() {
            try { await tick(); } catch { console.error("Publishing paused: service or receipt acknowledgement unavailable."); }
            if (!stopping()) timer = setTimeout(() => { task = loop(); }, 5000);
        }
        task = loop();
    }
    async function stop() {
        stopped = true; clearTimeout(timer);
        try { await deadline(task, 15000); } catch { /* Lease becomes uncertain; never resend. */ }
        await journalWrites;
    }
    return { start, stop, tick };
}
module.exports = { createPublisher, resolveDestination, receipt, rejection };
