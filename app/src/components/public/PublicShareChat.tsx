import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  CircularProgress,
  IconButton,
  Paper,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { Database, Send, Sparkles, Square, X } from "lucide-react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  terminateTrackedDuckDBInstance,
  loadParquetTable,
  loadJsonTable,
  dropTable,
  describeTable,
  listTables,
  queryDuckDB,
  collectStreamBytes,
} from "../../lib/duckdb";
import StreamingMarkdown from "../StreamingMarkdown";
import type { PublicDashboardContent } from "./PublicDashboardViewer";
import type { PublicAppContent } from "./PublicAppViewer";

/**
 * Anonymous "Ask AI" panel for public share links (/share/:token).
 *
 * Loads the same data the viewer can see into a private browser-local DuckDB
 * instance, then chats with a read-only agent via POST /api/share/:token/chat.
 * The agent's only tool (`query_data`) runs HERE, against this local DuckDB —
 * so it can never reach data the viewer couldn't already see, and no SQL ever
 * runs server-side. Ephemeral: nothing is persisted.
 */

type ShareContent = PublicDashboardContent | PublicAppContent;

interface TableSpec {
  name: string;
  label?: string;
  rowCount: number | null;
  load: (db: AsyncDuckDB) => Promise<void>;
}

interface TableContext {
  name: string;
  label?: string;
  rowCount?: number | null;
  columns: Array<{ name: string; type: string }>;
  sampleRows?: Record<string, unknown>[];
}

/** Drop BigInt / non-JSON values so request + tool-result bodies serialize. */
function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  ) as T;
}

async function fetchParquetBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok || !res.body) throw new Error("Failed to load data");
  return collectStreamBytes(res.body);
}

function dashboardTableSpecs(content: PublicDashboardContent): TableSpec[] {
  return content.dataSources
    .filter(ds => ds.ready && ds.artifactUrl)
    .map(ds => ({
      name: ds.tableRef,
      label: ds.name,
      rowCount: ds.rowCount,
      load: async db => {
        const buffer = await fetchParquetBytes(ds.artifactUrl as string);
        await dropTable(db, ds.tableRef).catch(() => undefined);
        await loadParquetTable(db, ds.tableRef, buffer);
      },
    }));
}

function appTableSpecs(content: PublicAppContent, token: string): TableSpec[] {
  const specs: TableSpec[] = [];
  for (const binding of content.dataBindings) {
    if (
      binding.materialization === "parquet" &&
      binding.ready &&
      binding.artifactUrl
    ) {
      specs.push({
        name: binding.name,
        label: binding.name,
        rowCount: binding.rowCount,
        load: async db => {
          const buffer = await fetchParquetBytes(binding.artifactUrl as string);
          await dropTable(db, binding.name).catch(() => undefined);
          await loadParquetTable(db, binding.name, buffer);
        },
      });
    } else if (
      binding.materialization !== "parquet" &&
      content.allowLiveQueries
    ) {
      // Live binding: pull the owner's PUBLISHED query result server-side
      // (read-only, row-capped) and load the rows locally.
      specs.push({
        name: binding.name,
        label: binding.name,
        rowCount: null,
        load: async db => {
          const res = await fetch(
            `/api/share/${token}/binding/${encodeURIComponent(binding.id)}/execute`,
            { method: "POST", credentials: "include" },
          );
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.success) {
            throw new Error(json?.error || `Failed to load "${binding.name}"`);
          }
          const rows = Array.isArray(json.rows) ? json.rows : [];
          await dropTable(db, binding.name).catch(() => undefined);
          if (rows.length > 0) await loadJsonTable(db, binding.name, rows);
        },
      });
    }
  }
  return specs;
}

function tableSpecsFor(content: ShareContent, token: string): TableSpec[] {
  return content.type === "dashboard"
    ? dashboardTableSpecs(content)
    : appTableSpecs(content, token);
}

interface Props {
  token: string;
  content: ShareContent;
}

export default function PublicShareChat({ token, content }: Props) {
  const [open, setOpen] = useState(false);
  const [db, setDb] = useState<AsyncDuckDB | null>(null);
  const [dataState, setDataState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [dataError, setDataError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const tablesContextRef = useRef<TableContext[]>([]);
  const dbRef = useRef<AsyncDuckDB | null>(null);
  dbRef.current = db;

  const chatId = useMemo(() => crypto.randomUUID(), []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `/api/share/${token}/chat`,
        // The unlock cookie is HttpOnly + path-scoped to /api/share.
        fetch: (url, init) =>
          fetch(url as string, { ...init, credentials: "include" }),
        prepareSendMessagesRequest: ({ messages }) => ({
          body: toJsonSafe({
            messages,
            context: { tables: tablesContextRef.current },
          }),
        }),
      }),
    [token],
  );

  const { messages, sendMessage, status, stop, addToolOutput } = useChat({
    id: chatId,
    transport,
    experimental_throttle: 50,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.toolName !== "query_data") return;
      const { sql } = (toolCall.input ?? {}) as { sql?: string };
      // Fire-and-forget: awaiting client work inside onToolCall stalls the SSE
      // finish chunk (see Chat.tsx). Settle asynchronously via addToolOutput.
      void (async () => {
        const output = await runQueryData(dbRef.current, sql ?? "");
        void addToolOutput({
          tool: "query_data",
          toolCallId: toolCall.toolCallId,
          output,
        });
      })();
    },
  });

  // Lazily create DuckDB + load the shared data the first time the panel opens.
  useEffect(() => {
    if (!open || db || dataState === "loading") return;
    let cancelled = false;
    let instance: AsyncDuckDB | null = null;
    setDataState("loading");
    setDataError(null);
    void (async () => {
      try {
        const created = await createDuckDBInstance();
        if (cancelled) {
          void terminateTrackedDuckDBInstance(created, "public-chat-unmount");
          return;
        }
        instance = created;

        const specs = tableSpecsFor(content, token);
        for (const spec of specs) {
          try {
            await spec.load(created);
          } catch {
            // A single failed source shouldn't sink the whole chat; the agent
            // simply won't see that table.
          }
        }

        const present = new Set(await listTables(created));
        const labelByName = new Map(specs.map(s => [s.name, s]));
        const tables: TableContext[] = [];
        for (const name of present) {
          try {
            const columns = await describeTable(created, name);
            let sampleRows: Record<string, unknown>[] = [];
            try {
              const sample = await queryDuckDB(
                created,
                `SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT 3`,
              );
              sampleRows = toJsonSafe(sample.rows);
            } catch {
              /* sampling is best-effort */
            }
            const spec = labelByName.get(name);
            tables.push({
              name,
              label: spec?.label,
              rowCount: spec?.rowCount ?? null,
              columns,
              sampleRows,
            });
          } catch {
            /* skip tables we can't introspect */
          }
        }

        if (cancelled) return;
        tablesContextRef.current = tables;
        setDb(created);
        setDataState(tables.length > 0 ? "ready" : "error");
        if (tables.length === 0) {
          setDataError("No data is available to ask about yet.");
        }
      } catch (e) {
        if (!cancelled) {
          setDataState("error");
          setDataError(
            e instanceof Error ? e.message : "Failed to prepare the data",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      if (instance && !db) {
        void terminateTrackedDuckDBInstance(instance, "public-chat-unmount");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Terminate DuckDB on unmount.
  useEffect(() => {
    return () => {
      if (dbRef.current) {
        void terminateTrackedDuckDBInstance(
          dbRef.current,
          "public-chat-unmount",
        );
      }
    };
  }, []);

  const isBusy = status === "submitted" || status === "streaming";

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy || dataState !== "ready") return;
    setInput("");
    void sendMessage({ text });
  }, [input, isBusy, dataState, sendMessage]);

  if (!open) {
    return (
      <Tooltip title="Ask AI about this data">
        <IconButton
          onClick={() => setOpen(true)}
          sx={{
            position: "fixed",
            right: 20,
            bottom: 20,
            zIndex: 1300,
            bgcolor: "primary.main",
            color: "primary.contrastText",
            boxShadow: 3,
            "&:hover": { bgcolor: "primary.dark" },
          }}
        >
          <Sparkles size={20} />
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <Paper
      elevation={8}
      sx={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: { xs: "100%", sm: 400 },
        zIndex: 1300,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid",
        borderColor: "divider",
        borderRadius: 0,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Sparkles size={18} />
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 600 }}>
          Ask AI
        </Typography>
        <IconButton size="small" onClick={() => setOpen(false)}>
          <X size={18} />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1.5 }}>
        {dataState === "loading" && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1.5,
              py: 4,
            }}
          >
            <CircularProgress size={22} />
            <Typography variant="caption" color="text.secondary">
              Preparing the data…
            </Typography>
          </Box>
        )}

        {dataState === "error" && (
          <Typography variant="body2" color="error" sx={{ py: 2 }}>
            {dataError || "Something went wrong."}
          </Typography>
        )}

        {dataState === "ready" && messages.length === 0 && (
          <Box sx={{ color: "text.secondary", py: 2 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              Ask a question about &ldquo;{content.title}&rdquo;.
            </Typography>
            <Typography variant="caption">
              For example: &ldquo;What&apos;s the total?&rdquo;, &ldquo;Which
              category is largest?&rdquo;, or &ldquo;Summarize the trend.&rdquo;
            </Typography>
          </Box>
        )}

        {messages.map(message => (
          <MessageBubble
            key={message.id}
            role={message.role}
            parts={message.parts as MessagePart[]}
            streaming={isBusy && message === messages[messages.length - 1]}
          />
        ))}
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          p: 1.5,
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <TextField
          fullWidth
          size="small"
          multiline
          maxRows={5}
          placeholder={
            dataState === "ready" ? "Ask about this data…" : "Loading data…"
          }
          value={input}
          disabled={dataState !== "ready"}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        {isBusy ? (
          <Tooltip title="Stop">
            <IconButton color="primary" onClick={() => void stop()}>
              <Square size={18} />
            </IconButton>
          </Tooltip>
        ) : (
          <IconButton
            color="primary"
            disabled={!input.trim() || dataState !== "ready"}
            onClick={handleSend}
          >
            <Send size={18} />
          </IconButton>
        )}
      </Box>
    </Paper>
  );
}

// ── Tool execution (client-side DuckDB) ──

interface QueryDataResult {
  success: boolean;
  error?: string;
  rows?: Record<string, unknown>[];
  fields?: Array<{ name: string; type: string }>;
  rowCount?: number;
  truncated?: boolean;
}

const QUERY_ROW_CAP = 200;

async function runQueryData(
  db: AsyncDuckDB | null,
  sql: string,
): Promise<QueryDataResult> {
  if (!db) return { success: false, error: "The data is not ready yet." };
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return { success: false, error: "Empty query." };
  if (!/^\s*(select|with)\b/i.test(trimmed)) {
    return {
      success: false,
      error: "Only read-only SELECT queries are allowed.",
    };
  }
  if (/;/.test(trimmed)) {
    return { success: false, error: "Only a single statement is allowed." };
  }
  try {
    const result = await queryDuckDB(db, trimmed);
    const rows = result.rows.slice(0, QUERY_ROW_CAP);
    return {
      success: true,
      rows: toJsonSafe(rows),
      fields: result.fields,
      rowCount: result.rowCount,
      truncated: result.rows.length > QUERY_ROW_CAP,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Query failed",
    };
  }
}

// ── Rendering ──

interface MessagePart {
  type: string;
  text?: string;
  state?: string;
}

function MessageBubble({
  role,
  parts,
  streaming,
}: {
  role: string;
  parts: MessagePart[];
  streaming: boolean;
}) {
  const isUser = role === "user";
  const textParts = parts.filter(p => p.type === "text" && p.text);
  const hasToolActivity = parts.some(p => p.type?.startsWith("tool-"));
  const toolDone = parts.some(
    p => p.type?.startsWith("tool-") && p.state === "output-available",
  );

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        mb: 1.5,
      }}
    >
      <Box
        sx={{
          maxWidth: "92%",
          px: 1.5,
          py: 1,
          borderRadius: 2,
          bgcolor: isUser ? "primary.main" : "action.hover",
          color: isUser ? "primary.contrastText" : "text.primary",
          "& p": { m: 0 },
          "& p + p": { mt: 1 },
          fontSize: 14,
          wordBreak: "break-word",
        }}
      >
        {!isUser && hasToolActivity && textParts.length === 0 && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              color: "text.secondary",
            }}
          >
            <Database size={14} />
            <Typography variant="caption">
              {toolDone ? "Analyzed the data" : "Querying the data…"}
            </Typography>
          </Box>
        )}
        {textParts.map((part, i) =>
          isUser ? (
            <Typography key={i} variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
              {part.text}
            </Typography>
          ) : (
            <StreamingMarkdown key={i} isStreaming={streaming}>
              {part.text as string}
            </StreamingMarkdown>
          ),
        )}
      </Box>
    </Box>
  );
}
