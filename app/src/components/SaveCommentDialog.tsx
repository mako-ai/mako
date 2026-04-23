import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  LinearProgress,
  Typography,
} from "@mui/material";
import { Sparkles } from "lucide-react";

interface SaveCommentDialogProps {
  open: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
  title?: string;
  defaultComment?: string;
  loading?: boolean;
}

export function SaveCommentDialog({
  open,
  onSave,
  onCancel,
  title = "Save",
  defaultComment,
  loading,
}: SaveCommentDialogProps) {
  const [comment, setComment] = useState("");
  const [userEdited, setUserEdited] = useState(false);

  useEffect(() => {
    if (open) {
      setComment(defaultComment ?? "");
      setUserEdited(false);
    }
  }, [open]);

  useEffect(() => {
    if (defaultComment && !userEdited) {
      setComment(defaultComment);
    }
  }, [defaultComment, userEdited]);

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
          onChange={e => {
            setComment(e.target.value);
            setUserEdited(true);
          }}
          onKeyDown={handleKeyDown}
          variant="outlined"
          size="small"
          sx={{ mt: 1 }}
        />
        {loading && (
          <Box sx={{ mt: 1.5 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                mb: 0.5,
              }}
            >
              <Sparkles size={14} />
              <Typography variant="caption" color="text.secondary">
                Generating comment with AI...
              </Typography>
            </Box>
            <LinearProgress
              sx={{
                borderRadius: 1,
                height: 3,
              }}
            />
          </Box>
        )}
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
