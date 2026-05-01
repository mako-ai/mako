import { useCallback, useEffect, useState } from "react";
import {
  Drawer,
  Box,
  Typography,
  List,
  ListItemButton,
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
  Avatar,
  Stack,
} from "@mui/material";
import { X, RotateCcw } from "lucide-react";
import Editor from "@monaco-editor/react";
import {
  useVersionStore,
  type VersionListItem,
  type VersionDetail,
} from "../store/versionStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useTheme } from "../contexts/ThemeContext";

interface VersionHistoryPanelProps {
  open: boolean;
  onClose: () => void;
  entityType: "console" | "dashboard";
  entityId: string;
  currentCode?: string;
  onRestore?: () => void;
}

const LIST_WIDTH = 380;
const PREVIEW_WIDTH = 640;

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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function VersionHistoryPanel({
  open,
  onClose,
  entityType,
  entityId,
  onRestore,
}: VersionHistoryPanelProps) {
  const { effectiveMode } = useTheme();
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
    if (!open) {
      setSelectedVersion(null);
    }
  }, [open]);

  useEffect(() => {
    if (open && workspaceId && entityId) {
      fetchHistory(workspaceId, entityType, entityId);
    }
  }, [open, workspaceId, entityType, entityId, fetchHistory]);

  const handleVersionClick = useCallback(
    async (item: VersionListItem) => {
      if (!workspaceId) return;
      setSelectedVersion({
        ...item,
        snapshot:
          entityType === "console"
            ? { code: "" }
            : ({} as Record<string, unknown>),
      });
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

  const monacoTheme = effectiveMode === "dark" ? "vs-dark" : "light";
  const snapshotValue =
    selectedVersion == null
      ? ""
      : entityType === "console"
        ? ((selectedVersion.snapshot.code as string) ?? "")
        : JSON.stringify(selectedVersion.snapshot ?? {}, null, 2);

  return (
    <>
      <Drawer
        variant="persistent"
        anchor="right"
        open={open && Boolean(selectedVersion)}
        hideBackdrop
        PaperProps={{
          sx: {
            width: PREVIEW_WIDTH,
            maxWidth: `calc(100vw - ${LIST_WIDTH}px)`,
            right: LIST_WIDTH,
            height: "100vh",
            borderRight: 1,
            borderColor: "divider",
            display: "flex",
            flexDirection: "column",
            zIndex: theme => theme.zIndex.drawer - 1,
          },
        }}
        ModalProps={{ keepMounted: false }}
      >
        {selectedVersion && (
          <>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1,
                px: 2,
                py: 1.5,
                borderBottom: 1,
                borderColor: "divider",
                flexShrink: 0,
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ minWidth: 0, flex: 1 }}
              >
                <Chip
                  size="small"
                  label={`v${selectedVersion.version}`}
                  color="primary"
                  sx={{ height: 20, fontSize: "0.7rem", fontWeight: 600 }}
                />
                <Typography variant="subtitle2" sx={{ flexShrink: 0 }}>
                  Snapshot
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ minWidth: 0 }}
                >
                  {selectedVersion.savedByName} ·{" "}
                  {formatDate(selectedVersion.createdAt)}
                </Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                <Button
                  size="small"
                  startIcon={<RotateCcw size={14} />}
                  onClick={() => handleRestoreClick(selectedVersion)}
                >
                  Restore
                </Button>
                <IconButton
                  size="small"
                  onClick={() => setSelectedVersion(null)}
                >
                  <X size={18} />
                </IconButton>
              </Stack>
            </Box>

            <Box sx={{ flex: 1, minHeight: 0, position: "relative" }}>
              {loadingDetail ? (
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    height: "100%",
                  }}
                >
                  <CircularProgress size={20} />
                </Box>
              ) : (
                <Editor
                  height="100%"
                  language={entityType === "console" ? "sql" : "json"}
                  theme={monacoTheme}
                  value={snapshotValue}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                    wordWrap: "on",
                    renderLineHighlight: "none",
                  }}
                />
              )}
            </Box>
          </>
        )}
      </Drawer>

      <Drawer
        anchor="right"
        open={open}
        onClose={onClose}
        PaperProps={{
          sx: {
            width: LIST_WIDTH,
            maxWidth: "90vw",
            display: "flex",
            flexDirection: "column",
            height: "100%",
            zIndex: theme => theme.zIndex.drawer,
          },
        }}
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
            flexShrink: 0,
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
          <List
            dense
            disablePadding
            sx={{ overflow: "auto", flex: 1, minHeight: 0 }}
          >
            {versions.map(v => (
              <ListItemButton
                key={v.version}
                selected={selectedVersion?.version === v.version}
                onClick={() => handleVersionClick(v)}
                sx={{
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 0.5,
                  px: 2,
                  py: 1,
                  "& .row-actions": {
                    opacity: 0,
                    transition: "opacity 120ms ease",
                  },
                  "&:hover .row-actions, &.Mui-selected .row-actions": {
                    opacity: 1,
                  },
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minWidth: 0,
                  }}
                >
                  <Chip
                    size="small"
                    label={`v${v.version}`}
                    color={
                      selectedVersion?.version === v.version
                        ? "primary"
                        : "default"
                    }
                    sx={{ height: 20, fontSize: "0.7rem", fontWeight: 600 }}
                  />
                  <Avatar sx={{ width: 20, height: 20, fontSize: "0.65rem" }}>
                    {initials(v.savedByName)}
                  </Avatar>
                  <Typography
                    variant="body2"
                    noWrap
                    sx={{ flex: 1, minWidth: 0 }}
                  >
                    {v.savedByName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(v.createdAt)}
                  </Typography>
                  <Tooltip title="Restore this version">
                    <IconButton
                      size="small"
                      className="row-actions"
                      onClick={e => {
                        e.stopPropagation();
                        handleRestoreClick(v);
                      }}
                    >
                      <RotateCcw size={14} />
                    </IconButton>
                  </Tooltip>
                </Box>

                {(v.comment || v.restoredFrom != null) && (
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.75,
                      pl: 3.5,
                      minWidth: 0,
                    }}
                  >
                    {v.restoredFrom != null && (
                      <Chip
                        label={`from v${v.restoredFrom}`}
                        size="small"
                        variant="outlined"
                        sx={{ height: 18, fontSize: "0.7rem", flexShrink: 0 }}
                      />
                    )}
                    {v.comment ? (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        fontStyle="italic"
                        noWrap
                        sx={{ minWidth: 0 }}
                      >
                        {v.comment}
                      </Typography>
                    ) : null}
                  </Box>
                )}
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
