/**
 * "Chat with app": the chat beside a published app on its viewer page.
 *
 * Built from Chat.tsx's own pieces — the same header, empty state, message
 * list, composer and history menu — so it looks and behaves like Mako's chat.
 * What it leaves out is everything workspace-bound: consoles, tabs, client
 * tools, the model picker and attachments. Every turn goes to the closed
 * `app_chat` agent with the app's id, so the server answers only from this
 * app's published data, and only for someone who can read the app. Chats are
 * kept per viewer, per app.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Virtuoso, type Components, type VirtuosoHandle } from "react-virtuoso";
import {
  Alert,
  Box,
  IconButton,
  Snackbar,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { ChevronDown, History, Plus, X } from "lucide-react";
import {
  appViewerKey,
  useAppViewerStore,
  type AppChatSummary,
} from "../store/appViewerStore";
import { generateObjectId } from "../utils/objectId";
import { useIsMobile } from "../hooks/useIsMobile";
import { useConfirm } from "./ConfirmDialog";
import { ChatMessageRow, MessageVirtuosoList } from "./chat/ChatMessageRow";
import { ChatMessageErrorBoundary } from "./chat/ChatMessageErrorBoundary";
import { ChatEmptyState } from "./chat/ChatEmptyState";
import { ChatInputArea } from "./chat/ChatInputArea";
import { ChatHistoryMenu } from "./chat/ChatHistoryMenu";
import { ToolDetailsDialog } from "./chat/ToolDetailsDialog";
import { convertStoredMessages } from "./chat/convert-stored-messages";
import { useChatScroll } from "./chat/hooks/useChatScroll";
import type { ChatSessionMeta } from "./chat/hooks/useChatSessions";
import type { ChatMessageRowProps } from "./chat-message-comparator";
import type { ToolInvocationInfo } from "./chat/tool-presentation";

interface AppChatPanelProps {
  workspaceId: string;
  appId: string;
  appTitle: string;
  /** The app's current query string (its filters), read at send time. */
  getAppSearch: () => string;
  onClose: () => void;
}

const SUGGESTIONS = [
  "Summarize what this app shows",
  "What stands out in the data?",
  "How are the main numbers calculated?",
] as const;

// Same bridge as Chat.tsx: Virtuoso types `List`'s ref as a LegacyRef.
const messageVirtuosoComponents: Components<ChatMessageRowProps["message"]> = {
  List: MessageVirtuosoList as Components<
    ChatMessageRowProps["message"]
  >["List"],
};

const EMPTY_ICONS: ReadonlyMap<string, string> = new Map();
const EMPTY_HISTORY: AppChatSummary[] = [];
const noop = () => undefined;

/** A server error body (JSON envelope or text) as one readable line. */
function readableError(message: string): string {
  try {
    const parsed = JSON.parse(message) as {
      message?: unknown;
      error?: unknown;
    };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON.
  }
  return message || "Something went wrong. Try again.";
}

export function AppChatPanel({
  workspaceId,
  appId,
  appTitle,
  getAppSearch,
  onClose,
}: AppChatPanelProps) {
  const theme = useTheme();
  const paletteMode = theme.palette.mode;
  const isMobile = useIsMobile();
  const confirm = useConfirm();
  const [chatId, setChatId] = useState(generateObjectId);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const getAppSearchRef = useRef(getAppSearch);
  getAppSearchRef.current = getAppSearch;
  // A chat picked from history whose messages still have to be loaded.
  const pendingLoadRef = useRef<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);

  const history =
    useAppViewerStore(s => s.chatsByApp[appViewerKey(workspaceId, appId)]) ??
    EMPTY_HISTORY;
  const fetchChats = useAppViewerStore(s => s.fetchChats);
  const loadChat = useAppViewerStore(s => s.loadChat);
  const stopChat = useAppViewerStore(s => s.stopChat);
  const deleteChat = useAppViewerStore(s => s.deleteChat);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toolDetails, setToolDetails] = useState<ToolInvocationInfo | null>(
    null,
  );

  const fetchHistory = useCallback(
    () => fetchChats(workspaceId, appId),
    [fetchChats, workspaceId, appId],
  );

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  // ChatHistoryMenu speaks the workspace chat list's shape.
  const sessions: ChatSessionMeta[] = useMemo(
    () =>
      history.map(chat => ({
        _id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt,
        activeStreamId: chat.streaming ? "streaming" : null,
      })),
    [history],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            chatId: chatIdRef.current,
            workspaceId,
            agentId: "app_chat",
            appId,
            appSearch: getAppSearchRef.current(),
          },
        }),
        prepareReconnectToStreamRequest: ({ id }) => ({
          api: `/api/agent/chat/${id}/stream`,
        }),
      }),
    [workspaceId, appId],
  );

  const {
    messages,
    sendMessage,
    status,
    error,
    clearError,
    stop,
    setMessages,
    resumeStream,
  } = useChat({
    id: chatId,
    transport,
    experimental_throttle: 50,
    onFinish: ({ isAbort }) => {
      if (!isAbort) void fetchHistory();
    },
  });

  // Load a chat picked from history once useChat has switched to its id.
  useEffect(() => {
    if (pendingLoadRef.current !== chatId) return;
    pendingLoadRef.current = null;
    let cancelled = false;
    void (async () => {
      const stored = await loadChat(workspaceId, chatId);
      if (cancelled || chatIdRef.current !== chatId) return;
      if (!stored) {
        setLoadError("This conversation could not be loaded.");
        return;
      }
      setMessages(
        convertStoredMessages(stored.messages, {
          turnActive: Boolean(stored.activeStreamId),
        }) as unknown as Parameters<typeof setMessages>[0],
      );
      if (stored.activeStreamId) void resumeStream();
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, workspaceId, loadChat, setMessages, resumeStream]);

  const isLoading = status === "streaming" || status === "submitted";
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const { isAtBottom, setIsAtBottom, scrollerElRef, handleListHeightChanged } =
    useChatScroll({ isLoading, isLoadingRef, virtuosoRef });

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoadingRef.current) return;
      clearError();
      setLoadError(null);
      void sendMessage({ text: trimmed });
    },
    [clearError, sendMessage],
  );

  const handleStop = useCallback(() => {
    void stopChat(chatIdRef.current);
    void stop();
  }, [stop, stopChat]);

  const startNewChat = useCallback(() => {
    if (isLoadingRef.current) void stop();
    clearError();
    setLoadError(null);
    setChatId(generateObjectId());
    setFocusKey(k => k + 1);
  }, [clearError, stop]);

  const openChat = useCallback(
    (id: string) => {
      setHistoryAnchor(null);
      if (id === chatIdRef.current) return;
      if (isLoadingRef.current) void stop();
      clearError();
      setLoadError(null);
      pendingLoadRef.current = id;
      setChatId(id);
    },
    [clearError, stop],
  );

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const ok = await confirm({
        title: "Delete this chat?",
        body: "The conversation and its history are removed for good.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      if (!(await deleteChat(workspaceId, appId, id))) {
        setActionError("Could not delete that chat. Please try again.");
        return;
      }
      if (id === chatIdRef.current) startNewChat();
    },
    [appId, confirm, deleteChat, startNewChat, workspaceId],
  );

  const isSessionStreaming = useCallback(
    (session: ChatSessionMeta) =>
      session._id === chatId ? isLoading : Boolean(session.activeStreamId),
    [chatId, isLoading],
  );

  const errorText = loadError ?? (error ? readableError(error.message) : null);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        bgcolor: "background.paper",
      }}
    >
      {/* Header — Chat.tsx's, titled for the app. */}
      <Box
        sx={{
          px: 1,
          py: isMobile ? 0.75 : 0.25,
          minHeight: isMobile ? 52 : 37,
          borderBottom: 1,
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          gap: 0.5,
        }}
      >
        <Typography
          variant="h6"
          sx={{
            flexGrow: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Ask {appTitle}
        </Typography>
        <Tooltip title="New chat">
          <IconButton size="small" aria-label="New chat" onClick={startNewChat}>
            <Plus size={20} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Chat history">
          <IconButton
            size="small"
            aria-label="Chat history"
            onClick={e => setHistoryAnchor(e.currentTarget)}
          >
            <History size={20} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Close chat">
          <IconButton size="small" aria-label="Close chat" onClick={onClose}>
            <X size={20} />
          </IconButton>
        </Tooltip>
      </Box>

      <ChatHistoryMenu
        anchorEl={historyAnchor}
        open={!!historyAnchor}
        onClose={() => setHistoryAnchor(null)}
        sessions={sessions}
        currentChatId={chatId}
        isSessionStreaming={isSessionStreaming}
        onSelect={openChat}
        onDelete={(id, e) => void handleDelete(id, e)}
      />

      {errorText && (
        <Box sx={{ p: 1 }}>
          <Alert
            severity="error"
            onClose={() => {
              clearError();
              setLoadError(null);
            }}
            sx={{ fontSize: "0.875rem" }}
          >
            {errorText}
          </Alert>
        </Box>
      )}

      {/* Messages — the same virtual list, rows and scroll pinning as Chat. */}
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
            disabled={false}
            onSelect={handleSubmit}
            title={`Ask ${appTitle}`}
            subtitle="Ask a question in plain English — answers come from the data this app has published."
            suggestions={SUGGESTIONS}
          />
        )}

        <Virtuoso<ChatMessageRowProps["message"]>
          ref={virtuosoRef}
          data={messages as unknown as ChatMessageRowProps["message"][]}
          computeItemKey={(_index, message) => message.id}
          followOutput={false}
          scrollerRef={el => {
            scrollerElRef.current = el;
          }}
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
                isStreaming={status === "streaming"}
                onToolClick={setToolDetails}
                onConsoleTitleClick={noop}
                onMcpApprovalResponse={noop}
                connectionIconById={EMPTY_ICONS}
                paletteMode={paletteMode}
              />
            </ChatMessageErrorBoundary>
          )}
        />

        {!isAtBottom && messages.length > 0 && (
          <Tooltip title="Scroll to latest" placement="top">
            <IconButton
              aria-label="Scroll to latest message"
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
          </Tooltip>
        )}
      </Box>

      <ChatInputArea
        onSubmit={handleSubmit}
        onStop={handleStop}
        isLoading={isLoading}
        disabled={isLoading}
        focusKey={focusKey}
        chatId={chatId}
        paletteMode={paletteMode}
        editingPrompt={null}
        onCancelEdit={noop}
        placeholder={`Ask about ${appTitle}...`}
        showModelControls={false}
        allowAttachments={false}
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

      <ToolDetailsDialog
        open={!!toolDetails}
        tool={toolDetails}
        onClose={() => setToolDetails(null)}
        paletteMode={paletteMode}
      />
    </Box>
  );
}
