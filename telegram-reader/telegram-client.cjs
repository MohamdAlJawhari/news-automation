const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const fs = require("node:fs");
const path = require("node:path");

function createTelegramClient({ apiId, apiHash }) {
    // Read the session previously created by login.cjs.
    // If session.txt is missing or unreadable, this throws an error.
    const session = fs.readFileSync(
        path.join(__dirname, "session.txt"), "utf8"
    ).trim();

    // Create a Telegram client using the saved session.
    // Configure connection retries and disable automatic flood-wait sleeping.
    const client = new TelegramClient(
        new StringSession(session),
        apiId,
        apiHash,
        { connectionRetries: 5, floodSleepThreshold: 0 }
    );

    return client;
}

async function findIntake(client, intakeId) {
    // Find the intake destination among this account's conversations.
    // for await processes results from an asynchronous iterator.
    let intake;

    for await (const dialog of client.iterDialogs({})) {
        if (dialog.id.toString() === intakeId) {
            intake = dialog.entity;
        }
    }

    // Stop if the configured intake conversation cannot be found.
    if (!intake) {
        throw new Error("News Intake was not found in this account.");
    }

    return intake;
}

module.exports = { createTelegramClient, findIntake };
