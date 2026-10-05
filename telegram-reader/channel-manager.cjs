function createChannelManager(client, config, isStopped) {
    let active = new Map();
    let enabledSourceIds = new Set();
    let lastConfigAt = 0;
    let lastSummary = "";

    const resolved = new Map();
    const retryAfter = new Map();
    const pinnedIds = new Map();

    async function refreshChannels() {
        try {
            const response = await fetch(config.configUrl, {
                headers: {
                    "x-ingest-secret": config.configSecret,
                },
                signal: AbortSignal.timeout(10000),
                cache: "no-store",
                redirect: "error",
            });

            if (!response.ok) {
                throw new Error(
                    `Channels API returned HTTP ${response.status}`
                );
            }

            const data = await response.json();

            if (
                !Array.isArray(data.channels) ||
                data.channels.some((row) =>
                    !row ||
                    typeof row.id !== "string" ||
                    !row.id ||
                    typeof row.username !== "string" ||
                    !/^[a-z][a-z0-9_]{3,31}$/.test(row.username) ||
                    !(
                        row.telegramChatId === null ||
                        typeof row.telegramChatId === "string"
                    )
                )
            ) {
                throw new Error("Invalid channel-list response.");
            }

            enabledSourceIds = new Set(
                data.channels.map((row) => row.id)
            );
            lastConfigAt = Date.now();

            for (const [id, source] of active) {
                if (!enabledSourceIds.has(source.sourceId)) {
                    active.delete(id);
                }
            }

            const next = new Map();

            for (const row of data.channels) {
                if (isStopped()) break;

                if ((retryAfter.get(row.id) || 0) > Date.now()) {
                    continue;
                }

                try {
                    let cached = resolved.get(row.id);

                    if (
                        !cached ||
                        cached.username !== row.username ||
                        cached.expires <= Date.now()
                    ) {
                        const entity = await client.getEntity(row.username);

                        if (!entity.broadcast) {
                            throw new Error("Not a broadcast channel.");
                        }

                        if (entity.left) {
                            throw new Error(
                                "Join this channel with the reader's Telegram account."
                            );
                        }

                        const id = String(
                            await client.getPeerId(entity, true)
                        );

                        cached = {
                            id,
                            sourceId: row.id,
                            username: row.username,
                            entity,
                            expires: Date.now() + 300000,
                        };
                    }

                    if (
                        cached.id === config.outputId ||
                        cached.id === config.intakeId
                    ) {
                        throw new Error(
                            "Intake/output channels cannot be sources."
                        );
                    }

                    const expectedId =
                        row.telegramChatId || pinnedIds.get(row.id);

                    if (expectedId && expectedId !== cached.id) {
                        throw new Error(
                            "Telegram identity changed. Check this source."
                        );
                    }

                    if (next.has(cached.id)) {
                        throw new Error(
                            "Another source resolves to this Telegram channel."
                        );
                    }

                    pinnedIds.set(row.id, cached.id);
                    resolved.set(row.id, cached);
                    retryAfter.delete(row.id);
                    next.set(cached.id, cached);
                } catch (error) {
                    resolved.delete(row.id);

                    const delay = Math.max(
                        60,
                        Number(error.seconds) || 0
                    );

                    retryAfter.set(
                        row.id,
                        Date.now() + delay * 1000
                    );

                    console.error(
                        `Source @${row.username}: ${error.message}`
                    );
                }
            }

            active = next;

            const summary = [...active.values()]
                .map((source) => `@${source.username}`)
                .sort()
                .join(", ");

            if (summary !== lastSummary) {
                console.log(`Monitoring: ${summary || "(none)"}`);
                lastSummary = summary;
            }
        } catch (error) {
            active.clear();
            enabledSourceIds.clear();
            lastConfigAt = 0;
            lastSummary = "";

            console.error("Channel refresh failed:", error.message);
        }
    }

    function getEligibleSource(chatId) {
        const source = active.get(chatId);

        if (
            !source ||
            !enabledSourceIds.has(source.sourceId) ||
            Date.now() - lastConfigAt > 45000
        ) {
            return undefined;
        }

        return source;
    }

    return {
        refreshChannels,
        getEligibleSource,
    };
}

module.exports = { createChannelManager };