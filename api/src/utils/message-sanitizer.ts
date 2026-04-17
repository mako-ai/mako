import type { UIMessage } from "ai";

/**
 * Sanitize UIMessages by removing incomplete tool parts.
 *
 * When a chat stream is interrupted (user closes browser, network failure, etc.),
 * tool parts may be saved to the database in an incomplete state (e.g., "input-available",
 * "input-streaming") without a corresponding result. When the user resumes the chat,
 * these malformed messages would cause Anthropic API errors:
 *
 *   "tool_use ids were found without tool_result blocks immediately after"
 *
 * This function filters out incomplete tool parts before sending to the model.
 * Tool parts are considered complete only if their state is:
 * - "output-available" (successful completion)
 * - "error" (failed with error result)
 *
 * All other states indicate incomplete tool calls that should be removed.
 */
export function sanitizeMessagesForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map(msg => {
    // Only assistant messages can have tool parts
    if (msg.role !== "assistant") {
      return msg;
    }

    // Empty assistant messages (e.g. from interrupted streams persisted with
    // no content) must not be forwarded to `convertToModelMessages`, which
    // throws "The messages do not match the ModelMessage[] schema." Replace
    // with the same placeholder we use for tool-only messages below.
    if (!msg.parts || msg.parts.length === 0) {
      return {
        ...msg,
        parts: [{ type: "text" as const, text: "[Response interrupted]" }],
      };
    }

    const sanitizedParts = msg.parts.filter(part => {
      const partType = part.type;

      // Keep all non-tool parts (text, reasoning, etc.)
      if (
        typeof partType !== "string" ||
        (!partType.startsWith("tool-") && partType !== "dynamic-tool")
      ) {
        return true;
      }

      // For tool parts, only keep those with complete states
      const state = (part as Record<string, unknown>).state as
        | string
        | undefined;

      // Complete states: output-available (success) or error (failed but has result)
      // Incomplete states: input-streaming, input-available, output-streaming, undefined
      return state === "output-available" || state === "error";
    });

    // If all parts were filtered out, return a minimal message to preserve structure
    // This prevents empty assistant messages which could confuse the model
    if (sanitizedParts.length === 0) {
      return {
        ...msg,
        parts: [{ type: "text" as const, text: "[Response interrupted]" }],
      };
    }

    // If nothing changed, return original to preserve object identity
    if (sanitizedParts.length === msg.parts.length) {
      return msg;
    }

    return { ...msg, parts: sanitizedParts };
  });
}
