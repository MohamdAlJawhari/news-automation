const { NewMessage } = require("teleproto/events");

// Own message filtering, the sequential forwarding queue, and event registration.
function createMessageForwarder(client, intake, channels, isStopped) {
    let queue = Promise.resolve();

    // Define what happens when a new Telegram message arrives.
    const handlePost = (event) => {
        const chatId = event.chatId?.toString();
        const message = event.message;

        // Ignore messages during shutdown, from unmonitored chats,
        // or without text/caption content.
        if (
            isStopped() ||
            !channels.hasSource(chatId) ||
            !message.message?.trim()
        ) return;

        // Add this post to the forwarding queue.
        // Each queued operation waits for the previous one to finish.
        queue = queue.then(async () => {
            const source = channels.getEligibleSource(chatId);

            // Recheck eligibility when the queued operation actually runs.
            // Skip if the source was disabled or configuration is over
            // 45 seconds old.
            if (
                isStopped() ||
                !source
            ) return;

            // Forward the original message into News Intake.
            await client.forwardMessages(intake, {
                messages: [message.id],
                fromPeer: source.entity,
            });

            console.log(
                `Forwarded @${source.username}/${message.id} → News Intake`
            );
        }).catch((error) => {
            // Log a forwarding failure so later queued posts can proceed.
            // This failed post is not automatically retried here.
            console.error(`Forward failed: ${error.message}`);
        });
    };

    function start() {
        client.addEventHandler(handlePost, new NewMessage({}));
    }

    async function stop() {
        client.removeEventHandler(handlePost);
        await queue;
    }

    return { start, stop };
}

module.exports = { createMessageForwarder };
