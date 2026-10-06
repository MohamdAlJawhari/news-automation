require("dotenv").config({ path: `${__dirname}/.env` });

function loadConfig() {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH?.trim();

    const intakeId = process.env.INTAKE_CHAT_ID?.trim();
    const outputId = process.env.OUTPUT_CHAT_ID?.trim();

    const configUrl = process.env.CHANNELS_API_URL?.trim();
    const postsUrl = process.env.INGEST_POSTS_URL?.trim();
    const configSecret = process.env.INGEST_READER_SECRET?.trim();

    if (
        !Number.isInteger(apiId) ||
        apiId <= 0 ||
        !apiHash ||
        !outputId ||
        !configUrl ||
        !postsUrl ||
        !configSecret ||
        configSecret.length < 32
    ) {
        throw new Error("Check the required reader settings.");
    }

    for (const value of [configUrl, postsUrl]) {
        const url = new URL(value);

        const local = ["localhost", "127.0.0.1", "[::1]"]
            .includes(url.hostname);

        if (
            url.username ||
            url.password ||
            (url.protocol !== "https:" &&
                !(local && url.protocol === "http:"))
        ) {
            throw new Error(
                "Reader API URLs must use HTTPS, or HTTP on localhost."
            );
        }
    }

    const publishingUrl = new URL("/api/reader/publishing", postsUrl).toString();

    return {
        apiId,
        apiHash,
        intakeId,
        outputId,
        configUrl,
        postsUrl,
        configSecret,
        publishingUrl,
    };
}

module.exports = { loadConfig };
