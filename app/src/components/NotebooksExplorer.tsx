import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputBase,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  MoreVertical,
  Notebook as NotebookIcon,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import ExplorerShell from "./ExplorerShell";
import { useNotebookStore, type NotebookSummary } from "../store/notebookStore";
import { focusNotebookTab } from "../notebook-runtime/shell";

/**
 * Left-pane explorer for Notebooks: lists the workspace's notebooks, creates a
 * new one (+), opens one on click, and renames/deletes via a per-row menu.
 */
export default function NotebooksExplorer() {
  const notebooks = useNotebookStore(s => s.notebooks);
  const isLoading = useNotebookStore(s => s.isLoading);
  const error = useNotebookStore(s => s.error);
  const loadNotebooks = useNotebookStore(s => s.loadNotebooks);
  const createNotebook = useNotebookStore(s => s.createNotebook);
  const updateNotebook = useNotebookStore(s => s.updateNotebook);
  const deleteNotebook = useNotebookStore(s => s.deleteNotebook);

  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    nb: NotebookSummary;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<NotebookSummary | null>(
    null,
  );

  useEffect(() => {
    void loadNotebooks();
  }, [loadNotebooks]);

  const handleCreate = async () => {
    const doc = await createNotebook();
    if (doc) focusNotebookTab(doc.id, doc.name);
  };

  const startRename = (nb: NotebookSummary) => {
    setMenu(null);
    setRenamingId(nb.id);
    setRenameValue(nb.name);
  };

  const commitRename = async (id: string) => {
    const name = renameValue.trim();
    const current = notebooks.find(n => n.id === id);
    setRenamingId(null);
    if (name && current && name !== current.name) {
      await updateNotebook(id, { name });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    await deleteNotebook(id);
  };

  return (
    <>
      <ExplorerShell
        title="Notebooks"
        searchPlaceholder="Search notebooks..."
        loading={isLoading}
        error={error}
        actions={
          <Tooltip title="New notebook">
            <IconButton size="small" onClick={() => void handleCreate()}>
              <Plus size={18} />
            </IconButton>
          </Tooltip>
        }
      >
        {({ searchQuery }) => {
          const q = searchQuery.trim().toLowerCase();
          const filtered = q
            ? notebooks.filter(n => n.name.toLowerCase().includes(q))
            : notebooks;

          if (filtered.length === 0) {
            return (
              <Box
                sx={{
                  px: 3,
                  py: 4,
                  textAlign: "center",
                  color: "text.secondary",
                }}
              >
                <NotebookIcon size={28} style={{ opacity: 0.5 }} />
                <Typography variant="body2" sx={{ mt: 1 }}>
                  {notebooks.length === 0 ? "No notebooks yet" : "No matches"}
                </Typography>
                {notebooks.length === 0 && (
                  <Typography
                    variant="caption"
                    sx={{ display: "block", mt: 0.5 }}
                  >
                    Click + to create your first notebook.
                  </Typography>
                )}
              </Box>
            );
          }

          return (
            <Box sx={{ py: 0.5 }}>
              {filtered.map(nb => {
                const renaming = renamingId === nb.id;
                return (
                  <Box
                    key={nb.id}
                    onClick={() =>
                      !renaming && focusNotebookTab(nb.id, nb.name)
                    }
                    sx={{
                      px: 2,
                      py: 0.75,
                      fontSize: "0.85rem",
                      cursor: renaming ? "default" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      "&:hover": { bgcolor: "action.hover" },
                      "&:hover .nb-actions": { opacity: 1 },
                    }}
                  >
                    <NotebookIcon
                      size={15}
                      style={{ opacity: 0.7, flexShrink: 0 }}
                    />
                    {renaming ? (
                      <InputBase
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === "Enter") void commitRename(nb.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => void commitRename(nb.id)}
                        sx={{ flex: 1, fontSize: "0.85rem" }}
                      />
                    ) : (
                      <>
                        <span
                          style={{
                            flex: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {nb.name}
                        </span>
                        <IconButton
                          className="nb-actions"
                          size="small"
                          sx={{
                            opacity: 0,
                            transition: "opacity 120ms",
                            p: 0.25,
                          }}
                          onClick={e => {
                            e.stopPropagation();
                            setMenu({ anchor: e.currentTarget, nb });
                          }}
                        >
                          <MoreVertical size={15} />
                        </IconButton>
                      </>
                    )}
                  </Box>
                );
              })}
            </Box>
          );
        }}
      </ExplorerShell>

      {/* Per-row actions menu — rendered once, anchored to the clicked row. */}
      <Menu
        anchorEl={menu?.anchor ?? null}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
      >
        <MenuItem onClick={() => menu && startRename(menu.nb)}>
          <Pencil size={14} style={{ marginRight: 8 }} /> Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) setDeleteTarget(menu.nb);
            setMenu(null);
          }}
        >
          <Trash2 size={14} style={{ marginRight: 8 }} /> Delete
        </MenuItem>
      </Menu>

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
      >
        <DialogTitle>Delete notebook?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            “{deleteTarget?.name}” will be permanently deleted. This cannot be
            undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" onClick={() => void confirmDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
