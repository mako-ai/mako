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

interface ToolConfig {
  getLabel: (input?: unknown) => string;
  icon: React.ReactNode;
  preview?: { field: string; language: string };
}

const ICON_SIZE = 13;

const TOOL_CONFIG: Record<string, ToolConfig> = {
  // ── Console ──────────────────────────────────────────────
  modify_console: {
    getLabel: input => {
      const action = (input as Record<string, unknown>)?.action;
      return action === "patch" ? "Patching console" : "Editing console";
    },
    icon: <Pencil size={ICON_SIZE} />,
    preview: { field: "content", language: "sql" },
  },
  create_console: {
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating "${title}"` : "Creating console";
    },
    icon: <Plus size={ICON_SIZE} />,
    preview: { field: "content", language: "sql" },
  },
  read_console: {
    getLabel: () => "Reading console",
    icon: <Eye size={ICON_SIZE} />,
  },
  list_open_consoles: {
    getLabel: () => "Listing open consoles",
    icon: <List size={ICON_SIZE} />,
  },
  set_console_connection: {
    getLabel: () => "Setting connection",
    icon: <Link size={ICON_SIZE} />,
  },
  open_console: {
    getLabel: () => "Opening console",
    icon: <ExternalLink size={ICON_SIZE} />,
  },

  // ── SQL ──────────────────────────────────────────────────
  sql_execute_query: {
    getLabel: () => "Executing SQL query",
    icon: <Play size={ICON_SIZE} />,
    preview: { field: "query", language: "sql" },
  },
  sql_list_connections: {
    getLabel: () => "Listing SQL connections",
    icon: <Database size={ICON_SIZE} />,
  },
  sql_list_databases: {
    getLabel: () => "Listing databases",
    icon: <Database size={ICON_SIZE} />,
  },
  sql_list_tables: {
    getLabel: input => {
      const db = (input as Record<string, unknown>)?.database;
      return db ? `Listing tables in ${db}` : "Listing tables";
    },
    icon: <Table2 size={ICON_SIZE} />,
  },
  sql_inspect_table: {
    getLabel: input => {
      const table = (input as Record<string, unknown>)?.table;
      return table ? `Inspecting ${table}` : "Inspecting table";
    },
    icon: <Search size={ICON_SIZE} />,
  },

  // ── MongoDB ──────────────────────────────────────────────
  mongo_execute_query: {
    getLabel: () => "Executing MongoDB query",
    icon: <Play size={ICON_SIZE} />,
    preview: { field: "query", language: "javascript" },
  },
  mongo_list_connections: {
    getLabel: () => "Listing MongoDB connections",
    icon: <Database size={ICON_SIZE} />,
  },
  mongo_list_databases: {
    getLabel: () => "Listing databases",
    icon: <Database size={ICON_SIZE} />,
  },
  mongo_list_collections: {
    getLabel: input => {
      const db = (input as Record<string, unknown>)?.databaseName;
      return db ? `Listing collections in ${db}` : "Listing collections";
    },
    icon: <Table2 size={ICON_SIZE} />,
  },
  mongo_inspect_collection: {
    getLabel: input => {
      const coll = (input as Record<string, unknown>)?.collectionName;
      return coll ? `Inspecting ${coll}` : "Inspecting collection";
    },
    icon: <Search size={ICON_SIZE} />,
  },

  // ── Universal discovery ──────────────────────────────────
  list_connections: {
    getLabel: () => "Listing connections",
    icon: <Database size={ICON_SIZE} />,
  },

  // ── Chart ────────────────────────────────────────────────
  modify_chart_spec: {
    getLabel: () => "Setting chart specification",
    icon: <BarChart3 size={ICON_SIZE} />,
    preview: { field: "vegaLiteSpec", language: "json" },
  },

  // ── Dashboard ────────────────────────────────────────────
  list_open_dashboards: {
    getLabel: () => "Listing open dashboards",
    icon: <List size={ICON_SIZE} />,
  },
  search_dashboards: {
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query
        ? `Searching dashboards: "${query}"`
        : "Searching dashboards";
    },
    icon: <Search size={ICON_SIZE} />,
  },
  open_dashboard: {
    getLabel: () => "Opening dashboard",
    icon: <ExternalLink size={ICON_SIZE} />,
  },
  create_dashboard: {
    getLabel: input => {
      const title = (input as Record<string, unknown>)?.title;
      return title ? `Creating dashboard "${title}"` : "Creating dashboard";
    },
    icon: <Plus size={ICON_SIZE} />,
  },
  add_widget: {
    getLabel: input => {
      const type = (input as Record<string, unknown>)?.type;
      return type ? `Adding ${type} widget` : "Adding widget";
    },
    icon: <Plus size={ICON_SIZE} />,
    preview: { field: "localSql", language: "sql" },
  },
  modify_widget: {
    getLabel: () => "Modifying widget",
    icon: <Pencil size={ICON_SIZE} />,
    preview: { field: "localSql", language: "sql" },
  },
  remove_widget: {
    getLabel: () => "Removing widget",
    icon: <Trash2 size={ICON_SIZE} />,
  },
  create_data_source: {
    getLabel: input => {
      const name = (input as Record<string, unknown>)?.name;
      return name ? `Creating data source "${name}"` : "Creating data source";
    },
    icon: <Plus size={ICON_SIZE} />,
    preview: { field: "code", language: "sql" },
  },
  update_data_source_query: {
    getLabel: input => {
      const inp = input as Record<string, unknown>;
      const action = inp?.action;
      const run = inp?.run === true;
      const suffix = run ? "" : " (definition only)";
      if (action === "patch") return `Patching data source query${suffix}`;
      if (action === "append") return `Appending to data source query${suffix}`;
      return `Updating data source query${suffix}`;
    },
    icon: <Pencil size={ICON_SIZE} />,
    preview: { field: "code", language: "sql" },
  },
  run_data_source_query: {
    getLabel: () => "Running data source query",
    icon: <Play size={ICON_SIZE} />,
  },
  import_console_as_data_source: {
    getLabel: () => "Importing console as data source",
    icon: <Download size={ICON_SIZE} />,
  },
  add_data_source: {
    getLabel: () => "Importing data source",
    icon: <Download size={ICON_SIZE} />,
  },
  get_dashboard_state: {
    getLabel: () => "Reading dashboard state",
    icon: <Eye size={ICON_SIZE} />,
  },
  preview_data_source: {
    getLabel: () => "Previewing data",
    icon: <Eye size={ICON_SIZE} />,
    preview: { field: "sql", language: "sql" },
  },
  get_data_preview: {
    getLabel: () => "Previewing data",
    icon: <Eye size={ICON_SIZE} />,
    preview: { field: "sql", language: "sql" },
  },
  suggest_charts: {
    getLabel: () => "Suggesting charts",
    icon: <BarChart3 size={ICON_SIZE} />,
  },
  add_global_filter: {
    getLabel: input => {
      const label = (input as Record<string, unknown>)?.label;
      return label ? `Adding filter "${label}"` : "Adding filter";
    },
    icon: <Filter size={ICON_SIZE} />,
  },
  remove_global_filter: {
    getLabel: () => "Removing filter",
    icon: <Trash2 size={ICON_SIZE} />,
  },
  link_tables: {
    getLabel: () => "Linking tables",
    icon: <Link size={ICON_SIZE} />,
  },
  set_time_dimension: {
    getLabel: () => "Setting time dimension",
    icon: <Clock size={ICON_SIZE} />,
  },

  // ── Search ───────────────────────────────────────────────
  search_consoles: {
    getLabel: input => {
      const query = (input as Record<string, unknown>)?.query;
      return query ? `Searching "${query}"` : "Searching consoles";
    },
    icon: <Search size={ICON_SIZE} />,
  },

  // ── Self-directive / memory ──────────────────────────────
  read_self_directive: {
    getLabel: () => "Reading memory",
    icon: <Brain size={ICON_SIZE} />,
  },
  update_self_directive: {
    getLabel: () => "Updating memory",
    icon: <Brain size={ICON_SIZE} />,
  },

  // ── Flow tools ───────────────────────────────────────────
  get_form_state: {
    getLabel: () => "Reading form state",
    icon: <Eye size={ICON_SIZE} />,
  },
  set_form_field: {
    getLabel: input => {
      const field = (input as Record<string, unknown>)?.fieldName;
      return field ? `Setting ${field}` : "Setting form field";
    },
    icon: <Pencil size={ICON_SIZE} />,
  },
  set_multiple_fields: {
    getLabel: input => {
      const fields = (input as Record<string, unknown>)?.fields;
      const count =
        fields && typeof fields === "object" ? Object.keys(fields).length : 0;
      return count > 0 ? `Setting ${count} fields` : "Setting form fields";
    },
    icon: <Pencil size={ICON_SIZE} />,
  },
  create_flow_tab: {
    getLabel: () => "Creating flow tab",
    icon: <Plus size={ICON_SIZE} />,
  },
  list_flow_tabs: {
    getLabel: () => "Listing flow tabs",
    icon: <List size={ICON_SIZE} />,
  },

  // ── Flow discovery ───────────────────────────────────────
  list_databases: {
    getLabel: () => "Listing databases",
    icon: <Database size={ICON_SIZE} />,
  },
  list_tables: {
    getLabel: () => "Listing tables",
    icon: <Table2 size={ICON_SIZE} />,
  },
  inspect_table: {
    getLabel: input => {
      const table = (input as Record<string, unknown>)?.table;
      return table ? `Inspecting ${table}` : "Inspecting table";
    },
    icon: <Search size={ICON_SIZE} />,
  },
  execute_query: {
    getLabel: () => "Executing query",
    icon: <Play size={ICON_SIZE} />,
    preview: { field: "query", language: "sql" },
  },
  validate_query: {
    getLabel: () => "Validating query",
    icon: <ShieldCheck size={ICON_SIZE} />,
    preview: { field: "query", language: "sql" },
  },
  explain_template: {
    getLabel: input => {
      const ph = (input as Record<string, unknown>)?.placeholder;
      return ph ? `Explaining {{${ph}}}` : "Explaining template";
    },
    icon: <HelpCircle size={ICON_SIZE} />,
  },
};

// ── Helpers ──────────────────────────────────────────────────

function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function getToolConfig(toolName: string): ToolConfig {
  return (
    TOOL_CONFIG[toolName] ?? {
      getLabel: () => humanizeToolName(toolName),
      icon: <Wrench size={ICON_SIZE} />,
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

// ── Component ────────────────────────────────────────────────

export const StreamingToolCard = React.memo(
  function StreamingToolCard({
    toolName,
    state,
    input,
    output,
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
    const code =
      typeof rawContent === "string"
        ? rawContent
        : rawContent && typeof rawContent === "object"
          ? JSON.stringify(rawContent, null, 2)
          : "";

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

    const label = config.getLabel(input);

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
          onClick={() => {
            if ((isDone || isError) && hasVisibleBody) {
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
              display: "flex",
              alignItems: "center",
              color: isActive ? "primary.main" : "text.secondary",
            }}
          >
            {(isDone || isError) && hasVisibleBody ? (
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
            sx={{
              fontWeight: 500,
              flex: 1,
              color: "text.primary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
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
                language={config.preview?.language ?? "text"}
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
  (prev, next) =>
    prev.toolName === next.toolName &&
    prev.state === next.state &&
    prev.input === next.input &&
    prev.output === next.output,
);
