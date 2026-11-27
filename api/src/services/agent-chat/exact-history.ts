/**
 * Byte-exact prompt-cache preservation across Postgres JSONB persistence.
 *
 * Adapted directly from Aura (`crm-chat-api/lib/trace/exact-history.ts` and
 * `crm-chat-api/AGENTS.md` "Same bytes after a new message"):
 *
 *   - PostgreSQL `jsonb` sorts object keys by `(utf8_byte_length ASC, byte_order ASC)`.
 *     String values (such as Anthropic `providerMetadata.anthropic.signature`) are never
 *     altered, so thinking signatures stay byte-exact — but live tool outputs serialize
 *     in JS insertion order on turn 1 and in PG `jsonb` order after a reload, breaking
 *     prompt-cache prefix equality if left unordered.
 *   - `jsonbOrdered()` sorts plain-object keys in exact Postgres `jsonb` order.
 *   - `withJsonbOrderedOutputs(tools)` wraps executable tools (NON-async, preserving
 *     async-iterable streaming tools verbatim) so live outputs already match PG `jsonb`
 *     key order on turn 1.
 *   - `normalizeReloadedToolParts(messages, tools)` validates persisted tool inputs
 *     through each tool's `inputSchema` (recovering the exact schema key order AI SDK
 *     produced live) and normalizes `output-available` tool outputs with `jsonbOrdered`.
 */
import { asSchema, type UIMessage } from "ai";

/** Exact Postgres `jsonb` object-key comparator: shorter UTF-8 byte length first, then bytewise. */
export function jsonbKeyOrder(left: string, right: string): number {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length - b.length || Buffer.compare(a, b);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Recursively reorder plain-object keys into exact Postgres `jsonb` key order.
 * Non-plain objects (Date, Uint8Array, class instances) and primitives pass through unchanged.
 */
export function jsonbOrdered<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => jsonbOrdered(item)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(jsonbKeyOrder)) {
    const entry = value[key];
    if (entry !== undefined) {
      ordered[key] = jsonbOrdered(entry);
    }
  }
  return ordered as T;
}

interface ExecutableToolLike {
  execute: (input: unknown, options: unknown) => unknown;
}

function isExecutableTool(value: unknown): value is ExecutableToolLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

/**
 * Wrap every executable tool in `tools` so its return value (or each yielded
 * chunk of a streaming async-iterable tool) is in exact Postgres `jsonb` key order.
 *
 * Deliberately NOT `async`: a streaming tool returns an async iterable that the
 * AI SDK must receive synchronously to drive preliminary outputs; awaiting it
 * would hand back the un-run generator object.
 */
export function withJsonbOrderedOutputs<T extends Record<string, unknown>>(
  tools: T,
): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, value]) => {
      if (!isExecutableTool(value)) {
        return [name, value];
      }
      const execute = (input: unknown, options: unknown) => {
        const result = value.execute(input, options);
        if (isAsyncIterable(result)) {
          return (async function* () {
            for await (const part of result) {
              yield jsonbOrdered(part);
            }
          })();
        }
        return Promise.resolve(result).then(jsonbOrdered);
      };
      return [name, { ...value, execute }];
    }),
  ) as T;
}

/**
 * Extract the tool name from a UI message part:
 *   - `dynamic-tool` -> `part.toolName`
 *   - `tool-<name>`  -> `<name>`
 *   - anything else  -> `null`
 */
export function toolNameOfPart(part: {
  type?: unknown;
  toolName?: unknown;
}): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : null;
  }
  return typeof part.type === "string" && part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : null;
}

type LooseToolPart = {
  type: string;
  toolName?: unknown;
  state?: unknown;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
};

async function normalizeToolPart(
  part: LooseToolPart,
  tools: Record<string, unknown>,
): Promise<LooseToolPart> {
  const name = toolNameOfPart(part);
  if (name == null) {
    return part;
  }

  const inputSchema = (tools[name] as { inputSchema?: unknown } | undefined)
    ?.inputSchema;
  let validatedInput: { ok: true; value: unknown } | null = null;

  if (inputSchema != null && part.input !== undefined) {
    try {
      const schema = asSchema(inputSchema as Parameters<typeof asSchema>[0]);
      const validated = await schema.validate?.(part.input);
      if (validated?.success) {
        validatedInput = { ok: true, value: validated.value };
      }
    } catch {
      // Schema changed or legacy tool arguments no longer validate; keep stored input as-is.
    }
  }

  const hasOutput =
    part.state === "output-available" &&
    Object.prototype.hasOwnProperty.call(part, "output");

  if (!validatedInput && !hasOutput) {
    return part;
  }

  return {
    ...part,
    ...(validatedInput ? { input: validatedInput.value } : {}),
    ...(hasOutput ? { output: jsonbOrdered(part.output) } : {}),
  };
}

/**
 * Normalize reloaded tool parts in `messages` before `convertToModelMessages`:
 *   1. Re-validate tool `input` through `tools[name].inputSchema` so key order
 *      matches what the AI SDK produced on the live turn.
 *   2. Order `output-available` tool outputs with `jsonbOrdered()` so both live
 *      and PG-reloaded history serialize to the exact same bytes.
 *   3. Leave non-tool parts (text, reasoning + providerMetadata signatures, files)
 *      completely untouched.
 */
export async function normalizeReloadedToolParts<M extends UIMessage>(
  messages: readonly M[],
  tools: Record<string, unknown>,
): Promise<M[]> {
  return Promise.all(
    messages.map(async message => {
      if (!Array.isArray(message.parts) || message.parts.length === 0) {
        return message;
      }
      const parts = await Promise.all(
        message.parts.map(part =>
          normalizeToolPart(part as LooseToolPart, tools),
        ),
      );
      return { ...message, parts: parts as M["parts"] };
    }),
  );
}
