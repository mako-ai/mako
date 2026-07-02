import { Box, Dialog, IconButton } from "@mui/material";
import { X } from "lucide-react";

/**
 * Lightweight, dependency-free image lightbox. Shows the full (uncropped) image
 * centered over a dimmed backdrop; closes on backdrop click, the X button, or
 * Escape (handled by MUI Dialog).
 */
export function ImagePreviewDialog({
  src,
  onClose,
}: {
  src: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={Boolean(src)}
      onClose={onClose}
      maxWidth="lg"
      slotProps={{
        paper: {
          sx: {
            backgroundColor: "transparent",
            boxShadow: "none",
            m: 2,
            overflow: "visible",
          },
        },
      }}
    >
      <Box sx={{ position: "relative", display: "flex" }}>
        <IconButton
          onClick={onClose}
          aria-label="Close preview"
          size="small"
          sx={{
            position: "absolute",
            top: 8,
            right: 8,
            color: "common.white",
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            "&:hover": { backgroundColor: "rgba(0, 0, 0, 0.8)" },
          }}
        >
          <X size={18} />
        </IconButton>
        {src && (
          <Box
            component="img"
            src={src}
            alt="Image preview"
            sx={{
              maxWidth: "90vw",
              maxHeight: "85vh",
              borderRadius: 1,
              objectFit: "contain",
              display: "block",
            }}
          />
        )}
      </Box>
    </Dialog>
  );
}
