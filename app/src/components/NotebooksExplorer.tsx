import { useEffect, useRef, useState, type ChangeEvent } from "react";
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
  Download,
  MoreVertical,
  Notebook as NotebookIcon,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import ExplorerShell from "./ExplorerShell";
import { useNotebookStore, type NotebookSummary } from "../store/notebookStore";
import { focusNotebookTab } from "../notebook-runtime/shell";
import {
  blocksFromIpynb,
  nameFromIpynb,
  notebookToIpynb,
  type Ipynb,
} from "../notebook-runtime/ipynb";

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
  const getNotebook = useNotebookStore(s => s.getNotebook);
  const importNotebook = useNotebookStore(s => s.importNotebook);

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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    const doc = await createNotebook();
    if (doc) focusNotebookTab(doc.id, doc.name);
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file
    if (!file) return;
    try {
      const json = JSON.parse(await file.text()) as Ipynb;
      const fallback =
        file.name.replace(/\.ipynb$/i, "") || "Imported notebook";
      const doc = await importNotebook(
        nameFromIpynb(json, fallback),
        blocksFromIpynb(json),
      );
      if (doc) focusNotebookTab(doc.id, doc.name);
    } catch {
      // Malformed file — ignore; store errors surface via the explorer banner.
    }
  };

  const handleExport = async (nb: NotebookSummary) => {
    setMenu(null);
    const doc = await getNotebook(nb.id);
    if (!doc) return;
    const json = JSON.stringify(notebookToIpynb(doc.name, doc.blocks), null, 2);
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${doc.name || "notebook"}.ipynb`;
    a.click();
    URL.revokeObjectURL(url);
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
          <>
            <Tooltip title="Import .ipynb">
              <IconButton
                size="small"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={17} />
              </IconButton>
            </Tooltip>
            <Tooltip title="New notebook">
              <IconButton size="small" onClick={() => void handleCreate()}>
                <Plus size={18} />
              </IconButton>
            </Tooltip>
          </>
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
            if (menu) void handleExport(menu.nb);
          }}
        >
          <Download size={14} style={{ marginRight: 8 }} /> Export .ipynb
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

      <input
        ref={fileInputRef}
        type="file"
        accept=".ipynb,application/json"
        style={{ display: "none" }}
        onChange={e => void handleImportFile(e)}
      />
    </>
  );
}
