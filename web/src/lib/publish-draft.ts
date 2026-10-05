import "server-only";

import { db } from "@/lib/db";
import { isAutoPublishEnabled } from "@/lib/settings";

type PublishState = {
    success: boolean;
    message: string;
};

type ClaimResult =
    | { error: string }
    | { text: string };

export async function publishSavedDraft(
    id: number,
    mode: "manual" | "auto" = "manual"
): Promise<PublishState> {
    const url = process.env.N8N_PUBLISH_URL;
    const secret = process.env.N8N_PUBLISH_SECRET;
    const outputChatId = process.env.TELEGRAM_OUTPUT_CHAT_ID;

    if (!Number.isSafeInteger(id) || id <= 0) {
        return { success: false, message: "Invalid draft ID." };
    }

    if (!url || !secret || !outputChatId) {
        return {
            success: false,
            message: "Publishing settings are missing from .env.local.",
        };
    }

    // Check eligibility and claim the draft in one transaction.
    const claimDraft = db.transaction((): ClaimResult => {
        const expectedStatus =
            mode === "auto" ? "pending" : "approved";

        if (mode === "auto" && !isAutoPublishEnabled()) {
            return {
                error: "Automatic publishing is off. Draft kept for review.",
            };
        }

        const draft = db.prepare(`
            SELECT final_text, status
            FROM drafts
            WHERE id = ?
        `).get(id) as {
            final_text: string;
            status: string;
        } | undefined;

        if (!draft || draft.status !== expectedStatus) {
            return {
                error: "This draft is not available for publishing.",
            };
        }

        if (
            !draft.final_text.trim() ||
            draft.final_text.length > 4096
        ) {
            return {
                error: "Publishing requires text between 1 and 4,096 characters.",
            };
        }

        const result = db.prepare(`
            UPDATE drafts
            SET status = 'publishing',
                last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = ?
        `).run(id, expectedStatus);

        if (result.changes !== 1) {
            return {
                error: "Another request already claimed this draft.",
            };
        }

        return { text: draft.final_text };
    });

    let finalText: string;

    try {
        const claim = claimDraft.immediate();

        if ("error" in claim) {
            return {
                success: false,
                message: claim.error,
            };
        }

        finalText = claim.text;
    } catch (error) {
        console.error("Claiming draft failed:", error);

        return {
            success: false,
            message: "Could not prepare the draft for publishing.",
        };
    }

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-publish-secret": secret,
            },
            body: JSON.stringify({
                draft_id: id,
                final_text: finalText,
            }),
            signal: AbortSignal.timeout(60000),
            cache: "no-store",
            redirect: "error",
        });

        if (!response.ok) {
            throw new Error(`n8n returned HTTP ${response.status}`);
        }

        const data = await response.json();
        const messageId = data?.result?.message_id;
        const chatId = data?.result?.chat?.id;

        if (
            data?.ok !== true ||
            !Number.isSafeInteger(messageId) ||
            messageId <= 0 ||
            String(chatId) !== outputChatId
        ) {
            throw new Error("Unexpected Telegram confirmation");
        }

        // Telegram confirmed delivery: save its ID and mark published.
        const result = db.prepare(`
            UPDATE drafts
            SET status = 'published',
                destination_message_id = ?,
                last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'publishing'
        `).run(messageId, id);

        if (result.changes !== 1) {
            throw new Error("Could not record Telegram confirmation");
        }
    } catch (error) {
        console.error(
            `Publication needs checking for draft ${id}:`,
            error
        );

        // Keep the draft locked because delivery may have succeeded.
        try {
            db.prepare(`
                UPDATE drafts
                SET last_error = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'publishing'
            `).run(
                "Publication not confirmed. Check Telegram and n8n before retrying.",
                id
            );
        } catch (databaseError) {
            console.error(
                "Could not record publication error:",
                databaseError
            );
        }

        return {
            success: false,
            message: "Publication not confirmed. Check Telegram and n8n.",
        };
    }

    return {
        success: true,
        message: "Published successfully.",
    };
}