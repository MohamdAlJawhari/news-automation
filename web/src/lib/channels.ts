import "server-only";
import { db } from "@/lib/db";

db.exec(`
    CREATE TABLE IF NOT EXISTS source_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        enabled INTEGER NOT NULL DEFAULT 1
            CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);

export type SourceChannel = {
    id: number;
    username: string;
    enabled: number;
};

export function getChannels(): SourceChannel[] {
    return db.prepare(`
        SELECT id, username, enabled
        FROM source_channels
        ORDER BY id DESC
    `).all() as SourceChannel[];
}

export function normalizeUsername(value: string): string | null {
    const input = value.trim();

    const link = input.match(
        /^(?:https?:\/\/)?(?:www\.)?t\.me\/([a-zA-Z0-9_]+)\/?$/i
    );

    const username = (link ? link[1] : input.replace(/^@/, ""))
        .toLowerCase();

    return /^[a-z][a-z0-9_]{3,31}$/.test(username)
        ? username
        : null;
}