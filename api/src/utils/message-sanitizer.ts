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
 * AI SDK `convertToModelMessages` (v6) emits a tool-result only for tool UI states
 * `output-available`, `output-error`, and `output-denied`. A legacy `state: "error"`
 * (used by older client normalization) still produces a tool-call but no tool-result,
 * which triggers the Anthropic error above. We map `error` → `output-error` first.
 *
 * This function filters out incomplete tool parts before sending to the model.
 * Complete tool states: output-available, output-error, output-denied.
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

    const partsNormalized = msg.parts.map(part => {
      const partType = part.type;
      if (
        typeof partType !== "string" ||
        (!partType.startsWith("tool-") && partType !== "dynamic-tool")
      ) {
        return part;
      }

      const p = part as Record<string, unknown>;
      if (p.state === "error") {
        const output = p.output as Record<string, unknown> | null | undefined;
        const errorText =
          typeof p.errorText === "string"
            ? p.errorText
            : output != null &&
                typeof output === "object" &&
                typeof output.error === "string"
              ? output.error
              : output != null &&
                  typeof output === "object" &&
                  output.error != null
                ? String(output.error)
                : "Tool failed";
        return {
          ...part,
          state: "output-error",
          output: undefined,
          errorText,
        } as typeof part;
      }
      return part;
    });

    const sanitizedParts = partsNormalized.filter(part => {
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

      // Match AI SDK UIToolInvocation terminal states (see convert-to-model-messages.ts)
      return (
        state === "output-available" ||
        state === "output-error" ||
        state === "output-denied"
      );
    });

    // If all parts were filtered out, return a minimal message to preserve structure
    // This prevents empty assistant messages which could confuse the model
    if (sanitizedParts.length === 0) {
      return {
        ...msg,
        parts: [{ type: "text" as const, text: "[Response interrupted]" }],
      };
    }

    return { ...msg, parts: sanitizedParts };
  });
}
