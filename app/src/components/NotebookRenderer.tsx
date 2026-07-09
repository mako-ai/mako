import { useEffect, useState } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { Notebook as NotebookIcon } from "lucide-react";

import { useNotebookStore, type NotebookDoc } from "../store/notebookStore";

interface NotebookRendererProps {
  /** Notebook id from the tab metadata. */
  notebookId: string;
  /** Owning editor tab id (used once the block editor + kernel are wired). */
  tabId: string;
}

/**
 * Center-pane renderer for a `kind: "notebook"` tab. Loads the notebook and
 * renders its blocks read-only. The interactive block editor (code/SQL cells,
 * kernels, collaboration) lands in later slices.
 */
export default function NotebookRenderer({
  notebookId,
}: NotebookRendererProps) {
  const getNotebook = useNotebookStore(s => s.getNotebook);
  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [loading, setLoading] = useState(true);

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
    };
  }, [notebookId, getNotebook]);

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
    <Box sx={{ height: "100%", overflowY: "auto", p: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
        <NotebookIcon size={18} />
        <Typography variant="h6">{doc.name}</Typography>
      </Box>

      {doc.blocks.length === 0 ? (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ maxWidth: 520 }}
        >
          This notebook is empty. The interactive block editor — code &amp; SQL
          cells, kernels, and real-time collaboration — is the next slice. For
          now, saved blocks render read-only here.
        </Typography>
      ) : (
        doc.blocks.map(b => (
          <Box
            key={b.id}
            sx={{
              mb: 1.5,
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              overflow: "hidden",
            }}
          >
            <Typography
              variant="caption"
              sx={{
                px: 1,
                py: 0.5,
                display: "block",
                bgcolor: "action.hover",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {b.type}
            </Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1,
                fontSize: "0.8rem",
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {b.source}
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}
