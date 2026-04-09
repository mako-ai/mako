import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  ToggleButton,
  ToggleButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Snackbar,
  Alert,
} from "@mui/material";
import {
  RefreshCw,
  Save,
  Download,
  Database,
  Plus,
  Settings,
  Undo2,
  Redo2,
  ChartPie as DashboardIcon,
  Code2,
  Pencil,
  Eye,
} from "lucide-react";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../store/dashboardStore";
import { useConsoleStore } from "../store/consoleStore";
import { useTheme } from "../contexts/ThemeContext";
import { useAuth } from "../contexts/auth-context";
import {
  applyFreshMaterializationCommand,
  materializeDashboardInBackgroundCommand,
  refreshDashboardCommand,
  reloadDashboardDataSourcesCommand,
  shouldAutoApplyFreshMaterialization,
} from "../dashboard-runtime/commands";
import { useDashboardSession } from "../hooks/useDashboardSession";
import { useDashboardEditSession } from "../hooks/useDashboardEditSession";
import DashboardRuntimeChrome from "./dashboard/DashboardRuntimeChrome";
import DashboardGrid from "./dashboard/DashboardGrid";
import DashboardCodeEditor from "./dashboard/DashboardCodeEditor";
import DataSourcePanel from "./dashboard/DataSourcePanel";
import AddWidgetDialog from "./dashboard/AddWidgetDialog";
import DashboardSettingsDialog from "./dashboard/DashboardSettingsDialog";
import WidgetInspector from "./dashboard/WidgetInspector";

type ViewMode = "canvas" | "code";

const {
  saveDashboard: saveDashboardAction,
  undo: undoAction,
  redo: redoAction,
  releaseLock: releaseLockAction,
} = useDashboardStore.getState();

interface DashboardCanvasProps {
  dashboardId?: string;
  isNew?: boolean;
  onCreated?: (dashboardId: string) => void;
}

const DashboardCanvas: React.FC<DashboardCanvasProps> = ({
  dashboardId,
  isNew,
  onCreated,
}) => {
  const { user } = useAuth();
  const { effectiveMode } = useTheme();

  const {
    dashboard,
    runtimeSession,
    mosaicInstance,
    allSourcesReady,
    isRuntimeInitializing,
    gridContainerRef,
    gridWidth,
    workspaceId,
  } = useDashboardSession({ dashboardId, isNew, onCreated });

  const {
    isEditMode,
    isReadOnly,
    hasUnsavedChanges,
    historyIndex,
    historyLength,
    conflict,
    lockError,
    exitEditConfirmOpen,
    handleEditModeToggle,
    handleForceEditMode,
    handleExitEditSave,
    handleExitEditDiscard,
    handleExitEditCancel,
    setLockError,
    resolveConflictAction,
  } = useDashboardEditSession({ dashboardId, workspaceId });

  const tabId = useConsoleStore(state =>
    Object.keys(state.tabs).find(id => {
      const tab = state.tabs[id];
      return (
        tab.kind === "dashboard" &&
        (tab.metadata?.dashboardId === dashboardId ||
          (isNew && tab.metadata?.isNew))
      );
    }),
  );

  useEffect(() => {
    if (!tabId) return;
    const shouldPin = hasUnsavedChanges || isEditMode;
    useConsoleStore.getState().updateDirty(tabId, shouldPin);
  }, [tabId, hasUnsavedChanges, isEditMode]);

  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const [hasCodeError, setHasCodeError] = useState(false);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [addWidgetOpen, setAddWidgetOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showEventLog, setShowEventLog] = useState(false);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const queryGeneration = runtimeSession?.queryGeneration ?? 0;

  const handleExportPng = useCallback(async () => {
    const gridEl = document.querySelector(".layout") as HTMLElement;
    if (!gridEl) return;
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(gridEl, {
        backgroundColor: null,
        scale: 2,
      });
      const link = document.createElement("a");
      link.download = `${dashboard?.title || "dashboard"}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      // silent
    }
  }, [dashboard?.title]);

  const handleRefresh = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    if (isEditMode) {
      void reloadDashboardDataSourcesCommand(workspaceId, dashboardId);
      return;
    }
    void refreshDashboardCommand(workspaceId, dashboardId);
  }, [workspaceId, dashboardId, isEditMode]);

  const dataFreshness = useMemo(() => {
    if (!dashboard || dashboard.dataSources.length === 0) return null;
    const ttl = dashboard.materializationSchedule?.dataFreshnessTtlMs;
    const threshold = ttl ?? 24 * 60 * 60 * 1000;
    let oldestDate: Date | null = null;
    for (const ds of dashboard.dataSources) {
      const builtAt = ds.cache?.parquetBuiltAt;
      if (!builtAt) continue;
      const d = new Date(builtAt);
      if (!oldestDate || d < oldestDate) oldestDate = d;
    }
    if (!oldestDate) {
      const lr = dashboard.cache?.lastRefreshedAt;
      if (lr) oldestDate = new Date(lr);
    }
    if (!oldestDate) return null;
    const ageMs = Date.now() - oldestDate.getTime();
    if (ageMs < threshold) return null;
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const label =
      days > 0
        ? `${days} day${days !== 1 ? "s" : ""} ago`
        : `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    return { ageMs, label };
  }, [dashboard]);

  const [freshnessDismissed, setFreshnessDismissed] = useState(false);

  useEffect(() => {
    setFreshnessDismissed(false);
  }, [dataFreshness?.ageMs]);

  useEffect(() => {
    if (
      !workspaceId ||
      !dashboardId ||
      isEditMode ||
      !runtimeSession?.freshDataAvailable ||
      !shouldAutoApplyFreshMaterialization(dashboardId)
    ) {
      return;
    }

    void applyFreshMaterializationCommand({
      workspaceId,
      dashboardId,
    }).catch(() => undefined);
  }, [
    dashboardId,
    isEditMode,
    runtimeSession?.freshDataAvailable,
    workspaceId,
  ]);

  const handleReloadData = useCallback(async () => {
    if (workspaceId) {
      setFreshnessDismissed(true);
      try {
        await reloadDashboardDataSourcesCommand(workspaceId, dashboardId);
      } catch {
        setFreshnessDismissed(false);
      }
    }
  }, [workspaceId, dashboardId]);

  const handleDismissStaleLock = useCallback(async () => {
    if (workspaceId && dashboardId) {
      await releaseLockAction(workspaceId, dashboardId);
    }
  }, [workspaceId, dashboardId]);

  const recentEventLogCount = Math.min(
    runtimeSession?.eventLog.length ?? 0,
    10,
  );

  if (!dashboard) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        <Typography>Loading dashboard...</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Toolbar */}
      <Box
        sx={{
          px: 1.5,
          py: 0.75,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.default",
          minHeight: 44,
        }}
      >
        {!isReadOnly && (
          <ToggleButtonGroup
            value={isEditMode ? "edit" : "view"}
            exclusive
            onChange={(_, v) => v && handleEditModeToggle(v as "edit" | "view")}
            size="small"
            sx={{ height: 28 }}
          >
            <ToggleButton value="view" sx={{ px: 1, py: 0.25 }}>
              <Tooltip title="View mode">
                <Eye size={14} />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="edit" sx={{ px: 1, py: 0.25 }}>
              <Tooltip title="Edit mode">
                <Pencil size={14} />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
        )}

        {isReadOnly && (
          <Chip
            label="Read-only"
            size="small"
            color="default"
            variant="outlined"
            sx={{ mr: 0.5 }}
          />
        )}

        <Tooltip
          title={
            isReadOnly ? "Data sources (read-only)" : "Manage data sources"
          }
        >
          <Chip
            icon={<Database size={14} />}
            label={`${dashboard.dataSources.length} sources`}
            size="small"
            variant="outlined"
            onClick={
              isReadOnly ? undefined : () => setDataSourcePanelOpen(true)
            }
            sx={{ cursor: isReadOnly ? "default" : "pointer" }}
          />
        </Tooltip>

        <Tooltip title="Clear filters and rerun all widgets">
          <Chip
            icon={<RefreshCw size={14} />}
            label="Refresh"
            size="small"
            variant="outlined"
            onClick={handleRefresh}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        {isEditMode && (
          <>
            <Tooltip title="Reload data from source database">
              <Chip
                icon={<Database size={14} />}
                label="Reload data"
                size="small"
                variant="outlined"
                onClick={handleReloadData}
                sx={{ cursor: "pointer" }}
              />
            </Tooltip>

            <Tooltip title="Add widget">
              <IconButton size="small" onClick={() => setAddWidgetOpen(true)}>
                <Plus size={18} />
              </IconButton>
            </Tooltip>

            <Tooltip title="Undo (Cmd+Z)">
              <span>
                <IconButton
                  size="small"
                  onClick={() => dashboardId && undoAction(dashboardId)}
                  disabled={historyIndex <= 0}
                >
                  <Undo2 size={16} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Redo (Cmd+Shift+Z)">
              <span>
                <IconButton
                  size="small"
                  onClick={() => dashboardId && redoAction(dashboardId)}
                  disabled={historyIndex >= historyLength - 1}
                >
                  <Redo2 size={16} />
                </IconButton>
              </span>
            </Tooltip>

            <ToggleButtonGroup
              value={viewMode}
              exclusive
              onChange={(_, v) => v && setViewMode(v)}
              size="small"
              sx={{ height: 28 }}
            >
              <ToggleButton value="canvas" sx={{ px: 1, py: 0.25 }}>
                <Tooltip title="Dashboard view">
                  <DashboardIcon size={14} />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="code" sx={{ px: 1, py: 0.25 }}>
                <Tooltip title="Code view (JSON)">
                  <Code2 size={14} />
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>
          </>
        )}

        <Tooltip title="Export">
          <IconButton size="small" onClick={handleExportPng}>
            <Download size={16} />
          </IconButton>
        </Tooltip>

        {isEditMode && (
          <>
            <Tooltip
              title={
                viewMode === "code" && hasCodeError
                  ? "Fix JSON errors before saving"
                  : hasUnsavedChanges
                    ? "Save (Ctrl+S)"
                    : "No changes to save"
              }
            >
              <span>
                <IconButton
                  size="small"
                  disabled={
                    !hasUnsavedChanges || (viewMode === "code" && hasCodeError)
                  }
                  onClick={async () => {
                    if (!workspaceId || !dashboardId) return;
                    try {
                      const result = await saveDashboardAction(
                        workspaceId,
                        dashboardId,
                      );
                      if (!result.ok) {
                        if (result.error) setSaveError(result.error);
                        return;
                      }
                      void materializeDashboardInBackgroundCommand({
                        workspaceId,
                        dashboardId,
                      }).catch(() => undefined);
                    } catch (err) {
                      setSaveError(
                        err instanceof Error
                          ? err.message
                          : "Failed to save dashboard",
                      );
                    }
                  }}
                >
                  <Save size={16} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Dashboard settings">
              <IconButton size="small" onClick={() => setSettingsOpen(true)}>
                <Settings size={16} />
              </IconButton>
            </Tooltip>
          </>
        )}

        {!isEditMode && (
          <Tooltip title="Dashboard settings">
            <IconButton size="small" onClick={() => setSettingsOpen(true)}>
              <Settings size={16} />
            </IconButton>
          </Tooltip>
        )}

        <Tooltip title="Toggle dashboard event log">
          <Chip
            size="small"
            label={`Logs ${recentEventLogCount}`}
            variant={showEventLog ? "filled" : "outlined"}
            onClick={() => setShowEventLog(prev => !prev)}
            sx={{ cursor: "pointer", ml: "auto" }}
          />
        </Tooltip>
      </Box>

      <DashboardRuntimeChrome
        dashboard={dashboard}
        dashboardId={dashboardId}
        workspaceId={workspaceId}
        runtimeSession={runtimeSession}
        isRuntimeInitializing={isRuntimeInitializing}
        showEventLog={showEventLog}
        lockError={lockError}
        isEditMode={isEditMode}
        isReadOnly={isReadOnly}
        userId={user?.id}
        onClearLockError={() => setLockError(null)}
        onForceEditMode={handleForceEditMode}
        onDismissStaleLock={handleDismissStaleLock}
        onEditModeToggle={handleEditModeToggle}
        onReloadData={handleReloadData}
        dataFreshness={freshnessDismissed ? null : dataFreshness}
      />

      {/* Content area */}
      <Box sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <Box sx={{ flex: 1, overflow: "auto" }}>
          {viewMode === "canvas" || !isEditMode ? (
            <DashboardGrid
              dashboard={dashboard}
              dashboardId={dashboardId}
              runtimeSession={runtimeSession}
              mosaicInstance={mosaicInstance}
              allSourcesReady={allSourcesReady}
              isEditMode={isEditMode}
              gridContainerRef={gridContainerRef}
              gridWidth={gridWidth}
              queryGeneration={queryGeneration}
              onOpenDataSourcePanel={() => setDataSourcePanelOpen(true)}
              onOpenAddWidget={() => setAddWidgetOpen(true)}
              onInspectWidget={setInspectedWidget}
            />
          ) : (
            <DashboardCodeEditor
              dashboard={dashboard}
              dashboardId={dashboardId}
              effectiveMode={effectiveMode}
              onCodeError={setHasCodeError}
            />
          )}
        </Box>

        {inspectedWidget && (
          <WidgetInspector
            widget={inspectedWidget}
            dashboardId={dashboardId}
            onClose={() => setInspectedWidget(null)}
          />
        )}
      </Box>

      {/* Panels & Dialogs */}
      <DataSourcePanel
        open={dataSourcePanelOpen}
        onClose={() => setDataSourcePanelOpen(false)}
        dashboardId={dashboardId}
      />
      <AddWidgetDialog
        open={addWidgetOpen}
        onClose={() => setAddWidgetOpen(false)}
        dashboardId={dashboardId}
      />
      <DashboardSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        dashboardId={dashboardId}
      />
      <Dialog open={!!conflict} maxWidth="sm" fullWidth>
        <DialogTitle>Save Conflict</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This dashboard was modified by another user while you were editing.
            Your save was rejected to prevent overwriting their changes.
          </DialogContentText>
          <DialogContentText sx={{ mt: 1 }}>
            You can discard your local changes and load the latest version, or
            overwrite the server version with your changes.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() =>
              workspaceId && resolveConflictAction("discard", workspaceId)
            }
          >
            Discard my changes
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() =>
              workspaceId && resolveConflictAction("overwrite", workspaceId)
            }
          >
            Overwrite with my changes
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={exitEditConfirmOpen} onClose={handleExitEditCancel}>
        <DialogTitle>Unsaved Changes</DialogTitle>
        <DialogContent>
          <DialogContentText>
            You have unsaved changes. Do you want to save before leaving edit
            mode?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleExitEditDiscard} color="error">
            Discard
          </Button>
          <Button onClick={handleExitEditCancel}>Cancel</Button>
          <Button onClick={handleExitEditSave} variant="contained">
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!saveError}
        autoHideDuration={8000}
        onClose={() => setSaveError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setSaveError(null)}
          severity="error"
          sx={{ width: "100%" }}
        >
          {saveError}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default DashboardCanvas;
