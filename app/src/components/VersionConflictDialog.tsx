import React from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  IconButton,
  Alert,
  Stack,
} from "@mui/material";
import {
  Close as CloseIcon,
  Warning as WarningIcon,
} from "@mui/icons-material";
import { DiffEditor } from "@monaco-editor/react";
import { EDITOR_OPTIONS, useMonacoTheme } from "../lib/monaco-presets";
import type { ConsoleVersionConflict } from "../lib/api-types";

interface VersionConflictDialogProps {
  open: boolean;
  onClose: () => void;
  conflict: ConsoleVersionConflict | null;
  /** The content this client tried to save. */
  newContent: string;
  language?: "sql" | "javascript" | "mongodb";
  /** Re-save, replacing the latest server version with this client's content. */
  onOverwrite: () => void;
  /** Discard this client's changes and load the latest server version. */
  onLoadLatest: () => void;
  isProcessing?: boolean;
}

/**
 * Shown when an explicit console save hits a 409 version_conflict: someone
 * else saved this console after this client loaded it (optimistic
 * concurrency). Lets the user compare both versions and pick a resolution
 * instead of silently overwriting the other person's work.
 */
const VersionConflictDialog: React.FC<VersionConflictDialogProps> = ({
  open,
  onClose,
  conflict,
  newContent,
  language,
  onOverwrite,
  onLoadLatest,
  isProcessing = false,
}) => {
  const monacoTheme = useMonacoTheme();

  if (!conflict) return null;

  const handleClose = () => {
    if (!isProcessing) {
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          height: "85vh",
          maxHeight: "900px",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          pb: 1,
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1}>
          <WarningIcon color="warning" />
          <Typography variant="h6">Console Was Modified</Typography>
        </Stack>
        <IconButton
          aria-label="close"
          onClick={handleClose}
          disabled={isProcessing}
          sx={{
            color: theme => theme.palette.grey[500],
          }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ display: "flex", flexDirection: "column" }}>
        <Alert severity="warning" sx={{ mb: 2 }}>
          {conflict.name ? (
            <>
              <strong>&quot;{conflict.name}&quot;</strong> was
            </>
          ) : (
            "This console was"
          )}{" "}
          saved by someone else since you opened it. Compare the differences
          below and choose how to proceed.
        </Alert>

        {/* Labels for the diff editor */}
        <Box
          sx={{
            display: "flex",
            mb: 1,
            px: 1,
          }}
        >
          <Typography
            variant="subtitle2"
            sx={{ flex: 1, color: "text.secondary" }}
          >
            Latest Saved Version (theirs)
          </Typography>
          <Typography
            variant="subtitle2"
            sx={{ flex: 1, color: "text.secondary", textAlign: "right" }}
          >
            Your Changes (unsaved)
          </Typography>
        </Box>

        {/* Diff Editor */}
        <Box
          sx={{
            flexGrow: 1,
            minHeight: "400px",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            overflow: "hidden",
          }}
        >
          <DiffEditor
            height="100%"
            theme={monacoTheme}
            language={language === "mongodb" ? "javascript" : language || "sql"}
            original={conflict.content}
            modified={newContent}
            options={{
              ...EDITOR_OPTIONS.diff,
              wordWrap: "on",
              diffWordWrap: "on",
            }}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={handleClose} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          onClick={onLoadLatest}
          variant="outlined"
          disabled={isProcessing}
        >
          Discard Mine &amp; Load Latest
        </Button>
        <Button
          onClick={onOverwrite}
          variant="contained"
          color="warning"
          disabled={isProcessing}
          disableElevation
        >
          {isProcessing ? "Saving..." : "Overwrite With Mine"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default VersionConflictDialog;
