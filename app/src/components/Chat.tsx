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
import { Box, Alert, Collapse, Snackbar } from "@mui/material";
import { useTheme as useMuiTheme } from "@mui/material/styles";
import { useChat } from "@ai-sdk/react";
import { Virtuoso, type VirtuosoHandle, type Components } from "react-virtuoso";
import { useMcpStore } from "../store/mcpStore";
// TODO(state-rules): legacy direct call (chat stop) — move into the chat
// store when it grows an action for aborting server-side generation.
// eslint-disable-next-line no-restricted-imports
import { api } from "../api/client";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSchemaStore } from "../store/schemaStore";
import { useUIStore } from "../store/uiStore";
import { useIsMobile } from "../hooks/useIsMobile";
import { isLocalAcpModelId } from "../lib/local-acp-models";
import { startDesktopAcpBridge } from "../lib/desktop-acp-bridge";
import { DbFlowFormRef } from "./DbFlowForm";
import { type ChatMessageRowProps } from "./chat-message-comparator";
import {
  useClientToolRegistry,
  type AddToolOutputFn,
} from "./chat/hooks/useClientToolRegistry";
import { reportClientToolFailure } from "../agent-runtime/client-tool-failure-reporter";
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
import { ChatMessageErrorBoundary } from "./chat/ChatMessageErrorBoundary";
import { QueuedPromptList } from "./chat/QueuedPrompts";
import { ChatInputArea } from "./chat/ChatInputArea";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import { useSessionUsageCounter } from "./chat/hooks/useSessionUsageCounter";
import { AcpPermissionBanner } from "./AcpPermissionBanner";
import { ChatPanelErrorBoundary } from "./chat/ChatPanelErrorBoundary";
import { AcpWorkspaceToolsBanner } from "./AcpWorkspaceToolsBanner";
import { useChatTransport } from "./chat/hooks/useChatTransport";
import {
  useChatIdentity,
  useChatSessionActions,
} from "./chat/hooks/useChatSessionActions";
import { openConsoleFromChat } from "./chat/open-console-from-chat";
import { useConnectionIconById } from "../hooks/useConnectionIconById";
import { useLocalAcpTurns } from "./chat/hooks/useLocalAcpTurns";
import { settleDanglingToolParts } from "./chat/chat-helpers";
import {
  useAutoSendPredicates,
  useCopyChatHistory,
  useToolDetailsDialog,
} from "./chat/hooks/useChatPanelState";
import { usePendingInteractiveTool } from "./chat/hooks/usePendingInteractiveTool";
import {
  ChatErrorBanner,
  ChatHeader,
  ScrollToLatestButton,
} from "./chat/ChatChrome";
import { PendingInteractiveToolDock } from "./chat/PendingInteractiveToolDock";
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

const Chat: React.FC<ChatProps> = ({
  dbFlowFormRef,
  onChartSpecChangeRef,
  resultsContextRef,
}) => {
  const paletteMode = useMuiTheme().palette.mode;
  // One-off feedback for user-initiated actions that fail quietly otherwise
  // (clipboard, session delete).
  const [actionError, setActionError] = useState<string | null>(null);
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

  // Local Agent mako-desktop MCP → iframe run_app / previewErrors.
  useEffect(() => startDesktopAcpBridge(), []);
  const workspaceConnections = useMemo(
    () => (currentWorkspace ? connections[currentWorkspace.id] || [] : []),
    [connections, currentWorkspace],
  );
  const connectionIconById = useConnectionIconById(workspaceConnections);

  const {
    initialStoredSession,
    chatId,
    setChatId,
    isExistingChat,
    setIsExistingChat,
  } = useChatIdentity();
  // Virtualized message list (react-virtuoso). Replaces use-stick-to-bottom:
  // Virtuoso owns its own scroller and bottom-anchoring (`followOutput`), and
  // only mounts visible rows + overscan so long chats stay light on
  // DOM/memory/paint — critical on mobile. `isAtBottom` drives both the
  // "scroll to bottom" button and whether streaming auto-follows the tail.
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Refs for accessing current values in callbacks (avoids stale closures)
  const isExistingChatRef = useRef(isExistingChat);
  isExistingChatRef.current = isExistingChat;

  // NOTE: console tools execute server-side (issue #475); open tabs follow
  // along via the realtime channel (realtimeStore), so Chat no longer
  // applies console modifications itself.

  // Ref to capture the active console ID at the time the user submits a message
  // This prevents the race condition where user switches consoles while agent is thinking
  const capturedConsoleIdRef = useRef<string | null>(null);

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
  const toolDialog = useToolDetailsDialog();

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
  // Client-tool registry: in-flight executions, cancel/interrupt plumbing,
  // and the per-chat toolCallId dispatch dedupe gate (the triplicate-tool
  // fix). Created before useChat — its register/settle callbacks are wired
  // into onToolCall; addToolOutputRef is assigned right after useChat.
  const addToolOutputRef = useRef<AddToolOutputFn>(undefined);
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
  const onStreamErrorImplRef = useRef<(error: unknown) => void>(undefined);
  const clearErrorRef = useRef<(() => void) | undefined>(undefined);
  // Single-flight resume manager (assigned after useChat — it needs stop /
  // resumeStream). ALL reattach triggers (loadSession, wake, error retry) go
  // through requestResumeRef: calling the SDK's resumeStream directly attaches
  // an ADDITIONAL stream consumer without tearing down the previous one, and
  // every consumer re-processes every chunk — the root cause of the
  // triplicated tool executions and message parts.
  const requestResumeRef =
    useRef<(opts?: { skipReload?: boolean }) => Promise<void>>(undefined);
  // Refetch persisted messages + reset chat state; assigned by
  // useChatSessionLoader (shares the history-load conversion logic).
  const loadPersistedMessagesRef =
    useRef<(opts?: { forHistoryLoad?: boolean }) => Promise<boolean>>(
      undefined,
    );
  // Client tool dispatch lives in useClientToolDispatch (which needs useChat's
  // state, so it runs after useChat); useChat's onToolCall — captured once at
  // Chat-instance creation — delegates through this ref so it always invokes
  // the latest implementation.
  const onToolCallImplRef =
    useRef<(toolCall: DispatchableToolCall) => Promise<void>>(undefined);
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

  const { autoSendWhenComplete, sdkAutoSendWhen } = useAutoSendPredicates(
    manualStopRequestedRef,
    suppressNextAutoSendRef,
  );

  const transport = useChatTransport({
    workspaceIdRef,
    modelIdRef,
    chatIdRef,
    activeConsoleIdRef,
    dbFlowFormRefCurrent,
    resultsContextRef,
  });

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
      // Advance the session's cumulative token/cost counter by this turn.
      // Once per finished turn, never per chunk — the composer must not
      // re-render while streaming (chat-performance).
      onTurnFinishedRef.current?.();
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

  // Cumulative session token/cost. Seeded from the server's persisted totals by
  // the session loader; advanced here once per finished turn.
  const { onTurnFinishedRef } = useSessionUsageCounter({
    chatId,
    workspaceId: currentWorkspace?.id,
    messagesRef: messagesRef as unknown as React.MutableRefObject<
      Array<{ id?: string; metadata?: unknown }>
    >,
  });

  // Local Agent (Claude Code / Codex over ACP) sends + reattach.
  const {
    localAcpBusy,
    localAcpBusyRef,
    localAcpBindingRef,
    sendViaLocalAcpRef,
    requestLocalAcpResumeRef,
    abortLocalAcp,
  } = useLocalAcpTurns({
    chatId,
    selectedModelId,
    workspaceIdRef,
    chatIdRef,
    modelIdRef,
    messagesRef,
    isLoadingRef,
    drainQueuedPromptAfterTurnRef,
    fetchSessionsRef,
    setMessages,
    setIsExistingChat,
  });

  // Give the registry (created before useChat) the live addToolOutput. Client
  // tools execute outside the API process, so report domain failures before
  // settling them or Cloud Logging cannot see them.
  addToolOutputRef.current = payload => {
    reportClientToolFailure({
      workspaceId: workspaceIdRef.current,
      chatId: chatIdRef.current,
      toolName: payload.tool,
      toolCallId: payload.toolCallId,
      output: payload.output,
    });
    return addToolOutput(payload);
  };
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
    // Local ACP keeps useChat at "ready" while tools stream in — don't poison
    // in-flight dynamic-tool parts as orphans.
    suppressOrphanRescue: localAcpBusy,
  });
  onToolCallImplRef.current = dispatchClientToolCall;

  // Aborting mid-stream can leave assistant tool calls stuck in
  // "input-available"/"input-streaming" (their output never arrives). The AI
  // SDK blocks the next sendMessage until every tool call is settled, so patch
  // any dangling ones to "error" — otherwise a force-send after an interrupt
  // would hang.
  const settleDanglingAssistantToolCalls = useCallback(() => {
    setMessages(prev => settleDanglingToolParts(prev));
  }, [setMessages]);

  // Interrupt the in-flight turn: abort client tools, abort server-side
  // generation, and settle every dangling tool call. Does NOT touch the queue
  // so callers can choose to clear it (manual stop) or keep it (force-send).
  const interruptActiveTurn = useCallback(() => {
    manualStopRequestedRef.current = true;

    // Abort an in-flight local ACP (Claude Code / Codex) turn if any.
    abortLocalAcp();

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
  }, [
    abortLocalAcp,
    interruptActiveClientToolCalls,
    stop,
    settleDanglingAssistantToolCalls,
  ]);

  const isLoading =
    status === "streaming" ||
    status === "submitted" ||
    activeClientToolCallCount > 0 ||
    localAcpBusy;
  isLoadingRef.current = isLoading;

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

  // Restore validation + session pointer, and new / open / delete chat.
  const {
    composerDraft,
    createNewSession,
    handleSelectSession,
    handleDeleteSession,
  } = useChatSessionActions({
    workspaceId: currentWorkspace?.id,
    chatId,
    initialStoredSession,
    setChatId,
    setIsExistingChat,
    resetTurnState: () => {
      cancelActiveClientToolCalls("session-change");
      manualStopRequestedRef.current = false;
      clearQueuedPrompts();
      localAcpBindingRef.current = null;
    },
    setMessages,
    deleteSession,
    onHistoryMenuClose: handleHistoryMenuClose,
    onError: setActionError,
  });

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
    requestLocalAcpResumeRef,
    localAcpBindingRef,
    localAcpBusyRef,
  });

  const {
    pendingInteractiveTool,
    handleResolveInteractiveTool,
    isPlanAwaitingFeedback,
  } = usePendingInteractiveTool({
    messages,
    chatId,
    addToolOutput,
    pendingPlanToolCallIdRef,
  });

  const handleConsoleTitleClick = useCallback(
    (consoleId: string) =>
      openConsoleFromChat(consoleId, {
        isMobile: isMobileRef.current,
        workspaceId: workspaceIdRef.current,
      }),
    [],
  );

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

  const copyChat = useCopyChatHistory(setActionError);

  const isLocalAcp = isLocalAcpModelId(selectedModelId);

  // Focus the composer on chat switch and after the USER sends — not on every
  // assistant message. Keying this on `messages.length` yanked focus out of an
  // expanded reasoning block or a plan card mid-turn.
  const userMessageCount = messages.reduce(
    (n, m) => (m.role === "user" ? n + 1 : n),
    0,
  );
  const focusKey = `${chatId}-${userMessageCount}`;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ChatHeader
        isMobile={isMobile}
        copied={copyChat.copied}
        canCopy={messages.length > 0}
        onCopy={() => void copyChat.copy(messages)}
        onNewChat={createNewSession}
        onOpenHistory={handleHistoryMenuOpen}
        onClose={() => useUIStore.getState().closeRightPane()}
      />

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

      {error && (
        <ChatErrorBanner message={error.message} onClose={clearError} />
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
        {messages.length === 0 && (
          <ChatEmptyState
            isMobile={isMobile}
            disabled={!currentWorkspace}
            onSelect={handleChatSubmit}
          />
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
            style={{ flex: 1, paddingBottom: 24 }}
            itemContent={(msgIdx, message) => (
              <ChatMessageErrorBoundary
                messageId={message.id}
                messageRevision={message}
              >
                <ChatMessageRow
                  message={message}
                  isLastMessage={msgIdx === messages.length - 1}
                  isStreaming={status === "streaming" || localAcpBusy}
                  collapseEmptyReasoningWhileStreaming={localAcpBusy}
                  onToolClick={toolDialog.openTool}
                  onConsoleTitleClick={handleConsoleTitleClick}
                  onMcpApprovalResponse={handleMcpApprovalResponse}
                  connectionIconById={connectionIconById}
                  paletteMode={paletteMode}
                />
              </ChatMessageErrorBoundary>
            )}
          />
        </React.Profiler>

        {/* An empty thread has nothing to scroll to — the button used to sit
            over the intro screen on a brand-new chat. */}
        {!isAtBottom && messages.length > 0 && (
          <ScrollToLatestButton
            onClick={() =>
              virtuosoRef.current?.scrollToIndex({
                index: messages.length - 1,
                align: "end",
                behavior: "smooth",
              })
            }
          />
        )}
      </Box>

      {pendingInteractiveTool && (
        <PendingInteractiveToolDock
          pending={pendingInteractiveTool}
          chatId={chatId}
          onResolve={handleResolveInteractiveTool}
        />
      )}

      <Collapse
        in={queuedPrompts.length > 0}
        timeout={220}
        easing="cubic-bezier(0.4, 0, 0.2, 1)"
        unmountOnExit
        sx={{ mb: -1 }}
      >
        <ChatPanelErrorBoundary panel="queued prompts" resetKey={chatId}>
          <QueuedPromptList
            prompts={queuedPrompts}
            editingId={editingPromptId}
            onStartEdit={handleStartEditQueuedPrompt}
            onSendNow={handleSendQueuedPromptNow}
            onRemove={handleRemoveQueuedPrompt}
          />
        </ChatPanelErrorBoundary>
      </Collapse>

      {/* Local Claude/Codex: activate workspace MCP + HITL for Bash/edits. */}
      {isLocalAcp ? (
        <ChatPanelErrorBoundary
          panel="local agent tools banner"
          resetKey={chatId}
        >
          <AcpWorkspaceToolsBanner
            modelId={selectedModelId}
            workspaceId={currentWorkspace?.id}
          />
        </ChatPanelErrorBoundary>
      ) : null}
      {isLocalAcp ? (
        <ChatPanelErrorBoundary panel="permission request" resetKey={chatId}>
          <AcpPermissionBanner />
        </ChatPanelErrorBoundary>
      ) : null}

      {/* Input — isolated component so keystrokes don't re-render messages */}
      <ChatInputArea
        onSubmit={handleChatSubmit}
        onStop={handleStop}
        isLoading={isLoading}
        disabled={!currentWorkspace}
        focusKey={focusKey}
        chatId={chatId}
        isLocalAgent={isLocalAcp}
        paletteMode={paletteMode}
        editingPrompt={editingPrompt}
        onCancelEdit={handleCancelEditQueuedPrompt}
        planFeedbackMode={isPlanAwaitingFeedback}
        draft={composerDraft}
      />

      <Snackbar
        open={actionError !== null}
        autoHideDuration={5000}
        onClose={() => setActionError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity="error"
          variant="filled"
          onClose={() => setActionError(null)}
        >
          {actionError}
        </Alert>
      </Snackbar>

      {/* Tool Debug Dialog */}
      <ToolDetailsDialog
        open={toolDialog.open}
        tool={toolDialog.tool}
        onClose={toolDialog.close}
        paletteMode={paletteMode}
      />
    </Box>
  );
};

Chat.displayName = "Chat";

export default React.memo(Chat);
