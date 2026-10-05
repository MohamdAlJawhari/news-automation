const { NewMessage } = require("teleproto/events");
const { setTimeout: delay } = require("node:timers/promises");

function createMessageIngestor(client, config, channels, isStopped) {
    let queue = Promise.resolve();
    const eventBuilder = new NewMessage({});

    async function savePost(payload) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await fetch(config.postsUrl, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-ingest-secret": config.configSecret,
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15000),
                    redirect: "error",
                });

                if (!response.ok) {
                    const error = new Error(
                        `Ingestion API returned HTTP ${response.status}`
                    );

                    error.retryable =
                        response.status === 408 ||
                        response.status === 429 ||
                        response.status >= 500;

                    throw error;
                }

                const result = await response.json();

                if (
                    typeof result.originalPostId !== "string" ||
                    typeof result.duplicate !== "boolean" ||
                    !Number.isInteger(result.jobsCreated)
                ) {
                    throw new Error("Invalid ingestion confirmation.");
                }

                return result;
            } catch (error) {
                if (
                    error.retryable === false ||
                    attempt === 3 ||
                    isStopped()
                ) {
                    throw error;
                }

                console.warn(
                    `Save attempt ${attempt} failed; retrying the same post.`
                );

                await delay(attempt * 1000);
            }
        }
    }

    function handlePost(event) {
        if (isStopped()) return;

        const chatId = event.chatId?.toString();
        const message = event.message;
        const source = channels.getEligibleSource(chatId);

        if (!source || !message?.message?.trim()) return;

        const publishedAt = new Date(Number(message.date) * 1000);

        if (
            !Number.isSafeInteger(message.id) ||
            message.id <= 0 ||
            !Number.isFinite(publishedAt.getTime())
        ) {
            console.error("Skipped a post with invalid ID or timestamp.");
            return;
        }

        const payload = {
            sourceId: source.sourceId,
            telegramChatId: chatId,
            telegramMessageId: message.id,
            originalText: message.message,
            publishedAt: publishedAt.toISOString(),
        };

        queue = queue.then(async () => {
            const current = channels.getEligibleSource(chatId);

            if (
                isStopped() ||
                !current ||
                current.sourceId !== payload.sourceId
            ) {
                console.warn(
                    `Skipped queued post ${chatId}/${message.id}: reader stopped or source unavailable.`
                );
                return;
            }

            const result = await savePost(payload);

            console.log(
                `${result.duplicate ? "Already saved" : "Saved"} ` +
                `@${source.username}/${message.id} → ` +
                `${result.originalPostId}; jobs created: ${result.jobsCreated}`
            );
        }).catch((error) => {
            console.error(
                `Ingestion failed for ${chatId}/${message.id}: ${error.message}`
            );
        });
    }

    function start() {
        client.addEventHandler(handlePost, eventBuilder);
    }

    async function stop() {
        client.removeEventHandler(handlePost, eventBuilder);
        await queue;
    }

    return { start, stop };
}

module.exports = { createMessageIngestor };