import { useEffect, useState } from "react";
import {
  Box,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Tooltip,
  Alert,
  Skeleton,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  Trash2 as DeleteIcon,
  ChartPie as DashboardIcon,
  Copy as CopyIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useDashboardStore, type Dashboard } from "../store/dashboardStore";
import { useConsoleStore } from "../store/consoleStore";

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function DashboardsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const {
    dashboards: dashboardsMap,
    loading: loadingMap,
    error: errorMap,
    fetchDashboards,
    deleteDashboard,
  } = useDashboardStore();

  const dashboards = currentWorkspace
    ? dashboardsMap[currentWorkspace.id] || []
    : [];
  const isLoading = currentWorkspace
    ? !!loadingMap[currentWorkspace.id]
    : false;
  const error = currentWorkspace ? errorMap[currentWorkspace.id] || null : null;

  const { tabs, activeTabId, openTab, setActiveTab } = useConsoleStore();
  const consoleTabs = Object.values(tabs);

  const [deleteTarget, setDeleteTarget] = useState<Dashboard | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    if (currentWorkspace) {
      fetchDashboards(currentWorkspace.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace?.id, fetchDashboards]);

  const handleRefresh = async () => {
    if (currentWorkspace?.id) {
      await fetchDashboards(currentWorkspace.id);
    }
  };

  const handleCreate = () => {
    const id = openTab({
      title: "New Dashboard",
      content: "",
      kind: "dashboard",
      metadata: { isNew: true },
    });
    setActiveTab(id);
  };

  const handleSelect = (dashboard: Dashboard) => {
    const existingTab = Object.values(useConsoleStore.getState().tabs).find(
      (tab: any) =>
        tab.kind === "dashboard" && tab.metadata?.dashboardId === dashboard._id,
    );

    if (existingTab) {
      setActiveTab(existingTab.id);
    } else {
      const id = openTab({
        title: dashboard.title,
        content: "",
        kind: "dashboard",
        metadata: { dashboardId: dashboard._id },
      });
      setActiveTab(id);
    }
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget && currentWorkspace?.id) {
      await deleteDashboard(currentWorkspace.id, deleteTarget._id);
      setDeleteTarget(null);
    }
  };

  const handleRename = async (dashboardId: string) => {
    if (!currentWorkspace?.id || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    await useDashboardStore
      .getState()
      .updateDashboard(currentWorkspace.id, dashboardId, {
        title: renameValue.trim(),
      });
    await fetchDashboards(currentWorkspace.id);
    setRenamingId(null);
  };

  const handleDuplicate = async (dashboard: Dashboard) => {
    if (!currentWorkspace?.id) return;
    await useDashboardStore
      .getState()
      .duplicateDashboard(currentWorkspace.id, dashboard._id);
    const updated =
      useDashboardStore.getState().dashboards[currentWorkspace.id] || [];
    const duplicated =
      updated.find(d => d.title === `${dashboard.title} (copy)`) ||
      updated[updated.length - 1];
    if (duplicated) {
      const id = openTab({
        title: duplicated.title,
        content: "",
        kind: "dashboard",
        metadata: { dashboardId: duplicated._id },
      });
      setActiveTab(id);
    }
  };

  const renderSkeletonItems = () =>
    Array.from({ length: 3 }).map((_, index) => (
      <ListItem key={`skeleton-${index}`} disablePadding>
        <ListItemButton disabled>
          <ListItemText
            primary={
              <Skeleton
                variant="text"
                width={`${60 + Math.random() * 40}%`}
                height={20}
              />
            }
            secondary={
              <Box
                component="span"
                sx={{ display: "inline-flex", gap: 0.5, alignItems: "center" }}
              >
                <Skeleton variant="text" width={120} height={16} />
              </Box>
            }
          />
        </ListItemButton>
      </ListItem>
    ));

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Typography
            variant="h6"
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textTransform: "uppercase",
            }}
          >
            Dashboards
          </Typography>
          <Box sx={{ display: "flex", gap: 0 }}>
            <Tooltip title="New Dashboard">
              <IconButton size="small" onClick={handleCreate}>
                <AddIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={handleRefresh}
                disabled={isLoading}
              >
                <RefreshIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {/* Error Alert */}
      {error && (
        <Alert
          severity="error"
          onClose={() => {
            if (currentWorkspace?.id) {
              useDashboardStore.setState(state => {
                state.error[currentWorkspace.id] = null;
              });
            }
          }}
          sx={{ mx: 2, mt: 2 }}
        >
          {error}
        </Alert>
      )}

      {/* Dashboard List */}
      <Box sx={{ flexGrow: 1, overflow: "auto" }}>
        {isLoading && dashboards.length === 0 ? (
          <List dense>{renderSkeletonItems()}</List>
        ) : dashboards.length === 0 ? (
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">No dashboards yet.</Typography>
          </Box>
        ) : (
          <List dense>
            {dashboards.map(dashboard => {
              const isActive = !!(
                activeTabId &&
                consoleTabs.find(
                  (t: any) =>
                    t.id === activeTabId &&
                    t.kind === "dashboard" &&
                    t.metadata?.dashboardId === dashboard._id,
                )
              );
              const widgetCount = dashboard.widgets?.length || 0;
              const dsCount = dashboard.dataSources?.length || 0;

              return (
                <ListItem
                  key={dashboard._id}
                  disablePadding
                  secondaryAction={
                    <Box sx={{ display: "flex", gap: 0 }}>
                      <Tooltip title="Duplicate">
                        <IconButton
                          size="small"
                          onClick={e => {
                            e.stopPropagation();
                            handleDuplicate(dashboard);
                          }}
                        >
                          <CopyIcon size={14} strokeWidth={1.5} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton
                          edge="end"
                          size="small"
                          onClick={e => {
                            e.stopPropagation();
                            setDeleteTarget(dashboard);
                          }}
                        >
                          <DeleteIcon size={14} strokeWidth={1.5} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  }
                >
                  <ListItemButton
                    selected={isActive}
                    onClick={() => handleSelect(dashboard)}
                    sx={{
                      px: 1,
                      py: 0.2,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    <ListItemIcon sx={{ minWidth: 28 }}>
                      <DashboardIcon size={20} strokeWidth={1.5} />
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        renamingId === dashboard._id ? (
                          <TextField
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={() => handleRename(dashboard._id)}
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                handleRename(dashboard._id);
                              }
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            size="small"
                            autoFocus
                            sx={{ fontSize: "0.85rem" }}
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <Typography
                            variant="body2"
                            onDoubleClick={e => {
                              e.stopPropagation();
                              setRenamingId(dashboard._id);
                              setRenameValue(dashboard.title);
                            }}
                            sx={{
                              fontWeight: 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {dashboard.title || "Untitled Dashboard"}
                          </Typography>
                        )
                      }
                      secondary={
                        <Box
                          component="span"
                          sx={{
                            display: "inline-flex",
                            gap: 1,
                            alignItems: "center",
                          }}
                        >
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                          >
                            {widgetCount}w · {dsCount}ds
                          </Typography>
                          {dashboard.updatedAt && (
                            <Typography
                              component="span"
                              variant="caption"
                              color="text.disabled"
                            >
                              {formatRelativeTime(dashboard.updatedAt)}
                            </Typography>
                          )}
                        </Box>
                      }
                      sx={{ pr: 4 }}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete Dashboard</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete "{deleteTarget?.title}"? This action
            cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default DashboardsExplorer;
