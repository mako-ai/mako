import { useEffect, useState, useCallback } from "react";
import {
  Box,
  CircularProgress,
  List,
  ListItemButton,
  ListItemText,
  Typography,
  Alert,
  Stack,
  styled,
  Button,
  IconButton,
} from "@mui/material";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import {
  PlayArrow as PlayArrowIcon,
  EditOutlined as EditIcon,
  Stop as StopIcon,
  Refresh as RefreshIcon,
} from "@mui/icons-material";
import { useWorkspace } from "../contexts/workspace-context";
import { apiClient } from "../lib/api-client";

interface ExecutionHistoryItem {
  executionId: string;
  executedAt: string;
  startedAt?: string;
  lastHeartbeat?: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  success: boolean;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  duration?: number;
  system?: {
    workerId: string;
    workerVersion?: string;
    nodeVersion: string;
    hostname: string;
  };
  context?: {
    dataSourceId: string;
    destinationDatabaseId?: string;
    destinationDatabaseName?: string;
    syncMode: string;
    entityFilter?: string[];
  };
  stats?: any;
  logs?: Array<{
    timestamp: string;
    level: string;
    message: string;
    metadata?: any;
  }>;
}

interface SyncJobDetails {
  id: string;
  description?: any;
  dataSourceId: string;
  dataSourceName?: any;
  destinationDatabaseId?: string;
  destinationDatabaseName?: any;
  syncMode: any;
  entityFilter?: any[];
  schedule?: {
    cron: string;
    timezone?: string;
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SyncJobLogsProps {
  jobId: string;
  onRunNow?: () => void;
  onEdit?: () => void;
}

// Styled PanelResizeHandle components (moved from Databases.tsx/Consoles.tsx)
const StyledHorizontalResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  width: "1px",
  background: theme.palette.divider,
  cursor: "col-resize",
  transition: "background-color 0.2s ease",
  "&:hover": {
    backgroundColor: theme.palette.primary.main,
  },
}));

export function SyncJobLogs({ jobId, onRunNow, onEdit }: SyncJobLogsProps) {
  const { currentWorkspace } = useWorkspace();
  const [history, setHistory] = useState<ExecutionHistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [fullExecutionDetails, setFullExecutionDetails] =
    useState<ExecutionHistoryItem | null>(null);
  const [jobDetails, setJobDetails] = useState<SyncJobDetails | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runningExecutionId, setRunningExecutionId] = useState<string | null>(
    null,
  );

  // Function to fetch history
  const fetchHistory = useCallback(async () => {
    if (!currentWorkspace?.id || !jobId) return;
    setIsLoading(true);
    try {
      const response = await apiClient.get<{
        success: boolean;
        data: {
          history: ExecutionHistoryItem[];
        };
      }>(`/workspaces/${currentWorkspace.id}/sync-jobs/${jobId}/history`, {
        limit: "100",
      });

      if (response.success) {
        setHistory(response.data.history || []);
      } else {
        setError("Failed to load history");
      }
    } catch (err) {
      console.error("Failed to fetch execution history", err);
      setError("Failed to load execution history");
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkspace?.id, jobId]);

  // Function to check job running status
  const checkJobStatus = useCallback(async () => {
    if (!currentWorkspace?.id || !jobId) return;
    try {
      const response = await apiClient.get<{
        success: boolean;
        data: {
          isRunning: boolean;
          runningExecution: {
            executionId: string;
            startedAt: string;
            lastHeartbeat: string;
          } | null;
        };
      }>(`/workspaces/${currentWorkspace.id}/sync-jobs/${jobId}/status`);

      if (response.success) {
        setIsRunning(response.data.isRunning);
        setRunningExecutionId(
          response.data.runningExecution?.executionId || null,
        );
      }
    } catch (err) {
      console.error("Failed to check job status", err);
    }
  }, [currentWorkspace?.id, jobId]);

  // Function to cancel running job
  const handleCancel = useCallback(async () => {
    if (!currentWorkspace?.id || !jobId) return;
    try {
      const response = await apiClient.post<{
        success: boolean;
        message: string;
      }>(`/workspaces/${currentWorkspace.id}/sync-jobs/${jobId}/cancel`, {
        executionId: runningExecutionId, // Pass the executionId if available
      });

      if (response.success) {
        // Wait a moment then refresh status
        setTimeout(() => {
          checkJobStatus();
          // Refresh history to show cancelled execution
          fetchHistory();
        }, 1000);
      } else {
        setError("Failed to cancel job");
      }
    } catch (err) {
      console.error("Failed to cancel job", err);
      setError("Failed to cancel job execution");
    }
  }, [
    currentWorkspace?.id,
    jobId,
    runningExecutionId,
    checkJobStatus,
    fetchHistory,
  ]);

  // Function to handle run/cancel button click
  const handleButtonClick = useCallback(() => {
    if (isRunning) {
      handleCancel();
    } else if (onRunNow) {
      onRunNow();
      // Start checking status after triggering run
      setTimeout(() => {
        checkJobStatus();
        fetchHistory();
      }, 1000);
    }
  }, [isRunning, handleCancel, onRunNow, checkJobStatus, fetchHistory]);

  // Fetch job details
  useEffect(() => {
    const fetchJobDetails = async () => {
      if (!currentWorkspace?.id || !jobId) return;
      try {
        const response = await apiClient.get<{
          success: boolean;
          data: SyncJobDetails;
        }>(`/workspaces/${currentWorkspace.id}/sync-jobs/${jobId}`);

        if (response.success) {
          setJobDetails(response.data);
        }
      } catch (err) {
        console.error("Failed to fetch job details", err);
      }
    };

    fetchJobDetails();
  }, [currentWorkspace?.id, jobId]);

  // Fetch execution history and check status
  useEffect(() => {
    fetchHistory();
    checkJobStatus();
  }, [currentWorkspace?.id, jobId, fetchHistory, checkJobStatus]);

  const selectedHistory =
    selectedIndex >= 0 && selectedIndex < history.length
      ? history[selectedIndex]
      : null;

  // Fetch logs and full execution details when a history item is selected
  useEffect(() => {
    const fetchExecutionDetails = async () => {
      if (!selectedHistory || !currentWorkspace?.id) return;
      try {
        const response = await apiClient.get<{
          success: boolean;
          data: ExecutionHistoryItem;
        }>(
          `/workspaces/${currentWorkspace.id}/sync-jobs/${jobId}/executions/${selectedHistory.executionId}`,
        );

        if (response.success && response.data) {
          setFullExecutionDetails(response.data);
          setLogs(response.data.logs || []);
        } else {
          setFullExecutionDetails(null);
          setLogs([]);
        }
      } catch (err) {
        console.error("Failed to fetch execution details", err);
        setFullExecutionDetails(null);
        setLogs([]);
      }
    };

    fetchExecutionDetails();
  }, [selectedHistory, currentWorkspace?.id, jobId]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const formatDuration = (milliseconds: number): string => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "N/A";
    const totalSeconds = Math.floor(milliseconds / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
  };

  // Helper function to safely extract string values from potentially complex objects
  const extractStringValue = (value: any, fallback: string = ""): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object" && value.name) {
      return String(value.name);
    }
    return fallback;
  };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar with Run and Edit buttons */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          p: 1,
          backgroundColor: "background.paper",
        }}
      >
        <Box sx={{ display: "flex", gap: 1 }}>
          {onRunNow && (
            <Button
              variant={isRunning ? "contained" : "outlined"}
              size="small"
              startIcon={
                isRunning ? (
                  <StopIcon fontSize="small" />
                ) : (
                  <PlayArrowIcon fontSize="small" />
                )
              }
              onClick={handleButtonClick}
              color={isRunning ? "error" : "primary"}
            >
              {isRunning ? "Cancel" : "Run now"}
            </Button>
          )}
          {onEdit && (
            <Button
              variant="text"
              size="small"
              onClick={onEdit}
              disableElevation
              startIcon={<EditIcon fontSize="small" />}
            >
              Edit
            </Button>
          )}
        </Box>
      </Box>

      {/* Job Overview */}
      {jobDetails && (
        <Box
          sx={{
            p: 1,
            pt: 0,
            borderBottom: 1,
            borderColor: "divider",
            backgroundColor: "background.paper",
          }}
        >
          <Stack spacing={1}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 1,
              }}
            >
              <Typography variant="body2">
                <strong>Source:</strong>{" "}
                {extractStringValue(
                  jobDetails.dataSourceName,
                  extractStringValue(jobDetails.dataSourceId, "Unknown"),
                )}
              </Typography>
              <Typography variant="body2">
                <strong>Destination:</strong>{" "}
                {extractStringValue(
                  jobDetails.destinationDatabaseName,
                  extractStringValue(
                    jobDetails.destinationDatabaseId,
                    "Default",
                  ),
                )}
              </Typography>
              <Typography variant="body2">
                <strong>Sync Mode:</strong>{" "}
                {extractStringValue(jobDetails.syncMode, "Unknown")}
              </Typography>
              <Typography variant="body2">
                <strong>Status:</strong>{" "}
                {jobDetails.enabled ? "Active" : "Inactive"}
              </Typography>
            </Box>
            {jobDetails.schedule?.cron && (
              <Typography variant="body2">
                <strong>Schedule:</strong>{" "}
                {extractStringValue(jobDetails.schedule.cron, "")}
                {jobDetails.schedule.timezone &&
                  ` (${extractStringValue(jobDetails.schedule.timezone, "")})`}
              </Typography>
            )}
            {jobDetails.entityFilter &&
              Array.isArray(jobDetails.entityFilter) &&
              jobDetails.entityFilter.length > 0 && (
                <Typography variant="body2">
                  <strong>Entities:</strong>{" "}
                  {jobDetails.entityFilter
                    .map(entity => extractStringValue(entity, ""))
                    .join(", ")}
                </Typography>
              )}
            {jobDetails.description && (
              <Typography variant="body2">
                <strong>Description:</strong>{" "}
                {extractStringValue(jobDetails.description, "")}
              </Typography>
            )}
          </Stack>
        </Box>
      )}

      {/* Main content area */}
      <Box
        sx={{
          flex: 1,
          minHeight: 400,
        }}
      >
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <PanelGroup direction="horizontal" style={{ height: "100%" }}>
          <Panel
            defaultSize={25}
            minSize={10}
            maxSize={50}
            style={{ overflow: "auto" }}
          >
            <Box
              sx={{
                p: 1,
                pb: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: 1,
                borderColor: "divider",
              }}
            >
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                Run history
              </Typography>
              <IconButton
                size="small"
                aria-label="Refresh"
                onClick={() => {
                  fetchHistory();
                  checkJobStatus();
                }}
                disabled={isLoading}
                sx={{ color: "text.primary" }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Box>
            {isLoading ? (
              <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
                <CircularProgress size={24} />
              </Box>
            ) : history.length === 0 ? (
              <Typography variant="body2" sx={{ p: 2 }}>
                No execution history available.
              </Typography>
            ) : (
              <List dense>
                {history.map((h, idx) => (
                  <ListItemButton
                    key={idx}
                    selected={idx === selectedIndex}
                    onClick={() => setSelectedIndex(idx)}
                  >
                    <ListItemText
                      primary={formatDate(h.executedAt)}
                      secondary={
                        <Typography
                          variant="caption"
                          color={
                            h.status === "running"
                              ? "primary"
                              : h.status === "completed"
                                ? "success.main"
                                : h.status === "failed"
                                  ? "error.main"
                                  : h.status === "cancelled"
                                    ? "warning.main"
                                    : h.status === "abandoned"
                                      ? "text.secondary"
                                      : "text.secondary"
                          }
                        >
                          {h.status.charAt(0).toUpperCase() + h.status.slice(1)}
                          {h.status === "running" && " 🔄"}
                          {h.status === "abandoned" && " ⚠️"}
                        </Typography>
                      }
                      sx={{
                        "& .MuiListItemText-primary": {
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        },
                      }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Panel>
          <StyledHorizontalResizeHandle />
          <Panel style={{ padding: 16, overflow: "auto" }}>
            {selectedHistory ? (
              (() => {
                // Use fullExecutionDetails if available, otherwise fall back to selectedHistory
                const details = fullExecutionDetails || selectedHistory;
                return (
                  <Stack spacing={2}>
                    <Typography variant="subtitle2" color="text.secondary">
                      <strong>Run ID:</strong> {selectedHistory.executionId}
                    </Typography>

                    {/* Timing Information */}
                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 1,
                      }}
                    >
                      <Typography variant="body2">
                        <strong>Started:</strong>{" "}
                        {details.startedAt
                          ? formatDate(details.startedAt)
                          : "N/A"}
                      </Typography>
                      <Typography variant="body2">
                        <strong>Completed:</strong>{" "}
                        {details.completedAt
                          ? formatDate(details.completedAt)
                          : "N/A"}
                      </Typography>
                      <Typography variant="body2">
                        <strong>Last Heartbeat:</strong>{" "}
                        {details.lastHeartbeat
                          ? formatDate(details.lastHeartbeat)
                          : "N/A"}
                      </Typography>
                      <Typography variant="body2">
                        <strong>Status:</strong> {details.status}
                      </Typography>
                    </Box>

                    {details.duration !== undefined && (
                      <Typography variant="body2">
                        <strong>Duration:</strong>{" "}
                        {formatDuration(details.duration)}
                      </Typography>
                    )}

                    {/* System Information */}
                    {details.system && (
                      <Box>
                        <Typography variant="subtitle2" sx={{ mt: 1, mb: 1 }}>
                          System Information
                        </Typography>
                        <Box
                          sx={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 1,
                          }}
                        >
                          <Typography variant="body2">
                            <strong>Worker ID:</strong>{" "}
                            {details.system.workerId}
                          </Typography>
                          <Typography variant="body2">
                            <strong>Hostname:</strong> {details.system.hostname}
                          </Typography>
                          <Typography variant="body2">
                            <strong>Node Version:</strong>{" "}
                            {details.system.nodeVersion}
                          </Typography>
                          {details.system.workerVersion && (
                            <Typography variant="body2">
                              <strong>Worker Version:</strong>{" "}
                              {details.system.workerVersion}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    )}

                    {/* Context Information */}
                    {details.context && (
                      <Box>
                        <Typography variant="subtitle2" sx={{ mt: 1, mb: 1 }}>
                          Sync Configuration
                        </Typography>
                        <Box
                          sx={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 1,
                          }}
                        >
                          <Typography variant="body2">
                            <strong>Sync Mode:</strong>{" "}
                            {details.context.syncMode}
                          </Typography>
                          <Typography variant="body2">
                            <strong>Data Source ID:</strong>{" "}
                            {details.context.dataSourceId}
                          </Typography>
                        </Box>
                        {details.context.entityFilter &&
                          details.context.entityFilter.length > 0 && (
                            <Typography variant="body2" sx={{ mt: 1 }}>
                              <strong>Entities:</strong>{" "}
                              {details.context.entityFilter.join(", ")}
                            </Typography>
                          )}
                      </Box>
                    )}

                    {details.error && (
                      <Alert severity="error">
                        <Typography variant="body2" sx={{ mb: 1 }}>
                          <strong>Error:</strong> {details.error.message}
                        </Typography>
                        {details.error.stack && (
                          <Typography
                            variant="caption"
                            component="pre"
                            sx={{
                              whiteSpace: "pre-wrap",
                              fontSize: "0.7rem",
                              fontFamily: "monospace",
                            }}
                          >
                            {details.error.stack}
                          </Typography>
                        )}
                      </Alert>
                    )}

                    {logs.length > 0 && (
                      <Box>
                        <Typography variant="subtitle2">Logs</Typography>
                        {logs.map((l, idx) => (
                          <Typography
                            key={idx}
                            variant="caption"
                            component="pre"
                            sx={{
                              whiteSpace: "pre-wrap",
                              fontFamily: "monospace",
                            }}
                          >
                            [{new Date(l.timestamp).toLocaleTimeString()}]{" "}
                            {l.level.toUpperCase()}: {l.message}
                          </Typography>
                        ))}
                      </Box>
                    )}
                  </Stack>
                );
              })()
            ) : (
              <Typography variant="body2">
                Select a run to view details.
              </Typography>
            )}
          </Panel>
        </PanelGroup>
      </Box>
    </Box>
  );
}
