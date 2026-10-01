/**
 * Tool-output caps: keep any single tool result from flooding the prompt.
 *
 * Every tool result is re-sent on every later step of the turn (the agent
 * loop replays the whole history each step) and replayed verbatim for the
 * next turns too, so one `npm run build` log or one minified bundle read can
 * cost hundreds of thousands of input tokens. The caps are applied where the
 * output is PRODUCED — not only in what the model sees — so the persisted
 * chat, the client's replayed `messages[]`, and every later request carry the
 * same small, byte-stable value (which also keeps the prompt cache warm).
 *
 * The shape follows what other coding harnesses converged on (Claude Code,
 * Codex, OpenCode): keep the head AND the tail (errors live at the end), never
 * cut silently — the marker says how much went missing — and, where the full
 * output can be kept somewhere searchable, say where and how to look.
 */

import type { ToolSet, UIMessage } from "ai";
import { loggers } from "../../../logging";

const logger = loggers.agent();

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** app_bash stdout: 4k head (what ran) + 12k tail (how it ended). */
export const BASH_STDOUT_MAX_CHARS = 16_000;
export const BASH_STDOUT_HEAD_CHARS = 4_000;
/** app_bash stderr. */
export const BASH_STDERR_MAX_CHARS = 8_000;
export const BASH_STDERR_HEAD_CHARS = 2_000;

/** app_read_file: whichever of lines / chars runs out first. */
export const READ_DEFAULT_LIMIT_LINES = 2_000;
export const READ_MAX_CHARS = 50_000;
/** One minified line must not be able to eat the whole read budget. */
export const READ_MAX_LINE_CHARS = 2_000;

/** app_grep. */
export const GREP_MAX_MATCHES = 200;
export const GREP_MAX_LINE_CHARS = 500;

/**
 * Backstop for EVERY tool result. Sits above the per-tool caps (SQL/Mongo
 * results cap themselves at 50k), so tools that already behave never hit it —
 * it exists for the tool nobody capped yet, and for client-executed tools
 * whose results arrive from the browser.
 */
export const TOOL_OUTPUT_BACKSTOP_CHARS = 64_000;

/** Head share of a backstop preview; the rest is tail. */
const BACKSTOP_HEAD_RATIO = 0.25;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface CappedText {
  text: string;
  truncated: boolean;
  /** Characters removed from the middle (0 when not truncated). */
  omittedChars: number;
}

/** Never leave half of a UTF-16 surrogate pair at a cut. */
function safeEnd(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return end > 0 && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function safeStart(text: string, start: number): number {
  const code = text.charCodeAt(start);
  return start < text.length && code >= 0xdc00 && code <= 0xdfff
    ? start + 1
    : start;
}

/** How far a cut may move to land on a line boundary. */
const LINE_SNAP_WINDOW = 200;

/**
 * Keep the first `headChars` and the last `maxChars - headChars` characters
 * of `text`, with a marker in between that names how much was cut. Cuts snap
 * to a nearby line boundary so neither side starts or ends mid-line.
 */
export function capText(
  text: string,
  opts: { maxChars: number; headChars: number },
): CappedText {
  if (text.length <= opts.maxChars) {
    return { text, truncated: false, omittedChars: 0 };
  }
  const tailChars = Math.max(0, opts.maxChars - opts.headChars);

  let headEnd = Math.min(opts.headChars, text.length);
  const newlineBefore = text.lastIndexOf("\n", headEnd);
  if (newlineBefore > 0 && headEnd - newlineBefore <= LINE_SNAP_WINDOW) {
    headEnd = newlineBefore + 1;
  }
  headEnd = safeEnd(text, headEnd);

  let tailStart = Math.max(headEnd, text.length - tailChars);
  const newlineAfter = text.indexOf("\n", tailStart);
  if (newlineAfter !== -1 && newlineAfter - tailStart <= LINE_SNAP_WINDOW) {
    tailStart = newlineAfter + 1;
  }
  tailStart = safeStart(text, tailStart);

  const omittedChars = tailStart - headEnd;
  const marker = `\n…[${omittedChars.toLocaleString("en-US")} chars omitted]…\n`;
  return {
    text: `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`,
    truncated: true,
    omittedChars,
  };
}

/** Shorten one line, saying how much of it was dropped. */
export function capLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const end = safeEnd(line, maxChars);
  return `${line.slice(0, end)}… [+${(line.length - end).toLocaleString("en-US")} chars]`;
}

// ---------------------------------------------------------------------------
// Paged file reads
// ---------------------------------------------------------------------------

export interface PagedLines {
  /** Selected lines, each already capped at `maxLineChars`. */
  lines: string[];
  /** 1-based number of the first returned line (0 when none returned). */
  startLine: number;
  /** 1-based number of the last returned line (0 when none returned). */
  endLine: number;
  totalLines: number;
  /** Where the next page starts, when lines remain after this page. */
  nextOffset?: number;
  /** Lines in this page that were shortened. */
  longLinesCut: number;
}

/**
 * Select a window of a file's lines: start at 1-based `offset`, stop at
 * `limit` lines or once `maxChars` of (capped) line text is used, whichever
 * comes first. Always returns at least one line when any remain, so paging
 * makes progress even on a pathological line.
 */
export function pageLines(
  contents: string,
  opts: {
    offset?: number;
    limit?: number;
    maxChars?: number;
    maxLineChars?: number;
  } = {},
): PagedLines {
  const all = contents.split("\n");
  // A trailing newline is the end of the last line, not an extra empty line.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const totalLines = contents === "" ? 0 : all.length;
  const limit = Math.max(1, opts.limit ?? READ_DEFAULT_LIMIT_LINES);
  const maxChars = opts.maxChars ?? READ_MAX_CHARS;
  const maxLineChars = opts.maxLineChars ?? READ_MAX_LINE_CHARS;
  const startIdx = Math.max(0, (opts.offset ?? 1) - 1);

  const lines: string[] = [];
  let used = 0;
  let longLinesCut = 0;
  let idx = startIdx;
  for (; idx < totalLines && lines.length < limit; idx++) {
    const raw = all[idx];
    const line = capLine(raw, maxLineChars);
    if (lines.length > 0 && used + line.length + 1 > maxChars) break;
    if (line !== raw) longLinesCut += 1;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    lines,
    startLine: lines.length > 0 ? startIdx + 1 : 0,
    endLine: lines.length > 0 ? startIdx + lines.length : 0,
    totalLines,
    ...(idx < totalLines ? { nextOffset: idx + 1 } : {}),
    longLinesCut,
  };
}

// ---------------------------------------------------------------------------
// Backstop: any tool result
// ---------------------------------------------------------------------------

/** Marker shape of a result replaced by the backstop. */
export interface BackstoppedToolOutput {
  _outputCapped: true;
  originalChars: number;
  note: string;
  preview: string;
}

function isBackstopped(value: unknown): value is BackstoppedToolOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { _outputCapped?: unknown })._outputCapped === true
  );
}

function serializedLength(value: unknown): { text: string; length: number } {
  let text: string;
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    text = String(value);
  }
  return { text, length: text.length };
}

/**
 * Replace a tool result whose serialized form exceeds `maxChars` with a
 * head+tail preview. Results under the cap — and results already capped —
 * are returned as-is (same reference), so callers can detect "unchanged".
 */
export function capToolOutputValue(
  output: unknown,
  maxChars: number = TOOL_OUTPUT_BACKSTOP_CHARS,
): unknown {
  if (output == null || isBackstopped(output)) return output;
  const { text, length } = serializedLength(output);
  if (length <= maxChars) return output;
  const capped = capText(text, {
    maxChars,
    headChars: Math.floor(maxChars * BACKSTOP_HEAD_RATIO),
  });
  const result: BackstoppedToolOutput = {
    _outputCapped: true,
    originalChars: length,
    note:
      `Tool output was ${length.toLocaleString("en-US")} chars; showing the ` +
      "start and end. Re-run with a narrower request (filters, fewer rows, " +
      "a smaller range) if you need the part that was cut.",
    preview: capped.text,
  };
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * Wrap every server-executed tool so its result passes through the backstop.
 *
 * Skipped: tools without `execute` (client-executed — their results are
 * capped when they come back, see `capToolPartOutputsForModel`), tools with
 * `toModelOutput` (they already decide what the model sees, and a preview
 * string would break that mapping), and streaming results.
 */
export function withToolOutputBackstop<T extends ToolSet>(
  tools: T,
  maxChars: number = TOOL_OUTPUT_BACKSTOP_CHARS,
): T {
  const wrapped: Record<string, unknown> = { ...tools };
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: unknown }).execute;
    if (typeof execute !== "function") continue;
    if ((toolDef as { toModelOutput?: unknown }).toModelOutput) continue;
    wrapped[name] = {
      ...toolDef,
      execute: async (input: unknown, options: unknown) => {
        const result: unknown = await (
          execute as (input: unknown, options: unknown) => unknown
        )(input, options);
        if (isAsyncIterable(result)) return result;
        const capped = capToolOutputValue(result, maxChars);
        if (capped !== result) {
          logger.warn("Tool output hit the backstop cap", {
            toolName: name,
            originalChars: (capped as BackstoppedToolOutput).originalChars,
            maxChars,
          });
        }
        return capped;
      },
    };
  }
  return wrapped as T;
}

// ---------------------------------------------------------------------------
// Backstop: tool results replayed in UIMessages
// ---------------------------------------------------------------------------

export interface CapToolPartsResult {
  messages: UIMessage[];
  changed: boolean;
  cappedCount: number;
  screenshotsDropped: number;
}

/**
 * Cap tool outputs inside replayed `UIMessage`s before they go to the model.
 *
 * Covers what the execute wrapper cannot: client-executed tool results (they
 * arrive from the browser), chats persisted before caps existed, and inline
 * screenshots. `app_browse` returns its screenshot as base64; persistence
 * drops it, but the CLIENT's copy keeps it and re-sends it, and with
 * `convertToModelMessages` running without `tools` (so no `toModelOutput`)
 * the base64 would reach the model as plain text. The model already saw the
 * image on the step that took it, so it is dropped here exactly as
 * persistence does.
 *
 * Deterministic per message, so replays stay byte-identical (prompt cache).
 */
export function capToolPartOutputsForModel(
  messages: UIMessage[],
  maxChars: number = TOOL_OUTPUT_BACKSTOP_CHARS,
): CapToolPartsResult {
  let changed = false;
  let cappedCount = 0;
  let screenshotsDropped = 0;
  const next = messages.map(message => {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) {
      return message;
    }
    let messageChanged = false;
    const parts = message.parts.map(part => {
      const record = part as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (!type.startsWith("tool-") && type !== "dynamic-tool") return part;
      let output = record.output;
      if (output == null) return part;
      if (
        typeof output === "object" &&
        typeof (output as { screenshotBase64?: unknown }).screenshotBase64 ===
          "string"
      ) {
        const { screenshotBase64: _dropped, ...rest } = output as Record<
          string,
          unknown
        >;
        output = { ...rest, screenshotOmitted: true };
        screenshotsDropped += 1;
      }
      const capped = capToolOutputValue(output, maxChars);
      if (capped !== output) cappedCount += 1;
      if (capped === record.output) return part;
      messageChanged = true;
      return { ...record, output: capped };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, parts: parts as UIMessage["parts"] };
  });
  return { messages: next, changed, cappedCount, screenshotsDropped };
}
