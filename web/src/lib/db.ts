import "server-only";

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

function createDatabase() {
    const dataDirectory = path.join(process.cwd(), "data");

    mkdirSync(dataDirectory, { recursive: true });

    const database = new Database(
        path.join(dataDirectory, "news.db")
    );

    database.pragma("journal_mode = WAL");

    database.exec(`
        CREATE TABLE IF NOT EXISTS drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            source_chat_id TEXT NOT NULL,
            source_message_id INTEGER NOT NULL,
            source_url TEXT,

            original_text TEXT NOT NULL,
            ai_text TEXT NOT NULL,
            final_text TEXT NOT NULL,

            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (
                    status IN (
                        'pending',
                        'approved',
                        'rejected',
                        'publishing',
                        'published',
                        'failed'
                    )
                ),

            destination_message_id INTEGER,
            last_error TEXT,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(source_chat_id, source_message_id)
        );
    `);

    return database;
}

const globalForDatabase = globalThis as unknown as {
    newsDatabase?: ReturnType<typeof createDatabase>;
};

export const db =
    globalForDatabase.newsDatabase ?? createDatabase();

if (process.env.NODE_ENV !== "production") {
    globalForDatabase.newsDatabase = db;
}