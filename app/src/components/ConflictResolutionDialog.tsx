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
import { useTheme } from "../contexts/ThemeContext";

export interface ConflictData {
  existingId: string;
  existingContent: string;
  existingName: string;
  path: string;
}

interface ConflictResolutionDialogProps {
  open: boolean;
  onClose: () => void;
  conflict: ConflictData | null;
  newContent: string;
  onOverwrite: () => void;
  onSaveAsNew: () => void;
  isProcessing?: boolean;
}

const ConflictResolutionDialog: React.FC<ConflictResolutionDialogProps> = ({
  open,
  onClose,
  conflict,
  newContent,
  onOverwrite,
  onSaveAsNew,
  isProcessing = false,
}) => {
  const { effectiveMode } = useTheme();

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
          <Typography variant="h6">File Already Exists</Typography>
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
          A file named <strong>"{conflict.existingName}"</strong> already exists
          at <code>{conflict.path}</code>. Compare the differences below and
          choose how to proceed.
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
            Existing File (will be replaced)
          </Typography>
          <Typography
            variant="subtitle2"
            sx={{ flex: 1, color: "text.secondary", textAlign: "right" }}
          >
            Your Changes (new content)
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
            theme={effectiveMode === "dark" ? "vs-dark" : "vs"}
            language="sql"
            original={conflict.existingContent}
            modified={newContent}
            options={{
              automaticLayout: true,
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              renderSideBySide: true,
              enableSplitViewResizing: true,
              diffWordWrap: "on",
              originalEditable: false,
            }}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={handleClose} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          onClick={onSaveAsNew}
          variant="outlined"
          disabled={isProcessing}
        >
          Save with Different Name
        </Button>
        <Button
          onClick={onOverwrite}
          variant="contained"
          color="warning"
          disabled={isProcessing}
          disableElevation
        >
          {isProcessing ? "Overwriting..." : "Overwrite Existing"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ConflictResolutionDialog;
