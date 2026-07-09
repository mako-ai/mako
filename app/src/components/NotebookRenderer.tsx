import { Box, Typography } from "@mui/material";
import { Notebook as NotebookIcon } from "lucide-react";

interface NotebookRendererProps {
  /** Notebook id from the tab metadata (empty until storage is wired). */
  notebookId: string;
  /** Owning editor tab id (used once the block editor + kernel are wired). */
  tabId: string;
}

/**
 * Center-pane renderer for a `kind: "notebook"` tab. Placeholder today: the
 * block editor, kernel session, outputs, and collaboration land in later
 * slices. The tab kind + routing exist now so the rest can hang off them.
 */
export default function NotebookRenderer({
  notebookId,
}: NotebookRendererProps) {
  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1,
        color: "text.secondary",
        p: 3,
        textAlign: "center",
      }}
    >
      <NotebookIcon size={32} style={{ opacity: 0.5 }} />
      <Typography variant="subtitle1">Notebook</Typography>
      <Typography variant="caption">{notebookId || "untitled"}</Typography>
      <Typography variant="body2" sx={{ mt: 1, maxWidth: 360 }}>
        The notebook editor — blocks, Python/SQL cells, kernels, and real-time
        collaboration — is under construction.
      </Typography>
    </Box>
  );
}
