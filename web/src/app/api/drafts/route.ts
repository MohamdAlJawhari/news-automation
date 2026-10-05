// Receives the original and AI rewrite from n8n and saves the draft
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

import { isAutoPublishEnabled } from "@/lib/settings";
import { publishSavedDraft } from "@/lib/publish-draft";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.N8N_INGEST_SECRET;

  if (!secret) {
    return Response.json(
      { error: "Server secret is not configured" },
      { status: 500 },
    );
  }

  if (request.headers.get("x-ingest-secret") !== secret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  const { source_chat_id, source_message_id, original_text, ai_text } =
    body as Record<string, unknown>;

  if (
    typeof source_chat_id !== "string" ||
    !/^-100\d+$/.test(source_chat_id) ||
    typeof source_message_id !== "number" ||
    !Number.isSafeInteger(source_message_id) ||
    source_message_id <= 0 ||
    typeof original_text !== "string" ||
    !original_text.trim() ||
    original_text.length > 20000 ||
    typeof ai_text !== "string" ||
    !ai_text.trim() ||
    ai_text.length > 20000
  ) {
    return Response.json(
      { error: "Invalid source IDs or missing/oversized text" },
      { status: 400 },
    );
  }

  try {
    const autoPublishForThisDraft = isAutoPublishEnabled();
    const result = db
      .prepare(
        `
            INSERT INTO drafts (
                source_chat_id,
                source_message_id,
                original_text,
                ai_text,
                final_text
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_chat_id, source_message_id)
            DO NOTHING
        `,
      )
      .run(source_chat_id, source_message_id, original_text, ai_text, ai_text);

    let autoPublishResult: { success: boolean; message: string } | null = null;

    if (result.changes === 1 && autoPublishForThisDraft) {
      autoPublishResult = await publishSavedDraft(
        Number(result.lastInsertRowid),
        "auto",
      );
    }

    const draft = db
      .prepare(
        `
            SELECT id, status
            FROM drafts
            WHERE source_chat_id = ? AND source_message_id = ?
        `,
      )
      .get(source_chat_id, source_message_id) as {
      id: number;
      status: string;
    };

    revalidatePath("/review");

    return Response.json(
      {
        ...draft,
        duplicate: result.changes === 0,
        autoPublishResult,
      },
      { status: result.changes === 0 ? 200 : 201 },
    );
  } catch (error) {
    console.error("Saving draft failed:", error);

    return Response.json({ error: "Could not save draft" }, { status: 500 });
  }
}
