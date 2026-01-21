/**
 * Chat Component - Using Vercel AI SDK useChat hook
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
} from "@mui/material";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  prism,
  tomorrow,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { StreamingMarkdown } from "./StreamingMarkdown";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  History,
  Plus,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { useTheme as useMuiTheme, keyframes } from "@mui/material/styles";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { ConsoleTab } from "../store/appStore";
import { useSettingsStore } from "../store/settingsStore";
import { ModelSelector } from "./ModelSelector";
import { generateObjectId } from "../utils/objectId";
import { ConsoleModification } from "../hooks/useMonacoConsole";
import { applyModification } from "../utils/consoleModification";
import { trackEvent } from "../lib/analytics";

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
              <Check
                size={16}
                style={{ color: "var(--mui-palette-success-main, #4caf50)" }}
              />
            ) : (
              <Copy size={16} />
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
            paddingBottom: needsExpansion && !isScrollable ? "2rem" : "0.75rem",
            paddingTop: "0.75rem",
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
              {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </Button>
          </Box>
        )}
      </Box>
    );
  },
);

CodeBlock.displayName = "CodeBlock";

// Tool part structure - tool type is "tool-{toolName}" with state/input/output
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
                <Check size={16} />
              ) : tool.state === "error" ? (
                <Check
                  size={16}
                  style={{ color: "var(--mui-palette-error-main, #f44336)" }}
                />
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
          startIcon={
            expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />
          }
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

// Stable keyframes animation defined outside component to prevent re-renders
const pulseAnimation = keyframes`
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.35); }
`;

// Shimmer animation for "Working on" indicator
const shimmerAnimation = keyframes`
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
`;

// Stable style objects to prevent re-renders
const streamingIndicatorContainerSx = {
  display: "flex",
  alignItems: "center",
  mt: 0.5,
} as const;

const streamingIndicatorDotSx = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  backgroundColor: "primary.main",
  animation: `${pulseAnimation} 1s infinite ease-in-out`,
} as const;

// StreamingIndicator - Shows pulsing dot while content is being streamed
const StreamingIndicator = React.memo(() => {
  return (
    <Box component="span" sx={streamingIndicatorContainerSx}>
      <Box sx={streamingIndicatorDotSx} />
    </Box>
  );
});

StreamingIndicator.displayName = "StreamingIndicator";

// Extended ConsoleModification with fields for console creation
type ConsoleModificationPayload = ConsoleModification & {
  consoleId?: string;
  title?: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
};

interface ChatProps {
  onConsoleModification?: (modification: ConsoleModificationPayload) => void;
}

const Chat: React.FC<ChatProps> = ({ onConsoleModification }) => {
  const { currentWorkspace } = useWorkspace();
  const selectedModelId = useSettingsStore(s => s.selectedModelId);
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

  // Ref to capture the active console ID at the time the user submits a message
  // This prevents the race condition where user switches consoles while agent is thinking
  const capturedConsoleIdRef = useRef<string | null>(null);

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

  // Filter to only real console tabs (used for capturedConsoleTitle)
  const realConsoleTabs = useMemo(
    () =>
      (consoleTabs || []).filter(
        t => t?.kind === undefined || t?.kind === "console",
      ),
    [consoleTabs],
  );

  // Local input state
  const [input, setInput] = useState("");

  // Get the captured console's title for the visual indicator
  const capturedConsoleTitle = useMemo(() => {
    const capturedId = capturedConsoleIdRef.current;
    if (!capturedId) return null;
    const tab = realConsoleTabs.find(t => t.id === capturedId);
    return tab?.title || null;
  }, [realConsoleTabs]);

  // Ref to get current activeConsoleId at request time (avoids stale closure)
  const activeConsoleIdRef = useRef(activeConsoleId);
  activeConsoleIdRef.current = activeConsoleId;

  // Refs for values needed in prepareSendMessagesRequest (avoids stale closures)
  const workspaceIdRef = useRef(currentWorkspace?.id);
  const modelIdRef = useRef(selectedModelId);
  const chatIdRef = useRef(chatId);
  workspaceIdRef.current = currentWorkspace?.id;
  modelIdRef.current = selectedModelId;
  chatIdRef.current = chatId;

  // Create transport with prepareSendMessagesRequest for dynamic body values
  // prepareSendMessagesRequest REPLACES the body (doesn't merge), so we must include all fields
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/agent/chat",
        prepareSendMessagesRequest: ({ messages }) => {
          // Get fresh console state at request time
          const store = (useConsoleStore as any).getState();
          const tabs = store.consoleTabs as ConsoleTab[];

          const openConsoles = tabs
            .filter(t => t?.kind === undefined || t?.kind === "console")
            .map(tab => {
              const content = tab.content || "";
              const lines = content.split("\n");
              const maxLines = 50;
              const truncated = lines.length > maxLines;
              const displayContent = truncated
                ? lines.slice(0, maxLines).join("\n")
                : content;

              return {
                id: tab.id,
                title: tab.title,
                connectionId: tab.connectionId,
                databaseId: tab.databaseId,
                databaseName: tab.databaseName,
                content: displayContent,
                contentTruncated: truncated,
                lineCount: lines.length,
              };
            });

          return {
            body: {
              messages,
              workspaceId: workspaceIdRef.current,
              modelId: modelIdRef.current,
              chatId: chatIdRef.current,
              openConsoles,
              consoleId: activeConsoleIdRef.current,
            },
          };
        },
      }),
    [], // Empty deps - all values read from refs at request time
  );

  // Note: We use (useConsoleStore as any).getState() inside callbacks to avoid stale closure issues

  // useChat hook from Vercel AI SDK
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

      // Handle read_console - requires explicit consoleId
      if (toolName === "read_console") {
        const consoleId = input.consoleId as string | undefined;

        if (!consoleId) {
          addToolOutput({
            tool: "read_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error:
                "consoleId is required. Use list_open_consoles first to get available console IDs.",
            },
          });
          return;
        }

        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;
        const targetConsole = currentTabs.find((c: any) => c.id === consoleId);

        if (!targetConsole) {
          addToolOutput({
            tool: "read_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
            },
          });
          return;
        }

        // Add line numbers to help AI accurately specify patch ranges
        const rawContent = targetConsole.content || "";
        const lines = rawContent.split("\n");
        const totalLines = lines.length;
        const lineNumberWidth = String(totalLines).length;
        // Format: "  1| code here" - line numbers are for reference only
        const content = lines
          .map(
            (line: string, i: number) =>
              `${String(i + 1).padStart(lineNumberWidth)}| ${line}`,
          )
          .join("\n");

        addToolOutput({
          tool: "read_console",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            consoleId: targetConsole.id,
            title: targetConsole.title,
            content,
            totalLines,
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

      // Handle modify_console - requires explicit consoleId
      if (toolName === "modify_console") {
        const action = input.action as
          | "replace"
          | "insert"
          | "append"
          | "patch";
        const content = input.content as string;
        const position = input.position as number | null;
        const consoleId = input.consoleId as string | undefined;
        const startLine = input.startLine as number | undefined;
        const endLine = input.endLine as number | undefined;

        if (!consoleId) {
          addToolOutput({
            tool: "modify_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error:
                "consoleId is required. Use list_open_consoles to get IDs of existing consoles, or create_console to create a new one.",
            },
          });
          return;
        }

        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;

        const targetConsole = currentTabs.find((c: any) => c.id === consoleId);
        if (!targetConsole) {
          addToolOutput({
            tool: "modify_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
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

        // Validate patch action has startLine and endLine
        if (action === "patch" && (!startLine || !endLine)) {
          addToolOutput({
            tool: "modify_console",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error:
                "startLine and endLine are required for patch action. Use read_console first to see line numbers.",
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
            consoleId,
            startLine,
            endLine,
          });
        }

        // Also update store for consistency using shared utility
        const currentContent = targetConsole.content || "";
        const modification: ConsoleModification = {
          action,
          content,
          position:
            position !== null && position !== undefined
              ? { line: position, column: 1 }
              : undefined,
          startLine,
          endLine,
        };
        const newContent = applyModification(currentContent, modification);
        currentStore.updateConsoleContent(consoleId, newContent);

        addToolOutput({
          tool: "modify_console",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            consoleId,
            message: `Console ${action}${action === "patch" ? "ed" : "d"} successfully`,
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

        // Use captured console ID (from message submission time) as the primary fallback
        // This prevents the race condition where user switches consoles while agent is thinking
        const capturedId = capturedConsoleIdRef.current;

        // If connection info not provided, inherit from captured/active console
        const baseConsole =
          currentTabs.find((c: any) => c.id === capturedId) ||
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

      // Handle list_open_consoles - return all open console tabs
      if (toolName === "list_open_consoles") {
        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;
        const currentActiveId = currentStore.activeConsoleId;

        const consoles = currentTabs
          .filter(
            (tab: any) => tab?.kind === undefined || tab?.kind === "console",
          )
          .map((tab: any) => ({
            id: tab.id,
            title: tab.title || "Untitled",
            connectionId: tab.connectionId,
            connectionName: tab.metadata?.connectionName || tab.connectionId,
            databaseName:
              tab.databaseName || tab.metadata?.queryOptions?.databaseName,
            contentPreview:
              (tab.content || "").slice(0, 100) +
              ((tab.content || "").length > 100 ? "..." : ""),
            isActive: tab.id === currentActiveId,
          }));

        addToolOutput({
          tool: "list_open_consoles",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            consoles,
            message: `Found ${consoles.length} open console(s)`,
          },
        });
        return;
      }

      // Handle set_console_connection - requires explicit consoleId
      if (toolName === "set_console_connection") {
        const consoleId = input.consoleId as string | undefined;
        const connectionId = input.connectionId as string;
        const databaseId = input.databaseId as string | undefined;
        const databaseName = input.databaseName as string | undefined;

        if (!consoleId) {
          addToolOutput({
            tool: "set_console_connection",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error:
                "consoleId is required. Use list_open_consoles to get IDs of existing consoles, or create_console to create a new one.",
            },
          });
          return;
        }

        // Get fresh state to avoid stale closure issues
        const currentStore = (useConsoleStore as any).getState();
        const currentTabs = currentStore.consoleTabs;

        const targetConsole = currentTabs.find((c: any) => c.id === consoleId);
        if (!targetConsole) {
          addToolOutput({
            tool: "set_console_connection",
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
            },
          });
          return;
        }

        // Update the console's connection and database
        currentStore.updateConsoleConnection(consoleId, connectionId);
        if (databaseId !== undefined || databaseName !== undefined) {
          currentStore.updateConsoleDatabase(
            consoleId,
            databaseId,
            databaseName,
          );
        }

        addToolOutput({
          tool: "set_console_connection",
          toolCallId: toolCall.toolCallId,
          output: {
            success: true,
            consoleId,
            connectionId,
            databaseId,
            databaseName,
            message: `Console "${targetConsole.title}" attached to connection ${connectionId}${databaseName ? ` (database: ${databaseName})` : ""}`,
          },
        });
        return;
      }

      // Unknown tool - not a client-side console tool, let it be handled server-side
    },

    onError: err => {
      console.error("[Chat] Error:", err);
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
          // Convert stored messages to AI SDK format with parts including tool calls
          // Tool calls are included for UI display (shows what tools were used).
          // The backend sanitizes these before sending to the AI to avoid
          // "tool_use without tool_result" errors.
          const convertedMessages =
            data.messages?.map((msg: any) => {
              // NEW: If parts are stored, use them directly (preserves chronological order)
              if (
                msg.parts &&
                Array.isArray(msg.parts) &&
                msg.parts.length > 0
              ) {
                return {
                  id:
                    msg.id ||
                    msg._id?.toString() ||
                    `${Date.now()}-${Math.random()}`,
                  role: msg.role,
                  parts: msg.parts.map((p: any) => {
                    // Convert stored part to UI format
                    if (p.type === "text") {
                      return { type: "text", text: p.text || "" };
                    }
                    if (p.type === "reasoning") {
                      // Handle both 'reasoning' and 'text' fields for reasoning parts
                      return {
                        type: "reasoning",
                        text: p.reasoning || p.text || "",
                      };
                    }
                    // Tool parts: ensure state is set for UI rendering
                    if (
                      p.type?.startsWith("tool-") ||
                      p.type === "dynamic-tool"
                    ) {
                      return {
                        ...p,
                        state: p.state || "output-available",
                        input: p.input ?? {},
                        output: p.output ?? null,
                      };
                    }
                    // Unknown part type - pass through as-is
                    return p;
                  }),
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
                id:
                  msg._id?.toString() ||
                  msg.id ||
                  `${Date.now()}-${Math.random()}`,
                role: msg.role,
                parts,
              };
            }) || [];
          setMessages(convertedMessages);

          // Restore consoles that were modified by the agent in this chat
          // The backend extracts console IDs from modify_console tool calls in the messages
          // and fetches those consoles from the database
          if (data.consoles && data.consoles.length > 0) {
            const store = (useConsoleStore as any).getState();
            const existingTabs = store.consoleTabs || [];

            for (const console of data.consoles) {
              // Check if console already exists in tabs (by ID)
              const exists = existingTabs.some((t: any) => t.id === console.id);
              if (!exists) {
                // Add the console tab
                store.addConsoleTab({
                  id: console.id,
                  title: console.title || "Untitled",
                  content: console.content || "",
                  connectionId: console.connectionId,
                  databaseId: console.databaseId,
                  databaseName: console.databaseName,
                });
              }
            }

            // Set the first restored console as active and capture it for this chat
            const firstConsole = data.consoles[0];
            if (firstConsole) {
              store.setActiveConsole(firstConsole.id);
              capturedConsoleIdRef.current = firstConsole.id;
            }
          }
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

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header with history and new chat */}
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
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
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <IconButton size="small" onClick={createNewSession}>
              <Plus size={20} />
            </IconButton>
            <IconButton
              size="small"
              onClick={handleHistoryMenuOpen}
              disabled={sessions.length === 0}
            >
              <History size={20} />
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
                  <MessageSquare size={18} />
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
                  <Trash2 size={18} />
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
                <Box sx={{ flex: 1, mt: 2 }}>
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
                          // Extract text from parts
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
                    mt: 1,
                    "& pre": { margin: 0, overflow: "hidden" },
                  }}
                >
                  {/* Render message parts in chronological order */}
                  {(message.parts || []).map((part, partIndex) => {
                    const partType = (part as Record<string, unknown>)
                      .type as string;

                    // Render tool invocations inline (no box wrapper)
                    if (
                      partType?.startsWith("tool-") ||
                      partType === "dynamic-tool"
                    ) {
                      const toolName =
                        partType === "dynamic-tool"
                          ? ((part as Record<string, unknown>)
                              .toolName as string)
                          : partType.split("-").slice(1).join("-");
                      const toolPart = part as Record<string, unknown>;
                      return (
                        <Chip
                          key={partIndex}
                          icon={
                            toolPart.state === "output-available" ? (
                              <Check size={16} />
                            ) : toolPart.state === "error" ? (
                              <Check
                                size={16}
                                style={{
                                  color:
                                    "var(--mui-palette-error-main, #f44336)",
                                }}
                              />
                            ) : (
                              <CircularProgress size={14} thickness={5} />
                            )
                          }
                          label={toolName}
                          size="small"
                          variant="outlined"
                          sx={{
                            backgroundColor: "background.paper",
                            borderRadius: 2,
                            opacity: 0.8,
                            fontSize: "0.75rem",
                            cursor: "pointer",
                            mr: 0.5,
                            mb: 0.5,
                            "& .MuiChip-icon": {
                              color:
                                toolPart.state === "output-available"
                                  ? "success.main"
                                  : toolPart.state === "error"
                                    ? "error.main"
                                    : "primary.main",
                            },
                          }}
                          onClick={() =>
                            handleToolClick({
                              toolCallId: (toolPart.toolCallId as string) || "",
                              toolName: toolName || "",
                              state:
                                toolPart.state as ToolInvocationInfo["state"],
                              input: toolPart.input,
                              output: toolPart.output,
                            })
                          }
                          title={
                            toolPart.state === "output-available"
                              ? "Tool executed successfully"
                              : toolPart.state === "error"
                                ? "Tool execution failed"
                                : "Tool executing..."
                          }
                        />
                      );
                    }

                    // Render reasoning parts
                    if (partType === "reasoning") {
                      return null; // Skip inline, will be shown via ReasoningDisplay
                    }

                    // Render text parts using StreamingMarkdown for optimized streaming
                    if (
                      partType === "text" &&
                      (part as { text?: string }).text
                    ) {
                      return (
                        <StreamingMarkdown key={partIndex}>
                          {(part as { text: string }).text}
                        </StreamingMarkdown>
                      );
                    }

                    return null;
                  })}
                  {/* Display reasoning (collapsible) */}
                  <ReasoningDisplay
                    messageParts={
                      message.parts as Array<Record<string, unknown>>
                    }
                  />
                  {/* Show streaming indicator on last message while streaming */}
                  {status === "streaming" &&
                    message.id === messages[messages.length - 1]?.id && (
                      <StreamingIndicator />
                    )}
                </Box>
              )}
            </ListItem>
          ))}
        </List>
        <div ref={messagesEndRef} />
      </Box>

      {/* Working on console indicator - shows which console the agent is targeting */}
      {isLoading && capturedConsoleTitle && (
        <Box
          sx={{
            px: 1,
            py: 0.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Typography
            variant="caption"
            sx={{
              background: theme =>
                theme.palette.mode === "dark"
                  ? "linear-gradient(90deg, #666 0%, #999 50%, #666 100%)"
                  : "linear-gradient(90deg, #999 0%, #333 50%, #999 100%)",
              backgroundSize: "200% 100%",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              animation: `${shimmerAnimation} 2s linear infinite`,
            }}
          >
            {capturedConsoleTitle}
          </Typography>
        </Box>
      )}

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
              // Capture the active console ID at message submission time
              // This prevents the race condition where user switches consoles while agent is thinking
              capturedConsoleIdRef.current = activeConsoleId;
              const activeConsole = consoleTabs.find(
                t => t.id === activeConsoleId,
              );
              trackEvent("ai_chat_message_sent", {
                model: selectedModelId,
                has_context: !!activeConsole?.content,
              });
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
                  // Capture the active console ID at message submission time
                  // This prevents the race condition where user switches consoles while agent is thinking
                  capturedConsoleIdRef.current = activeConsoleId;
                  const activeConsole = consoleTabs.find(
                    t => t.id === activeConsoleId,
                  );
                  trackEvent("ai_chat_message_sent", {
                    model: selectedModelId,
                    has_context: !!activeConsole?.content,
                  });
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
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  backgroundColor: "action.hover",
                  border: 1,
                  borderColor: "divider",
                  "&:hover": {
                    backgroundColor: "action.selected",
                  },
                }}
              >
                {/* Square stop icon */}
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    backgroundColor: "text.primary",
                    borderRadius: 0.5,
                  }}
                />
              </IconButton>
            ) : (
              <IconButton
                type="submit"
                disabled={!input.trim() || !currentWorkspace}
                size="small"
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  backgroundColor:
                    input.trim() && currentWorkspace
                      ? "primary.main"
                      : "action.disabledBackground",
                  color:
                    input.trim() && currentWorkspace
                      ? "primary.contrastText"
                      : "text.disabled",
                  "&:hover": {
                    backgroundColor:
                      input.trim() && currentWorkspace
                        ? "primary.dark"
                        : "action.disabledBackground",
                  },
                  "&.Mui-disabled": {
                    backgroundColor: "action.disabledBackground",
                    color: "text.disabled",
                  },
                }}
              >
                <ArrowUp size={18} />
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

export default Chat;
