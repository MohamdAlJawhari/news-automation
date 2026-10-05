// Gives the Telegram reader its enabled-source list
import { getChannels } from "@/lib/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const secret = process.env.READER_CONFIG_SECRET;

    if (!secret) {
        return Response.json(
            { error: "Reader secret is not configured" },
            { status: 500 }
        );
    }

    if (request.headers.get("x-reader-secret") !== secret) {
        return Response.json(
            { error: "Unauthorized" },
            { status: 401 }
        );
    }

    return Response.json(
        {
            channels: getChannels().filter((channel) => channel.enabled === 1),
        },
        { headers: { "Cache-Control": "no-store" } }
    );
}