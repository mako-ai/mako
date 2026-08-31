import { useState } from "react";
import {
  Alert,
  Avatar,
  AvatarGroup,
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  TextField,
  Tooltip,
} from "@mui/material";
import Editor from "@monaco-editor/react";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import { ChevronDown, ChevronUp, Play, Trash2 } from "lucide-react";

import type { NotebookBlock, NotebookBlockType } from "../store/notebookStore";
import type { Connection } from "../store/schemaStore";
import type { KernelOutput } from "../notebook-runtime/kernel";
import {
  presenceColor,
  presenceInitials,
  type NotebookViewer,
} from "../store/notebookPresenceStore";
import { runCell } from "../notebook-runtime/run";
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
  /** True while a batch "Run all" is executing this cell. */
  isRunning?: boolean;
  /** Remote collaborators whose cursor is on this cell (soft-lock indicator). */
  remoteViewers?: NotebookViewer[];
  /** Called when the local user focuses this cell (drives their live cursor). */
  onFocus?: () => void;
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
  isRunning = false,
  remoteViewers,
  onFocus,
  onChange,
  onDelete,
  onMove,
}: NotebookCellProps) {
  const monacoTheme = useMonacoTheme();
  const monacoLanguage = MONACO_LANGUAGE[block.type];

  const [localRunning, setLocalRunning] = useState(false);
  // Live streaming buffer for the current Python run this session; when null we
  // render the persisted outputs off `block.outputs` (the source of truth).
  const [liveOutputs, setLiveOutputs] = useState<KernelOutput[] | null>(null);
  const [editingMarkdown, setEditingMarkdown] = useState(false);

  // Running = this cell's own run, or a batch "Run all" driven by the parent.
  const running = localRunning || isRunning;

  // Persisted outputs (survive reload; also reflect agent/collab writes).
  const codeOutputs =
    liveOutputs ??
    ((block.outputs ?? []).filter(o => o.type !== "sql") as KernelOutput[]);
  const sqlOutput = block.outputs?.find(o => o.type === "sql");
  const sqlError = block.outputs?.find(o => o.type === "error");
  const sqlResult: CellResult | null =
    sqlOutput && sqlOutput.type === "sql"
      ? {
          results: sqlOutput.rows,
          executedAt: block.executedAt ?? "",
          resultCount: sqlOutput.rowCount,
          executionTime: sqlOutput.executionTime,
          fields: sqlOutput.fields,
          pageInfo: null,
          currentPage: 1,
        }
      : null;

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

  // Run this Python cell: stream outputs live, persisting via runCell.
  const runCode = async () => {
    if (!workspaceId) return;
    setLocalRunning(true);
    setLiveOutputs([]);
    const collected: KernelOutput[] = [];
    await runCell(workspaceId, notebookId, block, {
      onOutput: o => {
        collected.push(o);
        setLiveOutputs([...collected]);
      },
    });
    setLocalRunning(false);
  };

  // Run this SQL cell; runCell persists the result/error to block.outputs.
  const runSql = async () => {
    if (!workspaceId) return;
    setLocalRunning(true);
    setLiveOutputs(null); // SQL renders from persisted block.outputs
    await runCell(workspaceId, notebookId, block);
    setLocalRunning(false);
  };

  const viewersHere = remoteViewers ?? [];
  const lockColor = viewersHere.length
    ? presenceColor(viewersHere[0].userId)
    : null;

  return (
    <Box
      onFocusCapture={onFocus}
      sx={{
        mb: 1.5,
        border: 1,
        borderColor: running ? "primary.main" : (lockColor ?? "divider"),
        borderRadius: 1,
        overflow: "hidden",
        transition: "border-color 120ms",
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

        {viewersHere.length > 0 && (
          <AvatarGroup
            max={3}
            sx={{
              mr: 0.5,
              "& .MuiAvatar-root": {
                width: 18,
                height: 18,
                fontSize: "0.6rem",
                border: "1.5px solid",
                borderColor: "action.hover",
              },
            }}
          >
            {viewersHere.map(v => (
              <Tooltip key={v.clientId} title={`${v.userName} is editing here`}>
                <Avatar sx={{ bgcolor: presenceColor(v.userId) }}>
                  {presenceInitials(v.userName)}
                </Avatar>
              </Tooltip>
            ))}
          </AvatarGroup>
        )}

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
          theme={monacoTheme}
          height={editorHeight(block.source)}
          options={{
            ...EDITOR_OPTIONS.code,
            folding: false,
            wordWrap: "on",
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
            sx: {
              fontSize: "0.85rem",
              p: 1,
              alignItems: "flex-start",
              bgcolor: "background.paper",
            },
          }}
        />
      ) : (
        <Box
          onClick={() => setEditingMarkdown(true)}
          sx={{
            p: 1,
            cursor: "text",
            fontSize: "0.9rem",
            bgcolor: "background.paper",
            "& > :first-of-type": { mt: 0 },
            "& > :last-child": { mb: 0 },
          }}
        >
          <StreamingMarkdown>{block.source}</StreamingMarkdown>
        </Box>
      )}

      {/* SQL result / error, from persisted block.outputs (survives reload). */}
      {block.type === "sql" && (sqlError || sqlResult) && (
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          {sqlError && sqlError.type === "error" ? (
            <Alert
              severity="error"
              sx={{ borderRadius: 0, fontSize: "0.8rem" }}
            >
              {sqlError.evalue}
            </Alert>
          ) : sqlResult ? (
            <Box sx={{ height: 320, position: "relative" }}>
              <ResultsTable results={sqlResult} />
            </Box>
          ) : null}
        </Box>
      )}

      {/* Python kernel outputs: live buffer while running, else persisted. */}
      {block.type === "code" && (
        <KernelOutputView
          outputs={codeOutputs}
          workspaceId={workspaceId}
          notebookId={notebookId}
        />
      )}
    </Box>
  );
}
