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
                campaigns: { select: { publishingSettings: { select: { destinationChatId: true, destinationUsername: true } } } },
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

        const destinations = workspace.campaigns.flatMap(c => c.publishingSettings ? [c.publishingSettings] : []);
        const destinationChatIds = destinations.flatMap(s => s.destinationChatId ? [s.destinationChatId] : []);
        return Response.json(
            {
                destinationChatIds,
                channels: workspace.sourceChannels.filter(source => !destinations.some(s => source.username === s.destinationUsername || (source.telegramChatId && source.telegramChatId === s.destinationChatId))),
            },
            {
                headers: {
                    "Cache-Control": "no-store",
                },
            }
        );
    } catch {
        console.error("Reading ingestion sources failed.");

        return Response.json(
            { error: "Could not load sources." },
            { status: 503 }
        );
    }
}
