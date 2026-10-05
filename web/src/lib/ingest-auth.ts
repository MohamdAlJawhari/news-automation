import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

export function authenticateIngestReader(request: Request) {
    const expected = process.env.INGEST_READER_SECRET?.trim();
    const workspaceId = process.env.INGEST_WORKSPACE_ID?.trim();

    if (!expected || expected.length < 32 || !workspaceId) {
        return {
            workspaceId: null,
            error: Response.json(
                { error: "Ingestion is not configured." },
                { status: 503 }
            ),
        };
    }

    const supplied = request.headers.get("x-ingest-secret");

    if (!supplied) {
        return {
            workspaceId: null,
            error: Response.json(
                { error: "Unauthorized." },
                { status: 401 }
            ),
        };
    }

    const hash = (value: string) =>
        createHash("sha256").update(value).digest();

    if (!timingSafeEqual(hash(supplied), hash(expected))) {
        return {
            workspaceId: null,
            error: Response.json(
                { error: "Unauthorized." },
                { status: 401 }
            ),
        };
    }

    return {
        workspaceId,
        error: null,
    };
}