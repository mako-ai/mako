import { useCallback, useEffect, useState } from "react";
import {
  Backdrop,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from "@mui/material";
import { History, RotateCcw, X } from "lucide-react";

import { useNotebookStore, type NotebookVersion } from "../store/notebookStore";
import { formatBytes } from "../utils/format";
import { formatRelativeTime } from "../utils/relative-time";

interface NotebookHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  notebookId: string;
}

/**
 * Right-side version-history panel for a notebook. Lists prior generations
 * (GCS object versions in deployed envs, filesystem snapshots locally) and
 * restores one as a new current generation. Restore is non-destructive — it
 * appends a new version, so the current state stays in history and the restore
 * is itself undoable.
 */
export default function NotebookHistoryDrawer({
  open,
  onClose,
  notebookId,
}: NotebookHistoryDrawerProps) {
  const listVersions = useNotebookStore(s => s.listVersions);
  const restoreVersion = useNotebookStore(s => s.restoreVersion);

  const [versions, setVersions] = useState<NotebookVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const list = await listVersions(notebookId);
    setVersions(list);
    setLoading(false);
  }, [listVersions, notebookId]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const doRestore = async () => {
    if (!confirmId) return;
    setRestoring(true);
    const ok = await restoreVersion(notebookId, confirmId);
    setRestoring(false);
    setConfirmId(null);
    if (ok) await refresh();
  };

  return (
    <>
      <Backdrop
        open={open}
        onClick={onClose}
        sx={{
          zIndex: theme => theme.zIndex.drawer - 1,
          bgcolor: "transparent",
        }}
      />
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        variant="persistent"
        PaperProps={{ sx: { width: 360 } }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1.5,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <History size={18} />
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            Version history
          </Typography>
          <Tooltip title="Close">
            <IconButton size="small" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </Tooltip>
        </Box>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={20} />
          </Box>
        ) : versions.length === 0 ? (
          <Box sx={{ p: 2, color: "text.secondary" }}>
            <Typography variant="body2">
              No saved versions yet. Edits are versioned automatically as you
              work.
            </Typography>
          </Box>
        ) : (
          <List dense sx={{ overflowY: "auto" }}>
            {versions.map(v => (
              <ListItem
                key={v.versionId}
                divider
                secondaryAction={
                  v.isCurrent ? (
                    <Chip label="Current" size="small" color="primary" />
                  ) : (
                    <Tooltip title="Restore this version">
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => setConfirmId(v.versionId)}
                      >
                        <RotateCcw size={15} />
                      </IconButton>
                    </Tooltip>
                  )
                }
              >
                <ListItemText
                  primary={formatRelativeTime(v.createdAt) ?? "unknown"}
                  secondary={formatBytes(v.size)}
                  primaryTypographyProps={{ variant: "body2" }}
                  secondaryTypographyProps={{ variant: "caption" }}
                />
              </ListItem>
            ))}
          </List>
        )}
      </Drawer>

      <Dialog open={!!confirmId} onClose={() => setConfirmId(null)}>
        <DialogTitle>Restore this version?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The current notebook will be replaced with this version. This is
            saved as a new version, so nothing is lost — you can restore the
            current state again from history.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmId(null)} disabled={restoring}>
            Cancel
          </Button>
          <Button
            onClick={() => void doRestore()}
            variant="contained"
            disabled={restoring}
            startIcon={
              restoring ? (
                <CircularProgress size={14} />
              ) : (
                <RotateCcw size={14} />
              )
            }
          >
            Restore
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
