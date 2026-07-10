import { useEffect, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  InputBase,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { Notebook as NotebookIcon, Plus } from "lucide-react";

import {
  useNotebookStore,
  type NotebookBlockType,
  type NotebookSaveState,
} from "../store/notebookStore";
import NotebookCell from "./NotebookCell";
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
}: NotebookRendererProps) {
  const doc = useNotebookStore(s => s.openNotebooks[notebookId]);
  const saveState = useNotebookStore(s => s.saveState[notebookId] ?? "idle");
  const openNotebook = useNotebookStore(s => s.openNotebook);
  const renameOpenNotebook = useNotebookStore(s => s.renameOpenNotebook);
  const addCell = useNotebookStore(s => s.addCell);
  const updateCell = useNotebookStore(s => s.updateCell);
  const deleteCell = useNotebookStore(s => s.deleteCell);
  const moveCell = useNotebookStore(s => s.moveCell);

  const workspaceId = useUIStore(s => s.currentWorkspaceId) ?? null;
  const connectionsByWs = useSchemaStore(s => s.connections);
  const ensureConnections = useSchemaStore(s => s.ensureConnections);
  const sources = workspaceId ? (connectionsByWs[workspaceId] ?? []) : [];

  const [loading, setLoading] = useState(!doc);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);

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
          gap: 1,
          px: 2,
          py: 1,
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
          sx={{ flex: 1, fontSize: "1.05rem", fontWeight: 600 }}
        />
        <Typography
          variant="caption"
          sx={{
            color: saveState === "error" ? "error.main" : "text.secondary",
            minWidth: 64,
            textAlign: "right",
          }}
        >
          {SAVE_LABEL[saveState]}
        </Typography>
      </Box>

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
            Empty notebook. Add a cell to get started — SQL cells run against a
            data source; Python runs once the kernel lands; Markdown renders
            inline.
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
