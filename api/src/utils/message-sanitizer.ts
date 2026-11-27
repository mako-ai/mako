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
 * Coerce a persisted tool-call input into the plain object shape providers
 * require. Anthropic rejects any replayed `tool_use` whose `input` is not a
 * JSON object ("Input should be a valid dictionary"), which happens when:
 *
 * - the model emitted malformed/truncated tool-call JSON (the AI SDK keeps
 *   the raw text on `rawInput` and leaves `input` undefined), or
 * - a stream was interrupted mid tool-input and the client persisted the
 *   partial raw string.
 *
 * `convertToModelMessages` (v6) forwards `input ?? rawInput` verbatim for
 * `output-error` parts, so a string leaks straight through to the provider.
 * Strings that parse to an object are recovered; everything else falls back
 * to `{}` (the tool-result/errorText still tells the model what happened).
 */
function coerceToolInputToObject(input: unknown, rawInput: unknown): unknown {
  const candidates = [input, rawInput];
  for (const candidate of candidates) {
    if (isRecord(candidate) && !Array.isArray(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (isRecord(parsed) && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Malformed JSON (e.g. truncated stream) — fall through.
      }
    }
  }
  return {};
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
      // Providers require tool_use.input to be a JSON object on replay; a
      // string/undefined input (invalid tool call, interrupted stream) must
      // be repaired here or the whole continuation request 400s. `rawInput`
      // is dropped so `convertToModelMessages` cannot fall back to the raw
      // (possibly malformed) string for output-error parts.
      const input = coerceToolInputToObject(p.input, p.rawInput);
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
          input,
          rawInput: undefined,
          output: undefined,
          errorText,
        } as typeof part;
      }
      return {
        ...part,
        input,
        rawInput: undefined,
      } as typeof part;
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
        string | undefined;

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

/**
 * Matches NUL bytes (`\u0000`) and UTF-16 surrogates (`\uD800`–`\uDFFF`) so
 * common clean strings skip allocation on the fast path.
 */
// eslint-disable-next-line no-control-regex
const PG_UNSAFE_UNICODE_RE = /[\u0000\uD800-\uDFFF]/;

/**
 * Strip NUL bytes (`\u0000`) and replace unpaired UTF-16 surrogates with
 * U+FFFD while preserving valid surrogate pairs (emojis / astral plane)
 * verbatim. Prevents Postgres `22021` (text) and `22P05` (jsonb) errors.
 */
export function sanitizePgString(str: string): string {
  if (!PG_UNSAFE_UNICODE_RE.test(str)) return str;
  let out = "";
  let dirty = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0) {
      dirty = true;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += str[i] + str[i + 1];
          i += 1;
          continue;
        }
      }
      dirty = true;
      out += "\uFFFD";
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      dirty = true;
      out += "\uFFFD";
      continue;
    }
    out += str[i];
  }
  return dirty ? out : str;
}

/**
 * Truncate a UTF-16 string to at most `maxLen` code units without splitting a
 * valid surrogate pair in half (which would create an unpaired high surrogate
 * rejected by Postgres `jsonb`).
 */
export function sliceSafeUtf16(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  if (maxLen <= 0) return "";
  let end = maxLen;
  const lastCode = str.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return str.slice(0, end);
}

/**
 * Recursively sanitize all strings (values and plain-object keys) inside a
 * JSON-serializable structure for Postgres `text`/`jsonb` safety. Returns the
 * original reference unchanged when nothing inside needed sanitization.
 */
export function sanitizePgJsonValue<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizePgString(value) as T;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (value instanceof Date || value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const next = sanitizePgJsonValue(value[i]);
      if (next !== value[i]) changed = true;
      out[i] = next;
    }
    return (changed ? out : value) as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const cleanKey = sanitizePgString(key);
    const val = rec[key];
    const cleanVal = sanitizePgJsonValue(val);
    if (cleanKey !== key || cleanVal !== val) {
      changed = true;
    }
    out[cleanKey] = cleanVal;
  }
  return (changed ? out : value) as T;
}

/**
 * Shrink assistant TOOL outputs before persistence (§13.25) and strip
 * Postgres-illegal NUL bytes (`\u0000`) / unpaired UTF-16 surrogates across
 * all message parts and metadata. Found on prod: an app_browse-heavy turn
 * carries screenshots as base64 inside tool outputs; externalizeChatAttachments
 * only covers user image `file` parts, so the stored messages array blew past
 * MongoDB's 16 MB BSON limit and the WHOLE save threw — caught by a log-only
 * catch, the entire turn vanished on reload while the agent's work (commits,
 * publishes) survived. The screenshot's post-turn value is nil (the model
 * already saw it), so it is dropped here; any other pathologically large output
 * is truncated on a UTF-16 code-point boundary with a marker rather than
 * sinking the save.
 */
const MAX_STORED_TOOL_OUTPUT_BYTES = 256 * 1024;

export function sanitizeMessagesForPersistence(
  messages: UIMessage[],
): UIMessage[] {
  return messages.map(message => {
    let nextMessage = message;

    if (message.role === "assistant" && Array.isArray(message.parts)) {
      let changed = false;
      const parts = message.parts.map(part => {
        if (!isRecord(part) || typeof part.type !== "string") return part;
        if (!part.type.startsWith("tool-")) return part;
        const output = (part as { output?: unknown }).output;
        if (!isRecord(output)) return part;
        let next = output;
        if (typeof next.screenshotBase64 === "string") {
          const { screenshotBase64: _dropped, ...rest } = next;
          next = { ...rest, screenshotOmitted: true };
        }
        const serialized = JSON.stringify(next);
        const size = Buffer.byteLength(serialized, "utf8");
        if (size > MAX_STORED_TOOL_OUTPUT_BYTES) {
          next = {
            truncatedForStorage: true,
            originalBytes: size,
            preview: sliceSafeUtf16(serialized, 4096),
          };
        }
        if (next === output) return part;
        changed = true;
        return { ...part, output: next };
      });
      if (changed) {
        nextMessage = { ...message, parts: parts as typeof message.parts };
      }
    }

    return sanitizePgJsonValue(nextMessage);
  });
}

/**
 * Last-resort shrink for a BSON-overflow retry: every tool output becomes a
 * small preview. Losing tool payloads beats losing the conversation.
 */
export function stripToolOutputsForRetry(messages: UIMessage[]): UIMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) {
      return sanitizePgJsonValue(message);
    }
    const parts = message.parts.map(part => {
      if (!isRecord(part) || typeof part.type !== "string") return part;
      if (!part.type.startsWith("tool-")) return part;
      const output = (part as { output?: unknown }).output;
      if (output === undefined) return part;
      return {
        ...part,
        output: {
          truncatedForStorage: true,
          preview: sanitizePgString(
            sliceSafeUtf16(JSON.stringify(output ?? null), 1024),
          ),
        },
      };
    });
    return sanitizePgJsonValue({
      ...message,
      parts: parts as typeof message.parts,
    });
  });
}
