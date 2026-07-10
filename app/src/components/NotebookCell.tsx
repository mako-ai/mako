import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  useTheme,
} from "@mui/material";
import Editor from "@monaco-editor/react";
import { ChevronDown, ChevronUp, Play, Trash2 } from "lucide-react";

import type { NotebookBlock, NotebookBlockType } from "../store/notebookStore";
import type { Connection } from "../store/schemaStore";
import { useConsoleStore } from "../store/consoleStore";
import {
  executeCode,
  startKernelSession,
  type KernelOutput,
} from "../notebook-runtime/kernel";
import KernelOutputView from "./KernelOutputView";
import ResultsTable from "./ResultsTable";
import { StreamingMarkdown } from "./StreamingMarkdown";

const MONACO_LANGUAGE: Record<NotebookBlockType, string | null> = {
  code: "python",
  sql: "sql",
  markdown: null,
};

/** Size a code/SQL editor to its content, clamped so long cells scroll. */
function editorHeight(source: string): number {
  const lines = Math.max(source.split("\n").length, 2);
  return Math.min(lines * 19 + 16, 360);
}

/** The `results`-prop shape ResultsTable expects (see Editor's execute path). */
interface CellResult {
  results: unknown[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
  pageInfo: null;
  currentPage: number;
}

interface NotebookCellProps {
  block: NotebookBlock;
  index: number;
  count: number;
  notebookId: string;
  workspaceId: string | null;
  sources: Connection[];
  onChange: (patch: Partial<NotebookBlock>) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
}

export default function NotebookCell({
  block,
  index,
  count,
  notebookId,
  workspaceId,
  sources,
  onChange,
  onDelete,
  onMove,
}: NotebookCellProps) {
  const theme = useTheme();
  const monacoLanguage = MONACO_LANGUAGE[block.type];

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CellResult | null>(null);
  const [kernelOutputs, setKernelOutputs] = useState<KernelOutput[]>([]);
  const [editingMarkdown, setEditingMarkdown] = useState(false);

  const canRunSql =
    block.type === "sql" &&
    !!workspaceId &&
    !!block.connectionId &&
    block.source.trim().length > 0 &&
    !running;

  const canRunCode =
    block.type === "code" &&
    !!workspaceId &&
    block.source.trim().length > 0 &&
    !running;

  // Run a Python cell: ensure the notebook's kernel session exists, then stream
  // execution outputs into the cell as they arrive.
  const runCode = async () => {
    if (!workspaceId) return;
    setRunning(true);
    setError(null);
    setKernelOutputs([]);
    const collected: KernelOutput[] = [];
    try {
      await startKernelSession(workspaceId, notebookId);
      await executeCode(workspaceId, notebookId, block.source, output => {
        collected.push(output);
        setKernelOutputs([...collected]);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed");
    } finally {
      setRunning(false);
    }
  };

  const runSql = async () => {
    if (!workspaceId || !block.connectionId) return;
    setRunning(true);
    setError(null);
    const start = Date.now();
    try {
      const res = await useConsoleStore
        .getState()
        .executeQuery(workspaceId, block.connectionId, block.source, {
          pageSize: 500,
        });
      if (!res.success) {
        setError(typeof res.error === "string" ? res.error : "Query failed");
        setResult(null);
        return;
      }
      const rows = (res as { rows?: unknown[] }).rows ?? [];
      const fields = (
        res as {
          fields?: Array<{ name?: string; originalName?: string } | string>;
        }
      ).fields;
      setResult({
        results: rows,
        executedAt: new Date().toISOString(),
        resultCount: rows.length,
        executionTime: Date.now() - start,
        fields,
        pageInfo: null,
        currentPage: 1,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Query failed");
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Box
      sx={{
        mb: 1.5,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        overflow: "hidden",
        "&:hover .cell-actions": { opacity: 1 },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 0.5,
          py: 0.25,
          bgcolor: "action.hover",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Select
          value={block.type}
          size="small"
          variant="standard"
          disableUnderline
          onChange={e =>
            onChange({ type: e.target.value as NotebookBlockType })
          }
          sx={{
            fontSize: "0.68rem",
            letterSpacing: 0.5,
            textTransform: "uppercase",
            ".MuiSelect-select": { py: 0.25, pl: 1, pr: 3 },
          }}
        >
          <MenuItem value="code">Python</MenuItem>
          <MenuItem value="sql">SQL</MenuItem>
          <MenuItem value="markdown">Markdown</MenuItem>
        </Select>

        <Box sx={{ flex: 1 }} />

        <Box
          className="cell-actions"
          sx={{ display: "flex", opacity: 0, transition: "opacity 120ms" }}
        >
          <Tooltip title="Move up">
            <span>
              <IconButton
                size="small"
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ChevronUp size={15} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Move down">
            <span>
              <IconButton
                size="small"
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                <ChevronDown size={15} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Delete cell">
            <IconButton size="small" onClick={onDelete}>
              <Trash2 size={15} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* SQL run toolbar: pick a source, run against it (control-plane preview). */}
      {block.type === "sql" && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1,
            py: 0.5,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Select
            size="small"
            displayEmpty
            value={block.connectionId ?? ""}
            onChange={e =>
              onChange({ connectionId: e.target.value || undefined })
            }
            sx={{ minWidth: 180, fontSize: "0.8rem" }}
          >
            <MenuItem value="" disabled>
              Select a data source…
            </MenuItem>
            {sources.map(s => (
              <MenuItem key={s.id} value={s.id} sx={{ fontSize: "0.8rem" }}>
                {s.displayName || s.name}
              </MenuItem>
            ))}
          </Select>
          <Tooltip
            title={
              !block.connectionId
                ? "Pick a data source first"
                : "Run (read-only preview, first 500 rows)"
            }
          >
            <span>
              <Button
                size="small"
                variant="contained"
                disableElevation
                startIcon={
                  running ? (
                    <CircularProgress size={13} color="inherit" />
                  ) : (
                    <Play size={13} />
                  )
                }
                disabled={!canRunSql}
                onClick={() => void runSql()}
                sx={{ textTransform: "none" }}
              >
                Run
              </Button>
            </span>
          </Tooltip>
        </Box>
      )}

      {/* Python run toolbar: execute on the notebook's GKE kernel. */}
      {block.type === "code" && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 1,
            py: 0.5,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Tooltip title="Run on the notebook kernel (Python)">
            <span>
              <Button
                size="small"
                variant="contained"
                disableElevation
                startIcon={
                  running ? (
                    <CircularProgress size={13} color="inherit" />
                  ) : (
                    <Play size={13} />
                  )
                }
                disabled={!canRunCode}
                onClick={() => void runCode()}
                sx={{ textTransform: "none" }}
              >
                Run
              </Button>
            </span>
          </Tooltip>
        </Box>
      )}

      {monacoLanguage ? (
        <Editor
          language={monacoLanguage}
          value={block.source}
          onChange={value => onChange({ source: value ?? "" })}
          theme={theme.palette.mode === "dark" ? "vs-dark" : "light"}
          height={editorHeight(block.source)}
          options={{
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            fontSize: 13,
            folding: false,
            wordWrap: "on",
            automaticLayout: true,
            scrollbar: { alwaysConsumeMouseWheel: false },
            padding: { top: 8, bottom: 8 },
          }}
        />
      ) : editingMarkdown || !block.source.trim() ? (
        <TextField
          value={block.source}
          onChange={e => onChange({ source: e.target.value })}
          onBlur={() => setEditingMarkdown(false)}
          placeholder="Markdown… (**bold**, # headings, lists, `code`)"
          autoFocus={editingMarkdown}
          multiline
          fullWidth
          minRows={2}
          variant="standard"
          InputProps={{
            disableUnderline: true,
            sx: { fontSize: "0.85rem", p: 1, alignItems: "flex-start" },
          }}
        />
      ) : (
        <Box
          onClick={() => setEditingMarkdown(true)}
          sx={{
            p: 1,
            cursor: "text",
            fontSize: "0.9rem",
            "& > :first-of-type": { mt: 0 },
            "& > :last-child": { mb: 0 },
          }}
        >
          <StreamingMarkdown>{block.source}</StreamingMarkdown>
        </Box>
      )}

      {/* SQL results / error, inline under the cell. */}
      {block.type === "sql" && (error || result) && (
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          {error ? (
            <Alert
              severity="error"
              sx={{ borderRadius: 0, fontSize: "0.8rem" }}
            >
              {error}
            </Alert>
          ) : (
            <Box sx={{ height: 320, position: "relative" }}>
              <ResultsTable results={result} />
            </Box>
          )}
        </Box>
      )}

      {/* Python kernel outputs / error, inline under the cell. */}
      {block.type === "code" && error && (
        <Alert severity="error" sx={{ borderRadius: 0, fontSize: "0.8rem" }}>
          {error}
        </Alert>
      )}
      {block.type === "code" && !error && (
        <KernelOutputView outputs={kernelOutputs} />
      )}
    </Box>
  );
}
