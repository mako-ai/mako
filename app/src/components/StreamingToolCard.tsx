import React, { useEffect, useRef, useState, useCallback } from "react";
import { Box, Typography, Collapse, CircularProgress } from "@mui/material";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  prism,
  tomorrow,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme as useMuiTheme, keyframes } from "@mui/material/styles";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  Play,
  Plus,
  X,
} from "lucide-react";

export type ToolPartState =
  | "input-streaming"
  | "input-available"
  | "output-streaming"
  | "output-available"
  | "error";

interface StreamingToolCardProps {
  toolName: string;
  state: ToolPartState;
  input?: unknown;
  output?: unknown;
  onDetailClick?: () => void;
}

interface ToolPreviewConfig {
  field: string;
  language: string;
  getLabel: (input?: unknown) => string;
  icon: React.ReactNode;
}

const TOOL_PREVIEW_CONFIG: Record<string, ToolPreviewConfig> = {
  modify_console: {
    field: "content",
    language: "sql",
    getLabel: input => {
      const action = (input as Record<string, unknown>)?.action;
      return action === "patch" ? "Patching console" : "Editing console";
    },
    icon: <Pencil size={13} />,
  },
  create_console: {
    field: "content",
    language: "sql",
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating "${title}"` : "Creating console";
    },
    icon: <Plus size={13} />,
  },
  sql_execute_query: {
    field: "query",
    language: "sql",
    getLabel: () => "Executing SQL query",
    icon: <Play size={13} />,
  },
  mongo_execute_query: {
    field: "query",
    language: "javascript",
    getLabel: () => "Executing MongoDB query",
    icon: <Play size={13} />,
  },
};

const pulseKf = keyframes`
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.35); }
`;

export function hasStreamingPreview(toolName: string): boolean {
  return toolName in TOOL_PREVIEW_CONFIG;
}

export const StreamingToolCard = React.memo(function StreamingToolCard({
  toolName,
  state,
  input,
  onDetailClick,
}: StreamingToolCardProps) {
  const config = TOOL_PREVIEW_CONFIG[toolName];
  const muiTheme = useMuiTheme();
  const isDark = muiTheme.palette.mode === "dark";
  const syntaxTheme = isDark ? tomorrow : prism;

  const codeContainerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const isStreaming = state === "input-streaming";
  const isExecuting =
    state === "input-available" || state === "output-streaming";
  const isDone = state === "output-available";
  const isError = state === "error";
  const isActive = isStreaming || isExecuting;

  // Start collapsed if already completed (e.g. historical messages)
  const [expanded, setExpanded] = useState(!isDone && !isError);

  // Auto-collapse when tool completes, auto-expand when streaming begins
  useEffect(() => {
    if (isDone || isError) {
      const timer = setTimeout(() => setExpanded(false), 800);
      return () => clearTimeout(timer);
    }
    if (isActive) {
      setExpanded(true);
      setUserScrolled(false);
    }
  }, [isDone, isError, isActive]);

  const inputObj = input as Record<string, unknown> | undefined;
  const codeContent = config ? inputObj?.[config.field] : undefined;
  const code = typeof codeContent === "string" ? codeContent : "";

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    if (isStreaming && !userScrolled && codeContainerRef.current) {
      codeContainerRef.current.scrollTop =
        codeContainerRef.current.scrollHeight;
    }
  }, [code, isStreaming, userScrolled]);

  const handleScroll = useCallback(() => {
    if (!codeContainerRef.current) return;
    const el = codeContainerRef.current;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setUserScrolled(!isAtBottom);
  }, []);

  if (!config) return null;

  const label = config.getLabel(input);
  const statusText = isStreaming
    ? "Generating..."
    : isExecuting
      ? "Running..."
      : isDone
        ? "Done"
        : isError
          ? "Error"
          : "";

  return (
    <Box
      sx={{
        my: 0.75,
        borderRadius: 1.5,
        border: 1,
        borderColor: isActive
          ? "primary.main"
          : isError
            ? "error.main"
            : "divider",
        overflow: "hidden",
        transition: "border-color 0.3s, opacity 0.3s",
        opacity: isDone || isError ? 0.85 : 1,
        backgroundColor: isDark
          ? "rgba(255,255,255,0.02)"
          : "rgba(0,0,0,0.015)",
      }}
    >
      {/* Header */}
      <Box
        onClick={() => {
          if (isDone || isError) setExpanded(prev => !prev);
          else onDetailClick?.();
        }}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 0.75,
          cursor: "pointer",
          userSelect: "none",
          "&:hover": {
            backgroundColor: isDark
              ? "rgba(255,255,255,0.04)"
              : "rgba(0,0,0,0.03)",
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            color: isActive ? "primary.main" : "text.secondary",
          }}
        >
          {isDone || isError ? (
            expanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            config.icon
          )}
        </Box>

        <Typography
          variant="caption"
          sx={{ fontWeight: 500, flex: 1, color: "text.primary" }}
        >
          {label}
        </Typography>

        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Typography
            variant="caption"
            sx={{ color: "text.secondary", fontSize: "0.7rem" }}
          >
            {statusText}
          </Typography>
          {isStreaming ? (
            <Box
              sx={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                backgroundColor: "primary.main",
                animation: `${pulseKf} 1s infinite ease-in-out`,
              }}
            />
          ) : isExecuting ? (
            <CircularProgress size={12} thickness={5} />
          ) : isDone ? (
            <Check
              size={14}
              style={{ color: "var(--mui-palette-success-main, #4caf50)" }}
            />
          ) : isError ? (
            <X
              size={14}
              style={{ color: "var(--mui-palette-error-main, #f44336)" }}
            />
          ) : null}
        </Box>
      </Box>

      {/* Auto-scrolling code preview */}
      <Collapse in={expanded && code.length > 0} timeout={300}>
        <Box
          ref={codeContainerRef}
          onScroll={handleScroll}
          sx={{
            maxHeight: 220,
            overflow: "auto",
            borderTop: 1,
            borderColor: "divider",
          }}
        >
          <SyntaxHighlighter
            style={syntaxTheme}
            language={config.language}
            PreTag="div"
            customStyle={{
              fontSize: "0.78rem",
              margin: 0,
              padding: "0.75rem",
              background: "transparent",
              overflow: "visible",
            }}
          >
            {code || " "}
          </SyntaxHighlighter>
        </Box>
      </Collapse>
    </Box>
  );
});
