import "server-only";
import { db } from "@/lib/db";

db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    INSERT INTO app_settings (key, value)
    VALUES ('auto_publish', 'false')
    ON CONFLICT(key) DO NOTHING;
`);

export function isAutoPublishEnabled(): boolean {
    const row = db.prepare(`
        SELECT value FROM app_settings WHERE key = 'auto_publish'
    `).get() as { value: string } | undefined;

    return row?.value === "true";
}

export function setAutoPublishEnabled(enabled: boolean) {
    db.prepare(`
        UPDATE app_settings SET value = ? WHERE key = 'auto_publish'
    `).run(String(enabled));
}