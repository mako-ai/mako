/**
 * Chat3 - Using Vercel AI SDK useChat hook
 * Native AI SDK streaming protocol for improved compatibility
 */
import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  Box,
  Button,
  Chip,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  TextField,
  Typography,
  Menu,
  ListItemIcon,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
  Tooltip,
} from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  prism,
  tomorrow,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  ExpandMore,
  ExpandLess,
  ContentCopy,
  Check,
  History as HistoryIcon,
  Add as AddIcon,
  Chat as ChatIcon,
  Delete as DeleteIcon,
} from "@mui/icons-material";
import { useTheme as useMuiTheme } from "@mui/material/styles";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useSettingsStore } from "../store/settingsStore";
import { ModelSelector } from "./ModelSelector";
import { generateObjectId } from "../utils/objectId";
import { ConsoleModification } from "../hooks/useMonacoConsole";

interface ChatSessionMeta {
  _id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
}

// CodeBlock component for syntax highlighting
const CodeBlock = React.memo(
  ({
    language,
    children,
    isGenerating,
    scrollable,
  }: {
    language: string;
    children: string;
    isGenerating: boolean;
    scrollable?: boolean;
  }) => {
    const muiTheme = useMuiTheme();
    const effectiveMode = muiTheme.palette.mode;
    const syntaxTheme = effectiveMode === "dark" ? tomorrow : prism;
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isCopied, setIsCopied] = React.useState(false);

    const lines = children.split("\n");
    const needsExpansion = lines.length > 12;

    const isScrollable = !!scrollable;
    const displayedCode = isScrollable
      ? children
      : needsExpansion && !isExpanded
        ? lines.slice(0, 12).join("\n")
        : children;

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(children);
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy code:", err);
      }
    };

    return (
      <Box
        sx={{
          overflow: "hidden",
          borderRadius: 1,
          my: 1,
          position: "relative",
        }}
      >
        {isGenerating && (
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1,
            }}
          >
            <Typography variant="body2" color="text.primary">
              Generating...
            </Typography>
          </Box>
        )}
        <Box
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 1,
          }}
        >
          <IconButton
            size="small"
            onClick={handleCopy}
            sx={{
              backgroundColor:
                effectiveMode === "dark"
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.1)",
              "&:hover": {
                backgroundColor:
                  effectiveMode === "dark"
                    ? "rgba(255,255,255,0.2)"
                    : "rgba(0,0,0,0.2)",
              },
              transition: "all 0.2s",
            }}
          >
            {isCopied ? (
              <Check sx={{ fontSize: 16, color: "success.main" }} />
            ) : (
              <ContentCopy sx={{ fontSize: 16 }} />
            )}
          </IconButton>
        </Box>

        <SyntaxHighlighter
          style={syntaxTheme}
          language={language}
          PreTag="div"
          customStyle={{
            fontSize: "0.8rem",
            margin: 0,
            overflow: "auto",
            maxWidth: "100%",
            maxHeight: isScrollable ? "50vh" : undefined,
            paddingBottom: needsExpansion && !isScrollable ? "2rem" : undefined,
            paddingTop: "2rem",
          }}
        >
          {displayedCode}
        </SyntaxHighlighter>

        {needsExpansion && !isScrollable && (
          <Box
            sx={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
            }}
          >
            <Button
              size="small"
              onClick={() => setIsExpanded(!isExpanded)}
              sx={{
                borderRadius: 0,
                flexGrow: 1,
                color: "text.primary",
                backgroundColor:
                  effectiveMode === "dark"
                    ? "rgba(0, 0, 0, 0.3)"
                    : "rgba(255, 255, 255, 0.3)",
                "&:hover": {
                  backgroundColor:
                    effectiveMode === "dark"
                      ? "rgba(0, 0, 0, 0.1)"
                      : "rgba(255, 255, 255, 0.1)",
                },
              }}
            >
              {isExpanded ? <ExpandLess /> : <ExpandMore />}
            </Button>
          </Box>
        )}
      </Box>
    );
  },
);

CodeBlock.displayName = "CodeBlock";

// V6 tool part structure - tool type is "tool-{toolName}" with state/input/output
interface ToolInvocationInfo {
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

// ToolCallsDisplay for showing tool invocations from AI SDK
const ToolCallsDisplay = React.memo(
  ({
    toolInvocations,
    onToolClick,
  }: {
    toolInvocations?: ToolInvocationInfo[];
    onToolClick?: (tool: ToolInvocationInfo) => void;
  }) => {
    if (!toolInvocations || toolInvocations.length === 0) return null;

    return (
      <Box sx={{ mt: 1, display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {toolInvocations.map(tool => (
          <Chip
            key={tool.toolCallId}
            icon={
              tool.state === "output-available" ? (
                <Check sx={{ fontSize: 16 }} />
              ) : tool.state === "error" ? (
                <Check sx={{ fontSize: 16, color: "error.main" }} />
              ) : (
                <CircularProgress size={14} thickness={5} />
              )
            }
            label={tool.toolName}
            size="small"
            variant="outlined"
            sx={{
              backgroundColor: "background.paper",
              borderRadius: 2,
              opacity: 0.8,
              fontSize: "0.75rem",
              cursor: onToolClick ? "pointer" : "default",
              "& .MuiChip-icon": {
                color:
                  tool.state === "output-available"
                    ? "success.main"
                    : tool.state === "error"
                      ? "error.main"
                      : "primary.main",
              },
            }}
            onClick={onToolClick ? () => onToolClick(tool) : undefined}
            title={
              tool.state === "output-available"
                ? "Tool executed successfully"
                : tool.state === "error"
                  ? "Tool execution failed"
                  : "Tool executing..."
            }
          />
        ))}
      </Box>
    );
  },
);

ToolCallsDisplay.displayName = "ToolCallsDisplay";

// ReasoningDisplay for showing reasoning/thinking parts
const ReasoningDisplay = React.memo(
  ({ messageParts }: { messageParts?: Array<Record<string, unknown>> }) => {
    const [expanded, setExpanded] = React.useState(false);

    if (!messageParts) return null;

    const reasoningParts = messageParts.filter(
      (p): p is { type: "reasoning"; text: string } =>
        p.type === "reasoning" && typeof p.text === "string",
    );

    if (reasoningParts.length === 0) return null;

    return (
      <Box sx={{ my: 1 }}>
        <Button
          size="small"
          onClick={() => setExpanded(!expanded)}
          startIcon={expanded ? <ExpandLess /> : <ExpandMore />}
          sx={{
            color: "text.secondary",
            textTransform: "none",
            fontSize: "0.8rem",
            p: 0,
            minWidth: "auto",
            "&:hover": {
              backgroundColor: "transparent",
              textDecoration: "underline",
            },
          }}
          disableRipple
        >
          Thinking Process
        </Button>
        {expanded && (
          <Box
            sx={{
              mt: 1,
              pl: 2,
              borderLeft: 2,
              borderColor: "divider",
              color: "text.secondary",
              fontSize: "0.875rem",
            }}
          >
            {reasoningParts.map((part, i) => (
              <Box key={i} sx={{ mb: 1, whiteSpace: "pre-wrap" }}>
                {part.text}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  },
);

ReasoningDisplay.displayName = "ReasoningDisplay";

// Extended ConsoleModification with fields for console creation
type ConsoleModificationPayload = ConsoleModification & {
  consoleId?: string;
  title?: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
};

interface Chat3Props {
  onConsoleModification?: (modification: ConsoleModificationPayload) => void;
}

const Chat3: React.FC<Chat3Props> = ({ onConsoleModification }) => {
  const muiTheme = useMuiTheme();
  const { currentWorkspace } = useWorkspace();
  const selectedModelId = useSettingsStore(s => s.selectedModelId);
  const useChatV3 = useSettingsStore(s => s.useChatV3);
  const setUseChatV3 = useSettingsStore(s => s.setUseChatV3);
  const { consoleTabs, activeConsoleId } = useConsoleStore();

  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  // chatId is a MongoDB ObjectId generated locally - frontend owns the ID (AI SDK best practice)
  const [chatId, setChatId] = useState<string>(() => generateObjectId());
  const [historyMenuAnchor, setHistoryMenuAnchor] =
    useState<null | HTMLElement>(null);
  const historyMenuOpen = Boolean(historyMenuAnchor);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Track if we're viewing an existing chat from history (vs a new chat)
  // Moved before useChat so onFinish callback can access it
  const [isExistingChat, setIsExistingChat] = useState(false);

  // Refs for accessing current values in callbacks (avoids stale closures)
  const isExistingChatRef = useRef(isExistingChat);
  isExistingChatRef.current = isExistingChat;

  // Ref for onConsoleModification to avoid stale closure in onToolCall
  const onConsoleModificationRef = useRef(onConsoleModification);
  onConsoleModificationRef.current = onConsoleModification;

  // Function to fetch sessions - defined before useChat so it can be used in onFinish
  // Using a ref-based pattern to always access the current workspace
  const fetchSessionsRef = useRef<() => Promise<void>>();
  fetchSessionsRef.current = async () => {
    if (!currentWorkspace) return;
    try {
      const res = await fetch(`/api/workspaces/${currentWorkspace.id}/chats`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch {
      /* ignore */
    }
  };

  // Tool debug dialog
  const [toolDialogOpen, setToolDialogOpen] = useState(false);
  const [selectedTool, setSelectedTool] = useState<ToolInvocationInfo | null>(
    null,
  );

  // Filter to only real console tabs
  const realConsoleTabs = useMemo(
    () =>
      (consoleTabs || []).filter(
        t => t?.kind === undefined || t?.kind === "console",
      ),
    [consoleTabs],
  );

  // Build consoles data for the backend
  const consolesData = useMemo(() => {
    const data: Array<{
      id: string;
      title: string;
      content: string;
      connectionId?: string;
      databaseId?: string;
      databaseName?: string;
    }> = [];

    for (const tab of realConsoleTabs) {
      if (!tab?.id) continue;
      const connectionId = tab?.connectionId;
      const databaseId =
        tab?.databaseId || tab?.metadata?.queryOptions?.databaseId;
      const databaseName =
        tab?.databaseName ||
        tab?.metadata?.queryOptions?.databaseName ||
        tab?.metadata?.queryOptions?.dbName;

      data.push({
        id: tab.id,
        title: tab.title,
        content: tab.content || "",
        connectionId,
        databaseId,
        databaseName,
      });
    }
    return data;
  }, [realConsoleTabs]);

  // Local input state (v6 useChat doesn't manage input)
  const [input, setInput] = useState("");

  // Create transport with dynamic body based on current state
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent-v3/chat",
        body: {
          workspaceId: currentWorkspace?.id,
          consoles: consolesData,
          consoleId: activeConsoleId,
          modelId: selectedModelId,
          chatId, // Frontend-owned ID (AI SDK best practice)
        },
      }),
    [
      currentWorkspace?.id,
      consolesData,
      activeConsoleId,
      selectedModelId,
      chatId,
    ],
  );

  // Note: We use (useConsoleStore as any).getState() inside callbacks to avoid stale closure issues

  // useChat hook from Vercel AI SDK v6
  // IMPORTANT: The 'id' prop is critical - it resets the hook's internal message state
  // when chatId changes. Without it, switching chats causes stale messages to persist.
  // @typescript-eslint/no-explicit-any
  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    setMessages,
    addToolOutput,
  } = useChat({
    id: chatId, // Reset hook state when chatId changes (fixes stale messages bug)
    transport: transport as any, // Type assertion to handle pnpm version resolution

    // Automatically submit when all tool results are available
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,

    // Handle client-side tools (console operations)
    async onToolCall({ toolCall }) {
      // Skip dynamic tools (not our console tools)
      if ((toolCall as { dynamic?: boolean }).dynamic) {
        return;
      }

      const toolName = toolCall.toolName;
      const input = toolCall.input as Record<string, unknown>;

      // Handle read_console
      if (toolName === "read_console") {
        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;
        const currentActiveId = currentStore.activeConsoleId;

        const consoleId = (input.consoleId as string | null) ?? currentActiveId;
        const targetConsole = consoleId
          ? currentTabs.find((c: any) => c.id === consoleId)
          : currentTabs.find((c: any) => c.id === currentActiveId) ||
            currentTabs[0];

        if (!targetConsole) {
          addToolOutput({
            tool: "read_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: consoleId
                ? `Console with ID ${consoleId} not found`
                : "No console is currently active",
            },
          });
          return;
        }

        addToolOutput({
          tool: "read_console",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            consoleId: targetConsole.id,
            title: targetConsole.title,
            content: targetConsole.content || "",
            connectionId: targetConsole.connectionId,
            connectionType: (
              targetConsole.metadata as { connectionType?: string }
            )?.connectionType,
            databaseId: targetConsole.databaseId,
            databaseName: targetConsole.databaseName,
          },
        });
        return;
      }

      // Handle modify_console - dispatch through event system for proper Monaco update
      if (toolName === "modify_console") {
        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;
        const currentActiveId = currentStore.activeConsoleId;

        const action = input.action as "replace" | "insert" | "append";
        const content = input.content as string;
        const position = input.position as number | null;
        const inputConsoleId = input.consoleId as string | null | undefined;

        // Determine target console
        const resolvedConsoleId =
          inputConsoleId ?? currentActiveId ?? currentTabs[0]?.id;

        if (!resolvedConsoleId) {
          addToolOutput({
            tool: "modify_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: "No console is currently open. Call create_console first.",
            },
          });
          return;
        }

        const targetConsole = currentTabs.find(
          (c: any) => c.id === resolvedConsoleId,
        );
        if (!targetConsole) {
          addToolOutput({
            tool: "modify_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: `Console with ID ${resolvedConsoleId} not found`,
            },
          });
          return;
        }

        // Validate insert action has position
        if (
          action === "insert" &&
          (position === null || position === undefined)
        ) {
          addToolOutput({
            tool: "modify_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: "Position is required for insert action",
            },
          });
          return;
        }

        // Dispatch through the event system - this ensures Monaco editor gets updated
        // The App.tsx handleConsoleModification callback will:
        // 1. Dispatch a CustomEvent that Editor.tsx listens to
        // 2. Editor.tsx calls showDiff() on the Console ref
        // 3. Console.tsx updates Monaco editor via the diff mode
        if (onConsoleModificationRef.current) {
          onConsoleModificationRef.current({
            action,
            content,
            // Convert line number to position format expected by ConsoleModification
            position:
              position !== null && position !== undefined
                ? { line: position, column: 1 }
                : undefined,
            consoleId: resolvedConsoleId,
          });
        }

        // Also update store for consistency
        const currentContent = targetConsole.content || "";
        let newContent: string;

        switch (action) {
          case "replace":
            newContent = content;
            break;
          case "append":
            newContent =
              currentContent +
              (currentContent.endsWith("\n") ? "" : "\n") +
              content;
            break;
          case "insert":
            if (position !== null && position !== undefined) {
              const lines = currentContent.split("\n");
              const insertIndex = Math.max(0, position - 1);
              lines.splice(insertIndex, 0, content);
              newContent = lines.join("\n");
            } else {
              newContent = content + currentContent;
            }
            break;
          default:
            newContent = content;
        }
        currentStore.updateConsoleContent(resolvedConsoleId, newContent);

        addToolOutput({
          tool: "modify_console",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            consoleId: resolvedConsoleId,
            message: `Console ${action}d successfully`,
          },
        });
        return;
      }

      // Handle create_console - dispatch through event system
      if (toolName === "create_console") {
        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;
        const currentActiveId = currentStore.activeConsoleId;

        const title = input.title as string;
        const content = input.content as string;
        const connectionId = (input.connectionId as string | null) ?? undefined;
        const databaseId = (input.databaseId as string | null) ?? undefined;
        const databaseName = (input.databaseName as string | null) ?? undefined;

        // If connection info not provided, inherit from active console
        const baseConsole =
          currentTabs.find((c: any) => c.id === currentActiveId) ||
          currentTabs[0];

        const effectiveConnectionId = connectionId ?? baseConsole?.connectionId;
        const effectiveDatabaseId = databaseId ?? baseConsole?.databaseId;
        const effectiveDatabaseName = databaseName ?? baseConsole?.databaseName;

        // Generate a new ID for the console
        const newConsoleId = generateObjectId();

        // Dispatch through the event system - App.tsx handleConsoleModification will:
        // 1. Call addConsoleTab with the provided consoleId
        // 2. Call setActiveConsole
        if (onConsoleModificationRef.current) {
          onConsoleModificationRef.current({
            action: "create",
            content,
            consoleId: newConsoleId,
            title,
            connectionId: effectiveConnectionId,
            databaseId: effectiveDatabaseId,
            databaseName: effectiveDatabaseName,
          });
        }

        addToolOutput({
          tool: "create_console",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            _eventType: "console_creation",
            consoleId: newConsoleId,
            title,
            content,
            connectionId: effectiveConnectionId,
            databaseId: effectiveDatabaseId,
            databaseName: effectiveDatabaseName,
            message: `✓ New console "${title}" created successfully`,
          },
        });
        return;
      }

      // Unknown tool - not a client-side console tool, let it be handled server-side
    },

    onError: err => {
      console.error("[Chat3] Error:", err);
    },
    onFinish: () => {
      // When a new chat's first message exchange completes, refresh the sessions list
      // so the newly saved chat appears in the history menu
      if (!isExistingChatRef.current) {
        fetchSessionsRef.current?.();
      }
    },
  });

  const isLoading = status === "streaming" || status === "submitted";

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Session management - fetch available chat sessions for history menu
  useEffect(() => {
    fetchSessionsRef.current?.();
  }, [currentWorkspace]);

  // Load messages when selecting an existing chat from history
  useEffect(() => {
    const loadSession = async () => {
      if (!isExistingChat || !currentWorkspace) {
        return;
      }
      try {
        const res = await fetch(
          `/api/workspaces/${currentWorkspace.id}/chats/${chatId}`,
        );
        if (res.ok) {
          const data = await res.json();
          // Convert stored messages to AI SDK v6 format with parts including tool calls
          const convertedMessages =
            data.messages?.map((msg: any) => {
              const parts: Array<Record<string, unknown>> = [];

              // Add tool call parts first (they execute before text response)
              // IMPORTANT: input must always be defined (at least {}) for OpenAI API compatibility
              // The API requires 'arguments' field which comes from 'input'
              if (msg.toolCalls && msg.toolCalls.length > 0) {
                for (const tc of msg.toolCalls) {
                  // Skip tool calls without a valid toolName
                  if (!tc.toolName) continue;

                  parts.push({
                    type: `tool-${tc.toolName}`,
                    toolCallId:
                      tc.toolCallId ||
                      tc._id?.toString() ||
                      `saved-${tc.toolName}-${Date.now()}-${Math.random()}`,
                    toolName: tc.toolName,
                    state: "output-available",
                    // CRITICAL: input must never be undefined - OpenAI API requires 'arguments'
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
                id:
                  msg._id?.toString() ||
                  msg.id ||
                  `${Date.now()}-${Math.random()}`,
                role: msg.role,
                parts,
              };
            }) || [];
          setMessages(convertedMessages);
        }
      } catch {
        /* ignore */
      }
    };
    loadSession();
  }, [chatId, isExistingChat, currentWorkspace, setMessages]);

  // Focus input
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, [chatId, messages.length]);

  // Create new chat session - just generate a new ID locally (no API call needed)
  const createNewSession = () => {
    setChatId(generateObjectId());
    setMessages([]);
    setIsExistingChat(false);
  };

  const handleHistoryMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setHistoryMenuAnchor(event.currentTarget);
  };

  const handleHistoryMenuClose = () => {
    setHistoryMenuAnchor(null);
  };

  const handleSelectSession = (id: string) => {
    setChatId(id);
    setMessages([]);
    setIsExistingChat(true);
    handleHistoryMenuClose();
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentWorkspace) return;
    try {
      const res = await fetch(
        `/api/workspaces/${currentWorkspace.id}/chats/${id}`,
        { method: "DELETE" },
      );
      if (res.ok) {
        const newSessions = sessions.filter(s => s._id !== id);
        setSessions(newSessions);
        if (chatId === id) {
          // If we deleted the current chat, start a new one
          createNewSession();
        }
      }
    } catch {
      /* ignore */
    }
  };

  // Tool debug dialog handlers
  const handleToolClick = (tool: ToolInvocationInfo) => {
    setSelectedTool(tool);
    setToolDialogOpen(true);
  };

  const handleCloseToolDialog = () => {
    setToolDialogOpen(false);
    setSelectedTool(null);
  };

  // Extract tool invocations from message parts (v6 API)
  // AI SDK v6 has two tool part types:
  // - Static tools: type is "tool-{toolName}" (e.g., "tool-list_connections")
  // - Dynamic tools: type is "dynamic-tool" with toolName as separate property
  const getToolInvocations = (
    messageParts: Array<Record<string, unknown>> | undefined,
  ): ToolInvocationInfo[] => {
    if (!messageParts) return [];
    return messageParts
      .filter(part => {
        const type = part.type;
        if (typeof type !== "string") return false;
        // Match static tools (type starts with "tool-") or dynamic tools
        return type.startsWith("tool-") || type === "dynamic-tool";
      })
      .map(part => {
        const partType = part.type as string;
        // For dynamic tools, use the toolName property; for static tools, extract from type
        // Static tool names: "tool-{name}" -> split on "-" and rejoin (handles names with hyphens)
        const toolName =
          partType === "dynamic-tool"
            ? (part.toolName as string)
            : partType.split("-").slice(1).join("-");
        return {
          toolCallId: (part.toolCallId as string) || "",
          toolName: toolName || "",
          state: part.state as ToolInvocationInfo["state"],
          input: part.input,
          output: part.output,
        };
      });
  };

  // Render message content from parts (v6 API - no content property, only parts)
  const renderMessageContent = (
    messageParts: Array<{ type: string; text?: string }> | undefined,
  ) => {
    // In v6, messages only have parts, no content property
    if (messageParts && messageParts.length > 0) {
      const textParts = messageParts.filter(p => p.type === "text" && p.text);
      if (textParts.length > 0) {
        return textParts.map((part, idx) => (
          <ReactMarkdown
            key={idx}
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children }) {
                const match = /language-(\w+)/.exec(className || "");
                const isInline = !match;
                const codeString = String(children).replace(/\n$/, "");
                return !isInline ? (
                  <CodeBlock
                    language={match ? match[1] : "text"}
                    key={codeString}
                    isGenerating={false}
                  >
                    {codeString}
                  </CodeBlock>
                ) : (
                  <code className={className} style={{ fontSize: "0.8rem" }}>
                    {children}
                  </code>
                );
              },
              table({ children }) {
                return (
                  <Box sx={{ overflow: "auto", my: 1 }}>
                    <table
                      style={{
                        borderCollapse: "collapse",
                        width: "100%",
                        fontSize: "0.875rem",
                        border: `1px solid ${muiTheme.palette.divider}`,
                      }}
                    >
                      {children}
                    </table>
                  </Box>
                );
              },
              th({ children }) {
                return (
                  <th
                    style={{
                      padding: "8px 12px",
                      textAlign: "left",
                      backgroundColor: muiTheme.palette.background.paper,
                      borderBottom: `2px solid ${muiTheme.palette.divider}`,
                      borderRight: `1px solid ${muiTheme.palette.divider}`,
                      fontWeight: 600,
                    }}
                  >
                    {children}
                  </th>
                );
              },
              td({ children }) {
                return (
                  <td
                    style={{
                      padding: "8px 12px",
                      borderBottom: `1px solid ${muiTheme.palette.divider}`,
                      borderRight: `1px solid ${muiTheme.palette.divider}`,
                      backgroundColor: muiTheme.palette.background.paper,
                    }}
                  >
                    {children}
                  </td>
                );
              },
            }}
          >
            {part.text || ""}
          </ReactMarkdown>
        ));
      }
    }

    return null;
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header with history and new chat */}
      <Box sx={{ px: 1, py: 0.25, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
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
            <Tooltip title="Switch back to original Chat" placement="bottom">
              <Switch
                size="small"
                checked={useChatV3}
                onChange={e => setUseChatV3(e.target.checked)}
                sx={{ ml: 0.5 }}
              />
            </Tooltip>
            <Typography variant="caption" color="primary.main">
              v3
            </Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <IconButton size="small" onClick={createNewSession}>
              <AddIcon />
            </IconButton>
            <IconButton
              size="small"
              onClick={handleHistoryMenuOpen}
              disabled={sessions.length === 0}
            >
              <HistoryIcon />
            </IconButton>
          </Box>
        </Box>
      </Box>

      {/* History Menu */}
      <Menu
        anchorEl={historyMenuAnchor}
        open={historyMenuOpen}
        onClose={handleHistoryMenuClose}
        PaperProps={{
          sx: { maxHeight: 400, width: 300 },
        }}
      >
        {sessions
          .filter(
            session =>
              session._id === chatId ||
              (session.title && session.title.length > 0),
          )
          .map(session => (
            <MenuItem
              key={session._id}
              onClick={() => handleSelectSession(session._id)}
              selected={session._id === chatId}
              sx={{ display: "flex", justifyContent: "space-between" }}
            >
              <Box sx={{ display: "flex", alignItems: "center", flex: 1 }}>
                <ListItemIcon>
                  <ChatIcon fontSize="small" />
                </ListItemIcon>
                <Box>
                  <ListItemText
                    primary={session.title || session._id.substring(0, 8)}
                    secondary={
                      session.updatedAt
                        ? new Date(session.updatedAt).toLocaleString()
                        : session.createdAt
                          ? new Date(session.createdAt).toLocaleString()
                          : ""
                    }
                    primaryTypographyProps={{
                      noWrap: true,
                      sx: { maxWidth: 200 },
                    }}
                  />
                </Box>
              </Box>
              {sessions.length > 1 && (
                <IconButton
                  size="small"
                  onClick={e => handleDeleteSession(session._id, e)}
                  sx={{ ml: 1 }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              )}
            </MenuItem>
          ))}
        {sessions.length === 0 && (
          <MenuItem disabled>
            <Typography variant="body2" color="text.secondary">
              No chat history yet
            </Typography>
          </MenuItem>
        )}
      </Menu>

      {/* Error display */}
      {error && (
        <Box sx={{ p: 1 }}>
          <Alert severity="error" sx={{ fontSize: "0.875rem" }}>
            {error.message}
          </Alert>
        </Box>
      )}

      {/* Messages */}
      <Box sx={{ flex: messages.length > 0 ? 1 : 0, overflow: "auto", p: 1 }}>
        <List dense>
          {messages.map(message => (
            <ListItem key={message.id} alignItems="flex-start" sx={{ p: 0 }}>
              {message.role === "user" ? (
                <Box sx={{ flex: 1 }}>
                  <Paper
                    variant="outlined"
                    sx={{
                      p: 1,
                      borderRadius: 1,
                      backgroundColor: "background.paper",
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        overflow: "auto",
                        maxWidth: "100%",
                      }}
                    >
                      <ListItemText
                        primary={
                          // V6: extract text from parts
                          (message.parts || [])
                            .filter(
                              (p): p is { type: "text"; text: string } =>
                                p.type === "text" && "text" in p,
                            )
                            .map(p => p.text)
                            .join("") || ""
                        }
                        primaryTypographyProps={{
                          variant: "body2",
                          color: "text.primary",
                          sx: {
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            overflowWrap: "break-word",
                          },
                        }}
                      />
                    </Box>
                  </Paper>
                </Box>
              ) : (
                <Box
                  sx={{
                    flex: 1,
                    overflow: "hidden",
                    fontSize: "0.875rem",
                    "& pre": { margin: 0, overflow: "hidden" },
                  }}
                >
                  {/* Display tool invocations */}
                  <ToolCallsDisplay
                    toolInvocations={getToolInvocations(
                      message.parts as Array<Record<string, unknown>>,
                    )}
                    onToolClick={handleToolClick}
                  />
                  {/* Display reasoning */}
                  <ReasoningDisplay
                    messageParts={
                      message.parts as Array<Record<string, unknown>>
                    }
                  />
                  {/* Display message content */}
                  {renderMessageContent(
                    message.parts as Array<{ type: string; text?: string }>,
                  )}
                </Box>
              )}
            </ListItem>
          ))}

          {/* Loading indicator */}
          {status === "submitted" && (
            <ListItem alignItems="flex-start" sx={{ p: 0 }}>
              <Box
                sx={{
                  flex: 1,
                  overflow: "hidden",
                  fontSize: "0.875rem",
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Assistant is thinking...
                </Typography>
              </Box>
            </ListItem>
          )}
        </List>
        <div ref={messagesEndRef} />
      </Box>

      {/* Input */}
      <Paper
        elevation={0}
        sx={{
          border: 1,
          borderColor: "divider",
          borderRadius: 2.5,
          p: 1,
          m: 1,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            if (input.trim() && !isLoading) {
              sendMessage({ text: input });
              setInput("");
            }
          }}
        >
          <TextField
            fullWidth
            autoFocus
            multiline
            minRows={1}
            maxRows={6}
            placeholder="Ask Chat..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (input.trim() && !isLoading) {
                  sendMessage({ text: input });
                  setInput("");
                }
              }
            }}
            disabled={isLoading}
            variant="outlined"
            inputRef={inputRef}
            sx={{
              m: 0.5,
              maxHeight: "50vh",
              overflowY: "auto",
              "& .MuiInputBase-input": {
                fontSize: 14,
              },
              "& .MuiInputBase-root": {
                p: 0,
                fontSize: 14,
              },
              "& .MuiOutlinedInput-notchedOutline": {
                border: "none",
              },
              "& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline":
                {
                  border: "none",
                },
              "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline":
                {
                  border: "none",
                },
            }}
          />

          {/* Bottom action bar with Model Selector on left, Send/Stop button on right */}
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center" }}>
              <ModelSelector />
            </Box>

            {isLoading ? (
              <IconButton
                onClick={stop}
                size="small"
                sx={{
                  color: "error.main",
                  p: 0,
                  "&:hover": {
                    backgroundColor: "action.hover",
                  },
                }}
              >
                <StopIcon sx={{ fontSize: 20 }} />
              </IconButton>
            ) : (
              <IconButton
                type="submit"
                disabled={!input.trim() || !currentWorkspace}
                size="small"
                sx={{
                  color:
                    input.trim() && currentWorkspace
                      ? "primary.main"
                      : "text.disabled",
                  p: 0,
                  "&:hover": {
                    backgroundColor: "action.hover",
                  },
                }}
              >
                <SendIcon sx={{ fontSize: 20 }} />
              </IconButton>
            )}
          </Box>
        </form>
      </Paper>

      {/* Tool Debug Dialog */}
      <Dialog
        open={toolDialogOpen}
        onClose={handleCloseToolDialog}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>
          {selectedTool ? `Tool: ${selectedTool.toolName}` : "Tool Details"}
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Input
            </Typography>
            <CodeBlock language="json" isGenerating={false} scrollable>
              {selectedTool && selectedTool.input !== undefined
                ? typeof selectedTool.input === "string"
                  ? selectedTool.input
                  : JSON.stringify(selectedTool.input, null, 2)
                : "No input captured"}
            </CodeBlock>
          </Box>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              Output
            </Typography>
            <CodeBlock language="json" isGenerating={false} scrollable>
              {selectedTool && selectedTool.output !== undefined
                ? typeof selectedTool.output === "string"
                  ? selectedTool.output
                  : JSON.stringify(selectedTool.output, null, 2)
                : "No output captured"}
            </CodeBlock>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseToolDialog}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Chat3;
