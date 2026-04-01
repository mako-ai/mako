import React, { useMemo } from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  LinearProgress,
  Alert,
  Button,
} from "@mui/material";
import { RefreshCw } from "lucide-react";
import {
  applyFreshMaterializationCommand,
  reloadDashboardDataSourcesCommand,
} from "../../dashboard-runtime/commands";
import type {
  Dashboard,
  DashboardSessionRuntimeState,
} from "../../dashboard-runtime/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DashboardRuntimeChromeProps {
  dashboard: Dashboard;
  dashboardId?: string;
  workspaceId?: string;
  runtimeSession: DashboardSessionRuntimeState | null;
  isRuntimeInitializing: boolean;
  isMaterializationBuilding: boolean;
  showEventLog: boolean;
  lockError: string | null;
  isEditMode: boolean;
  isReadOnly: boolean;
  userId?: string;
  onClearLockError: () => void;
  onForceEditMode: () => void;
  onEditModeToggle: (mode: "edit" | "view") => void;
  onReloadData: () => void;
  dataFreshness: { ageMs: number; label: string } | null;
}

const DashboardRuntimeChrome: React.FC<DashboardRuntimeChromeProps> = ({
  dashboard,
  dashboardId,
  workspaceId,
  runtimeSession,
  isRuntimeInitializing,
  isMaterializationBuilding,
  showEventLog,
  lockError,
  isEditMode,
  isReadOnly,
  userId,
  onClearLockError,
  onForceEditMode,
  onEditModeToggle,
  onReloadData,
  dataFreshness,
}) => {
  const someSourcesLoading = useMemo(() => {
    if (isRuntimeInitializing) return true;
    return Object.values(runtimeSession?.dataSources || {}).some(
      s => s.status === "loading",
    );
  }, [isRuntimeInitializing, runtimeSession]);

  const loadingSummary = useMemo(() => {
    if (!dashboard) return null;

    if (isRuntimeInitializing) {
      return {
        label: "Initializing dashboard runtime",
        rowsLoaded: 0,
        bytesLoaded: 0,
        totalBytes: null,
        progress: null,
      };
    }

    const loadingSources = dashboard.dataSources.filter(
      ds => runtimeSession?.dataSources[ds.id]?.status === "loading",
    );
    if (loadingSources.length === 0) return null;

    let bytesLoaded = 0;
    let totalBytes = 0;
    let hasKnownByteSize = true;
    for (const dataSource of loadingSources) {
      const runtime = runtimeSession?.dataSources[dataSource.id];
      bytesLoaded += runtime?.bytesLoaded ?? 0;
      if (runtime?.totalBytes == null) {
        hasKnownByteSize = false;
        continue;
      }
      totalBytes += runtime.totalBytes;
    }

    return {
      label:
        loadingSources.length === 1
          ? `Loading ${loadingSources[0].name}`
          : `Loading ${loadingSources.length} data sources`,
      rowsLoaded: loadingSources.reduce(
        (sum, ds) =>
          sum + (runtimeSession?.dataSources[ds.id]?.rowsLoaded || 0),
        0,
      ),
      bytesLoaded,
      totalBytes: hasKnownByteSize ? totalBytes : null,
      progress:
        hasKnownByteSize && totalBytes > 0
          ? (bytesLoaded / totalBytes) * 100
          : null,
    };
  }, [dashboard, isRuntimeInitializing, runtimeSession]);

  const errorSummary = useMemo(() => {
    if (!dashboard) return null;
    const failingSources = dashboard.dataSources.filter(
      ds => runtimeSession?.dataSources[ds.id]?.status === "error",
    );
    if (failingSources.length === 0) return null;
    const first = failingSources[0];
    return {
      count: failingSources.length,
      message:
        runtimeSession?.dataSources[first.id]?.error ||
        "Failed to load one or more data sources",
    };
  }, [dashboard, runtimeSession]);

  const recentEventLog = useMemo(
    () => runtimeSession?.eventLog.slice(-10).reverse() || [],
    [runtimeSession?.eventLog],
  );

  return (
    <>
      {lockError && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          onClose={onClearLockError}
          action={
            <Button color="inherit" size="small" onClick={onForceEditMode}>
              Force take over
            </Button>
          }
        >
          {lockError}
        </Alert>
      )}
      {!isEditMode &&
        dashboard?.editLock &&
        new Date(dashboard.editLock.expiresAt) > new Date() &&
        !isReadOnly &&
        (() => {
          const editLock = dashboard.editLock;
          if (!editLock) return null;
          const isSelfLock = editLock.userId === userId;
          return (
            <Alert
              severity={isSelfLock ? "warning" : "info"}
              sx={{ borderRadius: 0 }}
              action={
                <Box sx={{ display: "flex", gap: 0.5 }}>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={
                      isSelfLock
                        ? onForceEditMode
                        : () => onEditModeToggle("edit")
                    }
                  >
                    {isSelfLock ? "Resume editing" : "Enter edit mode"}
                  </Button>
                  {!isSelfLock && (
                    <Button
                      color="inherit"
                      size="small"
                      onClick={onForceEditMode}
                    >
                      Force take over
                    </Button>
                  )}
                </Box>
              }
            >
              {isSelfLock
                ? "You have unsaved changes from a previous session"
                : `${editLock.userName} is currently editing this dashboard`}
            </Alert>
          );
        })()}
      {dataFreshness && (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          action={
            <Button
              color="inherit"
              size="small"
              onClick={onReloadData}
              disabled={isMaterializationBuilding}
            >
              Refresh now
            </Button>
          }
        >
          Data was last refreshed {dataFreshness.label}
        </Alert>
      )}

      {someSourcesLoading && (
        <Box sx={{ borderBottom: "1px solid", borderColor: "divider" }}>
          <LinearProgress
            variant={
              loadingSummary?.progress != null ? "determinate" : "indeterminate"
            }
            value={loadingSummary?.progress ?? undefined}
          />
          {loadingSummary && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", px: 1.5, py: 0.5 }}
            >
              {loadingSummary.label}
              {loadingSummary.progress != null &&
                ` · ${Math.round(loadingSummary.progress)}%`}
              {loadingSummary.totalBytes != null &&
                ` · ${formatBytes(loadingSummary.bytesLoaded)} / ${formatBytes(loadingSummary.totalBytes)}`}
              {loadingSummary.rowsLoaded > 0 &&
                ` · ${loadingSummary.rowsLoaded.toLocaleString()} rows loaded`}
            </Typography>
          )}
        </Box>
      )}
      {errorSummary && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "error.light",
            color: "error.contrastText",
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          <Typography variant="caption" sx={{ flex: 1 }}>
            {errorSummary.count > 1
              ? `${errorSummary.count} data sources failed to load.`
              : "Data source failed to load."}{" "}
            {errorSummary.message}
          </Typography>
          <Tooltip title="Retry loading data sources">
            <IconButton
              size="small"
              onClick={() => {
                if (workspaceId) {
                  void reloadDashboardDataSourcesCommand(
                    workspaceId,
                    dashboardId,
                  );
                }
              }}
              sx={{
                color: "error.contrastText",
                p: 0.5,
                "&:hover": { backgroundColor: "error.dark" },
              }}
            >
              <RefreshCw size={14} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      {runtimeSession?.materializationPolling && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "warning.light",
            color: "warning.contrastText",
          }}
        >
          <Typography variant="caption" sx={{ display: "block" }}>
            Refreshing data sources in the background. The dashboard is using
            the previous materialized snapshot until fresh data is ready.
          </Typography>
        </Box>
      )}
      {runtimeSession?.freshDataAvailable && workspaceId && dashboardId && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "success.light",
            color: "success.contrastText",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          <Typography variant="caption" sx={{ display: "block" }}>
            Fresh materialized data is available.
          </Typography>
          <Chip
            size="small"
            label="Update now"
            onClick={() =>
              void applyFreshMaterializationCommand({
                workspaceId,
                dashboardId,
              })
            }
            sx={{ cursor: "pointer", backgroundColor: "background.paper" }}
          />
        </Box>
      )}
      {showEventLog && recentEventLog.length > 0 && (
        <Box
          sx={{
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            backgroundColor: "background.paper",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {recentEventLog.map((entry, index) => (
            <Typography
              key={`${entry.timestamp}-${index}`}
              variant="caption"
              sx={{
                display: "block",
                color:
                  entry.level === "error"
                    ? "error.main"
                    : entry.level === "warn"
                      ? "warning.main"
                      : "text.secondary",
                fontFamily: "monospace",
                mb: 0.5,
              }}
            >
              [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.message}
            </Typography>
          ))}
        </Box>
      )}
    </>
  );
};

export default DashboardRuntimeChrome;
