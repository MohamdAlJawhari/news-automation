"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";

export type RssItemState = {
    success: boolean;
    message: string;
    updatedAt: string;
};

export async function saveRssItem(
    previous: RssItemState,
    formData: FormData
): Promise<RssItemState> {
    const { workspace } = await requireWorkspaceAccess("rss");

    const fail = (message: string): RssItemState => ({
        success: false,
        message,
        updatedAt: previous.updatedAt,
    });

    const id = formData.get("itemId");
    const title = formData.get("title");
    const content = formData.get("content");
    const version = formData.get("updatedAt");
    const visible = formData.get("visible") === "on";

    if (
        typeof id !== "string" ||
        !id ||
        id.length > 100 ||
        typeof version !== "string"
    ) {
        return fail("Invalid item. Refresh the page and try again.");
    }

    const expectedUpdatedAt = new Date(version);

    if (
        !Number.isFinite(expectedUpdatedAt.getTime()) ||
        expectedUpdatedAt.toISOString() !== version
    ) {
        return fail("Invalid item version. Refresh the page.");
    }

    if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 200
    ) {
        return fail("Enter a title between 1 and 200 characters.");
    }

    if (
        typeof content !== "string" ||
        !content.trim() ||
        content.length > 20000
    ) {
        return fail("Enter content between 1 and 20,000 characters.");
    }

    // Always advance the timestamp, even for very fast consecutive saves.
    const updatedAt = new Date(
        Math.max(Date.now(), expectedUpdatedAt.getTime() + 1)
    );

    try {
        const result = await prisma.rssItem.updateMany({
            where: {
                id,
                workspaceId: workspace.id,
                updatedAt: expectedUpdatedAt,
            },
            data: {
                title: title.trim(),
                content: content.trim(),
                visible,
                updatedAt,
            },
        });

        if (result.count !== 1) {
            return fail(
                "This item changed or is unavailable. Copy any unsaved text, then reload the page."
            );
        }
    } catch {
        return fail("Could not save this item. Please try again.");
    }

    revalidatePath("/workspace/rss/items");

    return {
        success: true,
        message: visible
            ? "Saved. This item is eligible to appear in the RSS feed."
            : "Saved. This item is hidden from the RSS feed.",
        updatedAt: updatedAt.toISOString(),
    };
}