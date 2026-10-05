const { loadConfig } = require("./config.cjs");
const { createTelegramClient } = require("./telegram-client.cjs");
const { createChannelManager } = require("./channel-manager.cjs");
const { createMessageIngestor } = require("./message-ingestor.cjs");

async function main() {
    const config = loadConfig();
    const client = createTelegramClient(config);

    let stopped = false;
    let timer;
    let ingestor;
    let refreshTask = Promise.resolve();

    let resolveShutdown;
    const shutdown = new Promise((resolve) => {
        resolveShutdown = resolve;
    });

    function requestStop() {
        stopped = true;
        clearTimeout(timer);
        resolveShutdown();
    }

    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);

    try {
        await client.connect();
        if (stopped) return;

        const me = await client.getMe();
        if (stopped) return;

        const isStopped = () => stopped;

        const channels = createChannelManager(
            client,
            config,
            isStopped
        );

        ingestor = createMessageIngestor(
            client,
            config,
            channels,
            isStopped
        );

        ingestor.start();

        async function refreshLoop() {
            await channels.refreshChannels();

            if (!stopped) {
                timer = setTimeout(() => {
                    refreshTask = refreshLoop();
                }, 15000);
            }
        }

        console.log(`Connected as: ${me.username || me.firstName}`);

        refreshTask = refreshLoop();
        await refreshTask;

        if (!stopped) {
            console.log(
                "Direct ingestion active. Sources refresh every 15 seconds."
            );
        }

        await shutdown;
    } finally {
        stopped = true;
        clearTimeout(timer);

        try {
            if (ingestor) await ingestor.stop();
            await refreshTask;
        } finally {
            await client.disconnect();
            process.removeListener("SIGINT", requestStop);
            process.removeListener("SIGTERM", requestStop);
        }
    }
}

main().catch((error) => {
    console.error("Reader stopped:", error.message);
    process.exitCode = 1;
});