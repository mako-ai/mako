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
  ImagePlus,
  Plus,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";
import { useTheme as useMuiTheme, keyframes } from "@mui/material/styles";
import { useChat } from "@ai-sdk/react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type FileUIPart,
} from "ai";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { executeDashboardAgentTool } from "../dashboard-runtime/agent-tools";
import type { ConsoleTab } from "../store/lib/types";
import { useSettingsStore } from "../store/settingsStore";
import { useSchemaStore } from "../store/schemaStore";
import { ModelSelector } from "./ModelSelector";
import { generateObjectId } from "../utils/objectId";
import { ConsoleModificationPayload } from "../hooks/useMonacoConsole";
import { trackEvent } from "../lib/analytics";
import { DbFlowFormRef } from "./DbFlowForm";
import { safeStringify, toJsonSafe } from "../lib/json-safe";
import { StreamingToolCard, type ToolPartState } from "./StreamingToolCard";
import {
  chatMessageRowArePropsEqual,
  type ChatMessageRowProps,
} from "./chat-message-comparator";
import {
  buildChatRequestBody,
  type ActiveConsoleResultsContext,
} from "../agent-runtime/request-context";
import { executeConsoleAgentTool } from "../agent-runtime/console-agent-tools";
import {
  LONG_RUNNING_DASHBOARD_TOOL_NAMES,
  type AgentToolName,
} from "../agent-runtime/client-tool-manifest";
import { UpgradePrompt } from "./UpgradePrompt";

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

type AutoSendPredicateArgs = Parameters<
  typeof lastAssistantMessageIsCompleteWithToolCalls
>[0];

interface ActiveClientToolCall {
  toolCallId: string;
  toolName: string;
  executionId: string;
  abortController: AbortController;
  cancel: () => void | Promise<void>;
  cancellationOutput: Record<string, unknown>;
  settled: boolean;
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

const userMessageSx = { flex: 1, mt: 2, minWidth: 0 } as const;
const userMessagePaperSx = {
  p: 1,
  borderRadius: 1,
  backgroundColor: "background.paper",
  overflow: "hidden",
} as const;
const userMessageBoxSx = {
  maxWidth: "100%",
  "& .MuiListItemText-primary": {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "break-word",
    overflow: "visible",
    textOverflow: "unset",
  },
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

const ChatMessageRow = React.memo(function ChatMessageRow({
  message,
  isLastMessage,
  isStreaming,
  onToolClick,
}: ChatMessageRowProps) {
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
                    sx={{
                      maxWidth: 200,
                      maxHeight: 200,
                      borderRadius: 1,
                      objectFit: "contain",
                    }}
                  />
                ))}
              </Box>
            )}
            {textContent && (
              <Box sx={userMessageBoxSx}>
                <ListItemText
                  primary={textContent}
                  primaryTypographyProps={{
                    variant: "body2",
                    color: "text.primary",
                  }}
                />
              </Box>
            )}
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
}, chatMessageRowArePropsEqual);

ChatMessageRow.displayName = "ChatMessageRow";

// Isolated input component — owns its own `input` state so keystrokes
// never re-render the (expensive) message list above it.

interface ImageAttachment {
  id: string;
  file: File;
  previewUrl: string;
}

interface ChatInputAreaProps {
  onSubmit: (text: string, files?: FileUIPart[]) => void;
  onStop: () => void;
  isLoading: boolean;
  disabled: boolean;
  focusKey: string | number;
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
  ({ onSubmit, onStop, isLoading, disabled, focusKey }: ChatInputAreaProps) => {
    const [input, setInput] = useState("");
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [isPreparingSubmission, setIsPreparingSubmission] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imagesRef = useRef<ImageAttachment[]>([]);
    imagesRef.current = images;

    useEffect(() => {
      const timer = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }, [focusKey]);

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
      if ((!hasText && !hasImages) || isLoading || isPreparingSubmission) {
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
    }, [images, input, isLoading, isPreparingSubmission, onSubmit]);

    const hasContent = input.trim() || images.length > 0;
    const isSubmitDisabled =
      !hasContent || disabled || isLoading || isPreparingSubmission;

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
                    overflow: "visible",
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
                    sx={{
                      width: 56,
                      height: 56,
                      borderRadius: 1.5,
                      objectFit: "cover",
                      border: 1,
                      borderColor: "divider",
                    }}
                  />
                  <IconButton
                    type="button"
                    className="remove-btn"
                    onClick={() => removeImage(img.id)}
                    size="small"
                    disabled={isPreparingSubmission}
                    sx={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      width: 18,
                      height: 18,
                      p: 0,
                      opacity: 0,
                      transition: "opacity 0.15s",
                      backgroundColor: "background.paper",
                      border: 1,
                      borderColor: "divider",
                      "&:hover": {
                        backgroundColor: "action.hover",
                      },
                    }}
                  >
                    <X size={10} />
                  </IconButton>
                </Box>
              ))}
            </Box>
          )}

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
                submitMessage();
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
  const activeTabId = useConsoleStore(state => state.activeTabId);
  // Narrow selector: only re-render when the active tab's kind changes,
  // not when unrelated tabs are mutated (e.g. query results arriving).
  const activeTabKind = useConsoleStore(state => {
    const tab = state.tabs[state.activeTabId || ""];
    return tab?.kind;
  });
  const activeConsoleId = activeTabId;

  const activeView =
    activeTabKind === "dashboard" ||
    activeTabKind === "flow-editor" ||
    activeTabKind === "console"
      ? activeTabKind
      : "empty";

  // Ref for dbFlowFormRef to avoid stale closure in onToolCall
  const dbFlowFormRefCurrent = useRef(dbFlowFormRef);
  dbFlowFormRefCurrent.current = dbFlowFormRef;

  // Get connections to check if only database is the demo
  const connections = useSchemaStore(s => s.connections);
  const workspaceConnections = useMemo(
    () => (currentWorkspace ? connections[currentWorkspace.id] || [] : []),
    [connections, currentWorkspace],
  );

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
  const {
    scrollRef: scrollContainerRef,
    contentRef: scrollContentRef,
    isAtBottom,
    scrollToBottom,
  } = useStickToBottom();

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
  const [capturedConsoleTitle, setCapturedConsoleTitle] = useState<
    string | null
  >(null);

  // Ref to get current activeConsoleId at request time (avoids stale closure)
  const activeConsoleIdRef = useRef(activeConsoleId);
  activeConsoleIdRef.current = activeConsoleId;

  // Refs for values needed in prepareSendMessagesRequest (avoids stale closures)
  const workspaceIdRef = useRef(currentWorkspace?.id);
  const modelIdRef = useRef(selectedModelId);
  const chatIdRef = useRef(chatId);
  const manualStopRequestedRef = useRef(false);
  const activeClientToolCallsRef = useRef(
    new Map<string, ActiveClientToolCall>(),
  );
  workspaceIdRef.current = currentWorkspace?.id;
  modelIdRef.current = selectedModelId;
  chatIdRef.current = chatId;

  const autoSendWhenComplete = useCallback((options: AutoSendPredicateArgs) => {
    if (manualStopRequestedRef.current) {
      return false;
    }
    return lastAssistantMessageIsCompleteWithToolCalls(options);
  }, []);

  // Refs so the transport closure always reads fresh values without
  // needing to be recreated (which would reset the useChat hook).
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const workspaceConnectionsRef = useRef(workspaceConnections);
  workspaceConnectionsRef.current = workspaceConnections;

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

          const computedActiveView =
            activeTab?.kind === "dashboard" ||
            activeTab?.kind === "flow-editor" ||
            activeTab?.kind === "console"
              ? activeTab.kind
              : "empty";

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

          return {
            body: toJsonSafe(
              buildChatRequestBody({
                messages,
                workspaceId: workspaceIdRef.current,
                modelId: modelIdRef.current,
                chatId: chatIdRef.current,
                tabs,
                activeTabId: store.activeTabId,
                activeTab,
                activeView: computedActiveView,
                activeConsoleId: activeConsoleIdRef.current,
                activeConsoleResults,
                flowFormState,
                workspaceConnections: workspaceConnectionsRef.current,
                pinnedDashboardId: capturedDashboardIdRef.current,
              }),
            ) as Record<string, unknown>,
          };
        },
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
  } = useChat({
    id: chatId, // Reset hook state when chatId changes (fixes stale messages bug)
    transport,
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

      try {
        if (
          await executeConsoleAgentTool({
            toolCall: {
              toolName,
              toolCallId: toolCall.toolCallId,
            },
            input,
            workspaceId: workspaceIdRef.current,
            capturedConsoleId: capturedConsoleIdRef.current,
            onConsoleModification: onConsoleModificationRef.current,
            onChartSpecChange: onChartSpecChangeRef?.current,
            addToolOutput,
            registerActiveClientToolCall,
            settleActiveClientToolCall,
          })
        ) {
          return;
        }

        // --- Dashboard tools (client-side) ---
        try {
          const activeDashboardTool = LONG_RUNNING_DASHBOARD_TOOL_NAMES.has(
            toolName as AgentToolName,
          )
            ? registerActiveClientToolCall(toolName, toolCall.toolCallId)
            : null;

          const dashboardToolOutput = await executeDashboardAgentTool(
            toolName,
            input,
            activeDashboardTool
              ? {
                  executionId: activeDashboardTool.executionId,
                  signal: activeDashboardTool.abortController.signal,
                }
              : undefined,
          );

          if (dashboardToolOutput !== null) {
            if (activeDashboardTool) {
              settleActiveClientToolCall(
                toolName,
                toolCall.toolCallId,
                dashboardToolOutput,
              );
            } else {
              addToolOutput({
                tool: toolName,
                toolCallId: toolCall.toolCallId,
                output: dashboardToolOutput,
              });
            }
            return;
          }
        } catch (dashboardError) {
          if (
            LONG_RUNNING_DASHBOARD_TOOL_NAMES.has(toolName as AgentToolName)
          ) {
            if (manualStopRequestedRef.current) {
              return;
            }
            settleActiveClientToolCall(toolName, toolCall.toolCallId, {
              success: false,
              error:
                dashboardError instanceof Error
                  ? dashboardError.message
                  : "Dashboard tool execution failed",
            });
          } else {
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
                output: { success: false, error: "Stream disconnected" },
              };
            }) as any,
          };
        }),
      );
    },
    onFinish: () => {
      if (!isExistingChatRef.current) {
        fetchSessionsRef.current?.();
      }
    },
  });

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

      return { abortController, executionId };
    },
    [createCancellationOutput],
  );

  const settleActiveClientToolCall = useCallback(
    (
      toolName: string,
      toolCallId: string,
      output: Record<string, unknown>,
    ): void => {
      const activeToolCall = activeClientToolCallsRef.current.get(toolCallId);
      if (!activeToolCall) {
        if (!manualStopRequestedRef.current) {
          addToolOutput({ tool: toolName, toolCallId, output });
        }
        return;
      }

      if (!activeToolCall.settled) {
        activeToolCall.settled = true;
        addToolOutput({
          tool: activeToolCall.toolName,
          toolCallId,
          output,
        });
      }

      activeClientToolCallsRef.current.delete(toolCallId);
    },
    [addToolOutput],
  );

  const handleStop = useCallback(() => {
    manualStopRequestedRef.current = true;

    for (const activeToolCall of activeClientToolCallsRef.current.values()) {
      activeToolCall.abortController.abort("chat-stop");
      void activeToolCall.cancel();

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
    stop();
  }, [addToolOutput, stop]);

  const isLoading = status === "streaming" || status === "submitted";

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
                      const toolState = p.state as string | undefined;
                      const isComplete =
                        toolState === "output-available" ||
                        toolState === "error";
                      return {
                        ...p,
                        state: isComplete ? toolState : "error",
                        input: p.input ?? {},
                        output: isComplete
                          ? (p.output ?? null)
                          : (p.output ?? {
                              success: false,
                              error:
                                "Interrupted — stream disconnected before tool completed",
                            }),
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
    manualStopRequestedRef.current = false;
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
    manualStopRequestedRef.current = false;
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

  // Stable submit handler — reads store state at call time via getState() and refs
  // to keep the callback identity stable during streaming.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const handleChatSubmit = useCallback((text: string, files?: FileUIPart[]) => {
    manualStopRequestedRef.current = false;
    capturedConsoleIdRef.current = activeConsoleIdRef.current;
    const store = useConsoleStore.getState();
    const currentTab = store.tabs[store.activeTabId || ""] as
      | (ConsoleTab & { metadata?: Record<string, unknown> })
      | undefined;
    capturedDashboardIdRef.current =
      currentTab?.kind === "dashboard"
        ? ((currentTab.metadata?.dashboardId as string | undefined) ?? null)
        : null;
    const currentTabs = Object.values(store.tabs);
    const activeConsole = currentTabs.find(t => t.id === store.activeTabId);
    setCapturedConsoleTitle(
      activeConsole?.kind === undefined || activeConsole?.kind === "console"
        ? activeConsole?.title || null
        : null,
    );
    trackEvent("ai_chat_message_sent", {
      model: modelIdRef.current,
      has_context: !!activeConsole?.content,
      has_images: (files?.length ?? 0) > 0,
    });
    sendMessageRef.current({ text, files });
  }, []);

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
                  manualStopRequestedRef.current = false;
                  capturedConsoleIdRef.current = activeConsoleIdRef.current;
                  const store = useConsoleStore.getState();
                  const currentTab = store.tabs[store.activeTabId || ""] as
                    | (ConsoleTab & { metadata?: Record<string, unknown> })
                    | undefined;
                  capturedDashboardIdRef.current =
                    currentTab?.kind === "dashboard"
                      ? ((currentTab.metadata?.dashboardId as
                          | string
                          | undefined) ?? null)
                      : null;
                  const currentTabs = Object.values(store.tabs);
                  const console_ = currentTabs.find(
                    t => t.id === store.activeTabId,
                  );
                  setCapturedConsoleTitle(
                    console_?.kind === undefined || console_?.kind === "console"
                      ? console_?.title || null
                      : null,
                  );
                  trackEvent("ai_chat_message_sent", {
                    model: modelIdRef.current,
                    has_context: false,
                    from_suggestion: true,
                  });
                  sendMessageRef.current({ text: suggestion });
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
      <Box
        ref={scrollContainerRef}
        sx={{
          flex: messages.length > 0 ? 1 : 0,
          overflow: "auto",
          p: 1,
          position: "relative",
        }}
      >
        <div ref={scrollContentRef}>
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
        </div>

        {!isAtBottom && (
          <IconButton
            onClick={() => scrollToBottom()}
            size="small"
            sx={{
              position: "sticky",
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
        onStop={handleStop}
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
