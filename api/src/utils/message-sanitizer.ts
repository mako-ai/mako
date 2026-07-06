import type { UIMessage } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns true when a `file` part is well-formed enough to be converted to
 * model input. The AI SDK `FileUIPart` schema requires a non-empty `mediaType`
 * plus a payload — either a string `url` (data URL or remote URL) or inline
 * `data` (base64 string or `Uint8Array`).
 *
 * Historically, file attachments were persisted before the DB schema stored
 * `url`/`mediaType`, so Mongoose stripped those fields and reduced the part to
 * `{ type: "file", _id }`. Replaying such a part makes the AI SDK throw
 * "Invalid prompt: The messages do not match the ModelMessage[] schema."
 * Validating here lets us drop the unrecoverable part both before sending to
 * the model and before persisting it again.
 */
export function isModelReadyFilePart(part: unknown): boolean {
  if (!isRecord(part) || part.type !== "file") {
    return false;
  }

  const mediaType = part.mediaType;
  const url = part.url;
  const data = part.data;

  return (
    typeof mediaType === "string" &&
    mediaType.length > 0 &&
    ((typeof url === "string" && url.length > 0) ||
      (typeof data === "string" && data.length > 0) ||
      data instanceof Uint8Array)
  );
}

/**
 * Drop malformed `file` parts from a message's parts array. Non-file parts are
 * always kept; file parts are kept only when model-ready. The unrecoverable
 * file payload is dropped so the rest of the conversation (and any sibling text
 * part) still goes through.
 */
function dropMalformedFileParts(
  parts: ReadonlyArray<{ type: string } & Record<string, unknown>>,
): Array<{ type: string } & Record<string, unknown>> {
  return parts.filter(part =>
    part?.type === "file" ? isModelReadyFilePart(part) : true,
  );
}

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
 *
 * It also drops malformed `file` parts (missing `url`/`mediaType`) on any
 * message role, which otherwise make `convertToModelMessages` reject the entire
 * request with "The messages do not match the ModelMessage[] schema."
 */
export function sanitizeMessagesForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map(msg => {
    // Drop malformed file parts on every message role first — a single broken
    // file part (e.g. a legacy `{ type: "file", _id }`) poisons the whole
    // request, not just assistant messages.
    const fileSafeParts = dropMalformedFileParts(
      (msg.parts ?? []) as Array<{ type: string } & Record<string, unknown>>,
    );

    // Non-assistant messages only need the file-part repair. Guard against a
    // user/system message being left with zero parts (e.g. it contained only a
    // broken attachment) — an empty parts array also fails schema validation.
    if (msg.role !== "assistant") {
      if (fileSafeParts.length === (msg.parts?.length ?? 0)) {
        return msg;
      }
      if (fileSafeParts.length === 0) {
        return {
          ...msg,
          parts: [{ type: "text" as const, text: "[Attachment removed]" }],
        };
      }
      return { ...msg, parts: fileSafeParts as UIMessage["parts"] };
    }

    // Empty assistant messages (e.g. from interrupted streams persisted with
    // no content) must not be forwarded to `convertToModelMessages`, which
    // throws "The messages do not match the ModelMessage[] schema." Replace
    // with the same placeholder we use for tool-only messages below.
    if (fileSafeParts.length === 0) {
      return {
        ...msg,
        parts: [{ type: "text" as const, text: "[Response interrupted]" }],
      };
    }

    const partsNormalized = fileSafeParts.map(part => {
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

      // Match AI SDK UIToolInvocation terminal states (see convert-to-model-messages.ts).
      // `approval-responded` is deliberately kept: an approved-but-unexecuted
      // tool call (MCP human-in-the-loop) is converted into a
      // tool-approval-response, which is what makes streamText execute the
      // tool on the continuation request. Dropping it would make the model
      // re-issue the call — an endless approval loop. Unanswered
      // `approval-requested` parts are still dropped (no response exists yet).
      return (
        state === "output-available" ||
        state === "output-error" ||
        state === "output-denied" ||
        state === "approval-responded"
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

    return { ...msg, parts: sanitizedParts as UIMessage["parts"] };
  });
}
