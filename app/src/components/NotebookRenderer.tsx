import { useEffect, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputBase,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Eraser,
  FastForward,
  History,
  Notebook as NotebookIcon,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";

import {
  useNotebookStore,
  type NotebookBlockType,
  type NotebookSaveState,
} from "../store/notebookStore";
import { runCell } from "../notebook-runtime/run";
import { stopKernelSession } from "../notebook-runtime/kernel";
import NotebookCell from "./NotebookCell";
import NotebookHistoryDrawer from "./NotebookHistoryDrawer";
import { useConsoleStore } from "../store/consoleStore";
import { useSchemaStore } from "../store/schemaStore";
import { useUIStore } from "../store/uiStore";

const SAVE_LABEL: Record<NotebookSaveState, string> = {
  idle: "",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

interface NotebookRendererProps {
  notebookId: string;
  tabId: string;
}

/**
 * Center-pane editor for a `kind: "notebook"` tab. All edit state + autosave
 * live in `notebookStore.openNotebooks`, so the editor, the AI agent, and (later)
 * live collaboration all mutate one shared document. SQL cells run against a
 * chosen data source; Python cells run once the kernel lands.
 */
export default function NotebookRenderer({
  notebookId,
  tabId,
}: NotebookRendererProps) {
  const doc = useNotebookStore(s => s.openNotebooks[notebookId]);
  const saveState = useNotebookStore(s => s.saveState[notebookId] ?? "idle");
  const openNotebook = useNotebookStore(s => s.openNotebook);
  const renameOpenNotebook = useNotebookStore(s => s.renameOpenNotebook);
  const addCell = useNotebookStore(s => s.addCell);
  const updateCell = useNotebookStore(s => s.updateCell);
  const deleteCell = useNotebookStore(s => s.deleteCell);
  const moveCell = useNotebookStore(s => s.moveCell);
  const clearAllOutputs = useNotebookStore(s => s.clearAllOutputs);
  const updateTabTitle = useConsoleStore(s => s.updateTitle);

  const workspaceId = useUIStore(s => s.currentWorkspaceId) ?? null;
  const connectionsByWs = useSchemaStore(s => s.connections);
  const ensureConnections = useSchemaStore(s => s.ensureConnections);
  const sources = workspaceId ? (connectionsByWs[workspaceId] ?? []) : [];

  const [loading, setLoading] = useState(!doc);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // "Run all" progress: which cell is currently executing (highlights it).
  const [runningAll, setRunningAll] = useState(false);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);

  // Run every runnable cell top-to-bottom; stop on the first error since later
  // cells usually depend on earlier ones (Jupyter "Run all" semantics).
  const runAll = async () => {
    if (!workspaceId || runningAll) return;
    setRunningAll(true);
    try {
      const blocks =
        useNotebookStore.getState().openNotebooks[notebookId]?.blocks ?? [];
      for (const block of blocks) {
        if (block.type === "markdown" || !block.source.trim()) continue;
        setRunningCellId(block.id);
        const res = await runCell(workspaceId, notebookId, block);
        if (!res.ok) break;
      }
    } finally {
      setRunningCellId(null);
      setRunningAll(false);
    }
  };

  const restartKernel = async () => {
    if (workspaceId) await stopKernelSession(workspaceId, notebookId);
  };

  const restartAndRunAll = async () => {
    await restartKernel();
    await runAll();
  };

  useEffect(() => {
    let alive = true;
    void openNotebook(notebookId).finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [notebookId, openNotebook]);

  useEffect(() => {
    if (workspaceId) void ensureConnections(workspaceId);
  }, [workspaceId, ensureConnections]);

  // Keep the tab label, breadcrumb, and browser title in sync with the
  // notebook name — they all read `tab.title`, which was set once when the tab
  // opened, so a rename would otherwise leave them showing "Untitled notebook".
  useEffect(() => {
    if (doc?.name) updateTabTitle(tabId, doc.name);
  }, [doc?.name, tabId, updateTabTitle]);

  const handleAdd = (type: NotebookBlockType) => {
    setAddAnchor(null);
    addCell(notebookId, type);
  };

  if (loading && !doc) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CircularProgress size={22} />
      </Box>
    );
  }

  if (!doc) {
    return (
      <Box sx={{ p: 3, color: "text.secondary" }}>
        <Typography variant="body2">Notebook not found.</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", overflowY: "auto" }}>
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: 0.25,
          px: 2,
          py: 0.75,
          bgcolor: "background.paper",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <NotebookIcon size={18} style={{ flexShrink: 0, opacity: 0.8 }} />
        <InputBase
          value={doc.name}
          onChange={e => renameOpenNotebook(notebookId, e.target.value)}
          placeholder="Untitled notebook"
          sx={{ flex: 1, minWidth: 60, fontSize: "1.05rem", fontWeight: 600 }}
        />
        <Typography
          variant="caption"
          sx={{
            color: saveState === "error" ? "error.main" : "text.secondary",
            whiteSpace: "nowrap",
            mr: 0.5,
          }}
        >
          {SAVE_LABEL[saveState]}
        </Typography>

        {/* Compact run/clear/restart controls, inline with the title. */}
        <Tooltip title="Run all cells">
          <span>
            <IconButton
              size="small"
              disabled={runningAll || !workspaceId}
              onClick={() => void runAll()}
            >
              {runningAll ? <CircularProgress size={16} /> : <Play size={16} />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Restart kernel, then run all">
          <span>
            <IconButton
              size="small"
              disabled={runningAll || !workspaceId}
              onClick={() => void restartAndRunAll()}
            >
              <FastForward size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Clear all outputs">
          <span>
            <IconButton
              size="small"
              disabled={runningAll}
              onClick={() => clearAllOutputs(notebookId)}
            >
              <Eraser size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Restart kernel (clears variables)">
          <span>
            <IconButton
              size="small"
              disabled={runningAll || !workspaceId}
              onClick={() => void restartKernel()}
            >
              <RotateCcw size={16} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Version history">
          <span>
            <IconButton size="small" onClick={() => setHistoryOpen(true)}>
              <History size={16} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <NotebookHistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        notebookId={notebookId}
      />

      <Box sx={{ p: 2 }}>
        {doc.blocks.map((block, index) => (
          <NotebookCell
            key={block.id}
            block={block}
            index={index}
            count={doc.blocks.length}
            notebookId={notebookId}
            workspaceId={workspaceId}
            sources={sources}
            isRunning={runningCellId === block.id}
            onChange={patch => updateCell(notebookId, block.id, patch)}
            onDelete={() => deleteCell(notebookId, block.id)}
            onMove={dir => moveCell(notebookId, index, dir)}
          />
        ))}

        {doc.blocks.length === 0 && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 2, maxWidth: 520 }}
          >
            Empty notebook. Add a cell to get started — SQL runs against a data
            source, Python runs on the kernel, Markdown renders inline.
          </Typography>
        )}

        <Button
          size="small"
          startIcon={<Plus size={16} />}
          onClick={e => setAddAnchor(e.currentTarget)}
          sx={{ textTransform: "none" }}
        >
          Add cell
        </Button>
        <Menu
          anchorEl={addAnchor}
          open={Boolean(addAnchor)}
          onClose={() => setAddAnchor(null)}
        >
          <MenuItem onClick={() => handleAdd("code")}>Python</MenuItem>
          <MenuItem onClick={() => handleAdd("sql")}>SQL</MenuItem>
          <MenuItem onClick={() => handleAdd("markdown")}>Markdown</MenuItem>
        </Menu>
      </Box>
    </Box>
  );
}
