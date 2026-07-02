/**
 * Provider-agnostic conversation compaction.
 *
 * Long agent chats replay their full history every turn (the client sends the
 * whole `messages[]`, tool outputs and reasoning blocks are persisted verbatim
 * and replayed forever). Eventually the prompt exceeds the model's context
 * window and the provider rejects the request ("prompt is too long", OpenAI
 * "context_length_exceeded", Gemini token errors, …).
 *
 * This module keeps the model input under a computed budget BEFORE the request
 * goes out, working entirely on `UIMessage[]` (the shape the route controls)
 * so it is identical for every provider routed through the gateway. Because
 * tool calls/results live as *parts inside* a single assistant `UIMessage` in
 * this codebase, keeping/dropping/eliding whole messages preserves tool
 * call↔result pairing automatically.
 *
 * Tiered strategy (stop as soon as we fit):
 *   1. Elide large tool outputs in OLDER messages (cheap, mostly lossless).
 *   2. Summarize older turns with a cheap utility model, drop the raw turns,
 *      and fold the summary into the first surviving user message.
 *   3. Emergency: elide/truncate within the recent window, always keeping the
 *      latest user message intact.
 *
 * The reactive backstop in `context-overflow-self-heal.ts` covers the rare
 * case where the estimate was still too optimistic (tool-output sizes are
 * heavy-tailed) or where `contextWindow` is unknown.
 */

import { generateText, type UIMessage } from "ai";
import { getModel } from "../ai-gateway";
import { getUtilityModelId } from "../ai-models";
import { loggers } from "../../logging";
import {
  estimateTokensFromText,
  estimateTokensFromValue,
  estimateUiMessagesTokens,
  estimateUiMessageTokens,
} from "./token-estimate";

const logger = loggers.agent();

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Turns kept verbatim at the tail of the conversation. */
const DEFAULT_KEEP_RECENT_TURNS = 6;

/**
 * Turns kept verbatim by the ALWAYS-ON elision pass (cost control).
 *
 * Distinct from `DEFAULT_KEEP_RECENT_TURNS` (used by the budget-driven path):
 * even when the prompt comfortably fits the context window, replaying every
 * prior turn's full tool outputs on every request is the dominant driver of
 * token spend in long agent chats. We keep only the most recent few turns
 * verbatim and elide large tool outputs from everything older — regardless of
 * the budget. Smaller than the budget window because this runs every turn and
 * we want aggressive savings while preserving recent, actionable context.
 */
const ALWAYS_ELIDE_KEEP_RECENT_TURNS = 2;

/** Fraction of the context window reserved as a safety margin. */
const SAFETY_MARGIN_RATIO = 0.1;

/** Tokens reserved for the model's own output when no thinking budget known. */
const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000;

/** A tool output bigger than this (estimated tokens) is elided when old. */
const ELIDE_TOOL_OUTPUT_TOKENS = 400;

/** Cap on the transcript (chars) fed to the summarizer to protect ITS window. */
const SUMMARY_INPUT_CHAR_CAP = 120_000;

/** Max output tokens for the summary itself. */
const SUMMARY_MAX_OUTPUT_TOKENS = 1_500;

const ELIDED_OUTPUT_PLACEHOLDER = {
  _compacted: true as const,
  note: "Large tool output omitted to fit the context window. Re-run the tool if you need the full result.",
};

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface InputBudgetOptions {
  contextWindow: number | null | undefined;
  /**
   * The system prompt. Accepts the AI SDK system shape (string or
   * `SystemModelMessage[]`); only its serialised size matters for budgeting.
   */
  systemText: unknown;
  /** Reasoning budget tokens (Anthropic extended thinking, etc.). */
  thinkingBudgetTokens?: number;
  /** Override the default output reserve. */
  outputReserveTokens?: number;
}

/**
 * Tokens available for the message history. Returns `null` when the context
 * window is unknown (caller should skip proactive compaction and rely on the
 * reactive backstop).
 */
export function computeInputBudget(opts: InputBudgetOptions): number | null {
  if (!opts.contextWindow || opts.contextWindow <= 0) return null;
  const margin = Math.ceil(opts.contextWindow * SAFETY_MARGIN_RATIO);
  const output = opts.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS;
  const thinking = opts.thinkingBudgetTokens ?? 0;
  const system =
    typeof opts.systemText === "string"
      ? estimateTokensFromText(opts.systemText)
      : estimateTokensFromValue(opts.systemText);
  const budget = opts.contextWindow - margin - output - thinking - system;
  // Never return a non-positive budget; clamp to a small floor so the recent
  // turn(s) still get a chance (the reactive backstop handles the rest).
  return Math.max(budget, 2_000);
}

// ---------------------------------------------------------------------------
// Turn grouping
// ---------------------------------------------------------------------------

interface Turn {
  /** Index in the original messages array where this turn starts. */
  start: number;
  messages: UIMessage[];
}

/** A turn begins at each user message; assistant/tool messages attach to it. */
function groupIntoTurns(messages: UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" || turns.length === 0) {
      turns.push({ start: i, messages: [msg] });
    } else {
      turns[turns.length - 1].messages.push(msg);
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Tool-output elision (lossless-ish)
// ---------------------------------------------------------------------------

function elideToolOutputsInMessage(
  message: UIMessage,
  minTokens: number = ELIDE_TOOL_OUTPUT_TOKENS,
): {
  message: UIMessage;
  changed: boolean;
  count: number;
} {
  const parts = (message.parts ?? []) as Array<Record<string, unknown>>;
  let count = 0;
  const nextParts = parts.map(part => {
    const type = typeof part.type === "string" ? part.type : "";
    const isTool = type.startsWith("tool-") || type === "dynamic-tool";
    if (!isTool) return part;
    if (part.output == null) return part;
    if (
      (part as { output?: { _compacted?: boolean } }).output?._compacted ===
      true
    ) {
      return part;
    }
    if (estimateTokensFromValue(part.output) < minTokens) {
      return part;
    }
    count += 1;
    return { ...part, output: ELIDED_OUTPUT_PLACEHOLDER };
  });
  if (count === 0) return { message, changed: false, count: 0 };
  return {
    message: { ...message, parts: nextParts as UIMessage["parts"] },
    changed: true,
    count,
  };
}

function elideToolOutputs(
  messages: UIMessage[],
  range: { from: number; to: number },
  minTokens: number = ELIDE_TOOL_OUTPUT_TOKENS,
): { messages: UIMessage[]; changed: boolean; count: number } {
  let changed = false;
  let count = 0;
  const next = messages.map((msg, idx) => {
    if (idx < range.from || idx >= range.to) return msg;
    if (msg.role !== "assistant") return msg;
    const res = elideToolOutputsInMessage(msg, minTokens);
    if (res.changed) {
      changed = true;
      count += res.count;
    }
    return res.message;
  });
  return { messages: next, changed, count };
}

// ---------------------------------------------------------------------------
// Always-on old tool-output elision (cost control, budget-independent)
// ---------------------------------------------------------------------------

export interface ElideOldToolOutputsOptions {
  /** Turns kept fully verbatim at the tail. */
  keepRecentTurns?: number;
  /** Only elide tool outputs estimated at or above this many tokens. */
  minTokens?: number;
}

export interface ElideOldToolOutputsResult {
  messages: UIMessage[];
  changed: boolean;
  elidedCount: number;
}

/**
 * Elide large tool outputs from OLDER turns, independent of any token budget.
 *
 * This is the primary cost lever for long agent chats: the client replays the
 * entire `messages[]` every turn, so a session that ran 50 large SQL/schema
 * tool calls re-sends all of them on every subsequent request — even when the
 * total still fits the context window. Those bytes are re-billed as input
 * tokens (and re-processed) every single turn.
 *
 * We keep the most recent `keepRecentTurns` turns verbatim (the model's active
 * working set) and replace large tool outputs in everything older with a short
 * placeholder. Tool call↔result pairing is preserved because we only swap the
 * `output` field of a tool part; the tool call itself remains.
 */
export function elideOldToolOutputs(
  messages: UIMessage[],
  opts?: ElideOldToolOutputsOptions,
): ElideOldToolOutputsResult {
  const keepRecentTurns =
    opts?.keepRecentTurns ?? ALWAYS_ELIDE_KEEP_RECENT_TURNS;
  const minTokens = opts?.minTokens ?? ELIDE_TOOL_OUTPUT_TOKENS;
  if (messages.length === 0) {
    return { messages, changed: false, elidedCount: 0 };
  }

  const turns = groupIntoTurns(messages);
  if (turns.length <= keepRecentTurns) {
    return { messages, changed: false, elidedCount: 0 };
  }
  const recentStartTurn = Math.max(0, turns.length - keepRecentTurns);
  const recentStartIdx = turns[recentStartTurn].start;
  if (recentStartIdx <= 0) {
    return { messages, changed: false, elidedCount: 0 };
  }

  const res = elideToolOutputs(
    messages,
    { from: 0, to: recentStartIdx },
    minTokens,
  );
  return {
    messages: res.messages,
    changed: res.changed,
    elidedCount: res.count,
  };
}

// ---------------------------------------------------------------------------
// Replayed reasoning / thinking stripping (cost control, budget-independent)
// ---------------------------------------------------------------------------

export interface StripReasoningResult {
  messages: UIMessage[];
  changed: boolean;
  strippedCount: number;
}

/**
 * Drop replayed `reasoning` (extended-thinking) parts from the model input.
 *
 * `sendReasoning: true` streams the model's thinking to the UI and persists it,
 * so the client replays every prior turn's thinking trace on every request.
 * That is pure waste: a model never needs to re-read its own past thinking — the
 * conclusions already live in the assistant text/tool calls that follow — and
 * the blocks are re-billed as input tokens each turn.
 *
 * The one exception is provider-mandated: with Anthropic interleaved thinking +
 * tool use, the thinking block of the assistant turn that is being *continued*
 * with tool results must be preserved (signature verification). That turn is the
 * LAST assistant message, and only when the latest message is NOT a fresh user
 * message (i.e. we're mid tool-continuation). In every other case we strip all
 * reasoning. We never empty a message (guards a reasoning-only assistant turn).
 */
export function stripReplayedReasoning(
  messages: UIMessage[],
): StripReasoningResult {
  if (messages.length === 0) {
    return { messages, changed: false, strippedCount: 0 };
  }

  const lastMessage = messages[messages.length - 1];
  const isContinuation = lastMessage.role !== "user";
  let preserveIdx = -1;
  if (isContinuation) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        preserveIdx = i;
        break;
      }
    }
  }

  let changed = false;
  let strippedCount = 0;
  const next = messages.map((msg, idx) => {
    if (msg.role !== "assistant" || idx === preserveIdx) return msg;
    const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
    const filtered = parts.filter(part => part.type !== "reasoning");
    const removed = parts.length - filtered.length;
    // Nothing to strip, or stripping would leave the message empty (which
    // `convertToModelMessages` rejects) — leave it untouched.
    if (removed === 0 || filtered.length === 0) return msg;
    changed = true;
    strippedCount += removed;
    return { ...msg, parts: filtered as UIMessage["parts"] };
  });

  return { messages: next, changed, strippedCount };
}

export interface DedupeReasoningResult {
  messages: UIMessage[];
  changed: boolean;
  removedCount: number;
}

/**
 * Extract the Anthropic thinking-block signature from a reasoning UI part, if
 * present. The signature lives at `providerMetadata.anthropic.signature` (the
 * AI SDK forwards it through `sendReasoning: true`, and `convertToModelMessages`
 * re-emits it as `providerOptions` on the `thinking` model part).
 */
function reasoningSignature(part: Record<string, unknown>): string | null {
  const meta = part.providerMetadata as
    | Record<string, unknown>
    | undefined
    | null;
  const anthropic = meta?.anthropic as
    | Record<string, unknown>
    | undefined
    | null;
  const sig = anthropic?.signature;
  return typeof sig === "string" && sig.length > 0 ? sig : null;
}

/**
 * Remove duplicate `reasoning` (extended-thinking) parts within each assistant
 * message, preserving the first occurrence and original order.
 *
 * WHY THIS EXISTS — Anthropic 400 "thinking blocks cannot be modified":
 * With extended/interleaved thinking + tool use, Anthropic requires the
 * `thinking`/`redacted_thinking` blocks on the LATEST assistant message to be
 * replayed BYTE-FOR-BYTE as they were in the original response — "the entire
 * sequence of consecutive thinking blocks must match the outputs generated by
 * the model during the original request; you cannot rearrange or modify the
 * sequence". A duplicated thinking block is exactly such a modification, and the
 * API rejects the whole turn with:
 *
 *   messages.N.content.M: `thinking` or `redacted_thinking` blocks in the latest
 *   assistant message cannot be modified. These blocks must remain as they were
 *   in the original response.
 *
 * Our message lifecycle (streamed parts merged with `originalMessages`,
 * resumable-stream replay, persist→reload) can introduce duplicate reasoning
 * parts into a persisted assistant message. Once that happens the corrupted turn
 * is replayed verbatim on every subsequent request and the chat is permanently
 * wedged. De-duplicating restores the original (correct) sequence so the turn
 * round-trips. We MUST NOT otherwise alter the thinking text or signature.
 *
 * Dedup key: the Anthropic block `signature` when present (unique per generated
 * block — two parts sharing a signature are unambiguously the same block);
 * otherwise the trimmed reasoning text (signature-less legacy parts can't be
 * validated by the provider anyway, so a text match is a safe fallback).
 *
 * Runs across all assistant messages (cheap, order-preserving); in practice only
 * the preserved last-assistant turn matters, since `stripReplayedReasoning`
 * already drops reasoning from every earlier assistant turn.
 */
export function dedupeAssistantReasoning(
  messages: UIMessage[],
): DedupeReasoningResult {
  let changed = false;
  let removedCount = 0;

  const next = messages.map(msg => {
    if (msg.role !== "assistant") return msg;
    const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    let removedHere = 0;
    const filtered = parts.filter(part => {
      if (part.type !== "reasoning") return true;
      const key = `sig:${reasoningSignature(part) ?? ""}`;
      const textKey =
        key === "sig:"
          ? `txt:${String((part.text as string) ?? (part.reasoning as string) ?? "").trim()}`
          : key;
      // Empty/whitespace reasoning carries no signature and no content — let it
      // through untouched rather than collapsing all such parts together.
      if (textKey === "txt:") return true;
      if (seen.has(textKey)) {
        removedHere += 1;
        return false;
      }
      seen.add(textKey);
      return true;
    });
    if (removedHere === 0) return msg;
    changed = true;
    removedCount += removedHere;
    return { ...msg, parts: filtered as UIMessage["parts"] };
  });

  return { messages: next, changed, removedCount };
}

/**
 * Minimum trimmed length for a text part to participate in duplicate removal.
 * Short affirmations ("Done.", "Yes.") can legitimately repeat inside one
 * assistant message; the replay corruption this cleans up duplicates whole
 * paragraphs, so a modest threshold removes the corruption without ever
 * touching plausible legitimate repeats.
 */
const TEXT_DEDUPE_MIN_LENGTH = 24;

/**
 * Remove stream-replay artifacts from assistant messages: duplicated `text`
 * parts and bursts of consecutive `step-start` parts.
 *
 * WHY THIS EXISTS — resumable-stream replay corruption:
 * When a client attaches additional consumers to a turn's resumable stream
 * (resumeStream() after a wake/refresh/error — historically without any
 * single-flight guard), every consumer re-processes every chunk. Tool and
 * reasoning chunks MERGE into existing parts (by toolCallId / signature), but
 * `text-start` and `start-step` chunks unconditionally APPEND — so each extra
 * consumer appended a byte-identical copy of every text part plus a burst of
 * step-start parts. Later live chunks then interleave with the appended
 * copies, so the duplicates are NOT a clean suffix; they are byte-identical
 * repeats scattered through the tail of the message.
 *
 * The client-side fixes (tool dispatch gate + single-flight resume) stop new
 * corruption; this persist-time pass repairs messages that already carry it
 * (and acts as a backstop). Mirrors `dedupeAssistantReasoning`: first
 * occurrence and order are preserved.
 *
 * Conservative by construction:
 *  - only assistant messages;
 *  - only text parts whose trimmed content is at least
 *    TEXT_DEDUPE_MIN_LENGTH chars AND byte-identical (trimmed) to an earlier
 *    text part in the same message;
 *  - step-start parts are only dropped when DIRECTLY consecutive (possible
 *    only via replay appends — a real step boundary always carries content).
 */
export function dedupeAssistantStreamArtifacts(
  messages: UIMessage[],
): DedupeReasoningResult {
  let changed = false;
  let removedCount = 0;

  const next = messages.map(msg => {
    if (msg.role !== "assistant") return msg;
    const parts = (msg.parts ?? []) as Array<Record<string, unknown>>;
    const seenTexts = new Set<string>();
    let removedHere = 0;
    let previousKeptType: string | null = null;

    const filtered = parts.filter(part => {
      const type = part.type;

      if (type === "step-start") {
        if (previousKeptType === "step-start") {
          removedHere += 1;
          return false;
        }
        previousKeptType = "step-start";
        return true;
      }

      if (type === "text") {
        const trimmed = String((part.text as string) ?? "").trim();
        if (trimmed.length >= TEXT_DEDUPE_MIN_LENGTH) {
          if (seenTexts.has(trimmed)) {
            removedHere += 1;
            return false;
          }
          seenTexts.add(trimmed);
        }
        previousKeptType = "text";
        return true;
      }

      previousKeptType = typeof type === "string" ? type : null;
      return true;
    });

    if (removedHere === 0) return msg;
    changed = true;
    removedCount += removedHere;
    return { ...msg, parts: filtered as UIMessage["parts"] };
  });

  return { messages: next, changed, removedCount };
}

// ---------------------------------------------------------------------------
// Summarization (agnostic — cheapest curated tool-use model)
// ---------------------------------------------------------------------------

function renderMessageForSummary(message: UIMessage): string {
  const role = message.role === "assistant" ? "Assistant" : "User";
  const parts = (message.parts ?? []) as Array<Record<string, unknown>>;
  const chunks: string[] = [];
  for (const part of parts) {
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    } else if (type.startsWith("tool-") || type === "dynamic-tool") {
      const toolName =
        type === "dynamic-tool"
          ? String(part.toolName ?? "tool")
          : type.slice("tool-".length);
      const input = truncate(safeStringify(part.input), 300);
      const output = truncate(safeStringify(part.output), 400);
      chunks.push(`[tool ${toolName}] in=${input} out=${output}`);
    }
    // reasoning/file parts are intentionally skipped to save summarizer tokens.
  }
  const body = chunks.join("\n").trim();
  return body ? `${role}: ${body}` : "";
}

function safeStringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** Keep head + tail when the transcript is too large for the summarizer. */
function capTranscript(text: string): string {
  if (text.length <= SUMMARY_INPUT_CHAR_CAP) return text;
  const half = Math.floor(SUMMARY_INPUT_CHAR_CAP / 2);
  return `${text.slice(0, half)}\n\n…[middle of earlier conversation omitted]…\n\n${text.slice(-half)}`;
}

const SUMMARY_INSTRUCTIONS = `You are compacting the earlier part of a conversation between a user and an AI data/SQL assistant so it fits in the context window. Write a dense, factual summary using EXACTLY these markdown sections (omit a section only if truly empty):

## User intent & goals
## Databases, schemas & tables referenced
## Key decisions & conclusions
## SQL / queries written or run (with the actual statements when short)
## Important tool results & findings
## Open tasks / next steps

Rules: preserve concrete identifiers (table names, column names, IDs, file paths, exact SQL). Do not invent anything. Be concise but lossless on facts. Output only the summary.`;

async function summarizeMessages(
  messages: UIMessage[],
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const rendered = messages
    .map(renderMessageForSummary)
    .filter(Boolean)
    .join("\n\n");
  if (!rendered.trim()) return null;

  const transcript = capTranscript(rendered);
  try {
    const modelId = await getUtilityModelId();
    const { text } = await generateText({
      model: getModel(modelId),
      system: SUMMARY_INSTRUCTIONS,
      prompt: `Summarize this earlier conversation:\n\n${transcript}`,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      abortSignal,
    });
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    logger.warn("Conversation summarization failed; will hard-drop instead", {
      error: String(error),
    });
    return null;
  }
}

/** Prepend a summary block into the first user message of `messages`. */
function injectSummary(messages: UIMessage[], summary: string): UIMessage[] {
  const block = `[Summary of the earlier conversation, compacted to fit the context window]\n\n${summary}\n\n[End of summary — the most recent messages follow verbatim.]`;
  const idx = messages.findIndex(m => m.role === "user");
  if (idx === -1) {
    // No user message in the kept window (unusual) — prepend a synthetic one.
    const synthetic = {
      id: `compaction-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: block }],
    } as UIMessage;
    return [synthetic, ...messages];
  }
  const target = messages[idx];
  const parts = [...((target.parts ?? []) as Array<Record<string, unknown>>)];
  const firstText = parts.findIndex(p => p.type === "text");
  if (firstText === -1) {
    parts.unshift({ type: "text", text: block } as Record<string, unknown>);
  } else {
    parts[firstText] = {
      ...parts[firstText],
      text: `${block}\n\n${String(parts[firstText].text ?? "")}`,
    };
  }
  const next = [...messages];
  next[idx] = { ...target, parts: parts as UIMessage["parts"] };
  return next;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface CompactionOptions {
  messages: UIMessage[];
  /** Token budget for the message history (from `computeInputBudget`). */
  budgetTokens: number;
  keepRecentTurns?: number;
  /** Whether to summarize older turns (vs. elide+drop only). */
  summarize?: boolean;
  abortSignal?: AbortSignal;
}

export type CompactionStrategy =
  | "none"
  | "elide"
  | "summarize"
  | "emergency-drop";

export interface CompactionResult {
  messages: UIMessage[];
  didCompact: boolean;
  strategy: CompactionStrategy;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export async function compactUiMessagesForBudget(
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const { messages, budgetTokens } = opts;
  const keepRecentTurns = opts.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const summarize = opts.summarize ?? true;

  const estimatedTokensBefore = estimateUiMessagesTokens(messages);
  if (estimatedTokensBefore <= budgetTokens) {
    return {
      messages,
      didCompact: false,
      strategy: "none",
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
    };
  }

  const turns = groupIntoTurns(messages);
  const recentStartTurn = Math.max(0, turns.length - keepRecentTurns);
  // First message index that belongs to the protected recent window.
  const recentStartIdx =
    recentStartTurn < turns.length ? turns[recentStartTurn].start : 0;

  // --- Step 1: elide large tool outputs in the older region ---------------
  let working = messages;
  const elided = elideToolOutputs(working, { from: 0, to: recentStartIdx });
  working = elided.messages;
  let strategy: CompactionStrategy = elided.changed ? "elide" : "none";

  if (estimateUiMessagesTokens(working) <= budgetTokens) {
    return finalize(
      working,
      strategy === "none" ? "elide" : strategy,
      estimatedTokensBefore,
    );
  }

  // --- Step 2: summarize + drop older turns -------------------------------
  if (recentStartIdx > 0) {
    const older = working.slice(0, recentStartIdx);
    const recent = working.slice(recentStartIdx);

    let summary: string | null = null;
    if (summarize) {
      summary = await summarizeMessages(older, opts.abortSignal);
    }

    working = summary ? injectSummary(recent, summary) : recent;
    strategy = summary ? "summarize" : "emergency-drop";

    if (estimateUiMessagesTokens(working) <= budgetTokens) {
      return finalize(working, strategy, estimatedTokensBefore);
    }
  }

  // --- Step 3: emergency — elide everything, keep last user msg intact -----
  const emergency = emergencyCompact(working, budgetTokens);
  return finalize(emergency, "emergency-drop", estimatedTokensBefore);

  function finalize(
    msgs: UIMessage[],
    strat: CompactionStrategy,
    before: number,
  ): CompactionResult {
    const after = estimateUiMessagesTokens(msgs);
    logger.info("Compacted conversation for context budget", {
      strategy: strat,
      budgetTokens,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
      messagesBefore: messages.length,
      messagesAfter: msgs.length,
    });
    return {
      messages: msgs,
      didCompact: true,
      strategy: strat,
      estimatedTokensBefore: before,
      estimatedTokensAfter: after,
    };
  }
}

/**
 * Last resort: elide ALL tool outputs, then drop oldest whole messages while
 * always preserving the final user message (the current question). Used when
 * even the recent window blows the budget or summarization failed.
 */
function emergencyCompact(
  messages: UIMessage[],
  budgetTokens: number,
): UIMessage[] {
  // Elide every tool output regardless of age.
  let working = messages.map(msg =>
    msg.role === "assistant" ? elideToolOutputsInMessage(msg).message : msg,
  );

  if (estimateUiMessagesTokens(working) <= budgetTokens) return working;

  // Index of the last user message — never drop it or anything after it.
  let lastUserIdx = -1;
  for (let i = working.length - 1; i >= 0; i--) {
    if (working[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const protectedFrom = lastUserIdx === -1 ? working.length - 1 : lastUserIdx;

  // Drop from the front until we fit (or only the protected tail remains).
  while (
    working.length > 1 &&
    estimateUiMessagesTokens(working) > budgetTokens
  ) {
    // Stop dropping once we'd eat into the protected tail.
    if (working.length <= messages.length - protectedFrom) break;
    working = working.slice(1);
  }

  if (estimateUiMessagesTokens(working) <= budgetTokens) return working;

  // Still too big: the protected tail itself is oversized. Hard-truncate the
  // text parts of everything except the very last message.
  working = working.map((msg, idx) =>
    idx === working.length - 1 ? msg : truncateMessageText(msg),
  );
  return working;
}

function truncateMessageText(message: UIMessage): UIMessage {
  const parts = (message.parts ?? []) as Array<Record<string, unknown>>;
  const next = parts.map(part => {
    if (part.type === "text" && typeof part.text === "string") {
      const tokens = estimateUiMessageTokens({
        ...message,
        parts: [part] as UIMessage["parts"],
      });
      if (tokens > 1_000) {
        return { ...part, text: truncate(part.text, 2_000) };
      }
    }
    return part;
  });
  return { ...message, parts: next as UIMessage["parts"] };
}
