/**
 * "Chat with app": the chat beside a published app on its viewer page.
 *
 * A slim sibling of Chat.tsx — no consoles, tabs, model picker or client
 * tools. Every turn goes to the closed `app_chat` agent with the app's id, so
 * the server answers only from this app's published data, and only for
 * someone who can read the app. Chats are kept per viewer, per app.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  Alert,
  Box,
  Button,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { ArrowUp, History, Plus, Square, X } from "lucide-react";
import {
  appViewerKey,
  useAppViewerStore,
  type AppChatSummary,
} from "../store/appViewerStore";
import { generateObjectId } from "../utils/objectId";
import { ChatMessageRow } from "./chat/ChatMessageRow";
import { ToolDetailsDialog } from "./chat/ToolDetailsDialog";
import { convertStoredMessages } from "./chat/convert-stored-messages";
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
];

const EMPTY_ICONS: ReadonlyMap<string, string> = new Map();
const EMPTY_HISTORY: AppChatSummary[] = [];
const noop = () => undefined;

export function AppChatPanel({
  workspaceId,
  appId,
  appTitle,
  getAppSearch,
  onClose,
}: AppChatPanelProps) {
  const theme = useTheme();
  const paletteMode = theme.palette.mode;
  const [chatId, setChatId] = useState(generateObjectId);
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const getAppSearchRef = useRef(getAppSearch);
  getAppSearchRef.current = getAppSearch;
  // A chat picked from history whose messages still have to be loaded.
  const pendingLoadRef = useRef<string | null>(null);

  const history: AppChatSummary[] =
    useAppViewerStore(s => s.chatsByApp[appViewerKey(workspaceId, appId)]) ??
    EMPTY_HISTORY;
  const fetchChats = useAppViewerStore(s => s.fetchChats);
  const loadChat = useAppViewerStore(s => s.loadChat);
  const stopChat = useAppViewerStore(s => s.stopChat);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toolDetails, setToolDetails] = useState<ToolInvocationInfo | null>(
    null,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  const fetchHistory = useCallback(
    () => fetchChats(workspaceId, appId),
    [fetchChats, workspaceId, appId],
  );

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

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

  // Follow the conversation while the reader is at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isLoading) return;
      clearError();
      setLoadError(null);
      pinnedToBottomRef.current = true;
      void sendMessage({ text: trimmed });
      setInput("");
    },
    [clearError, isLoading, sendMessage],
  );

  const handleStop = useCallback(() => {
    void stopChat(chatIdRef.current);
    void stop();
  }, [stop, stopChat]);

  const startNewChat = useCallback(() => {
    if (isLoading) void stop();
    setLoadError(null);
    setChatId(generateObjectId());
  }, [isLoading, stop]);

  const openChat = useCallback(
    (id: string) => {
      setHistoryAnchor(null);
      if (id === chatIdRef.current) return;
      if (isLoading) void stop();
      setLoadError(null);
      pendingLoadRef.current = id;
      setChatId(id);
    },
    [isLoading, stop],
  );

  const errorText =
    loadError ??
    (error
      ? /403|404|Cannot access/i.test(error.message)
        ? "You no longer have access to this app's chat."
        : "Something went wrong. Try again."
      : null);

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
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1.5,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          Ask about {appTitle}
        </Typography>
        <Tooltip title="Previous conversations">
          <span>
            <IconButton
              size="small"
              aria-label="Previous conversations"
              disabled={history.length === 0}
              onClick={e => setHistoryAnchor(e.currentTarget)}
            >
              <History size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="New conversation">
          <IconButton
            size="small"
            aria-label="New conversation"
            onClick={startNewChat}
          >
            <Plus size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Close">
          <IconButton size="small" aria-label="Close chat" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={historyAnchor}
          open={!!historyAnchor}
          onClose={() => setHistoryAnchor(null)}
          slotProps={{ paper: { sx: { maxHeight: 360, width: 300 } } }}
        >
          {history.map(chat => (
            <MenuItem
              key={chat.id}
              selected={chat.id === chatId}
              onClick={() => openChat(chat.id)}
            >
              <ListItemText
                primary={chat.title}
                secondary={new Date(chat.updatedAt).toLocaleString()}
                slotProps={{
                  primary: { noWrap: true, variant: "body2" },
                  secondary: { variant: "caption" },
                }}
              />
            </MenuItem>
          ))}
        </Menu>
      </Box>

      <Box
        ref={scrollRef}
        onScroll={e => {
          const el = e.currentTarget;
          pinnedToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1 }}
      >
        {messages.length === 0 ? (
          <Box sx={{ pt: 4, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Ask a question about this app. Answers come from the data the app
              has published.
            </Typography>
            {SUGGESTIONS.map(suggestion => (
              <Button
                key={suggestion}
                variant="outlined"
                size="small"
                onClick={() => send(suggestion)}
                sx={{ justifyContent: "flex-start", textTransform: "none" }}
              >
                {suggestion}
              </Button>
            ))}
          </Box>
        ) : (
          messages.map((message, index) => (
            <ChatMessageRow
              key={message.id}
              message={
                message as unknown as Parameters<
                  typeof ChatMessageRow
                >[0]["message"]
              }
              isLastMessage={index === messages.length - 1}
              isStreaming={isLoading && index === messages.length - 1}
              onToolClick={setToolDetails}
              onConsoleTitleClick={noop}
              onMcpApprovalResponse={noop}
              connectionIconById={EMPTY_ICONS}
              paletteMode={paletteMode}
            />
          ))
        )}
        {errorText && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {errorText}
          </Alert>
        )}
      </Box>

      <Box
        component="form"
        onSubmit={e => {
          e.preventDefault();
          send(input);
        }}
        sx={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          p: 1.5,
          borderTop: 1,
          borderColor: "divider",
        }}
      >
        <TextField
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Ask a question…"
          multiline
          maxRows={6}
          size="small"
          fullWidth
          autoFocus
          slotProps={{ htmlInput: { "aria-label": "Ask a question" } }}
        />
        {isLoading ? (
          <IconButton aria-label="Stop" onClick={handleStop} color="primary">
            <Square size={16} />
          </IconButton>
        ) : (
          <IconButton
            aria-label="Send"
            type="submit"
            color="primary"
            disabled={!input.trim()}
          >
            <ArrowUp size={18} />
          </IconButton>
        )}
      </Box>

      <ToolDetailsDialog
        open={!!toolDetails}
        tool={toolDetails}
        onClose={() => setToolDetails(null)}
        paletteMode={paletteMode}
      />
    </Box>
  );
}
