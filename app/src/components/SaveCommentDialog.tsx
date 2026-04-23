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
  Collapse,
  IconButton,
} from "@mui/material";
import { Sparkles, ChevronDown, ChevronRight } from "lucide-react";

interface SaveCommentDialogProps {
  open: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
  title?: string;
  defaultComment?: string;
  loading?: boolean;
  diff?: string | null;
}

export function SaveCommentDialog({
  open,
  onSave,
  onCancel,
  title = "Save",
  defaultComment,
  loading,
  diff,
}: SaveCommentDialogProps) {
  const [comment, setComment] = useState("");
  const [userEdited, setUserEdited] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);

  useEffect(() => {
    if (open) {
      setComment(defaultComment ?? "");
      setUserEdited(false);
      setDiffExpanded(false);
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
            <LinearProgress sx={{ borderRadius: 1, height: 3 }} />
          </Box>
        )}
        {diff && (
          <Box sx={{ mt: 1.5 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                cursor: "pointer",
                userSelect: "none",
              }}
              onClick={() => setDiffExpanded(v => !v)}
            >
              <IconButton size="small" sx={{ p: 0, mr: 0.5 }}>
                {diffExpanded ? (
                  <ChevronDown size={14} />
                ) : (
                  <ChevronRight size={14} />
                )}
              </IconButton>
              <Typography variant="caption" color="text.secondary">
                Changes since last save
              </Typography>
            </Box>
            <Collapse in={diffExpanded}>
              <Box
                component="pre"
                sx={{
                  mt: 0.5,
                  p: 1,
                  borderRadius: 1,
                  bgcolor: "action.hover",
                  fontSize: "0.7rem",
                  fontFamily: "monospace",
                  overflow: "auto",
                  maxHeight: 200,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  lineHeight: 1.4,
                  "& .diff-add": { color: "success.main" },
                  "& .diff-del": { color: "error.main" },
                  "& .diff-hunk": { color: "info.main", opacity: 0.7 },
                }}
              >
                {diff.split("\n").map((line, i) => {
                  const isHunk = line.startsWith("@@");
                  const cls =
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "diff-add"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "diff-del"
                        : isHunk
                          ? "diff-hunk"
                          : undefined;
                  return (
                    <Box
                      component="span"
                      key={i}
                      className={cls}
                      sx={{ display: "block" }}
                    >
                      {line}
                      {"\n"}
                    </Box>
                  );
                })}
              </Box>
            </Collapse>
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
