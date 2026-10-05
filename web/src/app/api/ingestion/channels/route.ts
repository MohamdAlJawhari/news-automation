import { prisma } from "@/lib/prisma";
import { authenticateIngestReader } from "@/lib/ingest-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const authentication = authenticateIngestReader(request);

    if (authentication.error) {
        return authentication.error;
    }

    try {
        const workspace = await prisma.workspace.findFirst({
            where: {
                id: authentication.workspaceId,
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
                id: true,
                sourceChannels: {
                    where: { enabled: true },
                    select: {
                        id: true,
                        username: true,
                        telegramChatId: true,
                    },
                    orderBy: { createdAt: "asc" },
                },
            },
        });

        if (!workspace) {
            return Response.json(
                { error: "Workspace ingestion is disabled." },
                { status: 403 }
            );
        }

        return Response.json(
            {
                channels: workspace.sourceChannels,
            },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch (error) {
        console.error("Reading ingestion sources failed:", error);

        return Response.json(
            { error: "Could not load sources." },
            { status: 503 }
        );
    }
}