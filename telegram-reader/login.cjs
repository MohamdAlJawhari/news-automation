// 1. Load settings from the .env file beside this script.
// __dirname is the directory containing login.cjs.
require("dotenv").config({ path: `${__dirname}/.env` });

// 2. Import the tools this script needs.
const { TelegramClient } = require("teleproto"); // Communicates with Telegram.
const { StringSession } = require("teleproto/sessions"); // Loads and saves session data as text.
const input = require("input"); // Prompts for login details in the terminal.
const fs = require("node:fs"); // Reads and writes files.
const path = require("node:path"); // Builds filesystem paths.

// 3. Set the location where the Telegram session will be stored.
const sessionPath = path.join(__dirname, "session.txt");

// 4. Define the login workflow.
async function main() {
    // 5. Read the Telegram application credentials from the environment.
    // Convert the API ID to a number and remove whitespace from the API hash.
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH?.trim(); // ?. skips trim() if TELEGRAM_API_HASH is missing.

    // 6. Stop if the API ID is not a positive integer or the hash is empty.
    // This checks their format, not whether Telegram accepts them.
    if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
        throw new Error("Check TELEGRAM_API_ID and TELEGRAM_API_HASH in .env");
    }

    // 7. Load the existing session, if its file exists.
    // Otherwise, use an empty string to start without a saved session.
    const savedSession = fs.existsSync(sessionPath)
        ? fs.readFileSync(sessionPath, "utf8").trim()
        : "";

    // 8. Create the Telegram client with the session and API credentials.
    // Configure five connection retries.
    const client = new TelegramClient(
        new StringSession(savedSession),
        apiId,
        apiHash,
        { connectionRetries: 5 }
    );

    // 9. Run login and session saving inside a try/finally block
    // so the client is disconnected even if an operation fails.
    try {
        // 10. Connect and complete any required login steps.
        // These callback functions provide details when requested.
        await client.start({
            // Ask for the phone number, including its country code.
            phoneNumber: () => input.text("Phone number with country code: "),

            // Ask for the login code supplied by Telegram.
            phoneCode: () => input.text("Telegram login code: "),

            // Ask for the two-step verification password if required.
            password: () => input.password("Telegram two-step password: "),

            // Display authentication errors and return false to the library.
            onError: (error) => {
                console.error("Login error:", error.message);
                return false;
            },
        });

        // 11. Fetch the profile of the account that is now logged in.
        const me = await client.getMe();

        // 12. Convert the current session to text and save it for future use.
        // An existing session.txt is overwritten.
        // Windows handles file permissions differently.
        fs.writeFileSync(sessionPath, client.session.save(), {
            encoding: "utf8",
            mode: 0o600, // 0o600 requests owner-only read/write permissions on Unix-like systems;
        });

        // 13. Show the account's username, or first name if no username exists.
        // Session data is sensitive because it can grant account access.
        console.log(`Connected as: ${me.username || me.firstName}`);
        console.log("Session saved. Keep session.txt private.");
    } finally {
        // 14. Close the Telegram connection on success or failure.
        await client.disconnect();
    }
}

// 15. Start the workflow and handle any error that escapes main().
main().catch((error) => {
    console.error("Failed:", error.message);
    process.exitCode = 1; // Exit code 1 tells the calling terminal or program that the script failed.
});