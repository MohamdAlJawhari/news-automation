// Shared with the standalone worker: keep this module free of server-only imports.
export const LOCAL_MODELS = ["gpt-oss:latest"] as const;
export const MAX_AI_TEXT = 20000;
export const REQUEST_TIMEOUT_MS = 180000;
export const LEASE_MS = 240000;
export const MAX_ATTEMPTS = 5;
export const OUTPUT_TOKENS = 8192;

export function connectedWorkspace(id: string) {
  return Boolean(process.env.INGEST_WORKSPACE_ID?.trim()) &&
    id === process.env.INGEST_WORKSPACE_ID?.trim();
}

export function effectivePrompt(settings: { systemPrompt: string; editorialPerspective: string }) {
  return settings.systemPrompt.replace(
    "[INSERT COUNTRIES, PARTIES, OR MOVEMENTS]",
    settings.editorialPerspective.trim() || "(empty; use a straightforward news-reporting tone)",
  ) + "\n\nCurrent preferred editorial perspective: " +
    (settings.editorialPerspective.trim() || "(empty; use a straightforward news-reporting tone)");
}

export class PreparationError extends Error {
  constructor(message: string, public retryable = true) { super(message); }
}

export function validateOllamaResponse(value: unknown): string | null {
  if (!value || typeof value !== "object") throw new PreparationError("Invalid Ollama response.");
  const response = value as Record<string, unknown>;
  const message = response.message as Record<string, unknown> | undefined;
  if (response.done !== true || response.done_reason !== "stop" ||
      (typeof response.eval_count === "number" && response.eval_count >= OUTPUT_TOKENS)) {
    throw new PreparationError("Ollama output was incomplete or reached its token limit.");
  }
  if (!message || message.role !== "assistant" || typeof message.content !== "string" ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length)) {
    throw new PreparationError("Invalid Ollama final message.");
  }
  const text = message.content.trim();
  if (!text || text.length > MAX_AI_TEXT) throw new PreparationError("Ollama output is empty or exceeds the text limit.");
  return text === "NO_NEWS_CONTENT" ? null : text;
}
