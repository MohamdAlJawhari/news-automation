"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { lockPublishing } from "@/lib/publishing-db";
import { hasAiAccess } from "@/lib/ai-db";
import {
    requireSourceManagementAccess,
} from "@/lib/workspace-access";

function finish(message: string): never {
    revalidatePath("/workspace/sources");
    redirect(
        `/workspace/sources?message=${encodeURIComponent(message)}`
    );
}

function normalizeUsername(value: string): string | null {
    const input = value.trim();

    if (!input || input.length > 200) return null;

    const link = input.match(
        /^(?:https?:\/\/)?(?:www\.)?t\.me\/([a-zA-Z0-9_]+)\/?$/i
    );

    const username = (
        link ? link[1] : input.replace(/^@/, "")
    ).toLowerCase();

    return /^[a-z][a-z0-9_]{3,31}$/.test(username)
        ? username
        : null;
}

export async function addWorkspaceSource(formData: FormData) {
    const { workspace } = await requireSourceManagementAccess();

    const value = formData.get("channel");

    const username =
        typeof value === "string"
            ? normalizeUsername(value)
            : null;

    if (!username) {
        finish("Enter a public channel username or a t.me channel link.");
    }

    let message: string;

    try {
        const result = await prisma.$transaction(async tx => {
          const { settings } = await lockPublishing(tx, workspace.id);
          if (settings?.destinationUsername === username) return { count: -1 };
          return tx.sourceChannel.createMany({
            data: [
                {
                    workspaceId: workspace.id,
                    username,
                },
            ],
            skipDuplicates: true,
          });
        });

        message =
            result.count === 1
                ? "Source added. Telegram connection verification is pending."
                : result.count === -1 ? "The publishing destination cannot be a source." : "This source is already in your workspace.";
    } catch (error) {
        console.error("Adding workspace source failed:", error);
        message = "Could not add the source.";
    }

    finish(message);
}

export async function setSourceTelegramAutomation(formData: FormData) {
    const { workspace } = await requireSourceManagementAccess();
    const id = formData.get("sourceId");
    const enabled = formData.get("enabled") === "true";
    if (typeof id !== "string" || id.length > 100) finish("Invalid source.");
    const count = await prisma.$transaction(async tx => {
        const { workspace: access } = await lockPublishing(tx, workspace.id);
        if (!hasAiAccess(access)) return 0;
        return (await tx.sourceChannel.updateMany({ where: { id, workspaceId: workspace.id }, data: { telegramAutomationEnabled: enabled } })).count;
    });
    finish(count ? "Telegram automation saved. Collected posts, existing drafts and RSS are preserved. A send already in flight cannot be recalled." : "Source or automation access is unavailable.");
}

export async function setWorkspaceSourceEnabled(
    formData: FormData
) {
    const { workspace } = await requireSourceManagementAccess();

    const id = formData.get("sourceId");
    const enabled = formData.get("enabled");

    if (
        typeof id !== "string" ||
        !id.trim() ||
        (enabled !== "true" && enabled !== "false")
    ) {
        finish("Invalid source setting.");
    }

    let message: string;

    try {
        const result = await prisma.sourceChannel.updateMany({
            where: {
                id,
                workspaceId: workspace.id,
            },
            data: {
                enabled: enabled === "true",
            },
        });

        message =
            result.count === 1
                ? "Source setting saved."
                : "Source not found in your workspace.";
    } catch (error) {
        console.error("Updating workspace source failed:", error);
        message = "Could not update the source.";
    }

    finish(message);
}
