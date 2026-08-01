/**
 * Reattach main Chat to its Local Agent ACP turn after a page refresh or
 * History reopen. The Local Agent keeps running the turn (and recording its
 * events for SSE replay) while the browser is gone — this rebuilds the
 * in-flight assistant message from that replay backlog, streams the rest
 * live until `turn_done`, and persists the finished turn. It also backfills
 * a turn that finished while the page was closed (the tail was never
 * persisted because ACP transcripts persist client-side).
 */
import type { UIMessage } from "ai";
import { generateObjectId } from "../utils/objectId";
import { acpClient } from "./acp-client";
import { isAcpConnectionClosedError } from "./acp-connection-errors";
import { sanitizeAcpUserError } from "./acp-user-errors";
import type { AcpBridgeEvent, AcpProviderId } from "./acp-types";
import { localAcpModelIdToProviderId } from "./local-acp-models";
import {
  appendAssistantReasoning,
  appendAssistantText,
  getAssistantParts,
  isAcpCodexCommentaryPhase,
  markStreamingReasoningDone,
  setAssistantErrorText,
  upsertAcpToolPart,
  type AcpToolUpdate,
} from "./local-acp-parts";
import {
  persistLocalAcpChat,
  type LocalAcpChatBinding,
} from "./persist-local-acp-chat";
import { useAcpStore } from "../store/acpStore";
import { INTERRUPTED_TOOL_TEXT } from "../components/chat/convert-stored-messages";

type AssistantParts = ReturnType<typeof getAssistantParts>;

type SessionUpdatePayload = AcpToolUpdate & {
  content?: { type?: string; text?: string };
};

/** Old Local Agents may never send the `status: subscribed` backlog marker. */
const BACKLOG_SETTLE_TIMEOUT_MS = 10_000;
const MAX_ATTACH_ATTEMPTS = 3;

export type AcpResumeOutcome = "resumed" | "backfilled" | "none" | "aborted";

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
  "error",
]);

/** Raw text of the newest user message (what the last ACP prompt ended with). */
export function lastUserMessageText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    return (msg.parts ?? [])
      .filter(
        p =>
          p.type === "text" &&
          typeof (p as { text?: unknown }).text === "string",
      )
      .map(p => String((p as { text: string }).text))
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * True when the persisted transcript looks cut off mid-turn: the newest
 * message is a user turn with no reply, or an assistant checkpoint with
 * streaming/pending/poisoned parts and no settled content. Used to decide
 * whether a non-busy session still deserves a replay backfill.
 */
export function lastAssistantLooksIncomplete(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  if (last.role === "user") return true;
  if (last.role !== "assistant") return false;
  const parts = (last.parts ?? []) as Array<Record<string, unknown>>;
  if (parts.length === 0) return true;
  let hasContent = false;
  for (const p of parts) {
    const type = String(p.type ?? "");
    if (type === "reasoning") {
      if (p.state === "streaming") return true;
      if (String(p.text ?? "").trim()) hasContent = true;
      continue;
    }
    if (type === "text") {
      if (String(p.text ?? "").trim()) hasContent = true;
      continue;
    }
    if (type === "dynamic-tool" || type.startsWith("tool-")) {
      const state = String(p.state ?? "");
      if (!TERMINAL_TOOL_STATES.has(state)) return true;
      // History loader poisons pending tools of a dead turn to this text —
      // a refresh mid-turn lands here before the resume rebuild runs.
      if (p.errorText === INTERRUPTED_TOOL_TEXT) return true;
      hasContent = true;
    }
  }
  return !hasContent;
}

export interface AcpResumeTail {
  /** True when the backlog's newest prompt matches this chat's last user turn. */
  matched: boolean;
  /** Events after the newest user_message_chunk (the in-flight turn). */
  events: AcpBridgeEvent[];
  /** True when that turn already has a turn_done marker in the backlog. */
  done: boolean;
}

function sessionUpdateOf(event: AcpBridgeEvent): SessionUpdatePayload | null {
  if (event.type !== "session_update") return null;
  const update = event.update as SessionUpdatePayload | null | undefined;
  return update && typeof update === "object" ? update : null;
}

/**
 * Slice the replay backlog down to the newest turn and verify it belongs to
 * this chat. ACP process sessions can be reused across Mako chats, so the
 * prompt recorded on the bridge (which ends with the raw `[User message]`
 * text) must end with this chat's last user message — otherwise we would
 * paint another chat's turn into this transcript.
 */
export function extractResumeTail(
  events: AcpBridgeEvent[],
  lastUserText: string,
): AcpResumeTail {
  let lastUserIdx = -1;
  let lastUserChunkText = "";
  for (const [i, event] of events.entries()) {
    const update = sessionUpdateOf(event);
    if (
      update?.sessionUpdate === "user_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      lastUserIdx = i;
      lastUserChunkText = update.content.text.trim();
    }
  }
  if (lastUserIdx === -1 || !lastUserText) {
    return { matched: false, events: [], done: false };
  }
  const matched =
    lastUserChunkText === lastUserText ||
    lastUserChunkText.endsWith(lastUserText);
  const tail = events.slice(lastUserIdx + 1);
  return {
    matched,
    events: tail,
    done: tail.some(e => e.type === "turn_done"),
  };
}

function reduceSessionUpdate(
  parts: AssistantParts,
  update: SessionUpdatePayload,
): AssistantParts {
  if (
    update.sessionUpdate === "agent_thought_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string" &&
    update.content.text
  ) {
    return appendAssistantReasoning(parts, update.content.text);
  }
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string" &&
    update.content.text
  ) {
    // Codex puts most "thinking" in commentary-phase message chunks.
    return isAcpCodexCommentaryPhase(update)
      ? appendAssistantReasoning(parts, update.content.text)
      : appendAssistantText(parts, update.content.text);
  }
  if (
    update.sessionUpdate === "tool_call" ||
    update.sessionUpdate === "tool_call_update"
  ) {
    return upsertAcpToolPart(parts, update);
  }
  return parts;
}

/**
 * Rebuild the assistant message for one turn from its replayed events.
 * No UI focus side-effects here — replayed tool events must not yank tabs
 * around on reload the way live ones do.
 */
export function rebuildAssistantParts(
  tail: AcpBridgeEvent[],
  providerId: AcpProviderId,
): AssistantParts {
  let parts: AssistantParts = [];
  for (const event of tail) {
    if (event.type === "turn_done") break;
    if (event.type === "session_update") {
      const update = sessionUpdateOf(event);
      if (!update || update.sessionUpdate === "user_message_chunk") continue;
      parts = reduceSessionUpdate(parts, update);
    } else if (event.type === "error" || event.type === "session_invalidated") {
      if (!isAcpConnectionClosedError(event.message)) {
        const cleaned = sanitizeAcpUserError(event.message, { providerId });
        if (cleaned) {
          parts = setAssistantErrorText(parts, `Error: ${cleaned}`);
        }
      }
    }
  }
  return parts;
}

export function partsHaveContent(parts: AssistantParts): boolean {
  return parts.some(p => {
    if (p.type === "dynamic-tool") return true;
    if (p.type === "text" || p.type === "reasoning") {
      return Boolean(String((p as { text?: string }).text ?? "").trim());
    }
    return false;
  });
}

/** Same end-of-turn cleanup the live ACP transport applies. */
export function finalizeResumedParts(parts: AssistantParts): AssistantParts {
  let out = markStreamingReasoningDone(parts);
  out = out.filter(
    p =>
      !(
        p.type === "reasoning" &&
        !String((p as { text?: string }).text ?? "").trim()
      ),
  );
  if (!partsHaveContent(out)) {
    return [{ type: "text", text: "(No response from local agent)" }];
  }
  return out;
}

export interface ResumeLocalAcpChatArgs {
  binding: LocalAcpChatBinding;
  workspaceId: string;
  chatId: string;
  setMessages: (
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => void;
  /** Live in-memory transcript (post history-load) — read at call time. */
  getMessages: () => UIMessage[];
  signal?: AbortSignal;
  /** Fired once when we attach to a genuinely in-flight turn (show busy UI). */
  onLiveAttach?: () => void;
  /** Called after a successful persist so History can refresh / rebind. */
  onPersisted?: (binding?: LocalAcpChatBinding) => void;
}

/**
 * Check the bound ACP session and, when its newest turn belongs to this chat
 * and is still running (or finished unpersisted), rebuild + stream + persist
 * it. Resolves once the turn is settled locally; cheap no-op ("none") when
 * there is nothing to reattach to.
 */
export async function resumeLocalAcpChatTurn(
  args: ResumeLocalAcpChatArgs,
): Promise<AcpResumeOutcome> {
  const {
    binding,
    workspaceId,
    chatId,
    setMessages,
    getMessages,
    signal,
    onLiveAttach,
    onPersisted,
  } = args;
  const providerId = localAcpModelIdToProviderId(binding.modelId);
  if (!providerId) return "none";

  let sessionBusy = false;
  try {
    const sessions = await acpClient.listSessions();
    const session = sessions.find(s => s.id === binding.sessionId);
    if (!session) return "none";
    sessionBusy = Boolean(session.busy);
  } catch {
    // Local Agent unreachable (not running / different machine) — nothing to do.
    return "none";
  }
  if (signal?.aborted) return "aborted";

  // The history loader's setMessages may not have flushed into the caller's
  // messages ref yet (React batches state updates) — wait briefly for the
  // transcript instead of silently skipping the resume.
  let lastUserText = lastUserMessageText(getMessages());
  for (let i = 0; i < 10 && !lastUserText; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (signal?.aborted) return "aborted";
    lastUserText = lastUserMessageText(getMessages());
  }
  if (!lastUserText) return "none";
  if (!sessionBusy && !lastAssistantLooksIncomplete(getMessages())) {
    return "none";
  }

  // Mirror message updates synchronously so persists never race React's
  // batched setState flush (same pattern as runLocalAcpChatTurn).
  let mirrored: UIMessage[] | null = null;
  const applyMessages = (
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => {
    setMessages(prev => {
      const base = mirrored ?? prev;
      const next = typeof updater === "function" ? updater(base) : updater;
      mirrored = next;
      return next;
    });
  };
  const appendedAssistantId = generateObjectId();
  const applyAssistantParts = (parts: AssistantParts) => {
    applyMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, parts: parts as UIMessage["parts"] }
            : m,
        );
      }
      return [
        ...prev,
        {
          id: appendedAssistantId,
          role: "assistant" as const,
          parts: parts as UIMessage["parts"],
        },
      ];
    });
  };

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  let notifiedPersist = false;
  const persistIfPossible = async () => {
    if (!mirrored || mirrored.length === 0) return;
    const ok = await persistLocalAcpChat({
      workspaceId,
      chatId,
      messages: mirrored,
      localAcp: binding,
    });
    if (!ok) return;
    if (!notifiedPersist) {
      notifiedPersist = true;
      onPersisted?.(binding);
    }
  };
  const schedulePersist = (mode: "debounce" | "immediate" = "debounce") => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const run = () => {
      persistTimer = null;
      persistChain = persistChain
        .then(() => persistIfPossible())
        .catch(() => undefined);
    };
    if (mode === "immediate") {
      run();
      return;
    }
    persistTimer = setTimeout(run, 750);
  };
  const flushPersist = async () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistChain.catch(() => undefined);
    await persistIfPossible();
  };

  let liveAttached = false;
  const sessionId = binding.sessionId;

  const attachOnce = () =>
    new Promise<AcpResumeOutcome | "retry">(resolve => {
      let phase: "backlog" | "live" = "backlog";
      const backlog: AcpBridgeEvent[] = [];
      let parts: AssistantParts = [];
      let settled = false;
      let sawTurnDone = false;
      let backlogTimer: ReturnType<typeof setTimeout> | null = null;

      let unsub: () => void = () => undefined;
      const teardown = () => {
        settled = true;
        if (backlogTimer) clearTimeout(backlogTimer);
        signal?.removeEventListener("abort", onAbort);
        unsub();
      };
      const settle = (outcome: AcpResumeOutcome | "retry") => {
        if (settled) return;
        teardown();
        resolve(outcome);
      };
      const onAbort = () => settle("aborted");
      const finishTurn = (outcome: "resumed" | "backfilled") => {
        if (settled) return;
        // Tear down first so late events can't mutate the finalized state.
        teardown();
        parts = finalizeResumedParts(parts);
        applyAssistantParts(parts);
        void flushPersist().finally(() => resolve(outcome));
      };

      const processBacklog = () => {
        if (settled || phase !== "backlog") return;
        if (backlogTimer) {
          clearTimeout(backlogTimer);
          backlogTimer = null;
        }
        const tail = extractResumeTail(backlog, lastUserText);
        if (!tail.matched) {
          // Newest turn on this session belongs to another chat (or the
          // agent restarted and the log is gone) — nothing safe to resume.
          settle("none");
          return;
        }
        parts = rebuildAssistantParts(tail.events, providerId);
        if (tail.done || !sessionBusy) {
          // Turn already over: repaint the completed tail and persist it —
          // this is the refresh-after-finish case where the final tokens
          // never reached History.
          if (!tail.done && !partsHaveContent(parts)) {
            settle("none");
            return;
          }
          finishTurn("backfilled");
          return;
        }
        // Turn still streaming — seed a live Thinking block if the backlog
        // had nothing visible yet, then keep painting live events.
        if (parts.length === 0) {
          parts = [{ type: "reasoning", text: "", state: "streaming" }];
        }
        applyAssistantParts(parts);
        phase = "live";
        if (!liveAttached) {
          liveAttached = true;
          // Active session drives Stop (cancelActive) + the permission banner.
          useAcpStore.getState().setActiveSession(sessionId);
          onLiveAttach?.();
        }
      };

      unsub = acpClient.subscribeEvents(
        sessionId,
        event => {
          if (settled) return;
          if (signal?.aborted) {
            settle("aborted");
            return;
          }
          if (phase === "backlog") {
            if (event.type === "status") {
              processBacklog();
            } else {
              backlog.push(event);
            }
            return;
          }
          if (event.type === "session_update") {
            const update = sessionUpdateOf(event);
            if (!update) return;
            if (update.sessionUpdate === "user_message_chunk") {
              // A new prompt started on this session (another window/tab) —
              // this chat's turn is over; keep what we reconstructed.
              finishTurn("resumed");
              return;
            }
            parts = reduceSessionUpdate(parts, update);
            applyAssistantParts(parts);
            if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update"
            ) {
              schedulePersist(
                update.status === "completed" || update.status === "failed"
                  ? "immediate"
                  : "debounce",
              );
            }
          } else if (event.type === "turn_done") {
            sawTurnDone = true;
            finishTurn("resumed");
          } else if (event.type === "permission_request") {
            useAcpStore.getState().ingestPermissionRequest(sessionId, {
              requestId: event.requestId,
              toolCall: event.toolCall,
              options: event.options || [],
            });
          } else if (
            event.type === "error" ||
            event.type === "session_invalidated"
          ) {
            if (isAcpConnectionClosedError(event.message)) {
              // Adapter process died mid-turn — the turn cannot finish.
              parts = setAssistantErrorText(
                parts,
                "_Local Claude/Codex connection was lost — the reply may be incomplete._",
              );
              finishTurn("resumed");
              return;
            }
            const cleaned = sanitizeAcpUserError(event.message, {
              providerId,
            });
            if (cleaned) {
              parts = setAssistantErrorText(parts, `Error: ${cleaned}`);
              applyAssistantParts(parts);
              schedulePersist("immediate");
            }
            if (event.type === "session_invalidated") {
              finishTurn("resumed");
            }
          }
        },
        () => {
          if (settled) return;
          if (signal?.aborted) {
            settle("aborted");
            return;
          }
          // SSE transport dropped. Mid-turn we re-attach (replay rebuilds the
          // whole turn, so nothing is lost); before/after that it's a no-op.
          settle(phase === "live" && !sawTurnDone ? "retry" : "none");
        },
        // Default replay=true: the backlog IS the reconnect mechanism here.
      );

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      backlogTimer = setTimeout(processBacklog, BACKLOG_SETTLE_TIMEOUT_MS);
    });

  try {
    for (let attempt = 0; attempt < MAX_ATTACH_ATTEMPTS; attempt++) {
      const outcome = await attachOnce();
      if (outcome !== "retry") return outcome;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      if (signal?.aborted) return "aborted";
      const session = await acpClient.getSession(sessionId);
      if (!session) break;
      sessionBusy = Boolean(session.busy);
    }
    // Retries exhausted (or session gone) mid-turn — keep the checkpoint.
    await flushPersist();
    return "resumed";
  } finally {
    if (signal?.aborted) {
      // Chat switched / new send took over — checkpoint what we painted.
      void flushPersist();
    }
  }
}
