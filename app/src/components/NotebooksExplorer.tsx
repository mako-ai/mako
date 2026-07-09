import { useEffect } from "react";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { Notebook as NotebookIcon, Plus } from "lucide-react";

import ExplorerShell from "./ExplorerShell";
import { useNotebookStore } from "../store/notebookStore";
import { focusNotebookTab } from "../notebook-runtime/shell";

/**
 * Left-pane explorer for Notebooks: lists the workspace's notebooks, creates a
 * new one (+), and opens one as an editor tab on click.
 */
export default function NotebooksExplorer() {
  const notebooks = useNotebookStore(s => s.notebooks);
  const isLoading = useNotebookStore(s => s.isLoading);
  const error = useNotebookStore(s => s.error);
  const loadNotebooks = useNotebookStore(s => s.loadNotebooks);
  const createNotebook = useNotebookStore(s => s.createNotebook);

  useEffect(() => {
    void loadNotebooks();
  }, [loadNotebooks]);

  const handleCreate = async () => {
    const doc = await createNotebook();
    if (doc) focusNotebookTab(doc.id, doc.name);
  };

  return (
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
            {filtered.map(nb => (
              <Box
                key={nb.id}
                onClick={() => focusNotebookTab(nb.id, nb.name)}
                sx={{
                  px: 2,
                  py: 0.75,
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <NotebookIcon
                  size={15}
                  style={{ opacity: 0.7, flexShrink: 0 }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {nb.name}
                </span>
              </Box>
            ))}
          </Box>
        );
      }}
    </ExplorerShell>
  );
}
