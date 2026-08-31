import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
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
  History,
  Share2,
} from "lucide-react";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../store/dashboardStore";
import { useConsoleStore } from "../store/consoleStore";
import { useAuth } from "../contexts/auth-context";
import {
  applyFreshMaterializationCommand,
  materializeDashboardInBackgroundCommand,
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
import ShareDialog from "./ShareDialog";
import EntityLoadErrorState, {
  EntityLoadingState,
} from "./EntityLoadErrorState";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import WidgetInspector from "./dashboard/WidgetInspector";
import { SaveCommentDialog } from "./SaveCommentDialog";
import { useSaveCommentSuggestion } from "../hooks/useSaveCommentSuggestion";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import ResourceRefreshControl from "./ResourceRefreshControl";

type ViewMode = "canvas" | "code";

const {
  saveDashboard: saveDashboardAction,
  generateSaveComment: generateSaveCommentAction,
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

  const isWorkspaceAdmin = useIsWorkspaceAdmin();

  const dashboardLoadError = useDashboardStore(state =>
    dashboardId ? state.openDashboardErrors[dashboardId] : undefined,
  );

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
  const [shareOpen, setShareOpen] = useState(false);
  const [showEventLog, setShowEventLog] = useState(false);
  const [inspectedWidget, setInspectedWidget] =
    useState<DashboardWidget | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const saveSuggestion = useSaveCommentSuggestion();
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);

  const openSaveDialog = useCallback(() => {
    setCommentDialogOpen(true);

    // Only existing (persisted) dashboards can be diffed against a saved
    // version for an AI suggestion.
    if (!workspaceId || !dashboardId || isNew) {
      saveSuggestion.begin();
      return;
    }
    saveSuggestion.begin(signal =>
      generateSaveCommentAction(workspaceId, dashboardId, signal),
    );
  }, [workspaceId, dashboardId, isNew, saveSuggestion]);

  const closeSaveDialog = useCallback(() => {
    saveSuggestion.cancel();
    setCommentDialogOpen(false);
  }, [saveSuggestion]);

  const queryGeneration = runtimeSession?.queryGeneration ?? 0;

  const handleExportPng = useCallback(async () => {
    const gridEl = document.querySelector(".layout") as HTMLElement;
    if (!gridEl) return;
    try {
      const { domToPng } = await import("modern-screenshot");
      const dataUrl = await domToPng(gridEl, {
        backgroundColor: null,
        scale: 2,
      });
      const link = document.createElement("a");
      link.download = `${dashboard?.title || "dashboard"}.png`;
      link.href = dataUrl;
      link.click();
    } catch {
      // silent
    }
  }, [dashboard?.title]);

  const [reloadingData, setReloadingData] = useState(false);
  const [freshnessDismissed, setFreshnessDismissed] = useState(false);

  // One Refresh action everywhere: force-rematerialize every data source,
  // wait until ALL builds settle, then apply into the runtime once.
  const handleRefresh = useCallback(() => {
    if (!workspaceId || reloadingData) return;
    setFreshnessDismissed(true);
    setReloadingData(true);
    void reloadDashboardDataSourcesCommand(workspaceId, dashboardId)
      .catch(() => {
        setFreshnessDismissed(false);
      })
      .finally(() => setReloadingData(false));
  }, [workspaceId, dashboardId, reloadingData]);

  // Oldest materialized artifact across data sources — "every source is at
  // least this fresh". Drives both the toolbar "Updated X ago" caption and
  // the staleness banner.
  const lastRefreshedAt = useMemo(() => {
    if (!dashboard || dashboard.dataSources.length === 0) return null;
    let oldest: string | null = null;
    for (const ds of dashboard.dataSources) {
      const builtAt = ds.cache?.parquetBuiltAt;
      if (!builtAt || Number.isNaN(Date.parse(builtAt))) continue;
      if (!oldest || Date.parse(builtAt) < Date.parse(oldest)) oldest = builtAt;
    }
    return oldest ?? dashboard.cache?.lastRefreshedAt ?? null;
  }, [dashboard]);

  const dataFreshness = useMemo(() => {
    if (!dashboard || !lastRefreshedAt) return null;
    const ttl = dashboard.materializationSchedule?.dataFreshnessTtlMs;
    const threshold = ttl ?? 24 * 60 * 60 * 1000;
    const oldestDate = new Date(lastRefreshedAt);
    if (Number.isNaN(oldestDate.getTime())) return null;
    const ageMs = Date.now() - oldestDate.getTime();
    if (ageMs < threshold) return null;
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const label =
      days > 0
        ? `${days} day${days !== 1 ? "s" : ""} ago`
        : `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    return { ageMs, label };
  }, [dashboard, lastRefreshedAt]);

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
    if (dashboardLoadError && dashboardId) {
      return (
        <EntityLoadErrorState
          error={dashboardLoadError}
          entityLabel="dashboard"
          onRetry={() => {
            if (workspaceId) {
              void useDashboardStore
                .getState()
                .reloadDashboard(workspaceId, dashboardId);
            }
          }}
        />
      );
    }
    return <EntityLoadingState label="Loading dashboard…" />;
  }

  const isDashboardOwner =
    !!user?.id && (dashboard.owner_id ?? dashboard.createdBy) === user.id;
  const canManageShare = isDashboardOwner || isWorkspaceAdmin;

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

        {isEditMode && (
          <>
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

        <Box sx={{ flex: 1 }} />

        <ResourceRefreshControl
          subject="data source"
          busy={reloadingData}
          onClick={handleRefresh}
          lastRefreshedAt={lastRefreshedAt}
        />

        {canManageShare && (
          <Tooltip title="Share">
            <IconButton size="small" onClick={() => setShareOpen(true)}>
              <Share2 size={16} />
            </IconButton>
          </Tooltip>
        )}

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
                  onClick={openSaveDialog}
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
            <Tooltip title="Version History">
              <IconButton
                size="small"
                onClick={() => setVersionHistoryOpen(true)}
              >
                <History size={16} />
              </IconButton>
            </Tooltip>
          </>
        )}

        {!isEditMode && (
          <>
            <Tooltip title="Dashboard settings">
              <IconButton size="small" onClick={() => setSettingsOpen(true)}>
                <Settings size={16} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Version History">
              <IconButton
                size="small"
                onClick={() => setVersionHistoryOpen(true)}
              >
                <History size={16} />
              </IconButton>
            </Tooltip>
          </>
        )}

        <Tooltip title="Toggle dashboard event log">
          <Chip
            size="small"
            label={`Logs ${recentEventLogCount}`}
            variant={showEventLog ? "filled" : "outlined"}
            onClick={() => setShowEventLog(prev => !prev)}
            sx={{ cursor: "pointer" }}
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
        onReloadData={handleRefresh}
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
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        resourceType="dashboard"
        resourceId={dashboardId}
        resourceName={dashboard.title}
        ownerId={dashboard.owner_id ?? dashboard.createdBy}
        access={dashboard.access}
        workspaceRole={dashboard.workspaceRole ?? "viewer"}
        publicShare={dashboard.publicShare ?? { enabled: false }}
        canManage={canManageShare}
        onSharingChanged={changes => {
          if (dashboardId) {
            useDashboardStore
              .getState()
              .applySharingChanges(dashboardId, changes);
          }
        }}
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

      {dashboardId && (
        <VersionHistoryPanel
          open={versionHistoryOpen}
          onClose={() => setVersionHistoryOpen(false)}
          entityType="dashboard"
          entityId={dashboardId}
          onRestore={() => {
            if (workspaceId && dashboardId) {
              useDashboardStore
                .getState()
                .reloadDashboard(workspaceId, dashboardId);
            }
          }}
        />
      )}

      <SaveCommentDialog
        open={commentDialogOpen}
        title="Save dashboard version"
        defaultComment={saveSuggestion.comment}
        loading={saveSuggestion.loading}
        diff={saveSuggestion.diff}
        onCancel={closeSaveDialog}
        onSave={async comment => {
          saveSuggestion.cancel();
          setCommentDialogOpen(false);
          if (!workspaceId || !dashboardId) return;
          try {
            const result = await saveDashboardAction(
              workspaceId,
              dashboardId,
              comment,
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
              err instanceof Error ? err.message : "Failed to save dashboard",
            );
          }
        }}
      />

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
