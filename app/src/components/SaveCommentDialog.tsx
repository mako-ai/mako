import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
} from "@mui/material";

interface SaveCommentDialogProps {
  open: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
  title?: string;
  defaultComment?: string;
}

export function SaveCommentDialog({
  open,
  onSave,
  onCancel,
  title = "Save",
  defaultComment,
}: SaveCommentDialogProps) {
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (open) setComment(defaultComment ?? "");
  }, [open, defaultComment]);

  const handleSave = useCallback(() => {
    onSave(comment);
  }, [comment, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={2}
          maxRows={4}
          placeholder="Describe your changes (optional)"
          value={comment}
          onChange={e => setComment(e.target.value)}
          onKeyDown={handleKeyDown}
          variant="outlined"
          size="small"
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} size="small">
          Cancel
        </Button>
        <Button onClick={handleSave} variant="contained" size="small">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
