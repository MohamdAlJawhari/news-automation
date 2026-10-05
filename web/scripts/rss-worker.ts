import { loadEnvConfig } from "@next/env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { setTimeout as delay } from "node:timers/promises";

loadEnvConfig(
    process.cwd(),
    process.env.NODE_ENV !== "production"
);

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
}

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
});

const runOnce = process.argv.includes("--once");
const maxAttempts = 5;

let stopping = false;

function stop() {
    stopping = true;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function createTitle(text: string): string {
    const firstLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

    const characters = Array.from(
        (firstLine || "News update").replace(/\s+/g, " ")
    );

    return characters.length > 140
        ? characters.slice(0, 139).join("") + "…"
        : characters.join("");
}

async function processOne(): Promise<boolean> {
    const candidate = await prisma.processingJob.findFirst({
        where: {
            type: "RSS_PREPARE",
            status: "PENDING",
            availableAt: { lte: new Date() },
            attempts: { lt: maxAttempts },
        },
        orderBy: [
            { availableAt: "asc" },
            { createdAt: "asc" },
            { id: "asc" },
        ],
        select: {
            id: true,
            workspaceId: true,
            originalPostId: true,
            attempts: true,
            updatedAt: true,
        },
    });

    if (!candidate) return false;

    try {
        const outcome = await prisma.$transaction(
            async (tx) => {
                // Claim only the version of the job we selected.
                const claimed = await tx.processingJob.updateMany({
                    where: {
                        id: candidate.id,
                        type: "RSS_PREPARE",
                        status: "PENDING",
                        attempts: candidate.attempts,
                        updatedAt: candidate.updatedAt,
                        availableAt: { lte: new Date() },
                    },
                    data: {
                        status: "PROCESSING",
                    },
                });

                if (claimed.count !== 1) {
                    return "Job changed; another attempt will check again.";
                }

                const workspace = await tx.workspace.findFirst({
                    where: {
                        id: candidate.workspaceId,
                        rssEnabled: true,
                        owner: {
                            emailVerified: true,
                            approvalStatus: "APPROVED",
                        },
                    },
                    select: {
                        id: true,
                        name: true,
                    },
                });

                if (!workspace) {
                    // Pause without consuming a processing attempt.
                    await tx.processingJob.update({
                        where: { id: candidate.id },
                        data: {
                            status: "PENDING",
                            availableAt: new Date(Date.now() + 60000),
                            lastError:
                                "Waiting for approved workspace RSS access.",
                            lockedUntil: null,
                            lockToken: null,
                        },
                    });

                    return "Paused: workspace RSS access is unavailable.";
                }

                const original = await tx.originalPost.findUniqueOrThrow({
                    where: {
                        id_workspaceId: {
                            id: candidate.originalPostId,
                            workspaceId: workspace.id,
                        },
                    },
                    select: {
                        id: true,
                        originalText: true,
                        sourceUrl: true,
                        publishedAt: true,
                        sourceChannelId: true,
                        sourceChannel: {
                            select: {
                                username: true,
                            },
                        },
                    },
                });

                const feed = await tx.rssFeed.upsert({
                    where: {
                        sourceChannelId: original.sourceChannelId,
                    },
                    create: {
                        workspaceId: workspace.id,
                        sourceChannelId: original.sourceChannelId,
                        title: `@${original.sourceChannel.username} — News`,
                    },
                    update: {},
                });

                const item = await tx.rssItem.upsert({
                    where: {
                        originalPostId_workspaceId: {
                            originalPostId: original.id,
                            workspaceId: workspace.id,
                        },
                    },
                    create: {
                        workspaceId: workspace.id,
                        feedId: feed.id,
                        originalPostId: original.id,
                        title: createTitle(original.originalText),
                        content: original.originalText,
                        sourceUrl: original.sourceUrl,
                        publishedAt: original.publishedAt,
                    },
                    // A retry must not overwrite later manual edits.
                    update: {},
                });

                await tx.processingJob.update({
                    where: {
                        id: candidate.id,
                    },
                    data: {
                        status: "COMPLETED",
                        attempts: { increment: 1 },
                        completedAt: new Date(),
                        lastError: null,
                        lockedUntil: null,
                        lockToken: null,
                    },
                });

                return `Completed → RSS item ${item.id}`;
            },
            {
                isolationLevel: "Serializable",
                timeout: 10000,
            }
        );

        console.log(`[${candidate.id}] ${outcome}`);
    } catch (error) {
        // The failed transaction rolled back its claim and item writes.
        const attempts = candidate.attempts + 1;
        const failed = attempts >= maxAttempts;

        const errorMessage =
            error instanceof Error
                ? error.message.slice(0, 1000)
                : "Unknown RSS processing error.";

        const recorded = await prisma.processingJob.updateMany({
            where: {
                id: candidate.id,
                status: "PENDING",
                attempts: candidate.attempts,
                updatedAt: candidate.updatedAt,
            },
            data: {
                attempts: { increment: 1 },
                status: failed ? "FAILED" : "PENDING",
                availableAt: new Date(
                    Date.now() + Math.min(300000, 5000 * 2 ** (attempts - 1))
                ),
                lastError: errorMessage,
            },
        });

        if (recorded.count === 1) {
            console.error(
                `[${candidate.id}] ${failed ? "Failed after five attempts." : "Retry scheduled."
                } Check processing_job.lastError for details.`
            );
        } else {
            console.log(
                `[${candidate.id}] Job changed; failure state was not overwritten.`
            );
        }
    }

    return true;
}

async function main() {
    console.log(
        runOnce
            ? "RSS worker: checking one job."
            : "RSS worker running. Ctrl+C stops."
    );

    try {
        while (!stopping) {
            const found = await processOne();

            if (runOnce) {
                if (!found) console.log("No eligible RSS jobs.");
                break;
            }

            if (!found) {
                await delay(2000);
            }
        }
    } finally {
        await prisma.$disconnect();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    }
}

main().catch((error) => {
    console.error(
        "RSS worker stopped:",
        error instanceof Error ? error.message : "Unknown error."
    );
    process.exitCode = 1;
});