/**
 * Chat Component - Using Vercel AI SDK useChat hook
 * Native AI SDK streaming protocol for improved compatibility
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  Collapse,
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
  Circle,
  Copy,
  Check,
  History,
  ImagePlus,
  Menu as MenuIcon,
  Pencil,
  Plus,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";
import { useTheme as useMuiTheme, keyframes } from "@mui/material/styles";
import { useChat } from "@ai-sdk/react";
import { Virtuoso, type VirtuosoHandle, type Components } from "react-virtuoso";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type FileUIPart,
} from "ai";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { executeDashboardAgentTool } from "../dashboard-runtime/agent-tools";
import type { ConsoleTab } from "../store/lib/types";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useSettingsStore } from "../store/settingsStore";
import { useSchemaStore } from "../store/schemaStore";
import { selectActiveExplorer, useUIStore } from "../store/uiStore";
import { useRealtimeStore } from "../store/realtimeStore";
import { useAppStore } from "../store/appStore";
import { useDbtStore } from "../store/dbtStore";
import { useIsMobile } from "../hooks/useIsMobile";
import { ModelSelector } from "./ModelSelector";
import { generateObjectId } from "../utils/objectId";
import type { ConsoleModification } from "../hooks/useMonacoConsole";
import { trackEvent } from "../lib/analytics";
import { DbFlowFormRef } from "./DbFlowForm";
import { safeStringify, toJsonSafe } from "../lib/json-safe";
import { StreamingToolCard, type ToolPartState } from "./StreamingToolCard";
import { ClarifyingQuestionsCard } from "./ClarifyingQuestionsCard";
import { DbtRunCard } from "./DbtRunCard";
import { PlanCard } from "./PlanCard";
import {
  focusPlanTab,
  syncPlanTabTitle,
  usePlanStore,
  type PartialSubmitPlanInput,
} from "../store/planStore";
import type {
  AskClarifyingQuestionsInput,
  AskClarifyingQuestionsOutput,
  SubmitPlanInput,
  SubmitPlanOutput,
} from "@mako/agent-tools";
import {
  computeReasoningGroups,
  getStreamingReasoningGroupStart,
} from "./reasoning-groups";
import {
  chatMessageRowArePropsEqual,
  type ChatMessageRowProps,
} from "./chat-message-comparator";
import {
  buildChatRequestBody,
  type ActiveConsoleResultsContext,
} from "../agent-runtime/request-context";
import { executeConsoleAgentTool } from "../agent-runtime/console-agent-tools";
import { consumePendingScreenshotVisionAttachments } from "../agent-runtime/screenshot-agent-tools";
import { buildModificationDiff } from "../utils/consoleModification";
import {
  DASHBOARD_EXECUTOR_TOOL_NAMES,
  APP_EXECUTOR_TOOL_NAMES,
  DBT_EXECUTOR_TOOL_NAMES,
  DATA_SOURCE_EXECUTOR_TOOL_NAMES,
  getAgentToolManifestEntry,
  type AgentToolName,
} from "../agent-runtime/client-tool-manifest";
import { executeAppAgentTool } from "../app-runtime/agent-tools";
import { executeDbtAgentTool } from "../dbt-runtime/agent-tools";
import { executeDataSourceTool } from "../agent-runtime/data-source-tools";
import { UpgradePrompt } from "./UpgradePrompt";
import {
  onRenderDebug,
  useRenderCount,
  useWhyChanged,
} from "../utils/renderDebug";

interface ChatSessionMeta {
  _id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  /** Resume pointer set while a turn is generating server-side. */
  activeStreamId?: string | null;
}

// Human-in-the-loop tools resolve via an interactive card (the user answers /
// approves), not via an `execute` result. They legitimately stay pending at
// `input-available` with no output until the user acts, so any "settle the
// dangling tool" cleanup must skip them — otherwise the card is torn down
// before it can be answered. Part types are `tool-<toolName>`.
const HUMAN_IN_THE_LOOP_TOOL_PART_TYPES = new Set([
  "tool-ask_clarifying_questions",
  "tool-submit_plan",
]);

function isHumanInTheLoopToolPartType(partType: string): boolean {
  return HUMAN_IN_THE_LOOP_TOOL_PART_TYPES.has(partType);
}

function toolNameFromPartType(partType: string): string {
  return partType.startsWith("tool-")
    ? partType.slice("tool-".length)
    : partType;
}

// Server-executed mutation tools (issue #475 pattern) whose open-tab sync we
// ALSO reconcile off the resumable chat stream — in addition to the workspace
// realtime poke (app.updated / dbt.file.updated) — so an open app / dbt tab
// converges even when the workspace SSE is dead (mobile lock / laptop sleep).
const APP_SERVER_MUTATION_TOOLS = new Set<string>([
  "app_write_file",
  "app_delete_file",
  "app_rename_file",
  "app_add_dependency",
  "app_remove_dependency",
  "app_create_data_binding",
  "app_delete_data_binding",
]);
const DBT_SERVER_MUTATION_TOOLS = new Set<string>([
  "create_dbt_file",
  "modify_dbt_file",
  "delete_dbt_file",
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
type StreamInterruptionPath = "orphan-rescue" | "stream-error" | "wake-resume";

function reportStreamInterruption(detail: {
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

// ── Per-tab chat session persistence ─────────────────────────────
// sessionStorage scopes the active chat to the browser tab: a refresh
// restores (and reattaches to) the same chat, while new tabs start blank.

const CHAT_SESSION_STORAGE_KEY = "mako:active-chat";

interface StoredChatSession {
  chatId: string;
  workspaceId: string;
}

function readStoredChatSession(): StoredChatSession | null {
  try {
    const raw = sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChatSession>;
    if (
      typeof parsed.chatId === "string" &&
      /^[0-9a-fA-F]{24}$/.test(parsed.chatId) &&
      typeof parsed.workspaceId === "string"
    ) {
      return { chatId: parsed.chatId, workspaceId: parsed.workspaceId };
    }
  } catch {
    /* sessionStorage unavailable or corrupted entry */
  }
  return null;
}

function writeStoredChatSession(session: StoredChatSession): void {
  try {
    sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
}

// CodeBlock component for syntax highlighting
const CodeBlock = React.memo(
  ({
    language,
    children,
    isGenerating,
    scrollable,
    paletteMode,
  }: {
    language: string;
    children: string;
    isGenerating: boolean;
    scrollable?: boolean;
    /** Included so memo re-renders when the app theme toggles */
    paletteMode: "light" | "dark";
  }) => {
    const effectiveMode = paletteMode;
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

type AutoSendPredicateArgs = Parameters<
  typeof lastAssistantMessageIsCompleteWithToolCalls
>[0];

function hasPendingAssistantToolCalls(
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

interface ActiveClientToolCall {
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

interface ConsoleToolPresentation {
  consoleId: string;
  title: string;
  iconUrl?: string;
  diff?: string;
}

function getConsoleToolPresentation(
  toolName: string,
  input: unknown,
  output: unknown,
  connectionIconById: ReadonlyMap<string, string>,
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

  const outputDiff = outputObj?.diff;
  const diff =
    typeof outputDiff === "string" && outputDiff.length > 0
      ? outputDiff
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

// ReasoningDisplay for showing reasoning/thinking parts inline.
// - Auto-opens while streaming, auto-collapses when done.
// - Shows elapsed thinking time ("Thought for Xs").
// - Scrollable container with max height, auto-scrolls during streaming.
const ReasoningDisplay = React.memo(
  ({
    reasoningText,
    isStreaming,
    paletteMode: _paletteMode,
  }: {
    reasoningText: string;
    isStreaming: boolean;
    paletteMode: "light" | "dark";
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

// Queue card slides up from behind the chat input as it reveals
const queueSlideUp = keyframes`
  from { opacity: 0; transform: translateY(100%); }
  to { opacity: 1; transform: translateY(0); }
`;

// Stable style objects to prevent re-renders
const streamingIndicatorContainerSx = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  overflow: "visible",
  lineHeight: 0,
  flexShrink: 0,
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
// (not memoized) so it picks up theme updates when the parent palette changes
function StreamingIndicator() {
  return (
    <Box component="span" sx={streamingIndicatorContainerSx}>
      <Box sx={streamingIndicatorDotSx} />
    </Box>
  );
}

// ── Memoized message row ─────────────────────────────────────────
// Prevents completed messages from re-rendering on every streaming chunk.

const userMessageSx = { flex: 1, mt: 2, minWidth: 0 } as const;
const userMessagePaperSx = {
  p: 1,
  borderRadius: 1,
  backgroundColor: "background.paper",
  overflow: "hidden",
} as const;
const userMessageTextSx = {
  maxWidth: "100%",
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

// Sent user messages are collapsed in the history so a long prompt doesn't
// dominate the transcript. Show at most this many lines before clamping.
const USER_MESSAGE_COLLAPSED_LINES = 3;

const userMessageToggleSx = {
  display: "inline-block",
  mt: 0.5,
  border: "none",
  background: "none",
  p: 0,
  cursor: "pointer",
  color: "text.secondary",
  fontWeight: 600,
  "&:hover": { color: "text.primary", textDecoration: "underline" },
} as const;

/**
 * Renders a sent user message's text, collapsed to a few lines with an ellipsis
 * when it's long. Clicking the text (or the Show more/less toggle) expands and
 * re-collapses it. The toggle only appears when the text actually overflows the
 * collapsed clamp, so short messages render unchanged.
 */
function CollapsibleUserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement | null>(null);

  // Measure whether the clamped text overflows. Only meaningful while
  // collapsed, where the clamp limits height; comparing the full content
  // height (scrollHeight) against the visible height (clientHeight) tells us
  // if there's hidden content worth a toggle.
  useLayoutEffect(() => {
    if (expanded) return;
    const el = textRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  const canToggle = isOverflowing || expanded;
  const toggle = useCallback(() => setExpanded(prev => !prev), []);

  return (
    <Box>
      <Typography
        ref={textRef}
        variant="body2"
        color="text.primary"
        onClick={canToggle ? toggle : undefined}
        sx={{
          ...userMessageTextSx,
          ...(canToggle && { cursor: "pointer" }),
          ...(!expanded && {
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: USER_MESSAGE_COLLAPSED_LINES,
            overflow: "hidden",
          }),
        }}
      >
        {text}
      </Typography>
      {canToggle && (
        <Typography
          component="button"
          type="button"
          onClick={toggle}
          variant="caption"
          sx={userMessageToggleSx}
        >
          {expanded ? "Show less" : "Show more"}
        </Typography>
      )}
    </Box>
  );
}

/**
 * Lightweight, dependency-free image lightbox. Shows the full (uncropped) image
 * centered over a dimmed backdrop; closes on backdrop click, the X button, or
 * Escape (handled by MUI Dialog).
 */
function ImagePreviewDialog({
  src,
  onClose,
}: {
  src: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={Boolean(src)}
      onClose={onClose}
      maxWidth="lg"
      slotProps={{
        paper: {
          sx: {
            backgroundColor: "transparent",
            boxShadow: "none",
            m: 2,
            overflow: "visible",
          },
        },
      }}
    >
      <Box sx={{ position: "relative", display: "flex" }}>
        <IconButton
          onClick={onClose}
          aria-label="Close preview"
          size="small"
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            color: "common.white",
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            "&:hover": { backgroundColor: "rgba(0, 0, 0, 0.8)" },
          }}
        >
          <X size={18} />
        </IconButton>
        {src && (
          <Box
            component="img"
            src={src}
            alt="Image preview"
            sx={{
              maxWidth: "90vw",
              maxHeight: "85vh",
              borderRadius: 1,
              objectFit: "contain",
              display: "block",
            }}
          />
        )}
      </Box>
    </Dialog>
  );
}

const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  isLastMessage,
  isStreaming,
  onToolClick,
  onConsoleTitleClick,
  connectionIconById,
  paletteMode,
}: ChatMessageRowProps) {
  const parts = (message.parts || []) as Array<Record<string, unknown>>;
  useRenderCount(`ChatMessageRow:${message.id}`, {
    role: message.role,
    partCount: parts.length,
  });
  useWhyChanged(`ChatMessageRow:${message.id}`, {
    messageRef: message,
    partsRef: message.parts,
    partCount: parts.length,
    isLastMessage,
    isStreaming,
    onToolClick,
    onConsoleTitleClick,
    connectionIconById,
    paletteMode,
  });

  // Lightbox state for clicking an attached image to preview it full-size.
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (message.role === "user") {
    const fileParts = (message.parts || []).filter(
      (p): p is { type: "file"; url: string; mediaType: string } =>
        p.type === "file" && "url" in p,
    );
    const textContent =
      (message.parts || [])
        .filter(
          (p): p is { type: "text"; text: string } =>
            p.type === "text" && "text" in p,
        )
        .map(p => p.text)
        .join("") || "";

    return (
      <ListItem alignItems="flex-start" sx={listItemSx}>
        <Box sx={userMessageSx}>
          <Paper variant="outlined" sx={userMessagePaperSx}>
            {fileParts.length > 0 && (
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 1,
                  mb: textContent ? 1 : 0,
                }}
              >
                {fileParts.map((fp, i) => (
                  <Box
                    key={i}
                    component="img"
                    src={fp.url}
                    alt="Attached image"
                    loading="lazy"
                    decoding="async"
                    onClick={() => setPreviewSrc(fp.url)}
                    sx={{
                      width: 56,
                      height: 56,
                      borderRadius: 1.5,
                      objectFit: "cover",
                      cursor: "pointer",
                      border: 1,
                      borderColor: "divider",
                      display: "block",
                    }}
                  />
                ))}
              </Box>
            )}
            {textContent && <CollapsibleUserText text={textContent} />}
          </Paper>
        </Box>
        <ImagePreviewDialog
          src={previewSrc}
          onClose={() => setPreviewSrc(null)}
        />
      </ListItem>
    );
  }

  const isStreamingNow = isStreaming;

  const reasoningGroups = computeReasoningGroups(parts);

  const lastPartIndex = parts.length - 1;
  const lastPart = parts.at(-1);
  const isLastPartText =
    isLastMessage && isStreamingNow && lastPart?.type === "text";

  // The single reasoning group (if any) that should stay expanded because it
  // owns the streaming last part. `null` when not streaming or the last part
  // isn't reasoning, so previously-collapsed blocks are never re-opened.
  const streamingReasoningGroupStart =
    isLastMessage && isStreamingNow
      ? getStreamingReasoningGroupStart(parts, reasoningGroups)
      : null;

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
            const rawState = part.state as string;
            const cardState: ToolPartState =
              rawState === "output-error"
                ? "error"
                : (part.state as ToolPartState);
            const cardOutput =
              rawState === "output-error"
                ? {
                    success: false,
                    error:
                      (part.errorText as string | undefined) ?? "Tool failed",
                  }
                : part.output;
            const toolCallId = (part.toolCallId as string) || "";
            const consoleToolPresentation = getConsoleToolPresentation(
              toolName,
              part.input,
              cardOutput,
              connectionIconById,
            );
            // Key by toolCallId when available so reordering/insertion in the
            // parts array doesn't remount completed tool cards. Falls back to
            // a type+index tag for the (rare) case where toolCallId is missing.
            const key = toolCallId
              ? `tool-${toolCallId}`
              : `tool-idx-${partIndex}`;

            // Interactive plan-lifecycle tools: while pending they render in
            // the docked panel above the composer (Cursor-style), NOT in the
            // chat. Once resolved, a read-only summary appears inline here.
            // Errors fall through to the generic tool card.
            if (
              toolName === "ask_clarifying_questions" ||
              toolName === "submit_plan"
            ) {
              if (rawState === "output-available") {
                if (toolName === "ask_clarifying_questions") {
                  return (
                    <ClarifyingQuestionsCard
                      key={key}
                      input={part.input as AskClarifyingQuestionsInput}
                      output={part.output as AskClarifyingQuestionsOutput}
                    />
                  );
                }
                return (
                  <PlanCard
                    key={key}
                    toolCallId={toolCallId}
                    input={part.input as SubmitPlanInput}
                    output={part.output as SubmitPlanOutput}
                  />
                );
              }
              if (rawState !== "output-error") {
                return null;
              }
            }

            // Async dbt builds: once dbt_run_model has dispatched a run (output
            // carries a runId), render a live run card that self-polls the run
            // — decoupled from the agent turn, so it keeps updating after the
            // turn ends and resumes on chat reload. While the dispatch is still
            // in flight, or if it errored without a runId, fall through to the
            // generic card.
            if (
              toolName === "dbt_run_model" &&
              rawState === "output-available"
            ) {
              const dbtOutput = cardOutput as { runId?: string } | undefined;
              const dbtInput = part.input as
                | { projectId?: string; model?: string }
                | undefined;
              if (dbtOutput?.runId && dbtInput?.projectId) {
                return (
                  <DbtRunCard
                    key={key}
                    runId={dbtOutput.runId}
                    projectId={dbtInput.projectId}
                    label={dbtInput.model}
                  />
                );
              }
            }
            return (
              <StreamingToolCard
                key={key}
                toolCallId={toolCallId}
                toolName={toolName}
                state={cardState}
                input={part.input}
                output={cardOutput}
                labelOverride={consoleToolPresentation?.title}
                leadingIconUrl={consoleToolPresentation?.iconUrl}
                leadingIconAlt={
                  consoleToolPresentation ? "Database" : undefined
                }
                bodyPreview={
                  consoleToolPresentation?.diff
                    ? {
                        content: consoleToolPresentation.diff,
                        language: "diff",
                      }
                    : undefined
                }
                onTitleClick={
                  consoleToolPresentation
                    ? () =>
                        onConsoleTitleClick(consoleToolPresentation.consoleId)
                    : undefined
                }
                onDetailClick={() =>
                  onToolClick({
                    toolCallId,
                    toolName: toolName || "",
                    state: part.state as ToolInvocationInfo["state"],
                    input: part.input,
                    output: cardOutput,
                  })
                }
              />
            );
          }

          if (partType === "reasoning") {
            const group = reasoningGroups.get(partIndex);
            if (!group) return null;
            const isGroupStreaming = partIndex === streamingReasoningGroupStart;
            // Skip empty reasoning groups unless they're the block currently
            // streaming (a brand-new thinking block whose text hasn't arrived
            // yet). This avoids rendering blank "Thinking process" blocks for
            // empty reasoning parts loaded from history.
            if (!group.text && !isGroupStreaming) return null;
            return (
              <ReasoningDisplay
                key={`reasoning-${partIndex}`}
                reasoningText={group.text}
                isStreaming={isGroupStreaming}
                paletteMode={paletteMode}
              />
            );
          }

          if (partType === "text" && (part as { text?: string }).text) {
            // Only the trailing text block of the actively streaming
            // message is still growing — flag it so Streamdown knows to
            // treat its last markdown block as incomplete. All earlier
            // text blocks are static and can skip animation entirely.
            const isTrailingStreamingText =
              isLastPartText && partIndex === lastPartIndex;
            return (
              <StreamingMarkdown
                key={`text-${partIndex}`}
                isStreaming={isTrailingStreamingText}
              >
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
}, chatMessageRowArePropsEqual);

ChatMessageRow.displayName = "ChatMessageRow";

// List element Virtuoso renders the (windowed) message rows into. Rendered as
// a MUI `<List dense component="div">` so the `dense` ListContext still reaches
// each `ChatMessageRow`'s `<ListItem>` (context flows through Virtuoso's div
// Item wrappers regardless of DOM nesting) while avoiding `<ul>` DOM-nesting
// warnings. Virtuoso owns the inline `style` (it sets paddingTop/Bottom to
// offset windowed items) so we must forward it onto the list element.
const MessageVirtuosoList = React.memo(
  React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function MessageVirtuosoList({ style, children }, ref) {
      return (
        <List dense component="div" ref={ref} style={style} sx={{ px: 1 }}>
          {children}
        </List>
      );
    },
  ),
);
MessageVirtuosoList.displayName = "MessageVirtuosoList";

// Virtuoso's `Components['List']` types `ref` as a `LegacyRef` (string refs
// allowed), which is contravariant with forwardRef's `Ref`. The component is
// structurally correct; this cast bridges that one incompatibility.
const messageVirtuosoComponents: Components<ChatMessageRowProps["message"]> = {
  List: MessageVirtuosoList as Components<
    ChatMessageRowProps["message"]
  >["List"],
};

// Isolated input component — owns its own `input` state so keystrokes
// never re-render the (expensive) message list above it.

interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

interface QueuedPrompt {
  id: string;
  text: string;
  files?: FileUIPart[];
  consoleId: string | null;
  dashboardId: string | null;
}

interface QueuedPromptListProps {
  prompts: QueuedPrompt[];
  editingId: string | null;
  onStartEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}

interface QueuedPromptRowProps {
  prompt: QueuedPrompt;
  isEditing: boolean;
  onStartEdit: (id: string) => void;
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}

const QUEUED_ROW_ACTION_BTN_SX = {
  width: 22,
  height: 22,
  flexShrink: 0,
  color: "text.secondary",
  "&:hover": { color: "text.primary" },
} as const;

// One queued prompt. Editing happens in the main composer (Cursor-style), so
// the row itself only renders the prompt + hover actions.
const QueuedPromptRow = React.memo(
  ({
    prompt,
    isEditing,
    onStartEdit,
    onSendNow,
    onRemove,
  }: QueuedPromptRowProps) => {
    const imageCount = prompt.files?.length ?? 0;
    const display = prompt.text || (imageCount > 0 ? "Image attachment" : "");

    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          py: 0.5,
          borderRadius: 1,
          minHeight: 32,
          backgroundColor: isEditing ? "action.selected" : "transparent",
          "&:hover": {
            backgroundColor: isEditing ? "action.selected" : "action.hover",
          },
          "&:hover .queued-prompt-actions": { opacity: 1 },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            color: "text.secondary",
            flexShrink: 0,
          }}
        >
          <Circle size={10} />
        </Box>

        <Typography
          variant="body2"
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 13,
            color: "text.primary",
          }}
        >
          {display}
        </Typography>

        {imageCount > 0 && (
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", flexShrink: 0 }}
          >
            {imageCount} {imageCount === 1 ? "image" : "images"}
          </Typography>
        )}

        <Box
          className="queued-prompt-actions"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.25,
            flexShrink: 0,
            opacity: 0,
            transition: "opacity 120ms ease",
          }}
        >
          <IconButton
            type="button"
            aria-label="Edit queued prompt"
            onClick={() => onStartEdit(prompt.id)}
            size="small"
            sx={QUEUED_ROW_ACTION_BTN_SX}
          >
            <Pencil size={14} />
          </IconButton>
          <Tooltip title="Send now (interrupts the running chat)">
            <IconButton
              type="button"
              aria-label="Send now (interrupts the running chat)"
              onClick={() => onSendNow(prompt.id)}
              size="small"
              sx={QUEUED_ROW_ACTION_BTN_SX}
            >
              <ArrowUp size={14} />
            </IconButton>
          </Tooltip>
          <IconButton
            type="button"
            aria-label="Remove queued prompt"
            onClick={() => onRemove(prompt.id)}
            size="small"
            sx={QUEUED_ROW_ACTION_BTN_SX}
          >
            <Trash2 size={14} />
          </IconButton>
        </Box>
      </Box>
    );
  },
);
QueuedPromptRow.displayName = "QueuedPromptRow";

const QueuedPromptList = React.memo(
  ({
    prompts,
    editingId,
    onStartEdit,
    onSendNow,
    onRemove,
  }: QueuedPromptListProps) => {
    const [expanded, setExpanded] = useState(true);

    if (prompts.length === 0) return null;

    return (
      <Box
        sx={{
          mx: 2.25,
          mb: 0,
          border: 1,
          borderBottom: 0,
          borderColor: "divider",
          borderRadius: 2.5,
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          p: 0.5,
          transformOrigin: "bottom",
          animation: `${queueSlideUp} 220ms cubic-bezier(0.4, 0, 0.2, 1)`,
        }}
      >
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={() => setExpanded(prev => !prev)}
          onKeyDown={e => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded(prev => !prev);
            }
          }}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            px: 1,
            py: 0.5,
            cursor: "pointer",
            color: "text.secondary",
            borderRadius: 1,
            "&:hover": { color: "text.primary" },
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, letterSpacing: 0.2 }}
          >
            {prompts.length} Queued
          </Typography>
        </Box>

        {expanded && (
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {prompts.map(prompt => (
              <QueuedPromptRow
                key={prompt.id}
                prompt={prompt}
                isEditing={prompt.id === editingId}
                onStartEdit={onStartEdit}
                onSendNow={onSendNow}
                onRemove={onRemove}
              />
            ))}
          </Box>
        )}
      </Box>
    );
  },
);
QueuedPromptList.displayName = "QueuedPromptList";

interface ChatInputAreaProps {
  onSubmit: (text: string, files?: FileUIPart[]) => void;
  onStop: () => void;
  isLoading: boolean;
  disabled: boolean;
  focusKey: string | number;
  paletteMode: "light" | "dark";
  editingPrompt: QueuedPrompt | null;
  onCancelEdit: () => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ChatInputArea = React.memo(
  ({
    onSubmit,
    onStop,
    isLoading,
    disabled,
    focusKey,
    paletteMode: _paletteMode,
    editingPrompt,
    onCancelEdit,
  }: ChatInputAreaProps) => {
    const [input, setInput] = useState("");
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const [isPreparingSubmission, setIsPreparingSubmission] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef<ImageAttachment[]>([]);
    // When entering edit mode, load the queued prompt's text into the composer
    // and stash whatever the user was drafting so Cancel/commit can restore it.
    const inputValueRef = useRef(input);
    inputValueRef.current = input;
    const preEditDraftRef = useRef("");
    const prevEditingIdRef = useRef<string | null>(null);
    useRenderCount("ChatInputArea", {
      isLoading,
      disabled,
      imageCount: images.length,
    });
    useWhyChanged("ChatInputArea", {
      onSubmit,
      onStop,
      isLoading,
      disabled,
      focusKey,
      imageCount: images.length,
    });
    imagesRef.current = images;

    useEffect(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }, [focusKey]);

    useEffect(() => {
      const prevId = prevEditingIdRef.current;
      const currId = editingPrompt?.id ?? null;
      if (currId === prevId) return;
      if (currId) {
        if (!prevId) preEditDraftRef.current = inputValueRef.current;
        setInput(editingPrompt?.text ?? "");
        setTimeout(() => inputRef.current?.focus(), 0);
      } else {
        setInput(preEditDraftRef.current);
        preEditDraftRef.current = "";
      }
      prevEditingIdRef.current = currId;
    }, [editingPrompt]);

    useEffect(() => {
      return () => {
        imagesRef.current.forEach(img => URL.revokeObjectURL(img.previewUrl));
      };
    }, []);

    const addImages = useCallback((files: File[]) => {
      const imageFiles = files.filter(f => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return;
      setImages(prev => [
        ...prev,
        ...imageFiles.map(file => ({
          id: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ]);
    }, []);

    const removeImage = useCallback((id: string) => {
      setImages(prev => {
        const img = prev.find(i => i.id === id);
        if (img) URL.revokeObjectURL(img.previewUrl);
        return prev.filter(i => i.id !== id);
      });
    }, []);

    const handlePaste = useCallback(
      (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const item of items) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length > 0) {
          e.preventDefault();
          addImages(files);
        }
      },
      [addImages],
    );

    const submitMessage = useCallback(async () => {
      const trimmedInput = input.trim();
      const currentImages = images;
      const hasText = trimmedInput.length > 0;
      const hasImages = currentImages.length > 0;
      if ((!hasText && !hasImages) || isPreparingSubmission) {
        return;
      }

      setIsPreparingSubmission(true);
      let fileParts: FileUIPart[] | undefined;
      try {
        if (hasImages) {
          fileParts = await Promise.all(
            currentImages.map(async img => ({
              type: "file" as const,
              url: await readFileAsDataUrl(img.file),
              mediaType: img.file.type,
            })),
          );
          currentImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
        }

        onSubmit(input, fileParts);
        setInput("");
        setImages([]);
      } finally {
        setIsPreparingSubmission(false);
      }
    }, [images, input, isPreparingSubmission, onSubmit]);

    const hasContent = input.trim() || images.length > 0;
    const isSubmitDisabled = !hasContent || disabled || isPreparingSubmission;

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
        {editingPrompt && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              px: 0.5,
              pb: 0.5,
              mb: 0.5,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Typography
              variant="caption"
              sx={{ fontWeight: 600, color: "text.secondary" }}
            >
              Editing queued message
            </Typography>
            <Typography
              component="button"
              type="button"
              onClick={onCancelEdit}
              variant="caption"
              sx={{
                border: "none",
                background: "none",
                cursor: "pointer",
                color: "primary.main",
                fontWeight: 600,
                p: 0,
                "&:hover": { textDecoration: "underline" },
              }}
            >
              Cancel
            </Typography>
          </Box>
        )}

        <form
          onSubmit={e => {
            e.preventDefault();
            submitMessage();
          }}
          onPaste={handlePaste}
        >
          {images.length > 0 && (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                gap: 1,
                px: 0.5,
                pt: 0.5,
              }}
            >
              {images.map(img => (
                <Box
                  key={img.id}
                  sx={{
                    position: "relative",
                    width: 56,
                    height: 56,
                    borderRadius: 1.5,
                    overflow: "hidden",
                    flexShrink: 0,
                    "&:hover .remove-btn": {
                      opacity: 1,
                    },
                  }}
                >
                  <Box
                    component="img"
                    src={img.previewUrl}
                    alt="Attachment"
                    onClick={() => setPreviewSrc(img.previewUrl)}
                    sx={{
                      width: 56,
                      height: 56,
                      borderRadius: 1.5,
                      objectFit: "cover",
                      cursor: "pointer",
                      border: 1,
                      borderColor: "divider",
                      display: "block",
                    }}
                  />
                  <IconButton
                    type="button"
                    className="remove-btn"
                    aria-label="Remove image"
                    onClick={e => {
                      e.stopPropagation();
                      removeImage(img.id);
                    }}
                    size="small"
                    disabled={isPreparingSubmission}
                    sx={{
                      position: "absolute",
                      top: 4,
                      right: 4,
                      width: 18,
                      height: 18,
                      p: 0,
                      opacity: 0,
                      transition: "opacity 0.15s",
                      color: "common.white",
                      backgroundColor: "rgba(0, 0, 0, 0.6)",
                      "&:hover": {
                        backgroundColor: "rgba(0, 0, 0, 0.8)",
                      },
                    }}
                  >
                    <X size={11} />
                  </IconButton>
                </Box>
              ))}
            </Box>
          )}

          <ImagePreviewDialog
            src={previewSrc}
            onClose={() => setPreviewSrc(null)}
          />

          <TextField
            fullWidth
            autoFocus
            multiline
            minRows={1}
            maxRows={24}
            placeholder={
              editingPrompt ? "Edit queued message..." : "Ask Chat..."
            }
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitMessage();
              }
              if (e.key === "Escape" && editingPrompt) {
                e.preventDefault();
                onCancelEdit();
              }
              if (e.key === "Backspace" && !input && images.length > 0) {
                e.preventDefault();
                const last = images[images.length - 1];
                if (last) removeImage(last.id);
              }
            }}
            variant="outlined"
            inputRef={inputRef}
            sx={{
              m: 0.5,
              maxHeight: "60vh",
              overflowY: "auto",
              "& .MuiInputBase-input": {
                fontSize: { xs: 16, sm: 14 },
              },
              "& .MuiInputBase-root": {
                p: 0,
                fontSize: { xs: 16, sm: 14 },
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

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={e => {
              if (e.target.files) {
                addImages(Array.from(e.target.files));
                e.target.value = "";
              }
            }}
          />

          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              minWidth: 0,
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                flex: "1 1 auto",
                minWidth: 0,
              }}
            >
              <ModelSelector />
            </Box>

            <Tooltip title="Attach image" placement="top">
              <IconButton
                type="button"
                onClick={() => fileInputRef.current?.click()}
                size="small"
                disabled={isPreparingSubmission || disabled || isLoading}
                sx={{
                  width: 28,
                  height: 28,
                  flexShrink: 0,
                  color: "text.secondary",
                  "&:hover": { color: "text.primary" },
                }}
              >
                <ImagePlus size={16} />
              </IconButton>
            </Tooltip>

            {isLoading ? (
              <IconButton
                type="button"
                aria-label="Stop generating"
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
                  flexShrink: 0,
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
                aria-label="Send message"
                disabled={isSubmitDisabled}
                size="small"
                sx={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  backgroundColor: !isSubmitDisabled
                    ? "primary.main"
                    : "action.disabledBackground",
                  color: !isSubmitDisabled
                    ? "primary.contrastText"
                    : "text.disabled",
                  "&:hover": {
                    backgroundColor: !isSubmitDisabled
                      ? "primary.dark"
                      : "action.disabledBackground",
                  },
                  "&.Mui-disabled": {
                    backgroundColor: "action.disabledBackground",
                    color: "text.disabled",
                  },
                  flexShrink: 0,
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

  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
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
  const [historyMenuAnchor, setHistoryMenuAnchor] =
    useState<null | HTMLElement>(null);
  const historyMenuOpen = Boolean(historyMenuAnchor);
  // Virtualized message list (react-virtuoso). Replaces use-stick-to-bottom:
  // Virtuoso owns its own scroller and bottom-anchoring (`followOutput`), and
  // only mounts visible rows + overscan so long chats stay light on
  // DOM/memory/paint — critical on mobile. `isAtBottom` drives both the
  // "scroll to bottom" button and whether streaming auto-follows the tail.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

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
  const activeClientToolCallsRef = useRef(
    new Map<string, ActiveClientToolCall>(),
  );
  const cancelledClientToolCallIdsRef = useRef(new Set<string>());
  // Spaces + bounds onError → resume retries. A failed resume re-fires onError,
  // so retrying instantly would burst; instead we schedule one delayed attempt
  // (giving a brief network blip time to recover) and cap attempts per window
  // before falling back to poisoning the tool cards.
  const errorResumeRef = useRef<{
    count: number;
    windowStart: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ count: 0, windowStart: 0, timer: null });
  const [activeClientToolCallCount, setActiveClientToolCallCount] = useState(0);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef(queuedPrompts);
  const isLoadingRef = useRef(false);
  queuedPromptsRef.current = queuedPrompts;
  // Id of the queued prompt currently being edited in the composer (Cursor-style).
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const editingPromptIdRef = useRef<string | null>(null);
  editingPromptIdRef.current = editingPromptId;
  // Id of a prompt the user force-sent (top arrow). Once the interrupted turn
  // settles, the drain sends it immediately, bypassing the normal busy guards.
  const pendingForcePromptIdRef = useRef<string | null>(null);
  const editingPrompt = useMemo(
    () => queuedPrompts.find(prompt => prompt.id === editingPromptId) ?? null,
    [queuedPrompts, editingPromptId],
  );
  workspaceIdRef.current = currentWorkspace?.id;
  modelIdRef.current = selectedModelId;
  chatIdRef.current = chatId;

  const cancelActiveClientToolCalls = useCallback((reason: string): void => {
    for (const activeToolCall of activeClientToolCallsRef.current.values()) {
      cancelledClientToolCallIdsRef.current.add(activeToolCall.toolCallId);
      activeToolCall.abortController.abort(reason);
      activeToolCall.settled = true;
      void Promise.resolve(activeToolCall.cancel()).catch(() => undefined);
    }

    activeClientToolCallsRef.current.clear();
    setActiveClientToolCallCount(0);
  }, []);

  const autoSendWhenComplete = useCallback((options: AutoSendPredicateArgs) => {
    if (manualStopRequestedRef.current) {
      return false;
    }
    return lastAssistantMessageIsCompleteWithToolCalls(options);
  }, []);

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
    sendAutomaticallyWhen: autoSendWhenComplete,

    // Handle client-side tools (console operations)
    async onToolCall({ toolCall }) {
      // Skip dynamic tools (not our console tools)
      if ((toolCall as { dynamic?: boolean }).dynamic) {
        return;
      }

      const toolName = toolCall.toolName;
      const input = toolCall.input as Record<string, unknown>;

      // Deferred plan-lifecycle tools: do NOT settle here. The interactive
      // card rendered in the message list resolves them via addToolOutput once
      // the user answers / approves. Returning without output keeps the tool
      // call pending (human-in-the-loop) until then.
      if (
        toolName === "ask_clarifying_questions" ||
        toolName === "submit_plan"
      ) {
        return;
      }

      try {
        if (
          await executeConsoleAgentTool({
            toolCall: {
              toolName,
              toolCallId: toolCall.toolCallId,
            },
            input,
            workspaceId: workspaceIdRef.current,
            onChartSpecChange: onChartSpecChangeRef?.current,
            addToolOutput,
            registerActiveClientToolCall,
            settleActiveClientToolCall,
          })
        ) {
          return;
        }

        // --- Dashboard tools (client-side) ---
        if (DASHBOARD_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeDashboardTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );

          // Fire-and-forget for ALL dashboard client work, never await it here.
          // The AI SDK awaits onToolCall while reading the SSE stream, and only
          // sends the follow-up request with the tool output once the stream
          // reaches its finish chunk. Awaiting any client work inside
          // onToolCall blocks the reader from processing that finish chunk, so
          // the continuation hangs until the HTTP/proxy stream times out — even
          // for tools that resolve in milliseconds (e.g. remove_widget,
          // get_dashboard_state). Settling asynchronously lets the finish chunk
          // be read immediately and the stream close cleanly.
          void (async () => {
            try {
              const dashboardToolOutput = await executeDashboardAgentTool(
                toolName,
                input,
                {
                  executionId: activeDashboardTool.executionId,
                  signal: activeDashboardTool.abortController.signal,
                },
              );

              if (activeDashboardTool.abortController.signal.aborted) {
                return;
              }

              settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                dashboardToolOutput ?? {
                  success: false,
                  error: `Dashboard tool "${toolName}" did not return a result.`,
                },
              );
            } catch (dashboardError) {
              if (
                manualStopRequestedRef.current ||
                activeDashboardTool.abortController.signal.aborted
              ) {
                return;
              }
              settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  dashboardError instanceof Error
                    ? dashboardError.message
                    : "Dashboard tool execution failed",
              });
            }
          })();
          return;
        }

        // --- React App tools (client-side) ---
        if (APP_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeAppTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );

          // Fire-and-forget, same rationale as dashboard tools above: never
          // await client work inside onToolCall or the SSE finish chunk stalls.
          void (async () => {
            try {
              const appToolOutput = await executeAppAgentTool(toolName, input, {
                executionId: activeAppTool.executionId,
                signal: activeAppTool.abortController.signal,
              });

              if (activeAppTool.abortController.signal.aborted) return;

              settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                appToolOutput ?? {
                  success: false,
                  error: `App tool "${toolName}" did not return a result.`,
                },
              );
            } catch (appError) {
              if (
                manualStopRequestedRef.current ||
                activeAppTool.abortController.signal.aborted
              ) {
                return;
              }
              settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  appError instanceof Error
                    ? appError.message
                    : "App tool execution failed",
              });
            }
          })();
          return;
        }

        // --- dbt tools (client-side) ---
        if (DBT_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeDbtTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );
          // Fire-and-forget, same rationale as app tools above.
          void (async () => {
            try {
              const dbtToolOutput = await executeDbtAgentTool(toolName, input);
              if (activeDbtTool.abortController.signal.aborted) return;
              settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                dbtToolOutput ?? {
                  success: false,
                  error: `dbt tool "${toolName}" did not return a result.`,
                },
              );
            } catch (dbtError) {
              if (
                manualStopRequestedRef.current ||
                activeDbtTool.abortController.signal.aborted
              ) {
                return;
              }
              settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  dbtError instanceof Error
                    ? dbtError.message
                    : "dbt tool execution failed",
              });
            }
          })();
          return;
        }

        // --- Shared data source tools (apps + dashboards) ---
        if (DATA_SOURCE_EXECUTOR_TOOL_NAMES.has(toolName as AgentToolName)) {
          const activeDataTool = registerActiveClientToolCall(
            toolName,
            toolCall.toolCallId,
          );
          void (async () => {
            try {
              const output = await executeDataSourceTool(toolName, input);
              if (activeDataTool.abortController.signal.aborted) return;
              settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                output ?? {
                  success: false,
                  error: `Data source tool "${toolName}" did not return a result.`,
                },
              );
            } catch (dataError) {
              if (
                manualStopRequestedRef.current ||
                activeDataTool.abortController.signal.aborted
              ) {
                return;
              }
              settleActiveClientToolCall(toolName, toolCall.toolCallId, {
                success: false,
                error:
                  dataError instanceof Error
                    ? dataError.message
                    : "Data source tool execution failed",
              });
            }
          })();
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

        const manifestEntry = getAgentToolManifestEntry(toolName);
        if (manifestEntry?.execution === "client") {
          addToolOutput({
            tool: toolName,
            toolCallId: toolCall.toolCallId,
            output: {
              success: false,
              error: `Client-side tool "${toolName}" is registered but has no browser handler.`,
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      const lastMessage = messagesRef.current.at(-1);
      const stalledToolNames =
        lastMessage?.role === "assistant"
          ? (lastMessage.parts ?? [])
              .filter(p => {
                const pt = p.type as string;
                if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") {
                  return false;
                }
                if (isHumanInTheLoopToolPartType(pt)) return false;
                const s = (p as Record<string, unknown>).state as string;
                return s !== "output-available" && s !== "error";
              })
              .map(p => toolNameFromPartType(p.type as string))
          : [];

      // Structured server errors (billing / model availability) arrive as JSON
      // with a `code` — those are genuine and must NOT be resumed.
      let isStructuredServerError = false;
      try {
        const parsed = JSON.parse(errorMessage);
        isStructuredServerError = !!parsed && typeof parsed.code === "string";
      } catch {
        /* not JSON → network / stream drop */
      }

      // The turn's lifetime is decoupled from the HTTP connection: the server
      // keeps generating and buffers a resumable stream after a client
      // disconnect. A mobile lock / computer sleep freezes the tab and the OS
      // kills the SSE socket; on wake the dead read surfaces here as a
      // non-structured network/stream error (the user-reported "network error"
      // / "Stream disconnected"). When the turn still looks live, reattach
      // instead of poisoning the cards — the replay re-emits the tool outputs,
      // and any in-flight client tool (e.g. a slow capture_screenshot) is left
      // running so it can settle on its own.
      const turnLooksLive =
        statusRef.current === "streaming" ||
        statusRef.current === "submitted" ||
        useRealtimeStore.getState().chatActivity[chatIdRef.current] ===
          "streaming" ||
        document.visibilityState !== "visible" ||
        stalledToolNames.length > 0;

      const RESUME_RETRY_DELAY_MS = 1500;
      const RESUME_RETRY_WINDOW_MS = 30_000;
      const RESUME_MAX_RETRIES = 4;
      const now = Date.now();
      const resumeState = errorResumeRef.current;
      if (now - resumeState.windowStart > RESUME_RETRY_WINDOW_MS) {
        resumeState.windowStart = now;
        resumeState.count = 0;
      }
      // Keep taking the resume branch while a retry is still scheduled, so we
      // never poison the cards out from under a pending reattach.
      const canRetryResume =
        resumeState.count < RESUME_MAX_RETRIES || resumeState.timer !== null;

      if (
        !isStructuredServerError &&
        turnLooksLive &&
        canRetryResume &&
        !manualStopRequestedRef.current
      ) {
        reportStreamInterruption({
          path: "stream-error",
          chatId,
          status,
          toolNames: stalledToolNames,
          errorMessage,
          resumed: true,
        });
        // Clear the SDK error so the hook can stream again, then reattach to
        // the buffered turn after a short delay. The delay coalesces the burst
        // of onError calls a failing reconnect produces and gives a brief
        // network blip time to recover. A finished turn answers 204 (cheap
        // no-op) and the orphan-rescue effect handles any stranded card.
        clearError();
        if (!resumeState.timer) {
          resumeState.count += 1;
          resumeState.timer = setTimeout(() => {
            resumeState.timer = null;
            void resumeStreamRef.current?.();
          }, RESUME_RETRY_DELAY_MS);
        }
        return;
      }

      // Genuine / fatal error (or too many resume retries): fall back to the
      // original behavior — cancel in-flight client tools and poison pending
      // tool parts so the AI SDK unblocks the next sendMessage.
      cancelActiveClientToolCalls("stream-error");
      reportStreamInterruption({
        path: "stream-error",
        chatId,
        status,
        toolNames: stalledToolNames,
        errorMessage,
        resumed: false,
      });
      // When the stream disconnects (e.g. 524 timeout), tool calls may be
      // stuck in "input-available" state. The AI SDK blocks sendMessage until
      // all tool calls are settled. Patch them to "error" so the chat remains
      // usable.
      setMessages(prev =>
        prev.map(msg => {
          if (msg.role !== "assistant") return msg;
          const hasPending = msg.parts?.some(p => {
            const pt = p.type as string;
            if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
            if (isHumanInTheLoopToolPartType(pt)) return false;
            const s = (p as Record<string, unknown>).state as string;
            return s !== "output-available" && s !== "error";
          });
          if (!hasPending) return msg;
          return {
            ...msg,
            parts: msg.parts.map(p => {
              const pt = p.type as string;
              if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return p;
              if (isHumanInTheLoopToolPartType(pt)) return p;
              const s = (p as Record<string, unknown>).state as string;
              if (s === "output-available" || s === "error") return p;
              return {
                ...p,
                state: "error" as const,
                output: { success: false, error: "Stream disconnected" },
              };
            }) as any,
          };
        }),
      );
    },
    onFinish: () => {
      // The turn settled cleanly — reset the resume-retry budget.
      errorResumeRef.current.count = 0;
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

  // Latest status for use inside stable event-listener / callback closures
  // (the wake handler and onError) without re-installing listeners every turn.
  const statusRef = useRef(status);
  statusRef.current = status;

  const createCancellationOutput = useCallback(
    (toolName: string): Record<string, unknown> => ({
      success: false,
      error:
        toolName === "run_console"
          ? "Query cancelled because the chat stopped."
          : "Tool cancelled because the chat stopped.",
    }),
    [],
  );

  const registerActiveClientToolCall = useCallback(
    (
      toolName: string,
      toolCallId: string,
      options?: {
        executionId?: string;
        cancel?: () => void | Promise<void>;
        cancellationOutput?: Record<string, unknown>;
      },
    ) => {
      const abortController = new AbortController();
      const executionId =
        options?.executionId ?? `chat-tool-${generateObjectId()}`;

      cancelledClientToolCallIdsRef.current.delete(toolCallId);
      activeClientToolCallsRef.current.set(toolCallId, {
        toolCallId,
        toolName,
        executionId,
        abortController,
        cancel: options?.cancel ?? (() => {}),
        cancellationOutput:
          options?.cancellationOutput ?? createCancellationOutput(toolName),
        settled: false,
      });
      setActiveClientToolCallCount(activeClientToolCallsRef.current.size);

      return { abortController, executionId };
    },
    [createCancellationOutput],
  );

  const settleActiveClientToolCall = useCallback(
    async (
      toolName: string,
      toolCallId: string,
      output: Record<string, unknown>,
    ): Promise<void> => {
      if (cancelledClientToolCallIdsRef.current.delete(toolCallId)) {
        return;
      }

      const activeToolCall = activeClientToolCallsRef.current.get(toolCallId);
      if (!activeToolCall) {
        if (!manualStopRequestedRef.current) {
          await addToolOutput({ tool: toolName, toolCallId, output });
        }
        return;
      }

      try {
        if (!activeToolCall.settled) {
          activeToolCall.settled = true;
          await addToolOutput({
            tool: activeToolCall.toolName,
            toolCallId,
            output,
          });
        }
      } finally {
        activeClientToolCallsRef.current.delete(toolCallId);
        setActiveClientToolCallCount(activeClientToolCallsRef.current.size);
      }
    },
    [addToolOutput],
  );

  // Self-heal a client tool call that the live stream delivered but never got
  // to dispatch (the SSE dropped, the SDK reconnected to a 204, and `status`
  // settled to "ready" with the tool frozen at "input-available"). Because a
  // completed run would be "output-available", a tool stuck at "input-available"
  // provably never executed — so we can safely re-dispatch it through the exact
  // same executor `onToolCall` would have used. Its result settles via
  // `addToolOutput`, and `sendAutomaticallyWhen` resumes the turn, recovering
  // transparently instead of poisoning the card with "Interrupted".
  //
  // Returns true if it took ownership of the call (recovering), false if the
  // tool is not a client-executable family we can safely re-run (those still
  // get the terminal error patch).
  const recoveredToolCallIdsRef = useRef<Set<string>>(new Set());
  const recoverOrphanedClientToolCall = useCallback(
    (
      toolName: string,
      toolCallId: string,
      input: Record<string, unknown>,
    ): boolean => {
      const name = toolName as AgentToolName;
      let run:
        | ((ctx: {
            executionId: string;
            signal: AbortSignal;
          }) => Promise<Record<string, unknown> | null | undefined>)
        | null = null;
      if (APP_EXECUTOR_TOOL_NAMES.has(name)) {
        run = ({ executionId, signal }) =>
          executeAppAgentTool(toolName, input, { executionId, signal });
      } else if (DASHBOARD_EXECUTOR_TOOL_NAMES.has(name)) {
        run = ({ executionId, signal }) =>
          executeDashboardAgentTool(toolName, input, { executionId, signal });
      } else if (DBT_EXECUTOR_TOOL_NAMES.has(name)) {
        run = () => executeDbtAgentTool(toolName, input);
      } else if (DATA_SOURCE_EXECUTOR_TOOL_NAMES.has(name)) {
        run = () => executeDataSourceTool(toolName, input);
      }
      if (!run) return false;

      // Already recovering this exact call (effect re-ran before it settled):
      // keep ownership so it isn't poisoned, but don't dispatch twice.
      if (recoveredToolCallIdsRef.current.has(toolCallId)) return true;
      recoveredToolCallIdsRef.current.add(toolCallId);

      const active = registerActiveClientToolCall(toolName, toolCallId);
      void (async () => {
        try {
          const output = await run({
            executionId: active.executionId,
            signal: active.abortController.signal,
          });
          if (active.abortController.signal.aborted) return;
          await settleActiveClientToolCall(
            toolName,
            toolCallId,
            output ?? {
              success: false,
              error: `Recovered tool "${toolName}" did not return a result.`,
            },
          );
        } catch (recoverError) {
          if (
            manualStopRequestedRef.current ||
            active.abortController.signal.aborted
          ) {
            return;
          }
          await settleActiveClientToolCall(toolName, toolCallId, {
            success: false,
            error:
              recoverError instanceof Error
                ? recoverError.message
                : "Recovered tool execution failed",
          });
        } finally {
          recoveredToolCallIdsRef.current.delete(toolCallId);
        }
      })();
      return true;
    },
    [registerActiveClientToolCall, settleActiveClientToolCall],
  );

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

    for (const activeToolCall of activeClientToolCallsRef.current.values()) {
      cancelledClientToolCallIdsRef.current.add(activeToolCall.toolCallId);
      activeToolCall.abortController.abort("chat-stop");
      void Promise.resolve(activeToolCall.cancel()).catch(() => undefined);

      if (!activeToolCall.settled) {
        activeToolCall.settled = true;
        addToolOutput({
          tool: activeToolCall.toolName,
          toolCallId: activeToolCall.toolCallId,
          output: activeToolCall.cancellationOutput,
        });
      }
    }

    activeClientToolCallsRef.current.clear();
    setActiveClientToolCallCount(0);
    // With resumable streams, disconnecting no longer cancels the turn — the
    // server keeps generating for reconnecting clients. Stop must be explicit:
    // this aborts the server-side generation and clears the resume pointer.
    if (chatIdRef.current) {
      void fetch(`/api/agent/chat/${chatIdRef.current}/stop`, {
        method: "POST",
      }).catch(() => undefined);
    }
    stop();
    settleDanglingAssistantToolCalls();
  }, [addToolOutput, stop, settleDanglingAssistantToolCalls]);

  const handleStop = useCallback(() => {
    interruptActiveTurn();
    setQueuedPrompts([]);
  }, [interruptActiveTurn]);

  const isLoading =
    status === "streaming" ||
    status === "submitted" ||
    activeClientToolCallCount > 0;
  isLoadingRef.current = isLoading;

  // Rescue tool cards orphaned by a clean stream end.
  //
  // A tool card's "Running…" status is derived purely from the AI SDK tool
  // part `state` — it only resolves once a terminal `output-available` /
  // `output-error` chunk arrives. `onError` patches stuck parts when the
  // stream *throws* (e.g. a 524), and the history-load path rewrites them when
  // a chat is reopened. But with resumable streams a long server-side tool can
  // outlive the edge proxy's idle timeout: the SSE connection is closed, the
  // SDK silently reconnects, the reconnect returns 204 ("nothing streaming"),
  // and `status` settles back to "ready" without any error ever surfacing. The
  // live in-memory message then keeps a tool part frozen at "input-available"
  // → a permanent "Running…" card that also blocks the composer (the SDK won't
  // accept a new message until every tool call is settled).
  //
  // Once the turn has settled (`status === "ready"`) and no client-side tool is
  // still executing, any non-terminal tool part on the last assistant message
  // is orphaned. Patch it to an error so the card resolves and input unblocks.
  // Mirrors the `onError` rescue; uses `setMessages` (not `addToolOutput`) so
  // it does not feed back into `sendAutomaticallyWhen` and kick off a new turn.
  useEffect(() => {
    if (status !== "ready" || activeClientToolCallCount > 0) return;
    if (activeClientToolCallsRef.current.size > 0) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    // Human-in-the-loop tools (clarifying questions / plan review) are *meant*
    // to sit at "input-available" with no output until the user answers via
    // their docked card — that is not an orphan. Patching them here would tear
    // the card down before it can be answered (it surfaces as "Interrupted —
    // stream disconnected"). Leave them pending.
    const pendingToolParts = (last.parts ?? []).filter(p => {
      const pt = p.type as string;
      if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
      if (isHumanInTheLoopToolPartType(pt)) return false;
      const s = (p as Record<string, unknown>).state as string;
      return s !== "output-available" && s !== "output-error" && s !== "error";
    });
    if (pendingToolParts.length === 0) return;

    // Try to self-heal first: re-dispatch any client-executable tool stuck at
    // "input-available". The IDs we recover keep their card alive (the
    // re-dispatch registers an active client tool call) and must NOT be
    // poisoned below.
    const recoveredCallIds = new Set<string>();
    const recoveredToolNames: string[] = [];
    const orphanedToolNames: string[] = [];
    for (const part of pendingToolParts) {
      const record = part as Record<string, unknown>;
      const pt = part.type as string;
      const toolName =
        pt === "dynamic-tool"
          ? ((record.toolName as string) ?? "")
          : toolNameFromPartType(pt);
      const toolCallId = record.toolCallId as string | undefined;
      const input = (record.input ?? {}) as Record<string, unknown>;
      if (
        record.state === "input-available" &&
        toolCallId &&
        recoverOrphanedClientToolCall(toolName, toolCallId, input)
      ) {
        recoveredCallIds.add(toolCallId);
        recoveredToolNames.push(toolName);
      } else {
        orphanedToolNames.push(toolName);
      }
    }

    reportStreamInterruption({
      path: "orphan-rescue",
      chatId,
      status,
      toolNames: orphanedToolNames,
      recoveredToolNames,
    });

    // Nothing left to poison — everything is being recovered.
    if (orphanedToolNames.length === 0) return;
    setMessages(prev => {
      const lastIndex = prev.length - 1;
      const lastMsg = prev[lastIndex];
      if (!lastMsg || lastMsg.role !== "assistant") return prev;
      return prev.map((msg, i) => {
        if (i !== lastIndex) return msg;
        return {
          ...msg,
          parts: msg.parts.map(p => {
            const record = p as Record<string, unknown>;
            const pt = p.type as string;
            if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return p;
            if (isHumanInTheLoopToolPartType(pt)) return p;
            // Leave parts we just handed to recovery untouched.
            if (recoveredCallIds.has(record.toolCallId as string)) return p;
            const s = record.state as string;
            if (
              s === "output-available" ||
              s === "output-error" ||
              s === "error"
            ) {
              return p;
            }
            return {
              ...p,
              state: "error" as const,
              output: {
                success: false,
                error:
                  "Interrupted — stream disconnected before tool completed",
              },
            };
          }) as any,
        };
      });
    });
  }, [
    status,
    activeClientToolCallCount,
    messages,
    chatId,
    recoverOrphanedClientToolCall,
    setMessages,
  ]);

  // Reattach the chat stream when the tab wakes. A mobile lock / computer sleep
  // freezes the page and the OS silently kills the SSE socket; on wake the AI
  // SDK does not re-reconnect on its own, so an in-flight turn would otherwise
  // surface as a "stream error" (or strand a tool card). The server keeps
  // generating and buffers the turn as a resumable stream, so resumeStream()
  // replays the buffered + live chunks; a finished turn answers 204 (cheap
  // no-op). Mirrors realtimeStore.wake() (visibilitychange + focus + pageshow +
  // resume), throttled so a single wake burst fires the work once. Listeners
  // are installed once (stable closure over refs) and never re-installed.
  useEffect(() => {
    const WAKE_THROTTLE_MS = 2000;
    let lastWakeAt = 0;
    // Stable across the component's life (useRef object identity never changes);
    // captured for the cleanup to read the latest pending resume timer.
    const resumeState = errorResumeRef.current;

    const hasResumableTurn = (): boolean => {
      if (manualStopRequestedRef.current) return false;
      const s = statusRef.current;
      if (s === "streaming" || s === "submitted") return true;
      if (
        useRealtimeStore.getState().chatActivity[chatIdRef.current] ===
        "streaming"
      ) {
        return true;
      }
      // A tool card frozen mid-turn (non-terminal, non-HITL) means the turn was
      // interrupted while we were away — worth a reattach.
      const last = messagesRef.current.at(-1);
      if (!last || last.role !== "assistant") return false;
      return (last.parts ?? []).some(p => {
        const pt = p.type as string;
        if (!pt?.startsWith("tool-") && pt !== "dynamic-tool") return false;
        if (isHumanInTheLoopToolPartType(pt)) return false;
        const st = (p as Record<string, unknown>).state as string;
        return (
          st !== "output-available" && st !== "output-error" && st !== "error"
        );
      });
    };

    const wake = () => {
      const now = Date.now();
      // A window switch fires a burst (focus + visibilitychange); the first one
      // does the work.
      if (now - lastWakeAt < WAKE_THROTTLE_MS) return;
      lastWakeAt = now;
      if (!hasResumableTurn()) return;
      reportStreamInterruption({
        path: "wake-resume",
        chatId: chatIdRef.current,
        status: statusRef.current,
        toolNames: [],
        resumed: true,
      });
      void resumeStreamRef.current?.();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    // Page Lifecycle API: fired when the browser unfreezes a frozen tab.
    document.addEventListener("resume", wake);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("resume", wake);
      if (resumeState.timer) {
        clearTimeout(resumeState.timer);
        resumeState.timer = null;
      }
    };
  }, []);

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

  // Session management - fetch available chat sessions for history menu
  useEffect(() => {
    fetchSessionsRef.current?.();
  }, [currentWorkspace]);

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

  // In-band console sync: when a server-side console tool result streams in
  // (state "output-available"), reconcile THIS window against the server
  // draft. The chat stream is resumable, so unlike the workspace realtime
  // poke channel this survives SSE drops, half-closes, frozen background
  // tabs, reconnects and page refreshes — the replayed part triggers the
  // same idempotent reconciliation.
  //
  //   - create_console / open_console -> open the tab here.
  //   - modify_console / set_console_connection -> pull the authoritative
  //     draft for open tabs (revision sync). Without this, an agent EDIT
  //     reached the editor ONLY via the realtime poke; a missed poke (dead
  //     SSE, or a poke that raced the tab open) left the editor stale until
  //     the next focus/reconnect/watchdog/refresh — the reported "modify did
  //     nothing until I refreshed" bug. create_console never had this problem
  //     because it already rode the chat stream (asymmetry, issue #475).
  //
  // Tool call ids seen in RESTORED history are pre-seeded into this set by
  // loadSession (reopening a chat must not re-open/re-sync every console it
  // ever touched — the dedicated consoles-restore payload handles that).
  const handledConsoleOpenToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handledConsoleOpenToolCallIdsRef.current = new Set();
  }, [chatId]);
  useEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!workspaceId) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts ?? []) {
      const p = part as {
        type?: string;
        toolName?: string;
        state?: string;
        toolCallId?: string;
        output?: { success?: boolean; consoleId?: string };
      };
      const toolName =
        p.type === "dynamic-tool"
          ? p.toolName
          : p.type?.startsWith("tool-")
            ? p.type.slice("tool-".length)
            : undefined;
      const opensTab =
        toolName === "create_console" || toolName === "open_console";
      // Server console writes whose only client delivery is the realtime poke.
      // run_console bumps the draft revision AND persists a run artifact
      // (tab.lastRun); the revision sync refreshes both, and Editor.tsx
      // reactively renders lastRun into the results panel — so reconciling
      // here surfaces agent run RESULTS even when the run.completed poke was
      // missed (dead/half-closed SSE), matching modify/set-connection.
      const editsConsole =
        toolName === "modify_console" ||
        toolName === "set_console_connection" ||
        toolName === "run_console";
      if (!opensTab && !editsConsole) continue;
      if (p.state !== "output-available") continue;
      if (!p.toolCallId || !p.output?.success) continue;
      // Opening needs a consoleId; an edit reconciles all open tabs so it
      // does not. Don't burn the dedupe slot on an opener that lacks an id.
      if (opensTab && !p.output?.consoleId) continue;
      if (handledConsoleOpenToolCallIdsRef.current.has(p.toolCallId)) continue;
      handledConsoleOpenToolCallIdsRef.current.add(p.toolCallId);
      if (opensTab) {
        const consoleId = p.output.consoleId as string;
        void (async () => {
          await useConsoleStore
            .getState()
            .openConsoleFromServer(workspaceId, consoleId);
          // A create followed immediately by a modify can drop the modify's
          // workspace poke while the tab is still opening; reconcile once the
          // tab carries a revision base so it never sticks on create-time
          // content.
          void useRealtimeStore.getState().syncRevisions();
        })();
      } else {
        void useRealtimeStore.getState().syncRevisions();
      }
    }
  }, [messages, currentWorkspace?.id]);

  // In-band app/dbt sync — the app/dbt analogue of the console reconcile above.
  // The app_* and dbt file mutation tools execute SERVER-SIDE, so an OPEN app /
  // dbt tab learns about the agent's write via the workspace realtime poke
  // (app.updated / dbt.file.updated). That poke rides the workspace SSE, which
  // a mobile lock / laptop sleep / proxy half-close can kill — so reconcile
  // off the RESUMABLE CHAT STREAM too: when the tool result streams in (or is
  // replayed after a wake reattach), refetch the open app / dbt file. This
  // makes the open tab converge even under a dead workspace SSE (poke = fast
  // path, this = robust backstop). Mirrors the console pattern (issue #475).
  const handledEntitySyncToolCallIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    handledEntitySyncToolCallIdsRef.current = new Set();
  }, [chatId]);
  useEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!workspaceId) return;
    const last = messages.at(-1);
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts ?? []) {
      const p = part as {
        type?: string;
        toolName?: string;
        state?: string;
        toolCallId?: string;
        input?: { appId?: string; projectId?: string; path?: string };
        output?: { success?: boolean };
      };
      const toolName =
        p.type === "dynamic-tool"
          ? p.toolName
          : p.type?.startsWith("tool-")
            ? p.type.slice("tool-".length)
            : undefined;
      if (!toolName) continue;
      const isAppEdit = APP_SERVER_MUTATION_TOOLS.has(toolName);
      const isDbtEdit = DBT_SERVER_MUTATION_TOOLS.has(toolName);
      if (!isAppEdit && !isDbtEdit) continue;
      if (
        p.state !== "output-available" ||
        !p.toolCallId ||
        !p.output?.success
      ) {
        continue;
      }
      if (handledEntitySyncToolCallIdsRef.current.has(p.toolCallId)) continue;
      handledEntitySyncToolCallIdsRef.current.add(p.toolCallId);

      if (isAppEdit) {
        const appId = p.input?.appId;
        // Only reconcile a tab that is actually open here (mirrors the
        // realtime handler); fetchApp + bumpPreview rebuilds the preview.
        if (appId && useAppStore.getState().openApps[appId]) {
          void (async () => {
            const fresh = await useAppStore
              .getState()
              .fetchApp(workspaceId, appId);
            if (fresh) useAppStore.getState().bumpPreview(appId);
          })();
        }
      } else {
        const projectId = p.input?.projectId;
        const path = p.input?.path;
        // Only touch projects this window has loaded.
        if (
          projectId &&
          path &&
          useDbtStore.getState().filePathsByProject[projectId]
        ) {
          void useDbtStore
            .getState()
            .applyRemoteFileUpdate(
              workspaceId,
              projectId,
              path,
              toolName === "delete_dbt_file",
            );
        }
      }
    }
  }, [messages, currentWorkspace?.id]);

  // Load messages when selecting an existing chat from history
  useEffect(() => {
    // Flipped when this effect is superseded (chat switched / unmount) so a
    // slow fetch can't clobber the next chat's state or resume the wrong one.
    let cancelled = false;
    const loadSession = async () => {
      if (!isExistingChat || !currentWorkspace) {
        return;
      }
      try {
        const res = await fetch(
          `/api/workspaces/${currentWorkspace.id}/chats/${chatId}`,
        );
        if (cancelled) return;
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
                      // Handle both 'reasoning' and 'text' fields for reasoning parts.
                      // Carry providerMetadata back (Anthropic extended-thinking
                      // `signature`) so a continuation replays the thinking block
                      // byte-for-byte; without it Anthropic rejects the turn with
                      // "thinking ... blocks in the latest assistant message cannot
                      // be modified".
                      return {
                        type: "reasoning",
                        text: p.reasoning || p.text || "",
                        ...(p.providerMetadata != null
                          ? { providerMetadata: p.providerMetadata }
                          : {}),
                      };
                    }
                    // Tool parts: ensure state is set for UI rendering
                    // AI SDK v6 uses output-error (not "error") so convertToModelMessages
                    // emits a matching tool-result for Anthropic.
                    if (
                      p.type?.startsWith("tool-") ||
                      p.type === "dynamic-tool"
                    ) {
                      const toolState = p.state as string | undefined;
                      const interruptedText =
                        "Interrupted — stream disconnected before tool completed";
                      if (toolState === "error") {
                        const output = p.output as
                          | { error?: unknown }
                          | null
                          | undefined;
                        const errorText =
                          typeof p.errorText === "string"
                            ? p.errorText
                            : typeof output?.error === "string"
                              ? output.error
                              : output?.error != null
                                ? String(output.error)
                                : "Tool failed";
                        return {
                          ...p,
                          state: "output-error",
                          input: p.input ?? {},
                          output: undefined,
                          errorText,
                        };
                      }
                      const isComplete =
                        toolState === "output-available" ||
                        toolState === "output-error" ||
                        toolState === "output-denied";
                      if (isComplete) {
                        return {
                          ...p,
                          input: p.input ?? {},
                        };
                      }
                      // A persisted, unanswered human-in-the-loop tool
                      // (clarifying questions / plan review) is not an
                      // interrupted tool: re-render its interactive card so the
                      // user can still answer it. Answering sends the tool
                      // result, which continues the turn from persisted
                      // history. Keep it pending instead of marking it errored.
                      if (
                        typeof p.type === "string" &&
                        isHumanInTheLoopToolPartType(p.type) &&
                        toolState === "input-available"
                      ) {
                        return {
                          ...p,
                          input: p.input ?? {},
                        };
                      }
                      return {
                        ...p,
                        state: "output-error",
                        input: p.input ?? {},
                        output: undefined,
                        errorText: interruptedText,
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

          setMessages(convertedMessages);

          // Virtuoso keeps ONE instance across chat switches (Chat isn't keyed
          // by chatId), so its `initialTopMostItemIndex` — read once at mount —
          // never re-applies when we bulk-load a different chat's history here.
          // Without this, opening an existing chat from history can land
          // mid-list or at the top. Pin to the newest message on the next
          // frame (after the new data has rendered) so it deterministically
          // opens at the bottom, matching the old stick-to-bottom behavior.
          if (convertedMessages.length > 0) {
            requestAnimationFrame(() => {
              if (cancelled) return;
              virtuosoRef.current?.scrollToIndex({
                index: "LAST",
                align: "end",
              });
            });
          }

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

      // Reattach to a still-generating turn AFTER the persisted messages are
      // in place: the resumable SSE replay only contains this turn's
      // assistant chunks, so loading first yields the full conversation and
      // avoids setMessages clobbering an in-flight replay. The server answers
      // 204 when the chat is idle (or unknown), making this a cheap no-op.
      if (!cancelled) {
        void resumeStreamRef.current?.();
      }
    };
    loadSession();
    return () => {
      cancelled = true;
    };
  }, [chatId, isExistingChat, currentWorkspace, setMessages]);

  // Create new chat session - just generate a new ID locally (no API call needed)
  const createNewSession = () => {
    cancelActiveClientToolCalls("session-change");
    manualStopRequestedRef.current = false;
    setQueuedPrompts([]);
    setChatId(generateObjectId());
    setMessages([]);
    setIsExistingChat(false);
  };

  // Live per-chat activity from the realtime channel. The server-fetched
  // activeStreamId is the initial value (correct on cold open); chat.activity
  // events keep it current while the menu is open — including turns started
  // by other windows or continuing server-side after a detach.
  const chatActivity = useRealtimeStore(s => s.chatActivity);
  const isSessionStreaming = useCallback(
    (session: ChatSessionMeta): boolean => {
      const live = chatActivity[session._id];
      if (live === "streaming") return true;
      if (live === "idle") return false;
      return Boolean(session.activeStreamId);
    },
    [chatActivity],
  );

  const handleHistoryMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setHistoryMenuAnchor(event.currentTarget);
    // The list goes stale the moment a new chat starts a turn (the doc is
    // created server-side at turn start) — refresh it on every open so
    // in-flight chats appear immediately with their streaming indicator.
    void fetchSessionsRef.current?.();
  };

  const handleHistoryMenuClose = () => {
    setHistoryMenuAnchor(null);
  };

  const handleSelectSession = (id: string) => {
    cancelActiveClientToolCalls("session-change");
    manualStopRequestedRef.current = false;
    setQueuedPrompts([]);
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
  // user message. Ref keeps handleChatSubmit's identity stable (perf rules).
  const pendingPlanToolCallIdRef = useRef<string | null>(null);
  pendingPlanToolCallIdRef.current =
    pendingInteractiveTool?.toolName === "submit_plan" &&
    !pendingInteractiveTool.streaming
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
      const data = await store.fetchConsoleContent(workspaceId, consoleId);
      if (!data) return;

      const currentStore = useConsoleStore.getState();
      currentStore.openTab({
        id: consoleId,
        title: data.name || data.path || "Untitled",
        content: data.content || "",
        connectionId: data.connectionId,
        databaseId: data.databaseId,
        databaseName: data.databaseName,
        filePath: data.path,
        isSaved: true,
      });
      currentStore.setActiveTab(consoleId);
    } catch {
      /* ignore focus failures */
    }
  }, []);

  const handleCloseToolDialog = () => {
    setToolDialogOpen(false);
    setSelectedTool(null);
  };

  // Stable submit handler — reads store state at call time via getState() and refs
  // to keep the callback identity stable during streaming.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // When a turn ends on a completed client-side tool call (e.g. a data
  // binding), `lastAssistantMessageIsCompleteWithToolCalls` stays true and the
  // SDK *may* auto-continue the agent loop in a microtask after onFinish. We
  // must not drain into that gap, but we also must not stall forever when the
  // SDK is actually idle and won't resume (e.g. the tool settled while the
  // stream was still streaming, so the SDK's auto-continue condition was
  // missed). When that predicate is the *only* thing blocking the drain, defer
  // one macrotask and re-check: if the SDK resumed, `status` is now
  // submitted/streaming and the loading guard bails; if it stayed idle, force
  // the drain past the (now-stale) predicate so the queue can't hang.
  const drainRecheckScheduledRef = useRef(false);
  const forceDrainPastAutoContinueRef = useRef(false);

  const tryDrainQueuedPromptRef = useRef<() => void>(() => {});
  tryDrainQueuedPromptRef.current = () => {
    // Force-send (top arrow): the user interrupted the running turn to push
    // this prompt now. Wait only until the aborted turn has fully settled
    // (no in-flight stream / unanswered tool calls), then send it past every
    // other guard — including the manual-stop flag the interrupt just set.
    const forcedId = pendingForcePromptIdRef.current;
    if (forcedId) {
      const forced = queuedPromptsRef.current.find(p => p.id === forcedId);
      if (!forced) {
        pendingForcePromptIdRef.current = null;
      } else {
        if (
          isLoadingRef.current ||
          hasPendingAssistantToolCalls(messagesRef.current)
        ) {
          return;
        }
        pendingForcePromptIdRef.current = null;
        const remaining = queuedPromptsRef.current.filter(
          p => p.id !== forcedId,
        );
        queuedPromptsRef.current = remaining;
        isLoadingRef.current = true;
        setQueuedPrompts(remaining);
        capturedConsoleIdRef.current = forced.consoleId;
        capturedDashboardIdRef.current = forced.dashboardId;
        manualStopRequestedRef.current = false;
        trackEvent("ai_chat_message_sent", {
          model: modelIdRef.current,
          has_context: false,
          has_images: (forced.files?.length ?? 0) > 0,
        });
        sendMessageRef.current({ text: forced.text, files: forced.files });
        return;
      }
    }

    if (
      manualStopRequestedRef.current ||
      // Don't auto-fire the next queued prompt into a failed turn. The error
      // (e.g. usage_limit_exceeded) stays on screen; dismissing it via
      // clearError flips status back to "ready" and re-triggers this drain.
      status === "error" ||
      queuedPromptsRef.current.length === 0 ||
      // Don't drain the head item while the user is editing it in the composer.
      queuedPromptsRef.current[0]?.id === editingPromptIdRef.current
    ) {
      forceDrainPastAutoContinueRef.current = false;
      return;
    }

    // Hard blocks: the agent is genuinely mid-turn (streaming, running a
    // client tool, or has an unanswered tool call). Sending now would race the
    // loop or break the SDK's "all tool calls must be settled" invariant.
    if (
      isLoadingRef.current ||
      hasPendingAssistantToolCalls(messagesRef.current)
    ) {
      forceDrainPastAutoContinueRef.current = false;
      return;
    }

    // Soft block: the turn ended on completed tool calls and the SDK might
    // auto-continue in a microtask. Give it one macrotask before draining.
    if (
      autoSendWhenComplete({ messages: messagesRef.current }) &&
      !forceDrainPastAutoContinueRef.current
    ) {
      if (!drainRecheckScheduledRef.current) {
        drainRecheckScheduledRef.current = true;
        setTimeout(() => {
          drainRecheckScheduledRef.current = false;
          forceDrainPastAutoContinueRef.current = true;
          tryDrainQueuedPromptRef.current();
        }, 80);
      }
      return;
    }

    forceDrainPastAutoContinueRef.current = false;

    const [next, ...rest] = queuedPromptsRef.current;
    // Synchronously advance the queue and mark loading BEFORE sending so a
    // second drain trigger firing in the same tick (the [isLoading,status]
    // effect and the onFinish microtask can both run before React re-renders)
    // bails out at the guards above instead of re-sending the same prompt.
    queuedPromptsRef.current = rest;
    isLoadingRef.current = true;
    setQueuedPrompts(rest);
    capturedConsoleIdRef.current = next.consoleId;
    capturedDashboardIdRef.current = next.dashboardId;
    manualStopRequestedRef.current = false;
    trackEvent("ai_chat_message_sent", {
      model: modelIdRef.current,
      has_context: false,
      has_images: (next.files?.length ?? 0) > 0,
    });
    sendMessageRef.current({ text: next.text, files: next.files });
  };
  drainQueuedPromptAfterTurnRef.current = () =>
    tryDrainQueuedPromptRef.current();

  const handleChatSubmit = useCallback((text: string, files?: FileUIPart[]) => {
    // Committing an edit of a queued prompt: update the queue entry in place
    // instead of sending/queuing a new message.
    if (editingPromptIdRef.current) {
      const id = editingPromptIdRef.current;
      const trimmed = text.trim();
      setEditingPromptId(null);
      if (trimmed) {
        setQueuedPrompts(prev =>
          prev.map(prompt =>
            prompt.id === id ? { ...prompt, text: trimmed } : prompt,
          ),
        );
      }
      return;
    }

    // Conversational plan iteration (Cursor-style): while a submitted plan is
    // awaiting review, the typed message becomes request_changes feedback on
    // the plan — including the current draft, so manual edits made in the
    // plan tab flow back — instead of a normal user message.
    const pendingPlanToolCallId = pendingPlanToolCallIdRef.current;
    if (pendingPlanToolCallId) {
      const planStore = usePlanStore.getState();
      const planEntry = planStore.plans[pendingPlanToolCallId];
      const feedback = text.trim();
      if (planEntry?.status === "pending" && feedback) {
        trackEvent("ai_plan_feedback_sent", { model: modelIdRef.current });
        planStore.resolvePlan(
          pendingPlanToolCallId,
          "request_changes",
          feedback,
        );
        return;
      }
    }

    capturedConsoleIdRef.current = activeConsoleIdRef.current;
    const store = useConsoleStore.getState();
    const currentTab = store.tabs[store.activeTabId || ""] as
      | (ConsoleTab & { metadata?: Record<string, unknown> })
      | undefined;
    const dashboardId =
      currentTab?.kind === "dashboard"
        ? ((currentTab.metadata?.dashboardId as string | undefined) ?? null)
        : null;
    capturedDashboardIdRef.current = dashboardId;
    const consoleId = capturedConsoleIdRef.current;

    if (isLoadingRef.current) {
      trackEvent("ai_chat_message_queued", {
        model: modelIdRef.current,
        has_images: (files?.length ?? 0) > 0,
      });
      setQueuedPrompts(prev => [
        ...prev,
        {
          id: generateObjectId(),
          text,
          files,
          consoleId,
          dashboardId,
        },
      ]);
      return;
    }

    manualStopRequestedRef.current = false;
    const activeConsole = store.tabs[store.activeTabId || ""];
    trackEvent("ai_chat_message_sent", {
      model: modelIdRef.current,
      has_context: !!activeConsole?.content,
      has_images: (files?.length ?? 0) > 0,
    });
    sendMessageRef.current({ text, files });
  }, []);

  useEffect(() => {
    tryDrainQueuedPromptRef.current();
  }, [isLoading, status, activeClientToolCallCount]);

  // Belt-and-suspenders: useChat `id` resets hook state on chatId change.
  useEffect(() => {
    setQueuedPrompts([]);
  }, [chatId]);

  const handleRemoveQueuedPrompt = useCallback((id: string) => {
    setQueuedPrompts(prev => prev.filter(prompt => prompt.id !== id));
  }, []);

  const handleStartEditQueuedPrompt = useCallback((id: string) => {
    setEditingPromptId(id);
  }, []);

  const handleCancelEditQueuedPrompt = useCallback(() => {
    setEditingPromptId(null);
  }, []);

  // If the edited prompt leaves the queue (drained, removed, or cleared), exit
  // edit mode so a stale id can't swallow the next real submit.
  useEffect(() => {
    if (
      editingPromptId &&
      !queuedPrompts.some(prompt => prompt.id === editingPromptId)
    ) {
      setEditingPromptId(null);
    }
  }, [queuedPrompts, editingPromptId]);

  // Force-send (top arrow): send this prompt right now. If the agent is still
  // running, interrupt the current turn first, then push it. If idle, just
  // send it immediately (ahead of any other queued items).
  const handleSendQueuedPromptNow = useCallback(
    (id: string) => {
      if (!queuedPromptsRef.current.some(p => p.id === id)) return;
      if (editingPromptIdRef.current === id) setEditingPromptId(null);

      // Move to the front for immediate visual feedback.
      setQueuedPrompts(prev => {
        const index = prev.findIndex(prompt => prompt.id === id);
        if (index <= 0) return prev;
        const next = [...prev];
        const [item] = next.splice(index, 1);
        next.unshift(item);
        return next;
      });

      pendingForcePromptIdRef.current = id;
      if (isLoadingRef.current) {
        interruptActiveTurn();
      }
      // Drain now if already idle; otherwise the status→ready transition from
      // the interrupt re-fires the drain effect, which sends the forced prompt.
      queueMicrotask(() => tryDrainQueuedPromptRef.current());
    },
    [interruptActiveTurn],
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
              isSessionStreaming(session) ||
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
                  {isSessionStreaming(session) ? (
                    // Turn in flight server-side — pulsing indicator instead
                    // of the static chat icon.
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                      }}
                    >
                      <Box sx={streamingIndicatorDotSx} />
                    </Box>
                  ) : (
                    <MessageSquare size={18} />
                  )}
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

      {/* Error display — billing errors get an upgrade prompt */}
      {error && (
        <Box sx={{ p: 1 }}>
          {(() => {
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
                {error.message}
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
            // Auto-stick to the tail while streaming, but only when the user is
            // already at the bottom (don't yank them down if they scrolled up
            // to read history). This preserves the old use-stick-to-bottom UX.
            followOutput={isAtBottom ? "smooth" : false}
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
            <CodeBlock
              language="json"
              isGenerating={false}
              scrollable
              paletteMode={paletteMode}
            >
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
            <CodeBlock
              language="json"
              isGenerating={false}
              scrollable
              paletteMode={paletteMode}
            >
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

Chat.displayName = "Chat";

export default React.memo(Chat);
