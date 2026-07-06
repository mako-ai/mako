/**
 * Dedupe gate for client-side tool dispatch.
 *
 * The AI SDK fires `onToolCall` for EVERY `tool-input-available` chunk a
 * stream consumer processes — including chunks replayed from position 0 by a
 * resumable-stream reattach (`resumeStream()`), and chunks broadcast to
 * additional concurrent consumers (the SDK never aborts the previous
 * `activeResponse` when a resume attaches). Tool PARTS merge by `toolCallId`
 * so the duplication is invisible in the transcript, but the dispatch is not
 * deduped anywhere — one `create_dashboard` call executed N times (the
 * "3 dashboards / 3 data sources from a single tool call" incident).
 *
 * The gate is scoped to a chat and a page instance:
 *  - `markDispatched` returns false when this page instance already dispatched
 *    the id, blocking same-instance replays and concurrent consumers.
 *  - `seedFromPersistedMessages` blocks ids whose PERSISTED state is terminal:
 *    they completed in a previous page instance, so a post-refresh replay must
 *    not re-run them.
 *  - Non-terminal persisted ids stay dispatchable ON PURPOSE: a refresh
 *    mid-execution relies on the resumed stream re-dispatching the call (the
 *    previous page died before the tool could settle).
 */

/** Tool part states that mean the call already ran to completion. */
const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
  "error",
]);

export interface PersistedMessageLike {
  role?: string;
  parts?: Array<Record<string, unknown>> | null;
}

function isToolPartType(type: unknown): type is string {
  return (
    typeof type === "string" &&
    (type.startsWith("tool-") || type === "dynamic-tool")
  );
}

export class ToolDispatchGate {
  private dispatched = new Set<string>();

  /** Forget everything (call when the active chat changes). */
  reset(): void {
    this.dispatched.clear();
  }

  /** True if this toolCallId was already dispatched (or seeded as terminal). */
  wasDispatched(toolCallId: string): boolean {
    return this.dispatched.has(toolCallId);
  }

  /**
   * Claim a toolCallId for dispatch. Returns true exactly once per id — a
   * false return means the call was already dispatched and the caller must
   * NOT execute it again. Ids without a value cannot be deduped and are always
   * allowed through.
   */
  markDispatched(toolCallId: string | undefined | null): boolean {
    if (!toolCallId) return true;
    if (this.dispatched.has(toolCallId)) return false;
    this.dispatched.add(toolCallId);
    return true;
  }

  /**
   * Seed from the RAW persisted messages (server shape, before any client
   * normalization). Only tool parts persisted in a TERMINAL state block
   * re-dispatch; the history loader rewrites interrupted parts to
   * `output-error` for display, so seeding must happen from the raw data or
   * legitimate post-refresh recovery of interrupted tools would be blocked.
   */
  seedFromPersistedMessages(messages: PersistedMessageLike[]): void {
    for (const message of messages) {
      for (const part of message.parts ?? []) {
        if (!isToolPartType(part.type)) continue;
        const toolCallId = part.toolCallId;
        if (typeof toolCallId !== "string" || toolCallId.length === 0) {
          continue;
        }
        const state = part.state;
        if (typeof state === "string" && TERMINAL_TOOL_STATES.has(state)) {
          this.dispatched.add(toolCallId);
        }
      }
    }
  }
}
