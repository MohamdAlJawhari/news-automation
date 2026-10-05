"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { normalizeUsername } from "@/lib/channels";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function finish(message: string): never {
    revalidatePath("/channels");
    redirect(`/channels?message=${encodeURIComponent(message)}`);
}

export async function addChannel(formData: FormData) {
    await requireAdmin();

    const username = normalizeUsername(
        String(formData.get("channel") ?? "")
    );

    if (!username) {
        finish("Enter a public channel username or a t.me channel link.");
    }

    if (username === "news_output_test") {
        finish("The output channel cannot also be a source.");
    }

    let message: string;

    try {
        const result = db.prepare(`
            INSERT INTO source_channels (username)
            VALUES (?)
            ON CONFLICT(username) DO NOTHING
        `).run(username);

        message = result.changes === 1
            ? "Channel added. Check the reader terminal for connection status."
            : "This channel is already listed.";
    } catch (error) {
        console.error("Adding channel failed:", error);
        message = "Could not add the channel.";
    }

    finish(message);
}

export async function setChannelEnabled(formData: FormData) {
    await requireAdmin();

    const id = Number(formData.get("id"));
    const enabled = formData.get("enabled");

    if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        (enabled !== "0" && enabled !== "1")
    ) {
        finish("Invalid channel setting.");
    }

    let message: string;

    try {
        const result = db.prepare(`
            UPDATE source_channels SET enabled = ? WHERE id = ?
        `).run(Number(enabled), id);

        message = result.changes === 1
            ? "Setting saved. Allow 15 seconds for the reader to refresh."
            : "Channel not found.";
    } catch (error) {
        console.error("Updating channel failed:", error);
        message = "Could not update the channel.";
    }

    finish(message);
}