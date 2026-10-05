"use server";

import { getCurrentAccess } from "@/lib/access";
import { revalidatePath } from "next/cache";
import { setAutoPublishEnabled } from "@/lib/settings";

type SettingsState = {
  message: string;
  enabled?: boolean;
};

export async function updateAutoPublish(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const access = await getCurrentAccess();

  if (!access?.isApprovedOwner) {
    return {
      message: "Access denied. An approved owner account is required.",
    };
  }

  const value = formData.get("enabled");

  if (value !== "true" && value !== "false") {
    return { message: "Invalid setting." };
  }

  try {
    setAutoPublishEnabled(value === "true");
  } catch (error) {
    console.error("Updating auto-publish failed:", error);
    return { message: "Could not save the setting." };
  }

  revalidatePath("/review");

  return {
    enabled: value === "true",
    message:
      value === "true"
        ? "Automatic publishing enabled for new drafts."
        : "Manual review enabled.",
  };
}
