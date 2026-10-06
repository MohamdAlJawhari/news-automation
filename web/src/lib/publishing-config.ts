export const MAX_TELEGRAM_TEXT = 4096; // Conservative UTF-16 bound, including emoji.
export const BLOCKING_PUBLICATIONS = ["QUEUED", "SENDING", "DELIVERY_UNKNOWN", "PUBLISHED"] as const;
export function destinationUsername(value: unknown) {
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/^(?:https?:\/\/)?t\.me\//i, "").replace(/^@/, "").replace(/\/$/, "").toLowerCase();
  return /^[a-z][a-z0-9_]{3,31}$/.test(username) ? username : null;
}
export function publishedLink(chatId: string | null, messageId: number | null) {
  return chatId && /^-100[1-9]\d{0,15}$/.test(chatId) && messageId && messageId > 0
    ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null;
}

export class PublishingError extends Error {}
