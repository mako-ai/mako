import { useCallback, useEffect, useState } from "react";
import {
  Drawer,
  Box,
  Typography,
  List,
  ListItemButton,
  ListItemText,
  Chip,
  IconButton,
  Tooltip,
  Button,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Divider,
} from "@mui/material";
import { X, RotateCcw } from "lucide-react";
import {
  useVersionStore,
  type VersionListItem,
  type VersionDetail,
} from "../store/versionStore";
import { useWorkspace } from "../contexts/workspace-context";

interface VersionHistoryPanelProps {
  open: boolean;
  onClose: () => void;
  entityType: "console" | "dashboard";
  entityId: string;
  currentCode?: string;
  onRestore?: () => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function VersionHistoryPanel({
  open,
  onClose,
  entityType,
  entityId,
  onRestore,
}: VersionHistoryPanelProps) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const versions = useVersionStore(s => s.versions[entityId]);
  const total = useVersionStore(s => s.totals[entityId] ?? 0);
  const loading = useVersionStore(s => s.loading[entityId] ?? false);
  const fetchHistory = useVersionStore(s => s.fetchVersionHistory);
  const fetchVersion = useVersionStore(s => s.fetchVersion);
  const restoreVersion = useVersionStore(s => s.restoreVersion);

  const [selectedVersion, setSelectedVersion] = useState<VersionDetail | null>(
    null,
  );
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<VersionListItem | null>(
    null,
  );
  const [restoreComment, setRestoreComment] = useState("");
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (open && workspaceId && entityId) {
      fetchHistory(workspaceId, entityType, entityId);
    }
  }, [open, workspaceId, entityType, entityId, fetchHistory]);

  const handleVersionClick = useCallback(
    async (item: VersionListItem) => {
      if (!workspaceId) return;
      setLoadingDetail(true);
      const detail = await fetchVersion(
        workspaceId,
        entityType,
        entityId,
        item.version,
      );
      setSelectedVersion(detail ?? null);
      setLoadingDetail(false);
    },
    [workspaceId, entityType, entityId, fetchVersion],
  );

  const handleRestoreClick = (item: VersionListItem) => {
    setRestoreTarget(item);
    setRestoreComment(`Restored from version ${item.version}`);
    setRestoreDialogOpen(true);
  };

  const handleRestoreConfirm = async () => {
    if (!workspaceId || !restoreTarget) return;
    setRestoring(true);
    const result = await restoreVersion(
      workspaceId,
      entityType,
      entityId,
      restoreTarget.version,
      restoreComment,
    );
    setRestoring(false);
    setRestoreDialogOpen(false);
    setRestoreTarget(null);
    if (result.success) {
      setSelectedVersion(null);
      onRestore?.();
    }
  };

  return (
    <>
      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        PaperProps={{ sx: { width: 380, maxWidth: "90vw" } }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1.5,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Typography variant="subtitle1" fontWeight={600}>
            Version History
          </Typography>
          <IconButton size="small" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </Box>

        {loading && !versions?.length ? (
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              py: 6,
            }}
          >
            <CircularProgress size={24} />
          </Box>
        ) : !versions?.length ? (
          <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
            <Typography variant="body2" color="text.secondary">
              No version history yet. Versions are created each time you save.
            </Typography>
          </Box>
        ) : (
          <List dense disablePadding sx={{ overflow: "auto", flex: 1 }}>
            {versions.map(v => (
              <ListItemButton
                key={v.version}
                selected={selectedVersion?.version === v.version}
                onClick={() => handleVersionClick(v)}
                sx={{ alignItems: "flex-start", px: 2, py: 1 }}
              >
                <ListItemText
                  primary={
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                      }}
                    >
                      <Typography variant="body2" fontWeight={600}>
                        v{v.version}
                      </Typography>
                      {v.restoredFrom && (
                        <Chip
                          label={`from v${v.restoredFrom}`}
                          size="small"
                          variant="outlined"
                          sx={{ height: 18, fontSize: "0.7rem" }}
                        />
                      )}
                      <Box sx={{ flex: 1 }} />
                      <Tooltip title="Restore this version">
                        <IconButton
                          size="small"
                          onClick={e => {
                            e.stopPropagation();
                            handleRestoreClick(v);
                          }}
                          sx={{ opacity: 0.6, "&:hover": { opacity: 1 } }}
                        >
                          <RotateCcw size={14} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  }
                  secondary={
                    <>
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                      >
                        {v.savedByName} &middot; {formatDate(v.createdAt)}
                      </Typography>
                      {v.comment && (
                        <Typography
                          variant="caption"
                          display="block"
                          sx={{
                            mt: 0.25,
                            color: "text.primary",
                            fontStyle: "italic",
                          }}
                        >
                          {v.comment}
                        </Typography>
                      )}
                    </>
                  }
                />
              </ListItemButton>
            ))}
            {versions.length < total && (
              <Box sx={{ textAlign: "center", py: 1.5 }}>
                <Button
                  size="small"
                  onClick={() =>
                    workspaceId &&
                    fetchHistory(workspaceId, entityType, entityId, {
                      limit: 50,
                      offset: versions.length,
                    })
                  }
                >
                  Load more
                </Button>
              </Box>
            )}
          </List>
        )}

        {selectedVersion && (
          <>
            <Divider />
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="caption" fontWeight={600}>
                Version {selectedVersion.version} snapshot
              </Typography>
              {loadingDetail ? (
                <CircularProgress size={16} sx={{ ml: 1 }} />
              ) : (
                <Box
                  component="pre"
                  sx={{
                    mt: 1,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    fontSize: "0.75rem",
                    fontFamily: "monospace",
                    overflow: "auto",
                    maxHeight: 260,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {entityType === "console"
                    ? ((selectedVersion.snapshot.code as string) ?? "")
                    : JSON.stringify(selectedVersion.snapshot, null, 2)}
                </Box>
              )}
            </Box>
          </>
        )}
      </Drawer>

      <Dialog
        open={restoreDialogOpen}
        onClose={() => !restoring && setRestoreDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Restore Version {restoreTarget?.version}?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This will create a new version with the content from v
            {restoreTarget?.version}. The current state is not lost.
          </Typography>
          <TextField
            fullWidth
            size="small"
            label="Comment"
            value={restoreComment}
            onChange={e => setRestoreComment(e.target.value)}
            placeholder="Describe the restore reason"
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setRestoreDialogOpen(false)}
            disabled={restoring}
          >
            Cancel
          </Button>
          <Button
            onClick={handleRestoreConfirm}
            variant="contained"
            disabled={restoring}
          >
            {restoring ? "Restoring..." : "Restore"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
