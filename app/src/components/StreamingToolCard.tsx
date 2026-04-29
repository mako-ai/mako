import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { Box, Typography, Collapse, CircularProgress } from "@mui/material";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
  prism,
  tomorrow,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme as useMuiTheme, keyframes } from "@mui/material/styles";
import {
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  Eye,
  Filter,
  HelpCircle,
  Link,
  List,
  Pencil,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Table2,
  Trash2,
  Wrench,
  X,
  ExternalLink,
  SquareTerminal,
} from "lucide-react";
import {
  getAgentToolManifestEntry,
  type ToolIconKey,
  type ToolUiConfig,
} from "../agent-runtime/client-tool-manifest";

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
  labelOverride?: string;
  leadingIconUrl?: string;
  leadingIconAlt?: string;
  bodyPreview?: { content: string; language: string };
  onTitleClick?: () => void;
  onDetailClick?: () => void;
  /**
   * Optional — used as a defensive check in the memo comparator so that
   * React re-renders if the underlying tool call identity actually changed.
   * In practice parents also use this as the React key, so unmount/remount
   * handles identity changes, but comparing here keeps memoization safe if
   * the key strategy ever regresses.
   */
  toolCallId?: string;
}

const ICON_SIZE = 13;

// ── Helpers ──────────────────────────────────────────────────

function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function renderToolIcon(iconKey: ToolIconKey): React.ReactNode {
  switch (iconKey) {
    case "pencil":
      return <Pencil size={ICON_SIZE} />;
    case "plus":
      return <Plus size={ICON_SIZE} />;
    case "eye":
      return <Eye size={ICON_SIZE} />;
    case "list":
      return <List size={ICON_SIZE} />;
    case "link":
      return <Link size={ICON_SIZE} />;
    case "external-link":
      return <ExternalLink size={ICON_SIZE} />;
    case "play":
      return <Play size={ICON_SIZE} />;
    case "database":
      return <Database size={ICON_SIZE} />;
    case "table":
      return <Table2 size={ICON_SIZE} />;
    case "search":
      return <Search size={ICON_SIZE} />;
    case "bar-chart":
      return <BarChart3 size={ICON_SIZE} />;
    case "download":
      return <Download size={ICON_SIZE} />;
    case "trash":
      return <Trash2 size={ICON_SIZE} />;
    case "filter":
      return <Filter size={ICON_SIZE} />;
    case "clock":
      return <Clock size={ICON_SIZE} />;
    case "brain":
      return <Brain size={ICON_SIZE} />;
    case "shield-check":
      return <ShieldCheck size={ICON_SIZE} />;
    case "help-circle":
      return <HelpCircle size={ICON_SIZE} />;
    default:
      return <Wrench size={ICON_SIZE} />;
  }
}

function getToolConfig(toolName: string): ToolUiConfig {
  const config = getAgentToolManifestEntry(toolName);
  return (
    config ?? {
      getLabel: () => humanizeToolName(toolName),
      icon: "help-circle",
    }
  );
}

function getOutputSummary(output: unknown): string | null {
  if (output === null || output === undefined) return null;

  const o = output as Record<string, unknown>;

  if (o.success === false || o.error) {
    const raw = o.error;
    const err =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "message" in raw
          ? String((raw as { message: unknown }).message)
          : "Failed";
    return err.length > 50 ? err.slice(0, 50) + "…" : err;
  }

  if (o.state === "definition_updated") {
    return "Definition saved only";
  }
  if (o.state === "loaded") {
    if (typeof o.rowCount === "number") {
      return `${o.rowCount} row${o.rowCount !== 1 ? "s" : ""}`;
    }
    return "Fresh data loaded";
  }

  if (Array.isArray(o.data)) {
    return `${o.data.length} row${o.data.length !== 1 ? "s" : ""}`;
  }
  if (typeof o.rowCount === "number") {
    return `${o.rowCount} row${o.rowCount !== 1 ? "s" : ""}`;
  }

  if (Array.isArray(output)) {
    return `${output.length} result${output.length !== 1 ? "s" : ""}`;
  }

  if (Array.isArray(o.fields)) {
    return `${o.fields.length} field${o.fields.length !== 1 ? "s" : ""}`;
  }
  if (Array.isArray(o.columns)) {
    return `${o.columns.length} column${o.columns.length !== 1 ? "s" : ""}`;
  }
  if (Array.isArray(o.databases)) {
    return `${o.databases.length} database${o.databases.length !== 1 ? "s" : ""}`;
  }
  if (Array.isArray(o.tables)) {
    return `${o.tables.length} table${o.tables.length !== 1 ? "s" : ""}`;
  }

  return null;
}

function formatOutputForDisplay(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;

  if (Array.isArray(output)) {
    const items = output.length > 10 ? output.slice(0, 10) : output;
    const json = JSON.stringify(items, null, 2);
    return output.length > 10
      ? json + `\n// … and ${output.length - 10} more`
      : json;
  }

  const o = { ...(output as Record<string, unknown>) };
  if (o.success === true) delete o.success;

  if (Array.isArray(o.data) && o.data.length > 10) {
    const total = o.data.length;
    o.data = o.data.slice(0, 10);
    o._truncated = `Showing 10 of ${total} rows`;
  }

  const keys = Object.keys(o);
  if (keys.length === 0) return "";
  if (keys.length === 1) {
    const val = o[keys[0]];
    if (typeof val === "string") return val;
  }

  return JSON.stringify(o, null, 2);
}

// ── Animations ───────────────────────────────────────────────

const pulseKf = keyframes`
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.35); }
`;

const titleShimmerKf = keyframes`
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
`;

// ── Component ────────────────────────────────────────────────

// Terminal states: once the tool call reaches one of these, `input` and
// `output` are immutable. useChat's `experimental_throttle` still hands us
// fresh cloned `input` / `output` object references on every tick while the
// active assistant message streams below, but the contents never change —
// so a reference-equality memo comparator (like we had before) would
// needlessly re-render every already-completed card ~20×/sec and make them
// feel unresponsive (scroll jitters, expand toggle lags). Checking state is
// enough to bail out here because the parent also uses `toolCallId` as the
// React key, so a truly different tool call would remount and reset memo.
const TERMINAL_TOOL_STATES = new Set<ToolPartState>([
  "output-available",
  "error",
]);

function toolInputSignature(input: unknown): string {
  // Only called while the tool is still active (non-terminal state), so the
  // payload is small (just the fields being streamed into). JSON.stringify
  // is plenty fast here and gives us stable value equality across clones.
  try {
    return JSON.stringify(input ?? null);
  } catch {
    // Circular / non-serializable → conservatively force a re-render.
    return `__unserializable_${Math.random()}`;
  }
}

export const StreamingToolCard = React.memo(
  function StreamingToolCard({
    toolName,
    state,
    input,
    output,
    labelOverride,
    leadingIconUrl,
    leadingIconAlt,
    bodyPreview,
    onTitleClick,
    onDetailClick,
  }: StreamingToolCardProps) {
    const config = getToolConfig(toolName);
    const muiTheme = useMuiTheme();
    const isDark = muiTheme.palette.mode === "dark";
    const syntaxTheme = isDark ? tomorrow : prism;

    const codeContainerRef = useRef<HTMLDivElement>(null);
    const [userScrolled, setUserScrolled] = useState(false);

    const isStreaming = state === "input-streaming";
    const isExecuting =
      state === "input-available" || state === "output-streaming";
    const isOutputAvailable = state === "output-available";
    const isStateError = state === "error";

    const hasFailedOutput =
      isOutputAvailable &&
      output !== null &&
      output !== undefined &&
      ((output as Record<string, unknown>).success === false ||
        Boolean((output as Record<string, unknown>).error) ||
        Boolean((output as Record<string, unknown>).queryError) ||
        Boolean((output as Record<string, unknown>).renderError));

    const isDone = isOutputAvailable && !hasFailedOutput;
    const isError = isStateError || hasFailedOutput;
    const isActive = isStreaming || isExecuting;

    const hasCodePreview = Boolean(config.preview);

    const [expanded, setExpanded] = useState(
      hasCodePreview ? !isDone && !isError : false,
    );

    useEffect(() => {
      if ((isDone || isError) && hasCodePreview) {
        const timer = setTimeout(() => setExpanded(false), 800);
        return () => clearTimeout(timer);
      }
      if (isActive && hasCodePreview) {
        setExpanded(true);
        setUserScrolled(false);
      }
    }, [isDone, isError, isActive, hasCodePreview]);

    // Resolve code preview content (supports both string and object fields)
    const inputObj = input as Record<string, unknown> | undefined;
    const rawContent = config.preview
      ? inputObj?.[config.preview.field]
      : undefined;
    const defaultCode =
      typeof rawContent === "string"
        ? rawContent
        : rawContent && typeof rawContent === "object"
          ? JSON.stringify(rawContent, null, 2)
          : "";
    const code = bodyPreview?.content ?? defaultCode;
    const codeLanguage =
      bodyPreview?.language ?? config.preview?.language ?? "text";

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

    const label = labelOverride ?? config.getLabel(input);

    const outputSummary = useMemo(
      () => (isDone || isError ? getOutputSummary(output) : null),
      [isDone, isError, output],
    );

    const formattedOutput = useMemo(
      () => (isDone || isError ? formatOutputForDisplay(output) : ""),
      [isDone, isError, output],
    );
    const outputLang =
      formattedOutput.startsWith("{") || formattedOutput.startsWith("[")
        ? "json"
        : "text";

    const hasVisibleBody =
      code.length > 0 || ((isDone || isError) && formattedOutput.length > 0);

    const canExpand = hasVisibleBody;

    const statusText = isStreaming
      ? "Generating…"
      : isExecuting
        ? "Running…"
        : isDone
          ? (outputSummary ?? "Done")
          : isError
            ? (outputSummary ?? "Error")
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
          className="tool-card-header"
          onClick={() => {
            if (canExpand) {
              setExpanded(prev => !prev);
            } else {
              onDetailClick?.();
            }
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
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: ICON_SIZE + 3,
              height: ICON_SIZE + 3,
              flexShrink: 0,
              color: isActive ? "primary.main" : "text.secondary",
              "& .tool-card-leading-icon, & .tool-card-chevron-icon": {
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "opacity 0.12s ease",
              },
              "& .tool-card-leading-icon": {
                opacity: canExpand && expanded ? 0 : 1,
              },
              "& .tool-card-chevron-icon": {
                opacity: canExpand ? (expanded ? 1 : 0) : 0,
              },
              ...(canExpand && {
                ".tool-card-header:hover & .tool-card-leading-icon": {
                  opacity: 0,
                },
                ".tool-card-header:hover & .tool-card-chevron-icon": {
                  opacity: 1,
                },
              }),
            }}
          >
            <Box className="tool-card-leading-icon">
              {leadingIconUrl ? (
                <Box
                  component="img"
                  src={leadingIconUrl}
                  alt={leadingIconAlt ?? ""}
                  sx={{
                    width: ICON_SIZE + 3,
                    height: ICON_SIZE + 3,
                    objectFit: "contain",
                    display: "block",
                  }}
                  draggable={false}
                />
              ) : labelOverride ? (
                <SquareTerminal size={ICON_SIZE + 2} strokeWidth={1.6} />
              ) : (
                renderToolIcon(config.icon)
              )}
            </Box>
            <Box className="tool-card-chevron-icon">
              {expanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </Box>
          </Box>

          <Typography
            component={onTitleClick ? "button" : "span"}
            onClick={(event: React.MouseEvent<HTMLElement>) => {
              if (!onTitleClick) return;
              event.stopPropagation();
              onTitleClick();
            }}
            variant="caption"
            sx={{
              fontWeight: 500,
              flex: 1,
              color: "text.primary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.75rem",
              ...(isStreaming && {
                background: theme =>
                  theme.palette.mode === "dark"
                    ? "linear-gradient(90deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.95) 45%, rgba(255,255,255,0.55) 90%)"
                    : "linear-gradient(90deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.9) 45%, rgba(0,0,0,0.45) 90%)",
                backgroundSize: "200% 100%",
                backgroundClip: "text",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                animation: `${titleShimmerKf} 1.6s linear infinite`,
              }),
              ...(onTitleClick && {
                p: 0,
                border: 0,
                backgroundColor: "transparent",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: "inherit",
                lineHeight: "inherit",
                "&:hover": {
                  textDecoration: "underline",
                },
              }),
            }}
          >
            {label}
          </Typography>

          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <Typography
              variant="caption"
              sx={{
                color: isError ? "error.main" : "text.secondary",
                fontSize: "0.7rem",
                maxWidth: 180,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
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

        {/* Expandable body: code preview + output */}
        <Collapse in={expanded && hasVisibleBody} timeout={300}>
          {/* Code preview */}
          {code.length > 0 && (
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
                language={codeLanguage}
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
          )}

          {/* Output */}
          {(isDone || isError) && formattedOutput.length > 0 && (
            <Box
              sx={{
                maxHeight: 200,
                overflow: "auto",
                borderTop: 1,
                borderColor: isError ? "error.main" : "divider",
                ...(isError && {
                  backgroundColor: isDark
                    ? "rgba(244,67,54,0.06)"
                    : "rgba(244,67,54,0.04)",
                }),
              }}
            >
              <SyntaxHighlighter
                style={syntaxTheme}
                language={outputLang}
                PreTag="div"
                customStyle={{
                  fontSize: "0.75rem",
                  margin: 0,
                  padding: "0.75rem",
                  background: "transparent",
                  overflow: "visible",
                }}
              >
                {formattedOutput}
              </SyntaxHighlighter>
            </Box>
          )}
        </Collapse>
      </Box>
    );
  },
  (prev, next) => {
    // Defensive: if the logical tool call changed, always re-render. In the
    // normal case the parent keys by toolCallId so this branch is dead, but
    // it protects us if the key strategy ever regresses.
    if (prev.toolCallId !== next.toolCallId) return false;
    if (prev.toolName !== next.toolName) return false;
    if (prev.state !== next.state) return false;
    if (prev.labelOverride !== next.labelOverride) return false;
    if (prev.leadingIconUrl !== next.leadingIconUrl) return false;
    if (prev.leadingIconAlt !== next.leadingIconAlt) return false;
    if (prev.bodyPreview?.content !== next.bodyPreview?.content) return false;
    if (prev.bodyPreview?.language !== next.bodyPreview?.language) return false;

    // Terminal states are immutable. Even if useChat handed us new cloned
    // references for `input` / `output` this tick, the contents are the
    // same — skip the render.
    if (TERMINAL_TOOL_STATES.has(next.state)) return true;

    // Non-terminal (input-streaming / input-available / output-streaming):
    // reference-equality first for the fast path, then fall back to value
    // equality so growing streamed input fields still trigger re-renders.
    if (prev.input === next.input && prev.output === next.output) return true;
    if (toolInputSignature(prev.input) !== toolInputSignature(next.input)) {
      return false;
    }
    if (toolInputSignature(prev.output) !== toolInputSignature(next.output)) {
      return false;
    }
    return true;
  },
);
