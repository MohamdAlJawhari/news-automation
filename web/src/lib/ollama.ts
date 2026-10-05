import { LOCAL_MODELS, MAX_AI_TEXT, OUTPUT_TOKENS, PreparationError,
  REQUEST_TIMEOUT_MS, validateOllamaResponse } from "./ai-config";

export async function rewriteWithOllama(model: string, system: string, original: string) {
  if (!LOCAL_MODELS.some((allowed) => allowed === model)) {
    throw new PreparationError("Model is not in the configured local allowlist.", false);
  }
  if (!original.trim() || original.length > MAX_AI_TEXT) {
    throw new PreparationError("Original text is empty or exceeds the input limit.", false);
  }
  const endpoint = new URL("/api/chat", process.env.OLLAMA_URL || "http://127.0.0.1:11434");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, think: "low",
        messages: [{ role: "system", content: system }, { role: "user", content: original }],
        // Smaller evaluation batches avoid CUDA allocation failures on the
        // initial Windows installation. Retain context and final-output bounds.
        options: { num_predict: OUTPUT_TOKENS, num_ctx: 32768, num_batch: 64 },
      }),
    });
    if (!response.ok) {
      throw new PreparationError(`Ollama HTTP ${response.status}.`,
        response.status === 408 || response.status === 429 || response.status >= 500);
    }
    // Bound the entire response, including thinking, before parsing JSON.
    const reader = response.body?.getReader();
    if (!reader) throw new PreparationError("Ollama returned no response body.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new PreparationError("Ollama response exceeds the response limit.");
      }
      chunks.push(chunk.value);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new PreparationError("Ollama returned invalid JSON."); }
    return validateOllamaResponse(value);
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    throw new PreparationError(controller.signal.aborted
      ? "Ollama request timed out." : "Ollama connection or response failed.");
  } finally { clearTimeout(timer); }
}
