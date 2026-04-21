import type { UIMessage } from "ai";

/**
 * Check whether a user message has at least one non-empty content part
 * (text with actual characters, or a file attachment).
 */
function userMessageHasContent(parts: UIMessage["parts"]): boolean {
  if (!parts || parts.length === 0) return false;
  return parts.some(part => {
    if (part.type === "text") {
      return (
        typeof (part as { text?: string }).text === "string" &&
        (part as { text: string }).text.trim().length > 0
      );
    }
    if (part.type === "file") return true;
    return false;
  });
}

/**
 * Sanitize a single user message's parts.
 * Strips empty text parts and returns null if nothing usable remains
 * (the caller should drop the message entirely).
 */
function sanitizeUserMessage(msg: UIMessage): UIMessage | null {
  if (!msg.parts || msg.parts.length === 0) {
    return null;
  }

  const cleaned = msg.parts.filter(part => {
    if (part.type === "text") {
      return (
        typeof (part as { text?: string }).text === "string" &&
        (part as { text: string }).text.trim().length > 0
      );
    }
    if (part.type === "file") return true;
    return false;
  });

  if (!userMessageHasContent(cleaned)) {
    return null;
  }

  if (cleaned.length === msg.parts.length) return msg;
  return { ...msg, parts: cleaned };
}

/**
 * Sanitize a single assistant message's parts.
 * Removes incomplete tool parts and repairs empty assistant messages.
 */
function sanitizeAssistantMessage(msg: UIMessage): UIMessage {
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
    const state = (part as Record<string, unknown>).state as string | undefined;
    return state === "output-available" || state === "error";
  });

  if (sanitizedParts.length === 0) {
    return {
      ...msg,
      parts: [{ type: "text" as const, text: "[Response interrupted]" }],
    };
  }

  if (sanitizedParts.length === msg.parts.length) return msg;
  return { ...msg, parts: sanitizedParts };
}

/**
 * Sanitize UIMessages for safe round-trip through the AI model.
 *
 * Handles both user and assistant messages:
 *
 * **User messages**: drops messages that have no usable content (empty text
 * parts, missing file parts, etc.) so they never reach `convertToModelMessages`
 * which rejects them with "user messages must have non-empty content".
 *
 * **Assistant messages**: removes incomplete tool parts from interrupted
 * streams and replaces empty assistant messages with a placeholder to prevent
 * Anthropic/OpenAI validation errors.
 */
export function sanitizeMessagesForModel(messages: UIMessage[]): UIMessage[] {
  const result: UIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const cleaned = sanitizeUserMessage(msg);
      if (cleaned) result.push(cleaned);
      continue;
    }

    if (msg.role === "assistant") {
      result.push(sanitizeAssistantMessage(msg));
      continue;
    }

    result.push(msg);
  }

  return result;
}
