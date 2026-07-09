import { useCallback, useEffect, useRef, useState } from "react";
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
  type NotebookBlock,
  type NotebookBlockType,
  type NotebookDoc,
} from "../store/notebookStore";
import NotebookCell from "./NotebookCell";

type SaveState = "idle" | "saving" | "saved" | "error";

function newBlock(type: NotebookBlockType): NotebookBlock {
  return { id: crypto.randomUUID(), type, source: "" };
}

const SAVE_LABEL: Record<SaveState, string> = {
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
 * Center-pane editor for a `kind: "notebook"` tab: editable title + ordered
 * cells (Python/SQL via Monaco, Markdown via a text field), add/delete/reorder,
 * with debounced autosave through the CRUD API. Cell *execution* (kernels /
 * SQL results) lands in the execution slice.
 */
export default function NotebookRenderer({
  notebookId,
}: NotebookRendererProps) {
  const getNotebook = useNotebookStore(s => s.getNotebook);
  const updateNotebook = useNotebookStore(s => s.updateNotebook);

  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getNotebook(notebookId).then(d => {
      if (alive) {
        setDoc(d);
        setLoading(false);
      }
    });
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [notebookId, getNotebook]);

  const scheduleSave = useCallback(
    (next: NotebookDoc, nameChanged: boolean) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaveState("saving");
      saveTimer.current = setTimeout(() => {
        void updateNotebook(next.id, {
          name: nameChanged ? next.name : undefined,
          blocks: next.blocks,
        }).then(res => setSaveState(res ? "saved" : "error"));
      }, 700);
    },
    [updateNotebook],
  );

  const mutate = useCallback(
    (updater: (d: NotebookDoc) => NotebookDoc, nameChanged = false) => {
      setDoc(prev => {
        if (!prev) return prev;
        const next = updater(prev);
        scheduleSave(next, nameChanged);
        return next;
      });
    },
    [scheduleSave],
  );

  const addBlock = (type: NotebookBlockType) => {
    setAddAnchor(null);
    mutate(d => ({ ...d, blocks: [...d.blocks, newBlock(type)] }));
  };

  const changeBlock = (id: string, patch: Partial<NotebookBlock>) =>
    mutate(d => ({
      ...d,
      blocks: d.blocks.map(b => (b.id === id ? { ...b, ...patch } : b)),
    }));

  const deleteBlock = (id: string) =>
    mutate(d => ({ ...d, blocks: d.blocks.filter(b => b.id !== id) }));

  const moveBlock = (index: number, direction: -1 | 1) =>
    mutate(d => {
      const target = index + direction;
      if (target < 0 || target >= d.blocks.length) return d;
      const blocks = [...d.blocks];
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      return { ...d, blocks };
    });

  if (loading) {
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
          onChange={e => mutate(d => ({ ...d, name: e.target.value }), true)}
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
            onChange={patch => changeBlock(block.id, patch)}
            onDelete={() => deleteBlock(block.id)}
            onMove={dir => moveBlock(index, dir)}
          />
        ))}

        {doc.blocks.length === 0 && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 2, maxWidth: 520 }}
          >
            Empty notebook. Add a cell to get started — Python and SQL cells run
            once the execution slice lands; Markdown renders inline.
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
          <MenuItem onClick={() => addBlock("code")}>Python</MenuItem>
          <MenuItem onClick={() => addBlock("sql")}>SQL</MenuItem>
          <MenuItem onClick={() => addBlock("markdown")}>Markdown</MenuItem>
        </Menu>
      </Box>
    </Box>
  );
}
