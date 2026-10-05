"use server";

// import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
// import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getCurrentAccess } from "@/lib/access";

type SaveState = {
  success: boolean;
  message: string;
};

export async function saveDraft(
  _previousState: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const access = await getCurrentAccess();

  if (!access?.isApprovedOwner) {
    return {
      success: false,
      message: "Access denied. An approved owner account is required.",
    };
  }

  const id = Number(formData.get("draftId"));
  const intent = formData.get("intent") ?? "save";
  const text = formData.get("finalText");

  if (!Number.isSafeInteger(id) || id <= 0) {
    return { success: false, message: "Invalid draft ID." };
  }

  if (intent !== "save" && intent !== "approve" && intent !== "reject") {
    return { success: false, message: "Invalid action." };
  }

  if (
    intent !== "reject" &&
    (typeof text !== "string" || !text.trim() || text.length > 20000)
  ) {
    return {
      success: false,
      message: "Enter text between 1 and 20,000 characters.",
    };
  }

  try {
    const result =
      intent === "reject"
        ? db
            .prepare(
              `
                UPDATE drafts
                SET status = 'rejected',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'pending'
            `,
            )
            .run(id)
        : db
            .prepare(
              `
                UPDATE drafts
                SET final_text = ?,
                    status = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'pending'
            `,
            )
            .run(
              text as string,
              intent === "approve" ? "approved" : "pending",
              id,
            );

    if (result.changes === 0) {
      return {
        success: false,
        message: "Draft not found or already reviewed. Refresh the page.",
      };
    }
  } catch (error) {
    console.error("Updating draft failed:", error);

    return {
      success: false,
      message: "Could not update the draft. Please try again.",
    };
  }

  revalidatePath("/review");

  const messages = {
    save: "Changes saved.",
    approve: "Draft approved.",
    reject: "Draft rejected.",
  };

  return { success: true, message: messages[intent] };
}
