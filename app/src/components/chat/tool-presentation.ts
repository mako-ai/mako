/**
 * Pure helpers around agent tool parts: naming, pending-state predicates,
 * console tool-card presentation, and stream-interruption diagnostics.
 * Extracted from Chat.tsx (no React — unit-testable).
 */
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useConsoleStore } from "../../store/consoleStore";
import type { ConsoleTab } from "../../store/lib/types";
import type { ConsoleModification } from "../../hooks/useMonacoConsole";
import { buildModificationDiff } from "../../utils/consoleModification";
import { trackEvent } from "../../lib/analytics";
import type { ToolPartState } from "../StreamingToolCard";

// Human-in-the-loop tools resolve via an interactive card (the user answers /
// approves), not via an `execute` result. They legitimately stay pending at
// `input-available` with no output until the user acts, so any "settle the
// dangling tool" cleanup must skip them — otherwise the card is torn down
// before it can be answered. Part types are `tool-<toolName>`.
const HUMAN_IN_THE_LOOP_TOOL_PART_TYPES = new Set([
  "tool-ask_clarifying_questions",
  "tool-submit_plan",
]);

export function isHumanInTheLoopToolPartType(partType: string): boolean {
  return HUMAN_IN_THE_LOOP_TOOL_PART_TYPES.has(partType);
}

export function toolNameFromPartType(partType: string): string {
  return partType.startsWith("tool-")
    ? partType.slice("tool-".length)
    : partType;
}

// Server-executed mutation tools (issue #475 pattern) whose open-tab sync we
// ALSO reconcile off the resumable chat stream — in addition to the workspace
// realtime poke (app.updated / dbt.file.updated) — so an open app / dbt tab
// converges even when the workspace SSE is dead (mobile lock / laptop sleep).
export const APP_SERVER_MUTATION_TOOLS = new Set<string>([
  "app_write_file",
  "app_edit_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_update_data_binding",
  "app_delete_data_binding",
]);
export const DBT_SERVER_MUTATION_TOOLS = new Set<string>([
  "create_dbt_file",
  "modify_dbt_file",
  "edit_dbt_file",
  "delete_dbt_file",
]);

// Server-executed dbt git tools that MOVE the acting user's checkout (their
// tool output carries the new `branch`). Reconciled off the resumable chat
// stream so the open dbt tab follows the agent onto the new branch even when
// the workspace SSE poke (dbt.checkout.updated) was missed.
export const DBT_CHECKOUT_MUTATION_TOOLS = new Set<string>([
  "dbt_switch_branch",
  "dbt_create_branch",
  "dbt_commit_to_branch",
  "dbt_merge_pull_request",
]);

// Server-executed dbt git tools that change the git surface (base tree /
// pending changes) WITHOUT moving the checkout. Chat-stream counterpart of
// the dbt.git.updated poke: refetch tree + git status.
export const DBT_GIT_MUTATION_TOOLS = new Set<string>([
  "dbt_sync_from_repo",
  "dbt_commit_and_push",
  "dbt_delete_branch",
  "dbt_restore_file",
]);

// Diagnostics for the *live* stream-disconnect signatures so they can be
// investigated after the fact:
//   - "orphan-rescue": a turn settled to `ready` while non-interactive tool
//     cards were still pending (the silent SSE drop → 204 reconnect path).
//   - "stream-error":  the SDK surfaced a thrown stream error (e.g. a 524 or a
//     network drop when the tab is frozen by a mobile lock / computer sleep).
//   - "wake-resume":   the tab woke (visibility/focus/pageshow/resume) with an
//     in-flight turn, so we proactively reattached to the buffered stream.
// `resumed` records whether we attempted a resume (reattach) rather than
// poisoning the tool cards — the recovery path we want to confirm in prod.
// Emits a structured console line for live debugging and a PostHog product
// event so frequency / affected tools are queryable. Correlate with the
// server's `mako.agent` logs (and the resume-endpoint 204 reasons) via chatId.
export type StreamInterruptionPath =
  | "orphan-rescue"
  | "stream-error"
  | "wake-resume";

export function reportStreamInterruption(detail: {
  path: StreamInterruptionPath;
  chatId: string;
  status: string;
  toolNames: string[];
  recoveredToolNames?: string[];
  errorMessage?: string;
  resumed?: boolean;
}): void {
  console.warn("[Chat][stream-interrupted]", detail);
  trackEvent("ai_chat_stream_interrupted", {
    interruption_path: detail.path,
    chat_id: detail.chatId,
    chat_status: detail.status,
    tool_names: detail.toolNames.join(",") || "(none)",
    tool_count: detail.toolNames.length,
    recovered_tool_names: detail.recoveredToolNames?.join(",") || "(none)",
    recovered_count: detail.recoveredToolNames?.length ?? 0,
    error_message: detail.errorMessage,
    resumed: detail.resumed ?? false,
  });
}

// Tool part structure - tool type is "tool-{toolName}" with state/input/output
export interface ToolInvocationInfo {
  toolCallId: string;
  toolName: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-streaming"
    | "output-available"
    | "error";
  input?: unknown;
  output?: unknown;
}

export type AutoSendPredicateArgs = Parameters<
  typeof lastAssistantMessageIsCompleteWithToolCalls
>[0];

export function hasPendingAssistantToolCalls(
  messages: AutoSendPredicateArgs["messages"],
): boolean {
  const last = messages.at(-1);
  if (!last?.parts || last.role !== "assistant") return false;

  return last.parts.some(part => {
    const partType = part.type as string;
    if (!partType.startsWith("tool-") && partType !== "dynamic-tool") {
      return false;
    }
    const state = (part as { state?: string }).state;
    return (
      state !== "output-available" &&
      state !== "output-error" &&
      state !== "error"
    );
  });
}

export interface ActiveClientToolCall {
  toolCallId: string;
  toolName: string;
  executionId: string;
  abortController: AbortController;
  cancel: () => void | Promise<void>;
  cancellationOutput: Record<string, unknown>;
  settled: boolean;
}

function asToolPayload(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function getConsoleIdFromToolPayload(
  input: unknown,
  output: unknown,
): string | null {
  const inputObj = asToolPayload(input);
  const outputObj = asToolPayload(output);
  const consoleId = inputObj?.consoleId ?? outputObj?.consoleId;
  return typeof consoleId === "string" && consoleId.length > 0
    ? consoleId
    : null;
}

export interface ConsoleToolPresentation {
  consoleId: string;
  title: string;
  iconUrl?: string;
  diff?: string;
}

export function getConsoleToolPresentation(
  toolName: string,
  input: unknown,
  output: unknown,
  connectionIconById: ReadonlyMap<string, string>,
  state: ToolPartState,
): ConsoleToolPresentation | null {
  if (toolName !== "modify_console") return null;

  const store = useConsoleStore.getState();
  const inputObj = asToolPayload(input);
  const outputObj = asToolPayload(output);
  const consoleId = getConsoleIdFromToolPayload(input, output);
  if (!consoleId) return null;

  const consoleTab = store.tabs[consoleId];
  const inputTitle = inputObj?.title;
  const outputTitle = outputObj?.title;
  const title =
    consoleTab?.title ??
    (typeof inputTitle === "string" ? inputTitle : undefined) ??
    (typeof outputTitle === "string" ? outputTitle : undefined) ??
    "Untitled console";

  // While the input is still streaming, the `content` field is partial, so a
  // line-diff against the existing console re-aligns its +/- groupings on every
  // token (interleaved → grouped as more text arrives) — the modify_console
  // "blink like mad" the diff card showed under Virtuoso. Skip the live diff
  // while streaming: with no diff, the card falls back to rendering the raw
  // `content` as plain SQL, which grows append-only and streams smoothly
  // (exactly the token-by-token write users want, same path as create_console).
  // Once the content is complete (`input-available`/`output-available`) the diff
  // is stable, so we show the proper red/green diff again — preferring the final
  // server `outputDiff` when present.
  const outputDiff = outputObj?.diff;
  const diff =
    typeof outputDiff === "string" && outputDiff.length > 0
      ? outputDiff
      : state === "input-streaming"
        ? undefined
        : buildStreamingModificationDiff(inputObj, consoleTab);

  return {
    consoleId,
    title,
    iconUrl: consoleTab?.connectionId
      ? connectionIconById.get(consoleTab.connectionId)
      : undefined,
    diff,
  };
}

function buildStreamingModificationDiff(
  input: Record<string, unknown> | undefined,
  consoleTab: ConsoleTab | undefined,
): string | undefined {
  const action = input?.action;
  const content = input?.content;
  if (
    !input ||
    !consoleTab ||
    typeof action !== "string" ||
    typeof content !== "string" ||
    content.length === 0
  ) {
    return undefined;
  }

  const position = input.position;
  const startLine = input.startLine;
  const endLine = input.endLine;
  const modification: ConsoleModification = {
    action: action as ConsoleModification["action"],
    content,
    position:
      typeof position === "number" ? { line: position, column: 1 } : undefined,
    startLine: typeof startLine === "number" ? startLine : undefined,
    endLine: typeof endLine === "number" ? endLine : undefined,
  };

  return buildModificationDiff(consoleTab.content || "", modification);
}
