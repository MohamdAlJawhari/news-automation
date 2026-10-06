"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { ensureDefaultCampaign } from "@/lib/default-campaign";

function finish(message: string): never {
  revalidatePath("/users");
  revalidatePath("/account-status");
  revalidatePath("/workspace/sources");
  revalidatePath("/workspace/ai-settings");
  revalidatePath("/workspace/ai-drafts");
  redirect(`/users?message=${encodeURIComponent(message)}`);
}

export async function updateUserAccess(formData: FormData) {
  const session = await requireAdmin();

  const userId = formData.get("userId");
  const status = formData.get("status");

  const rssEnabled = formData.get("rssEnabled") === "on";
  const automationEnabled = formData.get("automationEnabled") === "on";

  if (
    typeof userId !== "string" ||
    !userId.trim() ||
    userId === session.user.id
  ) {
    finish("Invalid user. You cannot change your own access here.");
  }

  if (
    status !== "PENDING" &&
    status !== "APPROVED" &&
    status !== "REJECTED" &&
    status !== "SUSPENDED"
  ) {
    finish("Invalid account status.");
  }

  if (status === "APPROVED" && !rssEnabled && !automationEnabled) {
    finish("Select RSS, Telegram automation, or both before approving.");
  }

  let message: string;

  try {
    message = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({
        where: { id: userId },
        select: {
          name: true,
          emailVerified: true,
          platformRole: true,
        },
      });

      if (!target || target.platformRole !== "USER") {
        return "User not found, or this account is an owner.";
      }

      if (status === "APPROVED" && !target.emailVerified) {
        return "A verified email is required before approval.";
      }

      const result = await tx.user.updateMany({
        where: {
          id: userId,
          platformRole: "USER",
          ...(status === "APPROVED" ? { emailVerified: true } : {}),
        },
        data: {
          approvalStatus: status,
        },
      });

      if (result.count !== 1) {
        return "The account changed. Refresh and try again.";
      }

      if (status === "APPROVED") {
        const workspace = await tx.workspace.upsert({
          where: { ownerId: userId },
          create: {
            ownerId: userId,
            name: `${target.name}'s workspace`,
            rssEnabled,
            automationEnabled,
          },
          update: {
            rssEnabled,
            automationEnabled,
          },
        });
        await ensureDefaultCampaign(tx, workspace.id);
      } else {
        await tx.workspace.updateMany({
          where: { ownerId: userId },
          data: {
            rssEnabled: false,
            automationEnabled: false,
          },
        });
      }

      return "Account status and feature access saved.";
    });
  } catch (error) {
    console.error("Updating user access failed:", error);
    message = "Could not update access. Please try again.";
  }

  finish(message);
}
