import { destinationConflict } from "@/lib/campaign-execution";
import { syncDefaultMembership } from "@/lib/default-campaign";
import { prisma } from "@/lib/prisma";
import { authenticateIngestReader } from "@/lib/ingest-auth";
import { lockPublishing } from "@/lib/publishing-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorCode(error: unknown): string | undefined {
    if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
    ) {
        return error.code;
    }

    return undefined;
}

export async function POST(request: Request) {
    const authentication = authenticateIngestReader(request);

    if (authentication.error) {
        return authentication.error;
    }

    let payload: unknown;

    try {
        payload = await request.json();
    } catch {
        return Response.json(
            { error: "Invalid JSON." },
            { status: 400 }
        );
    }

    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
    ) {
        return Response.json(
            { error: "Invalid post." },
            { status: 400 }
        );
    }

    const body = payload as Record<string, unknown>;

    const sourceId = body.sourceId;
    const telegramChatId = body.telegramChatId;
    const telegramMessageId = body.telegramMessageId;
    const originalText = body.originalText;
    const publishedAt = body.publishedAt;

    if (
        typeof sourceId !== "string" ||
        !sourceId.trim() ||
        sourceId.length > 200 ||
        typeof telegramChatId !== "string" ||
        !/^-100[1-9]\d{0,15}$/.test(telegramChatId) ||
        typeof telegramMessageId !== "number" ||
        !Number.isSafeInteger(telegramMessageId) ||
        telegramMessageId <= 0 ||
        telegramMessageId > 2147483647 ||
        typeof originalText !== "string" ||
        !originalText.trim() ||
        originalText.length > 20000 ||
        typeof publishedAt !== "string" ||
        publishedAt.length > 50 ||
        !Number.isFinite(Date.parse(publishedAt))
    ) {
        return Response.json(
            { error: "Invalid post fields." },
            { status: 400 }
        );
    }

    const outputChatId =
        process.env.TELEGRAM_OUTPUT_CHAT_ID?.trim();

    if (!outputChatId) {
        return Response.json(
            { error: "Output channel exclusion is not configured." },
            { status: 503 }
        );
    }

    if (telegramChatId === outputChatId) {
        return Response.json(
            { error: "The output channel cannot be a source." },
            { status: 409 }
        );
    }

    const workspaceId = authentication.workspaceId;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await prisma.$transaction(
                async (tx) => {
                    await lockPublishing(tx, workspaceId);
                    const workspace = await tx.workspace.findFirst({
                        where: {
                            id: workspaceId,
                            owner: {
                                emailVerified: true,
                                approvalStatus: "APPROVED",
                            },
                            OR: [
                                { rssEnabled: true },
                                { automationEnabled: true },
                            ],
                        },
                        select: {
                            rssEnabled: true,
                            automationEnabled: true,
                        },
                    });

                    if (!workspace) {
                        return {
                            status: 403,
                            body: {
                                error: "Workspace ingestion is disabled.",
                            },
                        };
                    }

                    const source = await tx.sourceChannel.findFirst({
                        where: {
                            id: sourceId,
                            workspaceId,
                            enabled: true,
                        },
                        select: {
                            id: true,
                            username: true,
                            telegramChatId: true,
                        },
                    });

                    if (!source) {
                        return {
                            status: 403,
                            body: {
                                error: "Source is unavailable in this workspace.",
                            },
                        };
                    }

                    if (await destinationConflict(tx, workspaceId, source.username, telegramChatId)) {
                        return { status: 409, body: { error: "The publishing destination cannot be a source." } };
                    }

                    if (
                        source.telegramChatId !== null &&
                        source.telegramChatId !== telegramChatId
                    ) {
                        return {
                            status: 409,
                            body: {
                                error: "Source Telegram identity has changed.",
                            },
                        };
                    }

                    // Bind the source to the identity reported by
                    // our authenticated reader on first ingestion.
                    if (source.telegramChatId === null) {
                        await tx.sourceChannel.update({
                            where: {
                                id_workspaceId: {
                                    id: source.id,
                                    workspaceId,
                                },
                            },
                            data: {
                                telegramChatId,
                            },
                        });
                    }

                    await syncDefaultMembership(tx, workspaceId, source.id);
                    const inserted = await tx.originalPost.createMany({
                        data: [
                            {
                                workspaceId,
                                sourceChannelId: source.id,
                                telegramChatId,
                                telegramMessageId,
                                originalText,
                                publishedAt: new Date(publishedAt),
                                sourceUrl:
                                    `https://t.me/${source.username}/${telegramMessageId}`,
                            },
                        ],
                        skipDuplicates: true,
                    });

                    const original = await tx.originalPost.findUniqueOrThrow({
                        where: {
                            workspaceId_telegramChatId_telegramMessageId: {
                                workspaceId,
                                telegramChatId,
                                telegramMessageId,
                            },
                        },
                        select: {
                            id: true,
                            receivedAt: true,
                        },
                    });

                    if (inserted.count === 0) {
                        return {
                            status: 200,
                            body: {
                                originalPostId: original.id,
                                duplicate: true,
                                jobsCreated: 0,
                            },
                        };
                    }

                    const jobs: Array<{ workspaceId: string; originalPostId: string; type: "RSS_PREPARE" | "TELEGRAM_PREPARE"; campaignId: string | null }> = [];
                    if (workspace.rssEnabled) jobs.push({ workspaceId, originalPostId: original.id, type: "RSS_PREPARE", campaignId: null });
                    if (workspace.automationEnabled) {
                        // Disabled participation/settings pause execution, not collection
                        // of eligible future jobs. Unactivated campaigns never get history.
                        const memberships = await tx.campaignSource.findMany({ where: { workspaceId, sourceChannelId: source.id,
                            eligibleAfter: { lt: original.receivedAt }, campaign: { executionStartsAt: { lt: original.receivedAt },
                                aiSettings: { activatedAt: { lt: original.receivedAt } } } } });
                        for (const membership of memberships) jobs.push({ workspaceId, originalPostId: original.id, type: "TELEGRAM_PREPARE", campaignId: membership.campaignId });
                    }
                    const queued = jobs.length ? await tx.processingJob.createMany({ data: jobs, skipDuplicates: true }) : { count: 0 };

                    return {
                        status: 201,
                        body: {
                            originalPostId: original.id,
                            duplicate: false,
                            jobsCreated: queued.count,
                        },
                    };
                },
                {
                    isolationLevel: "Serializable",
                }
            );

            return Response.json(result.body, {
                status: result.status,
            });
        } catch (error) {
            if (errorCode(error) === "P2034") {
                // Retry a transaction conflict from the beginning.
                continue;
            }

            if (errorCode(error) === "P2002") {
                return Response.json(
                    {
                        error:
                            "This Telegram channel is already assigned to another source record in this workspace.",
                    },
                    { status: 409 }
                );
            }

            console.error("Saving original post failed.");

            return Response.json(
                { error: "Could not save the original post." },
                { status: 503 }
            );
        }
    }

    return Response.json(
        { error: "Database busy. Retry this same post." },
        { status: 503 }
    );
}
