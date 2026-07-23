/**
 * Chat Component - Using Vercel AI SDK useChat hook
 * Native AI SDK streaming protocol for improved compatibility
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
} from "react";
import {
  Box,
  Chip,
  IconButton,
  Typography,
  Alert,
  Collapse,
  Tooltip,
} from "@mui/material";
import {
  ChevronDown,
  Copy,
  Check,
  History,
  Menu as MenuIcon,
  Plus,
} from "lucide-react";
import { useTheme as useMuiTheme } from "@mui/material/styles";
import { useChat } from "@ai-sdk/react";
import { Virtuoso, type VirtuosoHandle, type Components } from "react-virtuoso";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMcpStore } from "../store/mcpStore";
import { api } from "../api/client";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import type { ConsoleTab } from "../store/lib/types";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSchemaStore } from "../store/schemaStore";
import { useAcpStore } from "../store/acpStore";
import { selectActiveExplorer, useUIStore } from "../store/uiStore";
import { useRealtimeStore } from "../store/realtimeStore";
import { useIsMobile } from "../hooks/useIsMobile";
import { generateObjectId } from "../utils/objectId";
import { isLocalAcpModelId } from "../lib/local-acp-models";
import { runLocalAcpChatTurn } from "../lib/local-acp-chat";
import { DbFlowFormRef } from "./DbFlowForm";
import { safeStringify, toJsonSafe } from "../lib/json-safe";
import { ClarifyingQuestionsCard } from "./ClarifyingQuestionsCard";
import { PlanCard } from "./PlanCard";
import {
  focusPlanTab,
  syncPlanTabTitle,
  usePlanStore,
  type PartialSubmitPlanInput,
} from "../store/planStore";
import type {
  AskClarifyingQuestionsInput,
  SubmitPlanInput,
} from "@mako/agent-tools";
import { type ChatMessageRowProps } from "./chat-message-comparator";
import {
  buildChatRequestBody,
  type ActiveConsoleResultsContext,
} from "../agent-runtime/request-context";
import { consumePendingScreenshotVisionAttachments } from "../agent-runtime/screenshot-agent-tools";
import { UpgradePrompt } from "./UpgradePrompt";
import {
  readStoredChatSession,
  writeStoredChatSession,
  type StoredChatSession,
} from "./chat/session-storage";
import {
  type AutoSendPredicateArgs,
  type ToolInvocationInfo,
} from "./chat/tool-presentation";
import {
  useClientToolRegistry,
  type AddToolOutputFn,
} from "./chat/hooks/useClientToolRegistry";
import {
  useClientToolDispatch,
  type DispatchableToolCall,
} from "./chat/hooks/useClientToolDispatch";
import { useStreamResume } from "./chat/hooks/useStreamResume";
import { useServerToolSync } from "./chat/hooks/useServerToolSync";
import { useChatSessions } from "./chat/hooks/useChatSessions";
import { ChatHistoryMenu } from "./chat/ChatHistoryMenu";
import { ToolDetailsDialog } from "./chat/ToolDetailsDialog";
import { useChatSessionLoader } from "./chat/hooks/useChatSessionLoader";
import { useQueuedPrompts } from "./chat/hooks/useQueuedPrompts";
import { useChatScroll } from "./chat/hooks/useChatScroll";
import { useNotebookAutoOpen } from "./chat/hooks/useNotebookAutoOpen";
import { ChatMessageRow, MessageVirtuosoList } from "./chat/ChatMessageRow";
import { QueuedPromptList } from "./chat/QueuedPrompts";
import { ChatInputArea } from "./chat/ChatInputArea";
import { AcpPermissionBanner } from "./AcpPermissionBanner";
import {
  onRenderDebug,
  useRenderCount,
  useWhyChanged,
} from "../utils/renderDebug";

// Virtuoso's `Components['List']` types `ref` as a `LegacyRef` (string refs
// allowed), which is contravariant with forwardRef's `Ref`. The component is
// structurally correct; this cast bridges that one incompatibility.
const messageVirtuosoComponents: Components<ChatMessageRowProps["message"]> = {
  List: MessageVirtuosoList as Components<
    ChatMessageRowProps["message"]
  >["List"],
};

// DbFlowFormRef is imported from ./DbFlowForm

interface ChatProps {
  dbFlowFormRef?: React.RefObject<DbFlowFormRef | null>;
  onChartSpecChangeRef?: React.MutableRefObject<
    ((payload: import("./Editor").ChartSpecChangePayload) => void) | undefined
  >;
  resultsContextRef?: React.MutableRefObject<
    import("./Editor").ConsoleResultsContext | null
  >;
}

type ChatActiveView = "dashboard" | "flow-editor" | "console" | "empty";

function normalizeChatActiveView(kind: ConsoleTab["kind"]): ChatActiveView {
  return kind === "dashboard" || kind === "flow-editor" || kind === "console"
    ? kind
    : "empty";
}

// Starter prompts for the mobile "Ask your data" empty state. Tapping one runs
// it through the normal send path.
const MOBILE_ASK_SUGGESTIONS = [
  "What tables are in my database?",
  "Show me the 10 most recent records",
  "How many rows are in each table?",
  "Summarize my data with a chart",
];

// Claude-style floating round button used in the mobile pane headers. Each
// control carries its own paper fill + blur + hairline so it reads as floating
// chrome over the content rather than sitting in a solid app bar.
const MOBILE_FLOAT_BTN_SX = {
  width: 38,
  height: 38,
  borderRadius: "50%",
  color: "text.secondary",
  bgcolor: "background.paper",
  border: 1,
  borderColor: "divider",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
  backdropFilter: "blur(8px)",
  "&:hover": { bgcolor: "action.hover" },
} as const;

const Chat: React.FC<ChatProps> = ({
  dbFlowFormRef,
  onChartSpecChangeRef,
  resultsContextRef,
}) => {
  const paletteMode = useMuiTheme().palette.mode;
  const { currentWorkspace } = useWorkspace();
  const selectedModelId = useSettingsStore(s => s.selectedModelId);

  // On mobile, Chat is the full-screen "Ask your data" home. Track viewport in
  // a ref so stable useCallback handlers (e.g. console title click) can switch
  // the mobile tab without widening their dependency arrays.
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  // Ref for dbFlowFormRef to avoid stale closure in onToolCall
  const dbFlowFormRefCurrent = useRef(dbFlowFormRef);
  dbFlowFormRefCurrent.current = dbFlowFormRef;

  // Connection metadata is only needed to decorate completed console tool cards.
  const connections = useSchemaStore(s => s.connections);
  const dbTypes = useDatabaseCatalogStore(s => s.types);
  const fetchDbTypes = useDatabaseCatalogStore(s => s.fetchTypes);
  useEffect(() => {
    void fetchDbTypes();
  }, [fetchDbTypes]);
  const workspaceConnections = useMemo(
    () => (currentWorkspace ? connections[currentWorkspace.id] || [] : []),
    [connections, currentWorkspace],
  );
  const connectionIconById = useMemo(() => {
    const iconByType = new Map<string, string>();
    for (const dbType of dbTypes ?? []) {
      if (dbType.iconUrl) iconByType.set(dbType.type, dbType.iconUrl);
    }

    const iconByConnectionId = new Map<string, string>();
    for (const connection of workspaceConnections) {
      const iconUrl = iconByType.get(connection.type);
      if (iconUrl) iconByConnectionId.set(connection.id, iconUrl);
    }
    return iconByConnectionId;
  }, [dbTypes, workspaceConnections]);

  // The chat persisted for this tab (if any), read once per mount. Restoring
  // it means a page refresh reopens — and reattaches to — the same chat.
  const initialStoredSessionRef = useRef<StoredChatSession | null | undefined>(
    undefined,
  );
  if (initialStoredSessionRef.current === undefined) {
    initialStoredSessionRef.current = readStoredChatSession();
  }
  // chatId is a MongoDB ObjectId generated locally - frontend owns the ID (AI SDK best practice)
  const [chatId, setChatId] = useState<string>(
    () => initialStoredSessionRef.current?.chatId ?? generateObjectId(),
  );
  // Virtualized message list (react-virtuoso). Replaces use-stick-to-bottom:
  // Virtuoso owns its own scroller and bottom-anchoring (`followOutput`), and
  // only mounts visible rows + overscan so long chats stay light on
  // DOM/memory/paint — critical on mobile. `isAtBottom` drives both the
  // "scroll to bottom" button and whether streaming auto-follows the tail.
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Track if we're viewing an existing chat from history (vs a new chat)
  // Moved before useChat so onFinish callback can access it
  // A chat restored from sessionStorage is treated as existing so its
  // persisted messages are loaded before reattaching to the live stream.
  const [isExistingChat, setIsExistingChat] = useState(() =>
    Boolean(initialStoredSessionRef.current),
  );

  // Refs for accessing current values in callbacks (avoids stale closures)
  const isExistingChatRef = useRef(isExistingChat);
  isExistingChatRef.current = isExistingChat;

  // NOTE: console tools execute server-side (issue #475); open tabs follow
  // along via the realtime channel (realtimeStore), so Chat no longer
  // applies console modifications itself.

  // Ref to capture the active console ID at the time the user submits a message
  // This prevents the race condition where user switches consoles while agent is thinking
  const capturedConsoleIdRef = useRef<string | null>(null);

  // Ref to capture the active dashboard ID at submit time so switching tabs mid-turn
  // doesn't cause the agent to read context from a different dashboard
  const capturedDashboardIdRef = useRef<string | null>(null);

  // Session list / history menu state (fetch, delete, streaming indicator).
  // Called before useChat so onFinish can refresh the list via the ref.
  const {
    sessions,
    fetchSessionsRef,
    isSessionStreaming,
    deleteSession,
    historyMenuAnchor,
    historyMenuOpen,
    handleHistoryMenuOpen,
    handleHistoryMenuClose,
  } = useChatSessions({ workspaceId: currentWorkspace?.id });

  // Tool debug dialog
  const [toolDialogOpen, setToolDialogOpen] = useState(false);
  const [selectedTool, setSelectedTool] = useState<ToolInvocationInfo | null>(
    null,
  );

  // Keep the active console ID fresh without subscribing the whole chat panel
  // to every console switch. This avoids disrupting chat streaming when users
  // browse consoles/databases in the left explorer.
  const activeConsoleIdRef = useRef(useConsoleStore.getState().activeTabId);
  useEffect(() => {
    return useConsoleStore.subscribe(state => {
      activeConsoleIdRef.current = state.activeTabId;
    });
  }, []);

  // Refs for values needed in prepareSendMessagesRequest (avoids stale closures)
  const workspaceIdRef = useRef(currentWorkspace?.id);
  const modelIdRef = useRef(selectedModelId);
  const chatIdRef = useRef(chatId);
  const manualStopRequestedRef = useRef(false);
  const drainQueuedPromptAfterTurnRef = useRef<(() => void) | null>(null);
  const sendViaLocalAcpRef = useRef<
    ((text: string) => Promise<boolean>) | null
  >(null);
  const localAcpAbortRef = useRef<AbortController | null>(null);
  const [localAcpBusy, setLocalAcpBusy] = useState(false);
  // Client-tool registry: in-flight executions, cancel/interrupt plumbing,
  // and the per-chat toolCallId dispatch dedupe gate (the triplicate-tool
  // fix). Created before useChat — its register/settle callbacks are wired
  // into onToolCall; addToolOutputRef is assigned right after useChat.
  const addToolOutputRef = useRef<AddToolOutputFn>();
  const {
    activeClientToolCallsRef,
    toolDispatchGateRef,
    activeClientToolCallCount,
    registerActiveClientToolCall,
    settleActiveClientToolCall,
    cancelActiveClientToolCalls,
    interruptActiveClientToolCalls,
  } = useClientToolRegistry({
    addToolOutputRef,
    manualStopRequestedRef,
    chatId,
  });
  // onError's resume-retry budget/timer — owned by useStreamResume; declared
  // here because useChat's onFinish (built before that hook runs) resets it.
  const errorResumeRef = useRef<{
    count: number;
    windowStart: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ count: 0, windowStart: 0, timer: null });
  // Stream-error handling lives in useStreamResume (which needs useChat's
  // state, so it runs after useChat); useChat's onError — captured once per
  // Chat instance — delegates through this ref.
  const onStreamErrorImplRef = useRef<(error: unknown) => void>();
  const clearErrorRef = useRef<(() => void) | undefined>();
  // Single-flight resume manager (assigned after useChat — it needs stop /
  // resumeStream). ALL reattach triggers (loadSession, wake, error retry) go
  // through requestResumeRef: calling the SDK's resumeStream directly attaches
  // an ADDITIONAL stream consumer without tearing down the previous one, and
  // every consumer re-processes every chunk — the root cause of the
  // triplicated tool executions and message parts.
  const requestResumeRef =
    useRef<(opts?: { skipReload?: boolean }) => Promise<void>>();
  // Refetch persisted messages + reset chat state; assigned by
  // useChatSessionLoader (shares the history-load conversion logic).
  const loadPersistedMessagesRef =
    useRef<(opts?: { forHistoryLoad?: boolean }) => Promise<boolean>>();
  // Client tool dispatch lives in useClientToolDispatch (which needs useChat's
  // state, so it runs after useChat); useChat's onToolCall — captured once at
  // Chat-instance creation — delegates through this ref so it always invokes
  // the latest implementation.
  const onToolCallImplRef =
    useRef<(toolCall: DispatchableToolCall) => Promise<void>>();
  const isLoadingRef = useRef(false);
  // While a submit_plan awaits review, the composer routes sent messages to
  // the plan as request_changes feedback. Assigned below (after the
  // pendingInteractiveTool memo); declared here so useQueuedPrompts can close
  // over it.
  const pendingPlanToolCallIdRef = useRef<string | null>(null);
  // One-shot latch: suppress the SDK auto-send triggered by `addToolOutput`
  // when plan feedback resolves the tool — the feedback is then sent as a
  // real user message (visible in the chat), carrying the resolved tool
  // output and the message in a single request. Consumed by the
  // `sendAutomaticallyWhen` predicate below; reset in onFinish as a leak
  // guard (e.g. the SDK skipped the predicate because a request was already
  // in flight).
  const suppressNextAutoSendRef = useRef(false);
  workspaceIdRef.current = currentWorkspace?.id;
  modelIdRef.current = selectedModelId;
  chatIdRef.current = chatId;

  const autoSendWhenComplete = useCallback((options: AutoSendPredicateArgs) => {
    if (manualStopRequestedRef.current) {
      return false;
    }
    // Approval responses (MCP allow/deny) resume the turn just like settled
    // client tool calls do.
    return (
      lastAssistantMessageIsCompleteWithToolCalls(options) ||
      lastAssistantMessageIsCompleteWithApprovalResponses(options)
    );
  }, []);

  // The predicate handed to useChat. Split from `autoSendWhenComplete` (also
  // used by the queued-prompt drain as a soft-block mirror) so the one-shot
  // plan-feedback latch is only ever consumed by the SDK's own check.
  const sdkAutoSendWhen = useCallback(
    (options: AutoSendPredicateArgs) => {
      if (suppressNextAutoSendRef.current) {
        suppressNextAutoSendRef.current = false;
        return false;
      }
      return autoSendWhenComplete(options);
    },
    [autoSendWhenComplete],
  );

  // Create transport once — prepareSendMessagesRequest reads all dynamic
  // values from getState() / refs at request time, so the transport identity
  // is stable for the lifetime of the component.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        prepareSendMessagesRequest: ({ messages }) => {
          // Get fresh console state at request time
          const store = useConsoleStore.getState();
          const tabs = Object.values(store.tabs) as ConsoleTab[];
          const activeTab = tabs.find(t => t.id === store.activeTabId);
          const computedActiveView = normalizeChatActiveView(activeTab?.kind);
          const workspaceId = workspaceIdRef.current;
          const workspaceConnectionsForRequest = workspaceId
            ? useSchemaStore.getState().connections[workspaceId] || []
            : [];

          const flowFormState = dbFlowFormRefCurrent.current?.current
            ? dbFlowFormRefCurrent.current.current.getFormState()
            : undefined;

          // Read results context from Editor at request time
          const resultsCtx = resultsContextRef?.current ?? null;
          const activeConsoleResults: ActiveConsoleResultsContext | undefined =
            resultsCtx
              ? {
                  viewMode: resultsCtx.viewMode,
                  hasResults: resultsCtx.hasResults,
                  rowCount: resultsCtx.rowCount,
                  columns: resultsCtx.columns,
                  sampleRows: resultsCtx.sampleRows,
                  chartSpec: resultsCtx.chartSpec,
                }
              : undefined;

          const screenshotVisionAttachments =
            consumePendingScreenshotVisionAttachments();
          const requestBody = buildChatRequestBody({
            messages,
            workspaceId,
            modelId: modelIdRef.current,
            chatId: chatIdRef.current,
            tabs,
            activeTabId: store.activeTabId,
            activeTab,
            activeView: computedActiveView,
            activeExplorer: selectActiveExplorer(useUIStore.getState()),
            activeConsoleId: activeConsoleIdRef.current,
            activeConsoleResults,
            flowFormState,
            workspaceConnections: workspaceConnectionsForRequest,
            pinnedDashboardId: capturedDashboardIdRef.current,
          });

          return {
            body: toJsonSafe(
              screenshotVisionAttachments.length > 0
                ? {
                    ...requestBody,
                    screenshotVisionAttachments,
                  }
                : requestBody,
            ) as Record<string, unknown>,
          };
        },
        // Where `resume: true` reattaches to an in-flight turn (page refresh,
        // another device/viewer). 204 means nothing is streaming.
        prepareReconnectToStreamRequest: ({ id }) => ({
          api: `/api/agent/chat/${id}/stream`,
        }),
      }),
    [resultsContextRef],
  );

  // Note: We use useConsoleStore.getState() inside callbacks to avoid stale closure issues

  // useChat hook from Vercel AI SDK
  // IMPORTANT: The 'id' prop is critical - it resets the hook's internal message state
  // when chatId changes. Without it, switching chats causes stale messages to persist.
  // @typescript-eslint/no-explicit-any
  const {
    messages,
    sendMessage,
    status,
    error,
    clearError,
    stop,
    setMessages,
    addToolOutput,
    addToolApprovalResponse,
    resumeStream,
  } = useChat({
    id: chatId, // Reset hook state when chatId changes (fixes stale messages bug)
    transport,
    // NOTE: we intentionally do NOT use `resume: true`. The hook's resume
    // effect only fires on mount (its deps are [resume, chatRef] and chatRef
    // is a stable ref), so it never reattaches when chatId changes (history
    // selection). Instead `resumeStream()` is called explicitly at the end of
    // loadSession, which also sequences it after setMessages so the replayed
    // stream is never clobbered by the persisted-message load.
    experimental_throttle: 50,

    // Automatically submit when all tool results are available
    sendAutomaticallyWhen: sdkAutoSendWhen,

    // Handle client-side tools (console operations). The implementation
    // lives in useClientToolDispatch (it needs useChat state for its
    // orphan-rescue effect, so it runs after this hook); the SDK captures
    // this closure once per Chat instance, so delegate through a ref.
    async onToolCall({ toolCall }) {
      await onToolCallImplRef.current?.(toolCall as DispatchableToolCall);
    },

    // Stream-error handling (resume retry budget / poison fallback) lives in
    // useStreamResume; the SDK captures this closure once per Chat instance,
    // so delegate through a ref.
    onError: err => {
      onStreamErrorImplRef.current?.(err);
    },
    onFinish: ({ isAbort }) => {
      // A teardown abort — the resume manager stopping a stale consumer
      // before reattaching, or the user's Stop — is not a completed turn:
      // don't reset the retry budget, refetch sessions, or drain queued
      // prompts off it. (A force-send drains via the status-transition
      // effect once the interrupted turn settles.)
      if (isAbort) return;
      // The turn settled cleanly — reset the resume-retry budget and release
      // a plan-feedback auto-send latch that was never consumed (leak guard).
      errorResumeRef.current.count = 0;
      suppressNextAutoSendRef.current = false;
      if (!isExistingChatRef.current) {
        fetchSessionsRef.current?.();
      }
      // Runs after makeRequest's synchronous sendAutomaticallyWhen check so
      // queued prompts are not drained between agent auto-continuation steps.
      queueMicrotask(() => drainQueuedPromptAfterTurnRef.current?.());
    },
  });

  // Latest resumeStream for use inside effects without dep churn — it is
  // re-bound to a fresh Chat instance whenever chatId changes.
  const resumeStreamRef = useRef(resumeStream);
  resumeStreamRef.current = resumeStream;

  // Open + list-refresh a notebook the agent creates, driven off the chat
  // stream (reliable) rather than the ephemeral workspace realtime poke.
  useNotebookAutoOpen(messages);

  // Latest status for use inside stable event-listener / callback closures
  // (the wake handler and onError) without re-installing listeners every turn.
  const statusRef = useRef(status);
  statusRef.current = status;

  // Latest stop() for the resume manager (client-side abort only — it never
  // hits the server /stop endpoint, so the generation keeps running for the
  // replacement consumer to reattach to).
  const stopRef = useRef(stop);
  stopRef.current = stop;

  // Latest messages / sendMessage for stable closures (drain, wake handler).
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  // Give the registry (created before useChat) the live addToolOutput.
  addToolOutputRef.current = addToolOutput;
  clearErrorRef.current = clearError;

  // Single-flight + liveness-gated resume manager, tab-wake reattach, and the
  // stream-error handler — assigns requestResumeRef / onStreamErrorImplRef
  // and installs the wake listeners.
  useStreamResume({
    status,
    messages,
    statusRef,
    messagesRef,
    chatIdRef,
    manualStopRequestedRef,
    activeClientToolCallsRef,
    stopRef,
    resumeStreamRef,
    loadPersistedMessagesRef,
    requestResumeRef,
    errorResumeRef,
    onStreamErrorImplRef,
    clearErrorRef,
    setMessages,
    cancelActiveClientToolCalls,
  });

  // Client-tool dispatch (onToolCall body, orphan recovery + rescue effect).
  const { onToolCall: dispatchClientToolCall } = useClientToolDispatch({
    registry: {
      activeClientToolCallsRef,
      toolDispatchGateRef,
      activeClientToolCallCount,
      registerActiveClientToolCall,
      settleActiveClientToolCall,
    },
    addToolOutputRef,
    manualStopRequestedRef,
    workspaceIdRef,
    onChartSpecChangeRef,
    dbFlowFormRefCurrent,
    status,
    messages,
    chatId,
    setMessages,
    loadPersistedMessagesRef,
  });
  onToolCallImplRef.current = dispatchClientToolCall;

  // Aborting mid-stream can leave assistant tool calls stuck in
  // "input-available"/"input-streaming" (their output never arrives). The AI
  // SDK blocks the next sendMessage until every tool call is settled, so patch
  // any dangling ones to "error" — otherwise a force-send after an interrupt
  // would hang.
  const settleDanglingAssistantToolCalls = useCallback(() => {
    setMessages(prev =>
      prev.map(msg => {
        if (msg.role !== "assistant") return msg;
        const hasPending = msg.parts?.some(p => {
          const pt = p.type as string;
          if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
          const s = (p as Record<string, unknown>).state as string;
          return s !== "output-available" && s !== "error";
        });
        if (!hasPending) return msg;
        return {
          ...msg,
          parts: msg.parts.map(p => {
            const pt = p.type as string;
            if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return p;
            const s = (p as Record<string, unknown>).state as string;
            if (s === "output-available" || s === "error") return p;
            return {
              ...p,
              state: "error" as const,
              output: {
                success: false,
                error: "Tool cancelled (chat stopped)",
              },
            };
          }) as any,
        };
      }),
    );
  }, [setMessages]);

  // Interrupt the in-flight turn: abort client tools, abort server-side
  // generation, and settle every dangling tool call. Does NOT touch the queue
  // so callers can choose to clear it (manual stop) or keep it (force-send).
  const interruptActiveTurn = useCallback(() => {
    manualStopRequestedRef.current = true;

    // Abort an in-flight local ACP (Claude Code / Codex) turn if any.
    localAcpAbortRef.current?.abort();
    localAcpAbortRef.current = null;
    setLocalAcpBusy(false);
    void useAcpStore
      .getState()
      .cancelActive()
      .catch(() => undefined);

    interruptActiveClientToolCalls();
    // With resumable streams, disconnecting no longer cancels the turn — the
    // server keeps generating for reconnecting clients. Stop must be explicit:
    // this aborts the server-side generation and clears the resume pointer.
    if (chatIdRef.current) {
      void api
        .POST("/api/agent/chat/{chatId}/stop", {
          params: { path: { chatId: chatIdRef.current } },
        })
        .catch(() => undefined);
    }
    stop();
    settleDanglingAssistantToolCalls();
  }, [interruptActiveClientToolCalls, stop, settleDanglingAssistantToolCalls]);

  const isLoading =
    status === "streaming" ||
    status === "submitted" ||
    activeClientToolCallCount > 0 ||
    localAcpBusy;
  isLoadingRef.current = isLoading;

  // Main Chat → Local Agent ACP when the dropdown selection is a local model.
  sendViaLocalAcpRef.current = async (text: string) => {
    const modelId = modelIdRef.current;
    if (!modelId || !isLocalAcpModelId(modelId)) return false;

    localAcpAbortRef.current?.abort();
    const abort = new AbortController();
    localAcpAbortRef.current = abort;
    setLocalAcpBusy(true);
    isLoadingRef.current = true;
    try {
      await runLocalAcpChatTurn({
        modelId,
        text,
        setMessages,
        signal: abort.signal,
      });
    } catch {
      // Transcript already includes the error text.
    } finally {
      if (localAcpAbortRef.current === abort) {
        localAcpAbortRef.current = null;
      }
      setLocalAcpBusy(false);
      isLoadingRef.current = false;
      queueMicrotask(() => drainQueuedPromptAfterTurnRef.current?.());
    }
    return true;
  };

  // Bottom-pin / streaming-follow machinery (see useChatScroll).
  const { isAtBottom, setIsAtBottom, scrollerElRef, handleListHeightChanged } =
    useChatScroll({ isLoading, isLoadingRef, virtuosoRef });

  const lastMessage = messages.at(-1);
  const lastMessageParts = lastMessage?.parts ?? [];
  useRenderCount("Chat", {
    messageCount: messages.length,
    status,
  });
  useWhyChanged("Chat", {
    chatId,
    currentWorkspaceId: currentWorkspace?.id,
    selectedModelId,
    messagesRef: messages,
    messageCount: messages.length,
    lastMessageId: lastMessage?.id,
    lastMessageRole: lastMessage?.role,
    lastMessagePartCount: lastMessageParts.length,
    status,
    isLoading,
    connectionIconById,
  });

  // Validate the restored per-tab chat once the workspace resolves: a chat
  // persisted for a different workspace must not leak into this one.
  const sessionRestoreCheckedRef = useRef(false);
  useEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!workspaceId || sessionRestoreCheckedRef.current) return;
    sessionRestoreCheckedRef.current = true;
    const stored = initialStoredSessionRef.current;
    if (stored && stored.workspaceId !== workspaceId) {
      setChatId(generateObjectId());
      setMessages([]);
      setIsExistingChat(false);
    }
  }, [currentWorkspace?.id, setMessages]);

  // Keep the per-tab session pointer current so a refresh restores this chat.
  useEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!workspaceId) return;
    writeStoredChatSession({ chatId, workspaceId });
    // Register the active chat with the realtime store so chat.ui-intent
    // events (e.g. the agent opening a console) only act on the chat this
    // window is actually viewing.
    useRealtimeStore.getState().setActiveChatId(chatId);
    return () => {
      useRealtimeStore.getState().setActiveChatId(null);
    };
  }, [chatId, currentWorkspace?.id]);

  // In-band reconciliation of server-executed tool results (console open /
  // revision sync + app/dbt refetch) — see useServerToolSync. The returned
  // ref is seeded by the session loader so restored history doesn't re-open
  // every console the chat ever touched.
  const { handledConsoleOpenToolCallIdsRef } = useServerToolSync({
    chatId,
    workspaceId: currentWorkspace?.id,
    messages,
  });

  // History load (chat selection / tab restore) + the shared persisted-message
  // reload used by the resume manager.
  useChatSessionLoader({
    chatId,
    isExistingChat,
    workspaceId: currentWorkspace?.id,
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
  });

  // Create new chat session - just generate a new ID locally (no API call needed)
  const createNewSession = () => {
    cancelActiveClientToolCalls("session-change");
    manualStopRequestedRef.current = false;
    clearQueuedPrompts();
    setChatId(generateObjectId());
    setMessages([]);
    setIsExistingChat(false);
  };

  const handleSelectSession = (id: string) => {
    cancelActiveClientToolCalls("session-change");
    manualStopRequestedRef.current = false;
    clearQueuedPrompts();
    setChatId(id);
    setMessages([]);
    setIsExistingChat(true);
    handleHistoryMenuClose();
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const deleted = await deleteSession(id);
    // If we deleted the current chat, start a new one.
    if (deleted && chatId === id) {
      createNewSession();
    }
  };

  // Tool debug dialog handlers
  const handleToolClick = useCallback((tool: ToolInvocationInfo) => {
    setSelectedTool(tool);
    setToolDialogOpen(true);
  }, []);

  // Resolve a deferred interactive tool (clarifying questions / plan) with the
  // user's answer. Stable identity so the docked card doesn't remount.
  const handleResolveInteractiveTool = useCallback(
    (args: {
      tool: string;
      toolCallId: string;
      output: Record<string, unknown>;
    }) => {
      void addToolOutput({
        tool: args.tool,
        toolCallId: args.toolCallId,
        output: args.output,
      });
    },
    [addToolOutput],
  );

  // The deferred interactive tool call currently awaiting the user, if any.
  // Rendered as a docked panel above the composer (Cursor-style) rather than
  // inline in the chat; the inline summary only appears once resolved.
  const pendingInteractiveTool = useMemo(() => {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return null;
    for (const part of (last.parts ?? []) as Array<Record<string, unknown>>) {
      const partType = part.type as string | undefined;
      if (
        partType !== "tool-ask_clarifying_questions" &&
        partType !== "tool-submit_plan"
      ) {
        continue;
      }
      // submit_plan also surfaces while its input is still streaming so the
      // plan tab and dock card can render the plan as the model writes it.
      const isStreamingPlan =
        partType === "tool-submit_plan" && part.state === "input-streaming";
      if (part.state !== "input-available" && !isStreamingPlan) continue;
      return {
        toolName: partType.slice("tool-".length) as
          | "ask_clarifying_questions"
          | "submit_plan",
        toolCallId: (part.toolCallId as string) || "",
        input: part.input,
        streaming: isStreamingPlan,
      };
    }
    return null;
  }, [messages]);

  // While a submit_plan awaits review (input fully available, unresolved),
  // the chat composer becomes the plan-iteration channel: a sent message is
  // routed to the tool output as request_changes feedback instead of a normal
  // user message. Ref (declared above useChat) keeps handleChatSubmit's
  // identity stable (perf rules).
  const isPlanAwaitingFeedback =
    pendingInteractiveTool?.toolName === "submit_plan" &&
    !pendingInteractiveTool.streaming;
  pendingPlanToolCallIdRef.current = isPlanAwaitingFeedback
    ? pendingInteractiveTool.toolCallId
    : null;

  // Pending submit_plan: register the plan + its resolver in planStore and
  // auto-open the main-view plan tab (once per toolCallId, as soon as
  // streaming starts). While the input streams, each delta only does a cheap
  // store write (setStreamingInput) — no tab re-open, no resolver churn. The
  // resolver re-registers whenever handleResolveInteractiveTool changes so it
  // always settles the tool through the live useChat instance.
  const autoOpenedPlanTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (
      !pendingInteractiveTool ||
      pendingInteractiveTool.toolName !== "submit_plan"
    ) {
      return;
    }
    const { toolCallId, streaming } = pendingInteractiveTool;
    if (!toolCallId) return;

    const planStore = usePlanStore.getState();
    if (streaming) {
      planStore.setStreamingInput(
        toolCallId,
        chatId,
        pendingInteractiveTool.input as PartialSubmitPlanInput | undefined,
      );
    } else {
      const input = pendingInteractiveTool.input as SubmitPlanInput;
      planStore.registerPlan(toolCallId, chatId, input);
      planStore.registerResolver(toolCallId, output => {
        handleResolveInteractiveTool({
          tool: "submit_plan",
          toolCallId,
          output: output as unknown as Record<string, unknown>,
        });
      });
    }

    if (!autoOpenedPlanTabsRef.current.has(toolCallId)) {
      autoOpenedPlanTabsRef.current.add(toolCallId);
      const title = usePlanStore.getState().plans[toolCallId]?.draft.title;
      focusPlanTab(toolCallId, chatId, title || "Plan");
    } else {
      // Keep the tab title in sync as the title streams in / finalizes
      // (no-op unless it actually changed).
      const title = usePlanStore.getState().plans[toolCallId]?.draft.title;
      if (title) syncPlanTabTitle(toolCallId, chatId, title);
    }
  }, [pendingInteractiveTool, chatId, handleResolveInteractiveTool]);

  const handleConsoleTitleClick = useCallback(async (consoleId: string) => {
    const store = useConsoleStore.getState();
    // On mobile the editor lives behind the "Editor" tab — surface it so
    // tapping a console reference in chat ("view SQL") shows the query.
    if (isMobileRef.current) {
      useUIStore.getState().setMobileTab("editor");
    }
    const existingTab = store.tabs[consoleId];
    if (existingTab) {
      store.setActiveTab(consoleId);
      return;
    }

    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) return;

    try {
      await store.openConsoleFromServer(workspaceId, consoleId);
    } catch {
      /* ignore focus failures */
    }
  }, []);

  const handleCloseToolDialog = () => {
    setToolDialogOpen(false);
    setSelectedTool(null);
  };

  // Resolve an MCP tool approval request. Stable identity: reads the live
  // useChat function via ref so ChatMessageRow memoization holds.
  const addToolApprovalResponseRef = useRef(addToolApprovalResponse);
  addToolApprovalResponseRef.current = addToolApprovalResponse;
  const handleMcpApprovalResponse = useCallback(
    ({ approvalId, approved }: { approvalId: string; approved: boolean }) => {
      if (!approvalId) return;
      addToolApprovalResponseRef.current({ id: approvalId, approved });
    },
    [],
  );

  // Load MCP tool metadata (server names, risk tiers, grantability) so the
  // approval cards can label tools and offer "Always allow" correctly.
  useEffect(() => {
    if (currentWorkspace) {
      void useMcpStore.getState().fetchToolInfo(currentWorkspace.id);
    }
  }, [currentWorkspace]);

  // Prompt queue: queue-while-busy, drain-on-settle, in-composer editing,
  // and force-send. Owns handleChatSubmit.
  const {
    queuedPrompts,
    editingPromptId,
    editingPrompt,
    handleChatSubmit,
    handleRemoveQueuedPrompt,
    handleStartEditQueuedPrompt,
    handleCancelEditQueuedPrompt,
    handleSendQueuedPromptNow,
    clearQueuedPrompts,
  } = useQueuedPrompts({
    chatId,
    status,
    isLoading,
    activeClientToolCallCount,
    isLoadingRef,
    manualStopRequestedRef,
    messagesRef,
    sendMessageRef,
    modelIdRef,
    capturedConsoleIdRef,
    capturedDashboardIdRef,
    activeConsoleIdRef,
    pendingPlanToolCallIdRef,
    suppressNextAutoSendRef,
    autoSendWhenComplete,
    interruptActiveTurn,
    drainQueuedPromptAfterTurnRef,
    sendViaLocalAcpRef,
  });

  const handleStop = useCallback(() => {
    interruptActiveTurn();
    clearQueuedPrompts();
  }, [interruptActiveTurn, clearQueuedPrompts]);

  // Copy chat history handler
  const [copiedChat, setCopiedChat] = useState(false);
  const handleCopyChatHistory = async () => {
    const history = messages.map(msg => {
      const parts = (msg.parts || []).map((part: Record<string, unknown>) => {
        const partType = part.type as string;
        if (partType === "text") {
          return { type: "text", text: part.text };
        }
        if (partType === "reasoning") {
          return {
            type: "reasoning",
            text: (part as Record<string, unknown>).text,
          };
        }
        if (partType?.startsWith("tool-") || partType === "dynamic-tool") {
          return {
            type: partType,
            toolCallId: part.toolCallId,
            toolName:
              partType === "dynamic-tool"
                ? part.toolName
                : partType.split("-").slice(1).join("-"),
            state: part.state,
            input: part.input,
            output: part.output,
          };
        }
        return { type: partType, ...part };
      });
      return {
        id: msg.id,
        role: msg.role,
        parts,
      };
    });
    try {
      await navigator.clipboard.writeText(safeStringify(history, 2));
      setCopiedChat(true);
      setTimeout(() => setCopiedChat(false), 2000);
    } catch {
      /* clipboard not available */
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header with history and new chat. On mobile this is Claude-style
          floating chrome: a transparent strip with round buttons (hamburger
          left, actions right). Desktop keeps the bordered title bar. */}
      <Box
        sx={{
          px: 1,
          py: isMobile ? 0.75 : 0.25,
          minHeight: isMobile ? 52 : 37,
          borderBottom: isMobile ? 0 : 1,
          borderColor: "divider",
        }}
      >
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            height: "100%",
            minHeight: 32,
          }}
        >
          <Box
            sx={{
              flexGrow: 1,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              gap: 1,
            }}
          >
            {isMobile ? (
              <Tooltip title="Open explorer">
                <IconButton
                  aria-label="Open explorer"
                  onClick={() => useUIStore.getState().openMobileDrawer()}
                  sx={MOBILE_FLOAT_BTN_SX}
                >
                  <MenuIcon size={20} />
                </IconButton>
              </Tooltip>
            ) : (
              <Typography
                variant="h6"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                Chat
              </Typography>
            )}
          </Box>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: isMobile ? 1 : 0.5,
            }}
          >
            <Tooltip
              title={copiedChat ? "Copied!" : "Copy chat history as JSON"}
            >
              <span>
                <IconButton
                  size={isMobile ? "medium" : "small"}
                  aria-label="Copy chat history as JSON"
                  onClick={handleCopyChatHistory}
                  disabled={messages.length === 0}
                  sx={isMobile ? MOBILE_FLOAT_BTN_SX : undefined}
                >
                  {copiedChat ? <Check size={20} /> : <Copy size={20} />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="New chat">
              <IconButton
                size={isMobile ? "medium" : "small"}
                aria-label="New chat"
                onClick={createNewSession}
                sx={isMobile ? MOBILE_FLOAT_BTN_SX : undefined}
              >
                <Plus size={20} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Chat history">
              <IconButton
                size={isMobile ? "medium" : "small"}
                aria-label="Chat history"
                onClick={handleHistoryMenuOpen}
                sx={isMobile ? MOBILE_FLOAT_BTN_SX : undefined}
              >
                <History size={20} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {/* History Menu */}
      <ChatHistoryMenu
        anchorEl={historyMenuAnchor}
        open={historyMenuOpen}
        onClose={handleHistoryMenuClose}
        sessions={sessions}
        currentChatId={chatId}
        isSessionStreaming={isSessionStreaming}
        onSelect={handleSelectSession}
        onDelete={handleDeleteSession}
      />

      {/* Error display — billing errors get an upgrade prompt */}
      {error && (
        <Box sx={{ p: 1 }}>
          {(() => {
            let displayMessage = error.message;
            try {
              const parsed = JSON.parse(error.message);
              if (
                parsed.code === "usage_limit_exceeded" ||
                parsed.code === "model_not_available"
              ) {
                return (
                  <UpgradePrompt
                    errorCode={parsed.code}
                    message={parsed.message}
                    plan={parsed.plan}
                    currentUsageUsd={parsed.currentUsageUsd}
                    quotaUsd={parsed.quotaUsd}
                  />
                );
              }
              // Other structured server errors (model auth / rate limit /
              // stream failures): show the human-readable message, not the
              // raw JSON envelope.
              if (
                typeof parsed?.code === "string" &&
                typeof parsed?.message === "string"
              ) {
                displayMessage = parsed.message;
              }
            } catch {
              // not JSON, fall through to generic
            }
            return (
              <Alert
                severity="error"
                onClose={clearError}
                sx={{
                  fontSize: "0.875rem",
                  maxHeight: 200,
                  overflowY: "auto",
                  "& .MuiAlert-message": {
                    overflow: "auto",
                  },
                }}
              >
                {displayMessage}
              </Alert>
            );
          })()}
        </Box>
      )}

      {/* Messages — Virtuoso owns the scroller; this Box is just a relative,
          full-height flex container so the virtual list fills it and the
          floating "scroll to bottom" button + mobile hero can overlay it. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Mobile "Ask your data" home: hero + starter chips when empty */}
        {isMobile && messages.length === 0 && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              px: 3,
              gap: 3,
              pointerEvents: "none",
            }}
          >
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                Ask your data
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 1, maxWidth: 360 }}
              >
                Ask a question in plain English — Mako writes and runs the query
                for you.
              </Typography>
            </Box>
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 1,
                justifyContent: "center",
                maxWidth: 440,
                pointerEvents: "auto",
              }}
            >
              {MOBILE_ASK_SUGGESTIONS.map(suggestion => (
                <Chip
                  key={suggestion}
                  label={suggestion}
                  clickable
                  variant="outlined"
                  disabled={!currentWorkspace}
                  onClick={() => handleChatSubmit(suggestion)}
                  sx={{
                    height: "auto",
                    py: 0.75,
                    "& .MuiChip-label": {
                      whiteSpace: "normal",
                      display: "block",
                    },
                  }}
                />
              ))}
            </Box>
          </Box>
        )}

        <React.Profiler id="Chat.message-list" onRender={onRenderDebug}>
          <Virtuoso<ChatMessageRowProps["message"]>
            ref={virtuosoRef}
            data={messages}
            // Stable key per message so a row's identity (and thus its memo)
            // survives streaming ticks and history inserts — mirrors the old
            // `key={message.id}`.
            computeItemKey={(_index, message) => message.id}
            // Auto-scroll during streaming is owned by the bottom-pin in
            // `handleListHeightChanged` (wired to `totalListHeightChanged`
            // below), gated on `isAtBottom`. `followOutput` is left OFF:
            // it only fires on item-COUNT change (a whole turn streams into ONE
            // message, so it never fires mid-turn) and its
            // `scrollToIndex({ align: "end" })` races the pin and bounces the
            // view. Mount/history-load anchoring is handled by
            // `initialTopMostItemIndex` and the explicit post-load scroll.
            followOutput={false}
            // Capture the scroller so the height-change pin can set its
            // scrollTop directly (last write before paint on resize frames).
            scrollerRef={el => {
              scrollerElRef.current = el;
            }}
            // Pin the bottom on every total-height change while streaming (and
            // through the bounded post-turn settling window) — see the
            // `handleListHeightChanged` comment for why this beats a per-frame
            // rAF for the Collapse/diff resize bounce.
            totalListHeightChanged={handleListHeightChanged}
            initialTopMostItemIndex={Math.max(0, messages.length - 1)}
            atBottomStateChange={setIsAtBottom}
            atBottomThreshold={120}
            increaseViewportBy={{ top: 600, bottom: 900 }}
            components={messageVirtuosoComponents}
            style={{ flex: 1 }}
            itemContent={(msgIdx, message) => (
              <ChatMessageRow
                message={message}
                isLastMessage={msgIdx === messages.length - 1}
                isStreaming={status === "streaming"}
                onToolClick={handleToolClick}
                onConsoleTitleClick={handleConsoleTitleClick}
                onMcpApprovalResponse={handleMcpApprovalResponse}
                connectionIconById={connectionIconById}
                paletteMode={paletteMode}
              />
            )}
          />
        </React.Profiler>

        {!isAtBottom && (
          <IconButton
            onClick={() =>
              virtuosoRef.current?.scrollToIndex({
                index: messages.length - 1,
                align: "end",
                behavior: "smooth",
              })
            }
            size="small"
            sx={{
              position: "absolute",
              bottom: 8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 1,
              backgroundColor: "background.paper",
              border: 1,
              borderColor: "divider",
              boxShadow: 2,
              "&:hover": { backgroundColor: "action.hover" },
              width: 32,
              height: 32,
            }}
          >
            <ChevronDown size={18} />
          </IconButton>
        )}
      </Box>

      {/* Pending interactive tool (clarifying questions / plan approval) —
          docked above the composer like the prompt queue. The chat itself
          only shows a read-only summary once the user has responded. */}
      {pendingInteractiveTool && (
        <Box
          sx={
            pendingInteractiveTool.toolName === "ask_clarifying_questions"
              ? { mx: 2.25, mt: 1, mb: -1 }
              : { mx: 1, mt: 1, mb: -0.5 }
          }
          key={pendingInteractiveTool.toolCallId}
        >
          {pendingInteractiveTool.toolName === "ask_clarifying_questions" ? (
            <ClarifyingQuestionsCard
              docked
              input={
                pendingInteractiveTool.input as AskClarifyingQuestionsInput
              }
              onResolve={output =>
                handleResolveInteractiveTool({
                  tool: pendingInteractiveTool.toolName,
                  toolCallId: pendingInteractiveTool.toolCallId,
                  output: output as unknown as Record<string, unknown>,
                })
              }
            />
          ) : (
            <PlanCard
              toolCallId={pendingInteractiveTool.toolCallId}
              chatId={chatId}
              streaming={pendingInteractiveTool.streaming}
              // While streaming the input is partial — the card reads live
              // data from planStore instead (fed by setStreamingInput).
              input={
                pendingInteractiveTool.streaming
                  ? undefined
                  : (pendingInteractiveTool.input as SubmitPlanInput)
              }
            />
          )}
        </Box>
      )}

      <Collapse
        in={queuedPrompts.length > 0}
        timeout={220}
        easing="cubic-bezier(0.4, 0, 0.2, 1)"
        unmountOnExit
        sx={{ mb: -1 }}
      >
        <QueuedPromptList
          prompts={queuedPrompts}
          editingId={editingPromptId}
          onStartEdit={handleStartEditQueuedPrompt}
          onSendNow={handleSendQueuedPromptNow}
          onRemove={handleRemoveQueuedPrompt}
        />
      </Collapse>

      {/* Local Claude/Codex: Allow/Deny for Bash/edits (Mako MCP is auto-approved). */}
      {isLocalAcpModelId(selectedModelId) ? <AcpPermissionBanner /> : null}

      {/* Input — isolated component so keystrokes don't re-render messages */}
      <ChatInputArea
        onSubmit={handleChatSubmit}
        onStop={handleStop}
        isLoading={isLoading}
        disabled={!currentWorkspace}
        focusKey={`${chatId}-${messages.length}`}
        paletteMode={paletteMode}
        editingPrompt={editingPrompt}
        onCancelEdit={handleCancelEditQueuedPrompt}
        planFeedbackMode={isPlanAwaitingFeedback}
      />

      {/* Tool Debug Dialog */}
      <ToolDetailsDialog
        open={toolDialogOpen}
        tool={selectedTool}
        onClose={handleCloseToolDialog}
        paletteMode={paletteMode}
      />
    </Box>
  );
};

Chat.displayName = "Chat";

export default React.memo(Chat);
