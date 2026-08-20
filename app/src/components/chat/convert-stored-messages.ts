/**
 * Conversion of persisted chat messages (the MongoDB shape returned by
 * GET /api/workspaces/:id/chats/:chatId) into AI SDK UIMessage-compatible
 * objects for `setMessages`.
 *
 * Extracted from Chat.tsx's loadSession so it is unit-testable and shared by
 * the history loader and the resume manager's reload-before-replay path.
 */

import { isApprovalPendingState } from "./tool-presentation";
import type { ResponseCostMetadata } from "./response-cost";

/** Loose UIMessage shape accepted by useChat's setMessages. */
export interface ConvertedUiMessage {
  id: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  /** Per-response cost from the chat's persisted usage.history. */
  metadata?: ResponseCostMetadata;
}

/** Exported for the Local ACP resume path's incomplete-turn heuristic. */
export const INTERRUPTED_TOOL_TEXT =
  "Interrupted — stream disconnected before tool completed";

// Human-in-the-loop tools resolve via an interactive card, so a persisted
// unanswered one must be re-rendered pending rather than patched to an error.
const HUMAN_IN_THE_LOOP_TOOL_PART_TYPES = new Set([
  "tool-ask_clarifying_questions",
  "tool-submit_plan",
]);

export interface ConvertStoredMessagesOptions {
  /**
   * True when the chat has an in-flight turn server-side (activeStreamId
   * set). Non-terminal tool parts are then left PENDING instead of being
   * patched to "Interrupted": persistence is per-segment and asynchronous,
   * so mid-turn the snapshot can lag the live state (a client tool that
   * already settled may still read `input-available` here). Poisoning it
   * corrupts history — the resumed segment's replay only appends new chunks
   * and never re-delivers the settled tool, so the poison survives in memory
   * and the NEXT send persists it over the server's correct finalization.
   * Pending parts self-heal instead: the resume replay re-delivers/settles
   * them, and the orphan-rescue effect recovers or patches anything
   * genuinely stuck once the turn goes quiet.
   */
  turnActive?: boolean;
  /**
   * Per-response cost from the persisted chat's `usage.history`, keyed by the
   * assistant message's ordinal within the thread (saveChat's messageIndex).
   * When present, matching assistant messages get it as `metadata` — the same
   * shape live turns receive from the stream's messageMetadata.
   */
  costByAssistantOrdinal?: Map<number, ResponseCostMetadata>;
}

function convertStoredPart(
  p: any,
  opts?: ConvertStoredMessagesOptions,
): Record<string, unknown> {
  // Convert stored part to UI format
  if (p.type === "text") {
    return { type: "text", text: p.text || "" };
  }
  if (p.type === "reasoning") {
    // Handle both 'reasoning' and 'text' fields for reasoning parts.
    // Carry providerMetadata back (Anthropic extended-thinking
    // `signature`) so a continuation replays the thinking block
    // byte-for-byte; without it Anthropic rejects the turn with
    // "thinking ... blocks in the latest assistant message cannot
    // be modified".
    return {
      type: "reasoning",
      text: p.reasoning || p.text || "",
      ...(p.providerMetadata != null
        ? { providerMetadata: p.providerMetadata }
        : {}),
    };
  }
  // Tool parts: ensure state is set for UI rendering
  // AI SDK v6 uses output-error (not "error") so convertToModelMessages
  // emits a matching tool-result for Anthropic.
  if (p.type?.startsWith("tool-") || p.type === "dynamic-tool") {
    const toolState = p.state as string | undefined;
    if (toolState === "error") {
      const output = p.output as { error?: unknown } | null | undefined;
      const errorText =
        typeof p.errorText === "string"
          ? p.errorText
          : typeof output?.error === "string"
            ? output.error
            : output?.error != null
              ? String(output.error)
              : "Tool failed";
      return {
        ...p,
        state: "output-error",
        input: p.input ?? {},
        output: undefined,
        errorText,
      };
    }
    const isComplete =
      toolState === "output-available" ||
      toolState === "output-error" ||
      toolState === "output-denied";
    if (isComplete) {
      return {
        ...p,
        input: p.input ?? {},
      };
    }
    // A persisted, unanswered human-in-the-loop tool
    // (clarifying questions / plan review) is not an
    // interrupted tool: re-render its interactive card so the
    // user can still answer it. Answering sends the tool
    // result, which continues the turn from persisted
    // history. Keep it pending instead of marking it errored.
    if (
      typeof p.type === "string" &&
      HUMAN_IN_THE_LOOP_TOOL_PART_TYPES.has(p.type) &&
      toolState === "input-available"
    ) {
      return {
        ...p,
        input: p.input ?? {},
      };
    }
    // A persisted, unanswered MCP approval request: keep it pending so the
    // approval card re-renders on reload and the user can still allow/deny.
    if (isApprovalPendingState(toolState)) {
      return {
        ...p,
        input: p.input ?? {},
      };
    }
    // Turn still in flight server-side: the snapshot may simply lag the live
    // state — leave the part pending so the resume replay / orphan rescue can
    // settle it (see ConvertStoredMessagesOptions.turnActive).
    if (opts?.turnActive) {
      return {
        ...p,
        state: toolState ?? "input-available",
        input: p.input ?? {},
      };
    }
    return {
      ...p,
      state: "output-error",
      input: p.input ?? {},
      output: undefined,
      errorText: INTERRUPTED_TOOL_TEXT,
    };
  }
  // Unknown part type - pass through as-is
  return p;
}

/**
 * Convert stored messages to AI SDK format with parts including tool calls.
 * Tool calls are included for UI display (shows what tools were used).
 * The backend sanitizes these before sending to the AI to avoid
 * "tool_use without tool_result" errors.
 */
export function convertStoredMessages(
  rawMessages: unknown[] | null | undefined,
  opts?: ConvertStoredMessagesOptions,
): ConvertedUiMessage[] {
  let assistantOrdinal = -1;
  const costMetadata = (msg: any): Pick<ConvertedUiMessage, "metadata"> => {
    if (msg.role !== "assistant") return {};
    assistantOrdinal += 1;
    const meta = opts?.costByAssistantOrdinal?.get(assistantOrdinal);
    return meta ? { metadata: meta } : {};
  };

  return (
    (rawMessages as any[] | null | undefined)?.map((msg: any) => {
      // NEW: If parts are stored, use them directly (preserves chronological order)
      if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
        return {
          id: msg.id || msg._id?.toString() || `${Date.now()}-${Math.random()}`,
          role: msg.role,
          parts: msg.parts.map((p: any) => convertStoredPart(p, opts)),
          ...costMetadata(msg),
        };
      }

      // TODO: Remove this fallback once we're OK with losing the ability to show old chats
      // that were created before the parts array migration.
      // LEGACY FALLBACK: Reconstruct parts from legacy fields (for existing chats without parts)
      // Note: Order cannot be perfectly restored, use best-effort: tools -> reasoning -> text
      const parts: Array<Record<string, unknown>> = [];

      // Add tool call parts (for UI display - shows tool history)
      // IMPORTANT: input must always be defined (at least {}) for OpenAI API compatibility
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          if (!tc.toolName) continue;
          parts.push({
            type: `tool-${tc.toolName}`,
            toolCallId:
              tc.toolCallId ||
              tc._id?.toString() ||
              `saved-${tc.toolName}-${Date.now()}-${Math.random()}`,
            toolName: tc.toolName,
            state: "output-available",
            input: tc.input ?? {},
            output: tc.result ?? null,
          });
        }
      }

      // Add reasoning parts (if any)
      if (msg.reasoning && Array.isArray(msg.reasoning)) {
        for (const reasoningText of msg.reasoning) {
          parts.push({
            type: "reasoning",
            text: reasoningText,
          });
        }
      }

      // Add text content part
      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }

      return {
        id: msg._id?.toString() || msg.id || `${Date.now()}-${Math.random()}`,
        role: msg.role,
        parts,
        ...costMetadata(msg),
      };
    }) || []
  );
}
