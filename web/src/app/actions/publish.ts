"use server";

import { getCurrentAccess } from "@/lib/access";
import { revalidatePath } from "next/cache";
import { publishSavedDraft } from "@/lib/publish-draft";

type PublishState = {
  success: boolean;
  message: string;
};

export async function publishDraft(
  _previousState: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const access = await getCurrentAccess();

  if (!access?.isApprovedOwner) {
    return {
      success: false,
      message: "Access denied. An approved owner account is required.",
    };
  }

  const id = Number(formData.get("draftId"));
  const result = await publishSavedDraft(id, "manual");

  revalidatePath("/review");

  return result;
}
