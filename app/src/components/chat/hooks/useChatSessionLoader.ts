import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { VirtuosoHandle } from "react-virtuoso";
import { api } from "../../../api/client";
import type { LocalAcpChatBinding } from "../../../lib/persist-local-acp-chat";
import { isLocalAcpModelId } from "../../../lib/local-acp-models";
import { useConsoleStore } from "../../../store/consoleStore";
import { useSettingsStore } from "../../../store/settingsStore";
import { convertStoredMessages } from "../convert-stored-messages";
import { buildCostByAssistantOrdinal } from "../response-cost";
import type { ToolDispatchGate } from "../tool-dispatch-gate";

type ChatHelpers = UseChatHelpers<UIMessage>;

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
  "error",
]);

function isToolPart(part: Record<string, unknown>): boolean {
  const type = part.type;
  return (
    typeof type === "string" &&
    (type.startsWith("tool-") || type === "dynamic-tool")
  );
}

function lastUserText(
  messages: Array<{
    role?: string;
    parts?: Array<Record<string, unknown>> | null;
  }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const parts = msg.parts ?? [];
    const text = parts
      .filter(p => p.type === "text" && typeof p.text === "string")
      .map(p => String(p.text))
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

/**
 * True when the fetched persisted snapshot is BEHIND the live in-memory
 * state. Persistence is asynchronous and per-segment, so around a segment
 * boundary (a client tool just settled, the continuation hasn't saved yet)
 * the server may still hold the segment-END snapshot where that tool is
 * `input-available`. Swapping that in would clobber the settled output, the
 * history converter would poison the "pending" tool to Interrupted, and the
 * next send would persist the corrupted turn — history rewritten backwards.
 */
export function isPersistedSnapshotStale(
  rawPersisted: Array<{
    role?: string;
    parts?: Array<Record<string, unknown>> | null;
  }>,
  inMemory: ChatHelpers["messages"],
): boolean {
  if (inMemory.length === 0) return false;
  if (rawPersisted.length < inMemory.length) return true;
  if (rawPersisted.length > inMemory.length) return false;

  // Equal length but the newest user turn only exists in memory (e.g. Local
  // ACP optimistic append racing a History reload of the prior snapshot).
  const memoryUserText = lastUserText(inMemory);
  const persistedUserText = lastUserText(rawPersisted);
  if (
    memoryUserText !== null &&
    persistedUserText !== null &&
    memoryUserText !== persistedUserText
  ) {
    return true;
  }

  const persistedLast = rawPersisted[rawPersisted.length - 1];
  const memoryLast = inMemory[inMemory.length - 1];
  if (memoryLast.role !== "assistant") return false;
  if (persistedLast.role !== memoryLast.role) return true;

  const persistedParts = (persistedLast.parts ?? []) as Array<
    Record<string, unknown>
  >;
  const memoryParts = (memoryLast.parts ?? []) as Array<
    Record<string, unknown>
  >;
  if (persistedParts.length < memoryParts.length) return true;

  // Tool-output regression: a call settled in memory but still pending in
  // the snapshot means the snapshot predates the settle.
  const persistedToolStates = new Map<string, string>();
  for (const part of persistedParts) {
    if (!isToolPart(part)) continue;
    const id = part.toolCallId;
    if (typeof id === "string" && id) {
      persistedToolStates.set(id, String(part.state ?? ""));
    }
  }
  for (const part of memoryParts) {
    if (!isToolPart(part)) continue;
    const id = part.toolCallId;
    if (typeof id !== "string" || !id) continue;
    const memoryState = String(part.state ?? "");
    if (!TERMINAL_TOOL_STATES.has(memoryState)) continue;
    const persistedState = persistedToolStates.get(id);
    if (
      persistedState !== undefined &&
      !TERMINAL_TOOL_STATES.has(persistedState)
    ) {
      return true;
    }
  }
  return false;
}

export interface UseChatSessionLoaderArgs {
  chatId: string;
  isExistingChat: boolean;
  /** Current workspace id — reruns the history load when it resolves/changes. */
  workspaceId: string | undefined;
  setMessages: ChatHelpers["setMessages"];
  /** Live in-memory messages — the reload path must never step them backwards. */
  messagesRef: MutableRefObject<ChatHelpers["messages"]>;
  workspaceIdRef: MutableRefObject<string | undefined>;
  chatIdRef: MutableRefObject<string>;
  virtuosoRef: RefObject<VirtuosoHandle>;
  capturedConsoleIdRef: MutableRefObject<string | null>;
  handledConsoleOpenToolCallIdsRef: MutableRefObject<Set<string>>;
  toolDispatchGateRef: MutableRefObject<ToolDispatchGate>;
  /** Wired by this hook; used by the resume manager's reload-before-replay. */
  loadPersistedMessagesRef: MutableRefObject<
    ((opts?: { forHistoryLoad?: boolean }) => Promise<boolean>) | undefined
  >;
  requestResumeRef: MutableRefObject<
    ((opts?: { skipReload?: boolean }) => Promise<void>) | undefined
  >;
  /**
   * Local ACP counterpart of requestResumeRef: reattaches to a Local Agent
   * turn that kept running through a refresh (cheap no-op without a binding).
   */
  requestLocalAcpResumeRef?: MutableRefObject<(() => void) | undefined>;
  /**
   * Bound Local Agent ACP session for this History chat (if any). Cleared by
   * Chat on new-session; set here when a persisted localAcp payload is loaded.
   */
  localAcpBindingRef: MutableRefObject<LocalAcpChatBinding | null>;
  /**
   * True while a Local ACP turn is streaming. Mid-turn History checkpoints
   * persist in-flight tools; without this flag, reload would poison them to
   * "Interrupted — stream disconnected…" (ACP has no activeStreamId).
   */
  localAcpBusyRef: MutableRefObject<boolean>;
}

/**
 * Loads persisted chat messages (history selection / tab restore) and exposes
 * the same fetch+convert+set pipeline to the resume manager via
 * `loadPersistedMessagesRef`.
 */
export function useChatSessionLoader({
  chatId,
  isExistingChat,
  workspaceId,
  setMessages,
  messagesRef,
  workspaceIdRef,
  chatIdRef,
  virtuosoRef,
  capturedConsoleIdRef,
  handledConsoleOpenToolCallIdsRef,
  toolDispatchGateRef,
  loadPersistedMessagesRef,
  requestResumeRef,
  requestLocalAcpResumeRef,
  localAcpBindingRef,
  localAcpBusyRef,
}: UseChatSessionLoaderArgs): void {
  // Fetch the persisted chat and swap it into the hook state. Shared by the
  // history-load effect below and the resume manager's reload-before-replay
  // path (which must reset the in-memory assistant message before a replay
  // appends onto it). Reads chatId/workspaceId from refs at call time and
  // re-checks after every await so a slow fetch can never clobber a
  // different chat's state.
  loadPersistedMessagesRef.current = async (opts?: {
    forHistoryLoad?: boolean;
  }): Promise<boolean> => {
    const currentWorkspaceId = workspaceIdRef.current;
    const targetChatId = chatIdRef.current;
    if (!currentWorkspaceId || !targetChatId) return false;
    try {
      const { data: payload, response } = await api.GET(
        "/api/workspaces/{workspaceId}/chats/{id}",
        {
          params: {
            path: { workspaceId: currentWorkspaceId, id: targetChatId },
          },
        },
      );
      if (chatIdRef.current !== targetChatId) return false;
      if (!response.ok || !payload) return false;
      // The chat payload (messages/consoles) is spec-typed as a generic JSON
      // envelope; keep the loose shape the converter expects.
      const data = payload as {
        messages?: unknown[];
        consoles?: Array<{ id: string }>;
        activeStreamId?: string | null;
        localAcp?: LocalAcpChatBinding | null;
        usage?: unknown;
      };
      if (chatIdRef.current !== targetChatId) return false;

      // Rebind Local Agent ACP session + restore model when reopening History.
      if (
        data.localAcp?.sessionId &&
        data.localAcp.providerId &&
        data.localAcp.modelId
      ) {
        localAcpBindingRef.current = {
          providerId: data.localAcp.providerId,
          sessionId: data.localAcp.sessionId,
          modelId: data.localAcp.modelId,
        };
        if (opts?.forHistoryLoad && isLocalAcpModelId(data.localAcp.modelId)) {
          useSettingsStore.getState().setSelectedModelId(data.localAcp.modelId);
        }
      } else if (opts?.forHistoryLoad) {
        localAcpBindingRef.current = null;
      }

      const rawMessages = (data.messages ?? []) as Array<{
        role?: string;
        parts?: Array<Record<string, unknown>> | null;
      }>;

      // Never step the live in-memory state backwards to a stale snapshot
      // (persistence is async). Also covers Local ACP: first persist flips
      // isExistingChat → this loader re-fetches with forHistoryLoad and used
      // to clobber the optimistic user/assistant turn (message vanished on
      // Enter). History switches clear messages to [] first, so this guard
      // still allows a full load.
      if (isPersistedSnapshotStale(rawMessages, messagesRef.current)) {
        return false;
      }

      // Convert stored messages to AI SDK format with parts including tool
      // calls (for UI display — the backend sanitizes them before sending to
      // the AI to avoid "tool_use without tool_result" errors). While the
      // turn is still generating server-side (activeStreamId set), the
      // snapshot can lag the live state, so non-terminal tool parts are left
      // PENDING for the resume replay / orphan rescue to settle — patching
      // them to "Interrupted" here poisoned settled tools and the next send
      // persisted the poison over the server's correct finalization.
      const convertedMessages = convertStoredMessages(
        data.messages as unknown[],
        {
          turnActive:
            Boolean(data.activeStreamId) || Boolean(localAcpBusyRef.current),
          // Attach per-response cost from the persisted usage.history so
          // historical assistant messages show their cost tag too.
          costByAssistantOrdinal: buildCostByAssistantOrdinal(data.usage),
        },
      );

      // Restored tool parts must not re-trigger the in-band console
      // opener (only LIVE streamed results should); the consoles-restore
      // payload below already reopens what matters.
      for (const msg of convertedMessages) {
        for (const part of msg.parts ?? []) {
          const toolCallId = (part as { toolCallId?: string }).toolCallId;
          if (toolCallId) {
            handledConsoleOpenToolCallIdsRef.current.add(toolCallId);
          }
        }
      }

      // Seed the dispatch gate from the RAW persisted parts: tool calls that
      // completed in a previous page instance must not be re-executed by a
      // resumed-stream replay. Raw states on purpose — the converter rewrites
      // interrupted parts to output-error, and seeding those would block the
      // legitimate post-refresh re-dispatch of a tool that never got to run.
      toolDispatchGateRef.current.seedFromPersistedMessages(
        (data.messages ?? []) as Array<{
          role?: string;
          parts?: Array<Record<string, unknown>> | null;
        }>,
      );

      setMessages(convertedMessages as unknown as UIMessage[]);

      if (opts?.forHistoryLoad) {
        // Virtuoso keeps ONE instance across chat switches (Chat isn't keyed
        // by chatId), so its `initialTopMostItemIndex` — read once at mount —
        // never re-applies when we bulk-load a different chat's history here.
        // Without this, opening an existing chat from history can land
        // mid-list or at the top. Pin to the newest message on the next
        // frame (after the new data has rendered) so it deterministically
        // opens at the bottom, matching the old stick-to-bottom behavior.
        if (convertedMessages.length > 0) {
          requestAnimationFrame(() => {
            if (chatIdRef.current !== targetChatId) return;
            virtuosoRef.current?.scrollToIndex({
              index: "LAST",
              align: "end",
            });
          });
        }

        // Restore consoles that were modified by the agent in this chat
        // The backend extracts console IDs from modify_console tool calls in
        // the messages and fetches those consoles from the database
        if (data.consoles && data.consoles.length > 0) {
          const store = useConsoleStore.getState();
          for (const console of data.consoles) {
            // Check if console already exists in tabs (by ID)
            const exists = Boolean(store.tabs[console.id]);
            if (!exists) {
              await store.openConsoleFromServer(currentWorkspaceId, console.id);
            }
          }

          // Set the first restored console as active and capture it for this chat
          const firstConsole = data.consoles[0];
          if (firstConsole) {
            store.setActiveTab(firstConsole.id);
            capturedConsoleIdRef.current = firstConsole.id;
          }
        }
      }

      return true;
    } catch {
      /* ignore */
      return false;
    }
  };

  // Load messages when selecting an existing chat from history
  useEffect(() => {
    // Flipped when this effect is superseded (chat switched / unmount) so a
    // slow load can't resume the wrong chat. (State staleness is handled
    // inside loadPersistedMessages via chatId re-checks.)
    let cancelled = false;
    const loadSession = async () => {
      if (!isExistingChat || !workspaceId) {
        return;
      }
      await loadPersistedMessagesRef.current?.({ forHistoryLoad: true });

      // Reattach to a still-generating turn AFTER the persisted messages are
      // in place: the resumable SSE replay only contains this turn's
      // assistant chunks, so loading first yields the full conversation and
      // avoids setMessages clobbering an in-flight replay (skipReload — this
      // effect just loaded). The server answers 204 when the chat is idle
      // (or unknown), making this a cheap no-op.
      if (!cancelled) {
        void requestResumeRef.current?.({ skipReload: true });
        // Local ACP turns keep running on the Local Agent through a refresh;
        // rebind + replay them after the persisted snapshot is in place
        // (loadPersistedMessages set localAcpBindingRef just above).
        requestLocalAcpResumeRef?.current?.();
      }
    };
    loadSession();
    return () => {
      cancelled = true;
    };
  }, [
    chatId,
    isExistingChat,
    workspaceId,
    loadPersistedMessagesRef,
    requestResumeRef,
    requestLocalAcpResumeRef,
  ]);
}
