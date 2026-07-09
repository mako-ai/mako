import { useEffect } from "react";
import { Box, Typography } from "@mui/material";
import { Notebook as NotebookIcon } from "lucide-react";

import ExplorerShell from "./ExplorerShell";
import { useNotebookStore } from "../store/notebookStore";

/**
 * Left-pane explorer for the Notebooks feature. Uses the shared ExplorerShell
 * chrome (title + search + error). Notebook rows render once the Git-backed
 * list endpoint is wired (#3); today it shows an empty state.
 */
export default function NotebooksExplorer() {
  const notebooks = useNotebookStore(s => s.notebooks);
  const isLoading = useNotebookStore(s => s.isLoading);
  const error = useNotebookStore(s => s.error);
  const loadNotebooks = useNotebookStore(s => s.loadNotebooks);

  useEffect(() => {
    void loadNotebooks();
  }, [loadNotebooks]);

  return (
    <ExplorerShell
      title="Notebooks"
      searchPlaceholder="Search notebooks..."
      loading={isLoading}
      error={error}
    >
      {() =>
        notebooks.length === 0 ? (
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
              No notebooks yet
            </Typography>
            <Typography variant="caption" sx={{ display: "block", mt: 0.5 }}>
              Collaborative, agent-augmented notebooks are on the way.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ py: 0.5 }}>
            {notebooks.map(nb => (
              <Box
                key={nb.id}
                sx={{
                  px: 2,
                  py: 0.75,
                  fontSize: "0.85rem",
                  cursor: "pointer",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                {nb.name}
              </Box>
            ))}
          </Box>
        )
      }
    </ExplorerShell>
  );
}
