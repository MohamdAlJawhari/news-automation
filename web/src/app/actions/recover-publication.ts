"use server";

import { db } from "@/lib/db";
import { getCurrentAccess } from "@/lib/access";
import { revalidatePath } from "next/cache";

type RecoveryState = {
  success: boolean;
  message: string;
};

export async function recoverPublication(
  _previousState: RecoveryState,
  formData: FormData,
): Promise<RecoveryState> {
  const access = await getCurrentAccess();

  if (!access?.isApprovedOwner) {
    return {
      success: false,
      message: "Access denied. An approved owner account is required.",
    };
  }

  const id = Number(formData.get("draftId"));
  const outcome = formData.get("outcome");
  const checked = formData.get("checked") === "on";

  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !checked ||
    (outcome !== "published" && outcome !== "not-sent")
  ) {
    return {
      success: false,
      message: "Choose an outcome and confirm your checks.",
    };
  }

  let messageId: number | null = null;

  if (outcome === "published") {
    const link = String(formData.get("messageLink") ?? "").trim();

    const match = link.match(
      /^https:\/\/t\.me\/news_output_test\/([1-9]\d*)(?:\?[^#]*)?$/,
    );

    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      return {
        success: false,
        message: "Paste the message link from @news_output_test.",
      };
    }

    messageId = Number(match[1]);
  }

  try {
    const recover = db.transaction(() => {
      const draft = db
        .prepare(
          `
                SELECT
                    status,
                    updated_at <= datetime('now', '-5 minutes') AS old_enough
                FROM drafts
                WHERE id = ?
            `,
        )
        .get(id) as
        | {
            status: string;
            old_enough: number;
          }
        | undefined;

      if (!draft || draft.status !== "publishing") {
        return "This draft no longer needs publication recovery.";
      }

      if (!draft.old_enough) {
        return "Wait five minutes after the last publication update before recovering.";
      }

      if (messageId !== null) {
        const existing = db
          .prepare(
            `
                    SELECT id FROM drafts
                    WHERE destination_message_id = ? AND id <> ?
                `,
          )
          .get(messageId, id);

        if (existing) {
          return "That Telegram message is already linked to another draft.";
        }
      }

      const result = db
        .prepare(
          `
                UPDATE drafts
                SET status = ?,
                    destination_message_id = ?,
                    last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'publishing'
            `,
        )
        .run(outcome === "published" ? "published" : "approved", messageId, id);

      return result.changes === 1 ? null : "Draft changed. Refresh the page.";
    });

    const error = recover.immediate();

    if (error) {
      return { success: false, message: error };
    }
  } catch (error) {
    console.error("Publication recovery failed:", error);

    return {
      success: false,
      message: "Could not update the draft. Please try again.",
    };
  }

  revalidatePath("/review");

  return {
    success: true,
    message:
      outcome === "published"
        ? "Existing publication recorded."
        : "Returned to approved. Nothing was sent.",
  };
}
