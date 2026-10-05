"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
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
        const result = await prisma.sourceChannel.createMany({
            data: [
                {
                    workspaceId: workspace.id,
                    username,
                },
            ],
            skipDuplicates: true,
        });

        message =
            result.count === 1
                ? "Source added. Telegram connection verification is pending."
                : "This source is already in your workspace.";
    } catch (error) {
        console.error("Adding workspace source failed:", error);
        message = "Could not add the source.";
    }

    finish(message);
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