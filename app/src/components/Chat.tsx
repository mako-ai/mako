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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
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
  ChevronRight,
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
import { getDashboardStateSnapshot } from "../dashboard-runtime/commands";
import { executeDashboardAgentTool } from "../dashboard-runtime/agent-tools";
import type { ConsoleTab } from "../store/lib/types";
import { useSettingsStore } from "../store/settingsStore";
import { useSchemaStore } from "../store/schemaStore";
import { ModelSelector } from "./ModelSelector";
import { generateObjectId } from "../utils/objectId";
import {
  ConsoleModification,
  ConsoleModificationPayload,
} from "../hooks/useMonacoConsole";
import { applyModification } from "../utils/consoleModification";
import { trackEvent } from "../lib/analytics";
import { DbFlowFormRef } from "./DbFlowForm";
import { safeStringify, toJsonSafe } from "../lib/json-safe";
import { StreamingToolCard, type ToolPartState } from "./StreamingToolCard";

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

// ReasoningDisplay for showing reasoning/thinking parts inline.
// - Auto-opens while streaming, auto-collapses when done.
// - Shows elapsed thinking time ("Thought for Xs").
// - Scrollable container with max height, auto-scrolls during streaming.
const ReasoningDisplay = React.memo(
  ({
    reasoningText,
    isStreaming,
  }: {
    reasoningText: string;
    isStreaming: boolean;
  }) => {
    const [userToggled, setUserToggled] = React.useState(false);
    const [userOpen, setUserOpen] = React.useState(false);
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    // Track whether this component was live-streamed (vs loaded from history)
    const wasLiveRef = React.useRef(false);
    const startTimeRef = React.useRef<number | null>(null);
    const scrollRef = React.useRef<HTMLDivElement>(null);

    // Auto-open while streaming, auto-close when done.
    // If the user manually toggled, respect their choice.
    const isOpen = userToggled ? userOpen : isStreaming;

    const handleToggle = () => {
      setUserToggled(true);
      setUserOpen(!isOpen);
    };

    // Timer: start counting when streaming begins, freeze when it stops
    React.useEffect(() => {
      if (isStreaming) {
        // Mark that this component saw a live session
        wasLiveRef.current = true;
        // Reset for new streaming session
        setUserToggled(false);
        startTimeRef.current = Date.now();
        setElapsedSeconds(0);

        const interval = setInterval(() => {
          if (startTimeRef.current) {
            setElapsedSeconds(
              Math.round((Date.now() - startTimeRef.current) / 1000),
            );
          }
        }, 1000);

        return () => clearInterval(interval);
      }
      // Streaming just stopped — freeze the elapsed time
      // (elapsedSeconds already holds the last value)
      startTimeRef.current = null;
    }, [isStreaming]);

    // Auto-scroll the reasoning container to the bottom while streaming
    React.useEffect(() => {
      if (isStreaming && isOpen && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [reasoningText, isStreaming, isOpen]);

    // Build the label text
    let label: string;
    if (isStreaming) {
      label = `Thinking${elapsedSeconds > 0 ? ` for ${elapsedSeconds}s` : ""}...`;
    } else if (wasLiveRef.current) {
      label = `Thought for ${elapsedSeconds || "<1"}s`;
    } else {
      label = "Thinking process";
    }

    return (
      <Box sx={{ my: 0.5 }}>
        <Button
          size="small"
          onClick={handleToggle}
          endIcon={
            isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          }
          sx={{
            color: "text.secondary",
            textTransform: "none",
            fontSize: "0.8rem",
            p: 0,
            minWidth: "auto",
            "& .MuiButton-endIcon": {
              opacity: isOpen ? 1 : 0,
              transition: "opacity 0.15s ease",
            },
            "&:hover .MuiButton-endIcon": {
              opacity: 1,
            },
            "&:hover": {
              backgroundColor: "transparent",
            },
          }}
          disableRipple
        >
          {label}
        </Button>
        {isOpen && (
          <Box
            ref={scrollRef}
            sx={{
              mt: 0.5,
              pl: 2,
              borderLeft: 2,
              borderColor: "divider",
              color: "text.secondary",
              fontSize: "0.85rem",
              maxHeight: 300,
              overflowY: "auto",
              "& p": { my: 0.5 },
            }}
          >
            <StreamingMarkdown>{reasoningText}</StreamingMarkdown>
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

// ── Memoized message row ─────────────────────────────────────────
// Prevents completed messages from re-rendering on every streaming chunk.
interface ChatMessageRowProps {
  message: { id: string; role: string; parts?: Array<Record<string, unknown>> };
  isLastMessage: boolean;
  isStreaming: boolean;
  onToolClick: (tool: ToolInvocationInfo) => void;
}

const userMessageSx = { flex: 1, mt: 2 } as const;
const userMessagePaperSx = {
  p: 1,
  borderRadius: 1,
  backgroundColor: "background.paper",
  overflow: "hidden",
} as const;
const userMessageBoxSx = { overflow: "auto", maxWidth: "100%" } as const;
const userMessageTextSx = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "break-word",
} as const;
const assistantMessageSx = {
  flex: 1,
  overflow: "hidden",
  fontSize: "0.875rem",
  mt: 1,
  "& pre": { margin: 0, overflow: "hidden" },
} as const;
const listItemSx = { p: 0 } as const;

function computeReasoningGroups(parts: Array<Record<string, unknown>>) {
  const groups = new Map<number, { text: string; lastIndex: number }>();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "reasoning") continue;
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!text) {
      for (const [, group] of groups) {
        if (group.lastIndex === i - 1) {
          group.lastIndex = i;
          break;
        }
      }
      continue;
    }

    const prevIndex = i - 1;
    let groupStart = i;
    for (const [start, group] of groups) {
      if (group.lastIndex === prevIndex) {
        groupStart = start;
        break;
      }
    }

    if (groupStart === i) {
      groups.set(i, { text: (p.text as string).trim(), lastIndex: i });
    } else {
      const existing = groups.get(groupStart);
      if (existing) {
        existing.text += "\n\n" + (p.text as string).trim();
        existing.lastIndex = i;
      }
    }
  }

  return groups;
}

const ChatMessageRow = React.memo(
  function ChatMessageRow({
    message,
    isLastMessage,
    isStreaming,
    onToolClick,
  }: ChatMessageRowProps) {
    if (message.role === "user") {
      return (
        <ListItem alignItems="flex-start" sx={listItemSx}>
          <Box sx={userMessageSx}>
            <Paper variant="outlined" sx={userMessagePaperSx}>
              <Box sx={userMessageBoxSx}>
                <ListItemText
                  primary={
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
                    sx: userMessageTextSx,
                  }}
                />
              </Box>
            </Paper>
          </Box>
        </ListItem>
      );
    }

    const parts = (message.parts || []) as Array<Record<string, unknown>>;
    const isStreamingNow = isStreaming;

    const reasoningGroups = computeReasoningGroups(parts);

    const lastPart = parts.at(-1);
    const isLastPartReasoning =
      isLastMessage && isStreamingNow && lastPart?.type === "reasoning";

    let lastGroupStart = -1;
    for (const [start] of reasoningGroups) {
      if (start > lastGroupStart) lastGroupStart = start;
    }

    return (
      <ListItem alignItems="flex-start" sx={listItemSx}>
        <Box sx={assistantMessageSx}>
          {parts.map((part, partIndex) => {
            const partType = part.type as string;

            if (partType?.startsWith("tool-") || partType === "dynamic-tool") {
              const toolName =
                partType === "dynamic-tool"
                  ? (part.toolName as string)
                  : partType.split("-").slice(1).join("-");
              return (
                <StreamingToolCard
                  key={partIndex}
                  toolName={toolName}
                  state={part.state as ToolPartState}
                  input={part.input}
                  output={part.output}
                  onDetailClick={() =>
                    onToolClick({
                      toolCallId: (part.toolCallId as string) || "",
                      toolName: toolName || "",
                      state: part.state as ToolInvocationInfo["state"],
                      input: part.input,
                      output: part.output,
                    })
                  }
                />
              );
            }

            if (partType === "reasoning") {
              const group = reasoningGroups.get(partIndex);
              if (!group) return null;
              const isGroupStreaming =
                isLastPartReasoning && partIndex === lastGroupStart;
              return (
                <ReasoningDisplay
                  key={`reasoning-${partIndex}`}
                  reasoningText={group.text}
                  isStreaming={isGroupStreaming}
                />
              );
            }

            if (partType === "text" && (part as { text?: string }).text) {
              return (
                <StreamingMarkdown key={partIndex}>
                  {(part as { text: string }).text}
                </StreamingMarkdown>
              );
            }

            return null;
          })}
          {isStreaming && isLastMessage && <StreamingIndicator />}
        </Box>
      </ListItem>
    );
  },
  (prev, next) => {
    if (prev.isLastMessage !== next.isLastMessage) return false;
    if (prev.isStreaming !== next.isStreaming) return false;
    if (prev.message === next.message) return true;

    const prevParts = prev.message.parts || [];
    const nextParts = next.message.parts || [];
    if (prevParts.length !== nextParts.length) return false;

    for (let i = 0; i < nextParts.length; i++) {
      const pp = prevParts[i];
      const np = nextParts[i];
      if (pp.type !== np.type) return false;
      if (pp.state !== np.state) return false;
      // Actively streaming parts have changing content — must re-render
      if (np.state === "input-streaming" || np.state === "output-streaming") {
        return false;
      }
      if (
        (pp.type === "text" || pp.type === "reasoning") &&
        (pp as { text?: string }).text?.length !==
          (np as { text?: string }).text?.length
      ) {
        return false;
      }
    }

    return true;
  },
);

ChatMessageRow.displayName = "ChatMessageRow";

// Isolated input component — owns its own `input` state so keystrokes
// never re-render the (expensive) message list above it.
interface ChatInputAreaProps {
  onSubmit: (text: string) => void;
  onStop: () => void;
  isLoading: boolean;
  disabled: boolean;
  focusKey: string | number;
}

const ChatInputArea = React.memo(
  ({ onSubmit, onStop, isLoading, disabled, focusKey }: ChatInputAreaProps) => {
    const [input, setInput] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }, [focusKey]);

    return (
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
              onSubmit(input);
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
                  onSubmit(input);
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

          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <ModelSelector />
            </Box>

            {isLoading ? (
              <IconButton
                onClick={onStop}
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
                disabled={!input.trim() || disabled}
                size="small"
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  backgroundColor:
                    input.trim() && !disabled
                      ? "primary.main"
                      : "action.disabledBackground",
                  color:
                    input.trim() && !disabled
                      ? "primary.contrastText"
                      : "text.disabled",
                  "&:hover": {
                    backgroundColor:
                      input.trim() && !disabled
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
    );
  },
);
ChatInputArea.displayName = "ChatInputArea";

// DbFlowFormRef is imported from ./DbFlowForm

interface ChatProps {
  onConsoleModification?: (modification: ConsoleModificationPayload) => void;
  dbFlowFormRef?: React.RefObject<DbFlowFormRef | null>;
  onChartSpecChangeRef?: React.MutableRefObject<
    ((payload: import("./Editor").ChartSpecChangePayload) => void) | undefined
  >;
  resultsContextRef?: React.MutableRefObject<
    import("./Editor").ConsoleResultsContext | null
  >;
}

// Suggestion prompts for the demo Chinook database
const CHINOOK_SUGGESTIONS = [
  "Who are the top 10 best-selling artists?",
  "What are the most popular genres by revenue?",
  "Show me monthly revenue trends",
  "Who are our top 5 customers by spending?",
];

// Generic suggestions for any database
const GENERIC_SUGGESTIONS = [
  "What tables are in this database?",
  "Show me the schema structure",
  "Help me write a query to...",
];

// Suggestions for db-flow assistant
const DB_FLOW_SUGGESTIONS = [
  "Help me write a query to sync all users",
  "What template placeholders should I use?",
  "Suggest an incremental sync configuration",
  "Validate my query setup",
];

const Chat: React.FC<ChatProps> = ({
  onConsoleModification,
  dbFlowFormRef,
  onChartSpecChangeRef,
  resultsContextRef,
}) => {
  const { currentWorkspace } = useWorkspace();
  const selectedModelId = useSettingsStore(s => s.selectedModelId);
  const tabs = useConsoleStore(state => state.tabs);
  const activeTabId = useConsoleStore(state => state.activeTabId);
  const consoleTabs = useMemo(() => Object.values(tabs), [tabs]);
  const activeConsoleId = activeTabId;

  const activeTab = tabs[activeTabId || ""];
  const activeView =
    activeTab?.kind === "dashboard" ||
    activeTab?.kind === "flow-editor" ||
    activeTab?.kind === "console"
      ? activeTab.kind
      : "empty";

  // Ref for dbFlowFormRef to avoid stale closure in onToolCall
  const dbFlowFormRefCurrent = useRef(dbFlowFormRef);
  dbFlowFormRefCurrent.current = dbFlowFormRef;

  // Get connections to check if only database is the demo
  const connections = useSchemaStore(s => s.connections);
  const workspaceConnections = currentWorkspace
    ? connections[currentWorkspace.id] || []
    : [];

  // Show Chinook suggestions if the only database in workspace is the demo database
  const hasOnlyDemoDatabase =
    workspaceConnections.length === 1 &&
    workspaceConnections[0]?.isDemo === true;

  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  // chatId is a MongoDB ObjectId generated locally - frontend owns the ID (AI SDK best practice)
  const [chatId, setChatId] = useState<string>(() => generateObjectId());
  const [historyMenuAnchor, setHistoryMenuAnchor] =
    useState<null | HTMLElement>(null);
  const historyMenuOpen = Boolean(historyMenuAnchor);
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
          const store = useConsoleStore.getState();
          const tabs = Object.values(store.tabs) as ConsoleTab[];
          const activeTab = tabs.find(t => t.id === store.activeTabId);

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

          const openTabs = tabs.map(tab => ({
            id: tab.id,
            kind: tab.kind || "console",
            title: tab.title,
            isActive: tab.id === store.activeTabId,
            dashboardId:
              tab.kind === "dashboard"
                ? (tab.metadata?.dashboardId as string | undefined)
                : undefined,
            flowId:
              tab.kind === "flow-editor"
                ? (tab.metadata?.flowId as string | undefined)
                : undefined,
            connectionId:
              tab.kind === "console" || !tab.kind
                ? tab.connectionId
                : undefined,
            databaseName:
              tab.kind === "console" || !tab.kind
                ? tab.databaseName
                : undefined,
          }));

          const flowFormState = dbFlowFormRefCurrent.current?.current
            ? dbFlowFormRefCurrent.current.current.getFormState()
            : undefined;

          // Read results context from Editor at request time
          const resultsCtx = resultsContextRef?.current ?? null;
          const activeConsoleResults = resultsCtx
            ? {
                viewMode: resultsCtx.viewMode,
                hasResults: resultsCtx.hasResults,
                rowCount: resultsCtx.rowCount,
                columns: resultsCtx.columns,
                sampleRows: resultsCtx.sampleRows,
                chartSpec: resultsCtx.chartSpec,
              }
            : undefined;

          const requestBody = {
            messages,
            workspaceId: workspaceIdRef.current,
            modelId: modelIdRef.current,
            chatId: chatIdRef.current,
            openConsoles,
            openTabs,
            consoleId: activeConsoleIdRef.current,
            activeConsoleResults,
            // Unified agent selection
            agentId: "unified",
            activeView,
            tabKind: activeTab?.kind,
            flowType: activeTab?.metadata?.flowType,
            flowFormState,
            // Dashboard context — pass full snapshot, only strip DB metadata and
            // truncate large arrays. Enriches data sources with connection info.
            ...(() => {
              try {
                const snapshot = getDashboardStateSnapshot();
                if (!snapshot) return {};
                const connectionById = new Map(
                  workspaceConnections.map(connection => [
                    connection.id,
                    connection,
                  ]),
                );
                const SAMPLE_LIMIT = 3;
                return {
                  activeDashboardContext: {
                    dashboardId: snapshot._id,
                    title: snapshot.title,
                    description: snapshot.description,
                    crossFilter: snapshot.crossFilter,
                    layout: snapshot.layout,
                    materializationSchedule: snapshot.materializationSchedule,
                    dataSources: snapshot.dataSources.map((ds: any) => {
                      const { _id: _dsId, sampleRows, ...rest } = ds;
                      return {
                        ...rest,
                        sampleRows: sampleRows?.slice(0, SAMPLE_LIMIT),
                        connectionType:
                          connectionById.get(ds.query?.connectionId)?.type ||
                          undefined,
                        sqlDialect:
                          (
                            connectionById.get(ds.query?.connectionId) as
                              | { sqlDialect?: string }
                              | undefined
                          )?.sqlDialect ||
                          (ds.query?.language === "sql" ? "duckdb" : undefined),
                      };
                    }),
                    widgets: snapshot.widgets.map(
                      ({ _id: _wId, ...w }: any) => w,
                    ),
                  },
                };
              } catch {
                return {};
              }
            })(),
          };

          return {
            body: toJsonSafe(requestBody) as Record<string, unknown>,
          };
        },
      }),
    [activeView, resultsContextRef, workspaceConnections], // Request body uses live refs plus current screen context
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
    stop,
    setMessages,
    addToolOutput,
  } = useChat({
    id: chatId, // Reset hook state when chatId changes (fixes stale messages bug)
    transport,

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

      try {
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
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);
          const targetConsole = currentTabs.find(
            (c: any) => c.id === consoleId,
          );

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
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);

          const targetConsole = currentTabs.find(
            (c: any) => c.id === consoleId,
          );
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

          // Check if the console is read-only (shared/workspace without write access)
          if ((targetConsole as any).readOnly) {
            addToolOutput({
              tool: "modify_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "This console is shared as read-only. Use create_console to create a copy with the desired changes instead.",
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
          currentStore.updateContent(consoleId, newContent);

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
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);
          const currentActiveId = currentStore.activeTabId;

          const title = input.title as string;
          const content = input.content as string;
          const connectionId =
            (input.connectionId as string | null) ?? undefined;
          const databaseId = (input.databaseId as string | null) ?? undefined;
          const databaseName =
            (input.databaseName as string | null) ?? undefined;

          // Use captured console ID (from message submission time) as the primary fallback
          // This prevents the race condition where user switches consoles while agent is thinking
          const capturedId = capturedConsoleIdRef.current;

          // If connection info not provided, inherit from captured/active console
          const baseConsole =
            currentTabs.find((c: any) => c.id === capturedId) ||
            currentTabs.find((c: any) => c.id === currentActiveId) ||
            currentTabs[0];

          const effectiveConnectionId =
            connectionId ?? baseConsole?.connectionId;
          const effectiveDatabaseId = databaseId ?? baseConsole?.databaseId;
          const effectiveDatabaseName =
            databaseName ?? baseConsole?.databaseName;

          // Generate a new ID for the console
          const newConsoleId = generateObjectId();

          // Dispatch through the event system - App.tsx handleConsoleModification will:
          // 1. Call openTab with the provided consoleId
          // 2. Call setActiveTab
          if (onConsoleModificationRef.current) {
            onConsoleModificationRef.current({
              action: "create",
              content,
              consoleId: newConsoleId,
              title,
              connectionId: effectiveConnectionId,
              databaseId: effectiveDatabaseId,
              databaseName: effectiveDatabaseName,
              isDirty: true, // Mark as dirty so it won't be replaced by pristine tab logic
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
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);
          const currentActiveId = currentStore.activeTabId;

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
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);

          const targetConsole = currentTabs.find(
            (c: any) => c.id === consoleId,
          );
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
          currentStore.updateConnection(consoleId, connectionId);
          if (databaseId !== undefined || databaseName !== undefined) {
            currentStore.updateDatabase(consoleId, databaseId, databaseName);
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

        // Handle open_console - fetch and open a saved console
        if (toolName === "open_console") {
          const consoleId = input.consoleId as string | undefined;
          if (!consoleId) {
            addToolOutput({
              tool: "open_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: "consoleId is required.",
              },
            });
            return;
          }

          try {
            const currentStore = useConsoleStore.getState();
            const existingTab = currentStore.tabs[consoleId];
            if (existingTab) {
              currentStore.setActiveTab(consoleId);
              addToolOutput({
                tool: "open_console",
                toolCallId: toolCall.toolCallId,
                output: {
                  success: true,
                  consoleId,
                  title: existingTab.title,
                  message: `Console "${existingTab.title}" is already open — switched to it.`,
                },
              });
              return;
            }

            const data = await currentStore.fetchConsoleContent(
              workspaceIdRef.current!,
              consoleId,
            );
            if (!data) {
              addToolOutput({
                tool: "open_console",
                toolCallId: toolCall.toolCallId,
                output: {
                  success: false,
                  error: `Console ${consoleId} not found or access denied.`,
                },
              });
              return;
            }

            const title = data.name || data.path || "Untitled";
            currentStore.openTab({
              id: consoleId,
              title,
              content: data.content || "",
              connectionId: data.connectionId,
              databaseId: data.databaseId,
              databaseName: data.databaseName,
            });
            currentStore.setActiveTab(consoleId);

            addToolOutput({
              tool: "open_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: true,
                consoleId,
                title,
                message: `Console "${title}" opened successfully.`,
              },
            });
          } catch (err) {
            addToolOutput({
              tool: "open_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: `Failed to open console: ${err instanceof Error ? err.message : String(err)}`,
              },
            });
          }
          return;
        }

        // Handle modify_chart_spec - set chart visualization for current results
        if (toolName === "modify_chart_spec") {
          const vegaLiteSpec = input.vegaLiteSpec as
            | Record<string, unknown>
            | undefined;
          if (!vegaLiteSpec) {
            addToolOutput({
              tool: "modify_chart_spec",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: "vegaLiteSpec is required.",
              },
            });
            return;
          }

          // Validate the spec structure with Zod before sending to the renderer
          const { MakoChartSpec: MakoChartSpecSchema } = await import(
            "../lib/chart-spec"
          );
          const parsed = MakoChartSpecSchema.safeParse(vegaLiteSpec);
          if (!parsed.success) {
            const issues = parsed.error.issues
              .slice(0, 5)
              .map((i: any) => `${i.path.join(".")}: ${i.message}`)
              .join("; ");
            addToolOutput({
              tool: "modify_chart_spec",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: `Invalid Vega-Lite spec: ${issues}. Fix the spec and try again.`,
              },
            });
            return;
          }

          if (!onChartSpecChangeRef?.current) {
            addToolOutput({
              tool: "modify_chart_spec",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: "No active console tab to display the chart in.",
              },
            });
            return;
          }

          // Send the spec to the renderer and wait for render result
          const renderResult = await new Promise<{
            success: boolean;
            error?: string;
          }>(resolve => {
            const timeout = setTimeout(() => resolve({ success: true }), 5000);
            onChartSpecChangeRef.current!({
              spec: parsed.data,
              onRenderResult: result => {
                clearTimeout(timeout);
                resolve(result);
              },
            });
          });

          if (renderResult.success) {
            addToolOutput({
              tool: "modify_chart_spec",
              toolCallId: toolCall.toolCallId,
              output: {
                success: true,
                message: "Chart rendered successfully in the results panel.",
              },
            });
          } else {
            addToolOutput({
              tool: "modify_chart_spec",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: `Chart failed to render: ${renderResult.error}. Fix the Vega-Lite spec and try again.`,
              },
            });
          }
          return;
        }

        // --- Dashboard tools (client-side) ---
        try {
          const dashboardToolOutput = await executeDashboardAgentTool(
            toolName,
            input,
          );

          if (dashboardToolOutput !== null) {
            addToolOutput({
              tool: toolName,
              toolCallId: toolCall.toolCallId,
              output: dashboardToolOutput,
            });
            return;
          }
        } catch (dashboardError) {
          addToolOutput({
            tool: toolName,
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error:
                dashboardError instanceof Error
                  ? dashboardError.message
                  : "Dashboard tool execution failed",
            },
          });
          return;
        }

        // Handle run_console - execute the query in a console tab
        if (toolName === "run_console") {
          const consoleId = input.consoleId as string | undefined;

          if (!consoleId) {
            addToolOutput({
              tool: "run_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "consoleId is required. Use list_open_consoles to get IDs of existing consoles.",
              },
            });
            return;
          }

          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);
          const targetConsole = currentTabs.find(
            (c: any) => c.id === consoleId,
          ) as ConsoleTab | undefined;

          if (!targetConsole) {
            addToolOutput({
              tool: "run_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: `Console with ID ${consoleId} not found. Use list_open_consoles to see available consoles.`,
              },
            });
            return;
          }

          const content = targetConsole.content;
          const connectionId = targetConsole.connectionId;
          const workspaceId = workspaceIdRef.current;

          if (!content?.trim()) {
            addToolOutput({
              tool: "run_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Console is empty. Write a query first using modify_console.",
              },
            });
            return;
          }

          if (!connectionId) {
            addToolOutput({
              tool: "run_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Console has no database connection. Use set_console_connection to attach one first.",
              },
            });
            return;
          }

          if (!workspaceId) {
            addToolOutput({
              tool: "run_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: "No workspace selected.",
              },
            });
            return;
          }

          const QUERY_TIMEOUT_MS = 120_000; // 2 minutes
          const abortController = new AbortController();
          const timeoutId = setTimeout(
            () => abortController.abort(),
            QUERY_TIMEOUT_MS,
          );

          window.dispatchEvent(
            new CustomEvent("console-execution-start", {
              detail: { consoleId },
            }),
          );

          try {
            const startTime = Date.now();
            const result = await currentStore.executeQuery(
              workspaceId,
              connectionId,
              content,
              {
                databaseName: targetConsole.databaseName,
                databaseId: targetConsole.databaseId,
                signal: abortController.signal,
              },
            );
            clearTimeout(timeoutId);
            const executionTime = Date.now() - startTime;

            if (result.success) {
              const data = result.rows || [];
              const rowCount = Array.isArray(data) ? data.length : 1;
              const preview = Array.isArray(data) ? data.slice(0, 50) : data;

              window.dispatchEvent(
                new CustomEvent("console-execution-result", {
                  detail: {
                    consoleId,
                    result: {
                      results: data,
                      executedAt: new Date().toISOString(),
                      resultCount: rowCount,
                      executionTime,
                      fields: result.fields,
                      pageInfo: result.pageInfo || null,
                    },
                  },
                }),
              );

              addToolOutput({
                tool: "run_console",
                toolCallId: toolCall.toolCallId,
                output: {
                  success: true,
                  rowCount,
                  preview,
                  message: `Query executed successfully. ${rowCount} row(s) returned.`,
                },
              });
            } else {
              window.dispatchEvent(
                new CustomEvent("console-execution-result", {
                  detail: { consoleId, result: null },
                }),
              );

              addToolOutput({
                tool: "run_console",
                toolCallId: toolCall.toolCallId,
                output: {
                  success: false,
                  error: result.error || "Query execution failed.",
                },
              });
            }
          } catch (e: any) {
            clearTimeout(timeoutId);

            window.dispatchEvent(
              new CustomEvent("console-execution-result", {
                detail: { consoleId, result: null },
              }),
            );

            const isTimeout =
              e?.name === "AbortError" && abortController.signal.aborted;
            addToolOutput({
              tool: "run_console",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error: isTimeout
                  ? `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s. The query may be too complex or the database is under heavy load.`
                  : e?.message || "Query execution failed unexpectedly.",
              },
            });
          }
          return;
        }

        // Handle flow agent client-side tools
        // get_form_state - Return current form configuration
        if (toolName === "get_form_state") {
          const formRef = dbFlowFormRefCurrent.current?.current;
          if (!formRef) {
            addToolOutput({
              tool: "get_form_state",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Form is not available. Make sure you're in the flow editor.",
              },
            });
            return;
          }

          const formState = formRef.getFormState();
          addToolOutput({
            tool: "get_form_state",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              formState,
            },
          });
          return;
        }

        // set_form_field - Update a single form field
        if (toolName === "set_form_field") {
          const formRef = dbFlowFormRefCurrent.current?.current;
          if (!formRef) {
            addToolOutput({
              tool: "set_form_field",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Form is not available. Make sure you're in the flow editor.",
              },
            });
            return;
          }

          const { fieldName, value } = input as {
            fieldName: string;
            value: unknown;
          };

          // The tool schema uses a structured z.union() instead of z.any(),
          // so the LLM returns proper typed values (arrays as arrays, not strings).
          // See: TYPE_COERCION_SCHEMA in db-flow-form.schema.ts
          formRef.setField(fieldName, value);
          addToolOutput({
            tool: "set_form_field",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              fieldName,
              value,
              message: `Updated ${fieldName} successfully`,
            },
          });
          return;
        }

        // set_multiple_fields - Update multiple fields at once
        if (toolName === "set_multiple_fields") {
          const formRef = dbFlowFormRefCurrent.current?.current;
          if (!formRef) {
            addToolOutput({
              tool: "set_multiple_fields",
              toolCallId: toolCall.toolCallId,
              output: {
                success: false,
                error:
                  "Form is not available. Make sure you're in the flow editor.",
              },
            });
            return;
          }

          const { fields } = input as { fields: Record<string, unknown> };
          formRef.setMultipleFields(fields);
          addToolOutput({
            tool: "set_multiple_fields",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              fields: Object.keys(fields),
              message: `Updated ${Object.keys(fields).length} field(s) successfully`,
            },
          });
          return;
        }

        // NOTE: set_column_mappings has been removed
        // Use set_form_field with fieldName="typeCoercions" instead

        // create_flow_tab - Create a new db-scheduled flow tab
        if (toolName === "create_flow_tab") {
          const currentStore = useConsoleStore.getState();
          const title = (input.title as string) || "New Database Sync";

          // Generate a new ID and create the flow tab
          const newTabId = generateObjectId();
          currentStore.openTab({
            id: newTabId,
            title,
            content: "",
            kind: "flow-editor",
            metadata: { isNew: true, flowType: "db-scheduled" },
          });
          currentStore.setActiveTab(newTabId);

          addToolOutput({
            tool: "create_flow_tab",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              tabId: newTabId,
              title,
              message: `Created new flow tab "${title}"`,
            },
          });
          return;
        }

        // list_flow_tabs - List all open flow editor tabs
        if (toolName === "list_flow_tabs") {
          const currentStore = useConsoleStore.getState();
          const currentTabs = Object.values(currentStore.tabs);
          const currentActiveId = currentStore.activeTabId;

          const flowTabs = currentTabs
            .filter((tab: any) => tab?.kind === "flow-editor")
            .map((tab: any) => ({
              id: tab.id,
              title: tab.title || "Untitled Flow",
              flowType: tab.metadata?.flowType || "unknown",
              flowId: tab.metadata?.flowId,
              isNew: tab.metadata?.isNew || false,
              isActive: tab.id === currentActiveId,
            }));

          addToolOutput({
            tool: "list_flow_tabs",
            toolCallId: toolCall.toolCallId,
            output: {
              success: true,
              flowTabs,
              message: `Found ${flowTabs.length} open flow tab(s)`,
            },
          });
          return;
        }

        // Unknown tool - not a client-side tool, let it be handled server-side
      } catch (toolError) {
        // Safety net: if any client-side tool throws an uncaught error,
        // return the error to the LLM so the conversation doesn't hang.
        addToolOutput({
          tool: toolName,
          toolCallId: toolCall.toolCallId,
          output: {
            success: false,
            error:
              toolError instanceof Error
                ? toolError.message
                : "Client-side tool execution failed unexpectedly",
          },
        });
      }
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
            const store = useConsoleStore.getState();
            const existingTabs = Object.values(store.tabs);

            for (const console of data.consoles) {
              // Check if console already exists in tabs (by ID)
              const exists = existingTabs.some((t: any) => t.id === console.id);
              if (!exists) {
                // Add the console tab
                store.openTab({
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
              store.setActiveTab(firstConsole.id);
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
  const handleToolClick = useCallback((tool: ToolInvocationInfo) => {
    setSelectedTool(tool);
    setToolDialogOpen(true);
  }, []);

  const handleCloseToolDialog = () => {
    setToolDialogOpen(false);
    setSelectedTool(null);
  };

  // Stable submit handler — uses refs to avoid stale closures and minimize deps
  const handleChatSubmit = useCallback(
    (text: string) => {
      capturedConsoleIdRef.current = activeConsoleIdRef.current;
      const store = useConsoleStore.getState();
      const currentTabs = Object.values(store.tabs);
      const activeConsole = currentTabs.find(t => t.id === store.activeTabId);
      trackEvent("ai_chat_message_sent", {
        model: modelIdRef.current,
        has_context: !!activeConsole?.content,
      });
      sendMessage({ text });
    },
    [sendMessage],
  );

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
            <Tooltip
              title={copiedChat ? "Copied!" : "Copy chat history as JSON"}
            >
              <span>
                <IconButton
                  size="small"
                  onClick={handleCopyChatHistory}
                  disabled={messages.length === 0}
                >
                  {copiedChat ? <Check size={20} /> : <Copy size={20} />}
                </IconButton>
              </span>
            </Tooltip>
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

      {/* Suggestions when chat is empty */}
      {messages.length === 0 && (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            p: 2,
            gap: 2,
          }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: "center", mb: 1 }}
          >
            {activeView === "flow-editor"
              ? "I can help you configure your flow"
              : hasOnlyDemoDatabase
                ? "Try asking about the Chinook music store data"
                : "Ask a question about your data"}
          </Typography>
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 1,
              justifyContent: "center",
              maxWidth: 400,
            }}
          >
            {(activeView === "flow-editor"
              ? DB_FLOW_SUGGESTIONS
              : hasOnlyDemoDatabase
                ? CHINOOK_SUGGESTIONS
                : GENERIC_SUGGESTIONS
            ).map(suggestion => (
              <Chip
                key={suggestion}
                label={suggestion}
                variant="outlined"
                size="small"
                onClick={() => {
                  // Submit the suggestion immediately
                  capturedConsoleIdRef.current = activeConsoleId;
                  trackEvent("ai_chat_message_sent", {
                    model: selectedModelId,
                    has_context: false,
                    from_suggestion: true,
                  });
                  sendMessage({ text: suggestion });
                }}
                sx={{
                  cursor: "pointer",
                  "&:hover": {
                    backgroundColor: "action.hover",
                    borderColor: "primary.main",
                  },
                }}
              />
            ))}
          </Box>
        </Box>
      )}

      {/* Messages */}
      <Box sx={{ flex: messages.length > 0 ? 1 : 0, overflow: "auto", p: 1 }}>
        <List dense>
          {messages.map((message, msgIdx) => (
            <ChatMessageRow
              key={message.id}
              message={message}
              isLastMessage={msgIdx === messages.length - 1}
              isStreaming={status === "streaming"}
              onToolClick={handleToolClick}
            />
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

      {/* Input — isolated component so keystrokes don't re-render messages */}
      <ChatInputArea
        onSubmit={handleChatSubmit}
        onStop={stop}
        isLoading={isLoading}
        disabled={!currentWorkspace}
        focusKey={`${chatId}-${messages.length}`}
      />

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
                  : safeStringify(selectedTool.input, 2)
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
                  : safeStringify(selectedTool.output, 2)
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
