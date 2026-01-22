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
import { useFlowStore } from "../store/flowStore";

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

interface FlowDetails {
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

interface FlowLogsProps {
  flowId: string;
  onRunNow?: () => void;
  onEdit?: () => void;
}

// Styled PanelResizeHandle components
const StyledHorizontalResizeHandle = styled(PanelResizeHandle)(({ theme }) => ({
  width: "1px",
  background: theme.palette.divider,
  cursor: "col-resize",
  transition: "background-color 0.2s ease",
  "&:hover": {
    backgroundColor: theme.palette.primary.main,
  },
}));

export function FlowLogs({ flowId, onRunNow, onEdit }: FlowLogsProps) {
  const { currentWorkspace } = useWorkspace();
  const {
    fetchFlowHistory,
    fetchFlowStatus,
    cancelFlowExecution,
    fetchFlowDetails,
    fetchExecutionDetails,
  } = useFlowStore();
  const [history, setHistory] = useState<ExecutionHistoryItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [fullExecutionDetails, setFullExecutionDetails] =
    useState<ExecutionHistoryItem | null>(null);
  const [flowDetails, setFlowDetails] = useState<FlowDetails | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runningExecutionId, setRunningExecutionId] = useState<string | null>(
    null,
  );

  // Function to fetch history
  const fetchHistory = useCallback(async () => {
    if (!currentWorkspace?.id || !flowId) return;
    setIsLoading(true);
    try {
      const history = await fetchFlowHistory(currentWorkspace.id, flowId, 100);
      setHistory(history || []);
    } catch (err) {
      console.error("Failed to fetch execution history", err);
      setError("Failed to load execution history");
    } finally {
      setIsLoading(false);
    }
  }, [currentWorkspace?.id, flowId, fetchFlowHistory]);

  // Function to check flow running status
  const checkFlowStatus = useCallback(async () => {
    if (!currentWorkspace?.id || !flowId) return;
    try {
      const data = await fetchFlowStatus(currentWorkspace.id, flowId);
      if (data) {
        setIsRunning(data.isRunning);
        setRunningExecutionId(data.runningExecution?.executionId || null);
      }
    } catch (err) {
      console.error("Failed to check flow status", err);
    }
  }, [currentWorkspace?.id, flowId, fetchFlowStatus]);

  // Function to cancel running flow
  const handleCancel = useCallback(async () => {
    if (!currentWorkspace?.id || !flowId) return;
    try {
      const success = await cancelFlowExecution(
        currentWorkspace.id,
        flowId,
        runningExecutionId,
      );
      if (success) {
        // Wait a moment then refresh status
        setTimeout(() => {
          checkFlowStatus();
          // Refresh history to show cancelled execution
          fetchHistory();
        }, 1000);
      } else {
        setError("Failed to cancel flow");
      }
    } catch (err) {
      console.error("Failed to cancel flow", err);
      setError("Failed to cancel flow execution");
    }
  }, [
    currentWorkspace?.id,
    flowId,
    runningExecutionId,
    checkFlowStatus,
    fetchHistory,
    cancelFlowExecution,
  ]);

  // Function to handle run/cancel button click
  const handleButtonClick = useCallback(() => {
    if (isRunning) {
      handleCancel();
    } else if (onRunNow) {
      onRunNow();
      // Start checking status after triggering run
      setTimeout(() => {
        checkFlowStatus();
        fetchHistory();
      }, 1000);
    }
  }, [isRunning, handleCancel, onRunNow, checkFlowStatus, fetchHistory]);

  // Fetch flow details
  useEffect(() => {
    const loadFlowDetails = async () => {
      if (!currentWorkspace?.id || !flowId) return;
      const data = await fetchFlowDetails(currentWorkspace.id, flowId);
      if (data) setFlowDetails(data as FlowDetails);
    };

    loadFlowDetails();
  }, [currentWorkspace?.id, flowId, fetchFlowDetails]);

  // Fetch execution history and check status
  useEffect(() => {
    fetchHistory();
    checkFlowStatus();
  }, [currentWorkspace?.id, flowId, fetchHistory, checkFlowStatus]);

  const selectedHistory =
    selectedIndex >= 0 && selectedIndex < history.length
      ? history[selectedIndex]
      : null;

  // Fetch logs and full execution details when a history item is selected
  useEffect(() => {
    const fetchExecutionDetails = async () => {
      if (!selectedHistory || !currentWorkspace?.id) return;
      try {
        const data = await fetchExecutionDetails(
          currentWorkspace.id,
          flowId,
          selectedHistory.executionId,
        );
        if (data) {
          setFullExecutionDetails(data as ExecutionHistoryItem);
          setLogs(data.logs || []);
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
  }, [selectedHistory, currentWorkspace?.id, flowId]);

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

      {/* Flow Overview */}
      {flowDetails && (
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
                  flowDetails.dataSourceName,
                  extractStringValue(flowDetails.dataSourceId, "Unknown"),
                )}
              </Typography>
              <Typography variant="body2">
                <strong>Destination:</strong>{" "}
                {extractStringValue(
                  flowDetails.destinationDatabaseName,
                  extractStringValue(
                    flowDetails.destinationDatabaseId,
                    "Default",
                  ),
                )}
              </Typography>
              <Typography variant="body2">
                <strong>Sync Mode:</strong>{" "}
                {extractStringValue(flowDetails.syncMode, "Unknown")}
              </Typography>
              <Typography variant="body2">
                <strong>Status:</strong>{" "}
                {flowDetails.enabled ? "Active" : "Inactive"}
              </Typography>
            </Box>
            {flowDetails.schedule?.cron && (
              <Typography variant="body2">
                <strong>Schedule:</strong>{" "}
                {extractStringValue(flowDetails.schedule.cron, "")}
                {flowDetails.schedule.timezone &&
                  ` (${extractStringValue(flowDetails.schedule.timezone, "")})`}
              </Typography>
            )}
            {flowDetails.entityFilter &&
              Array.isArray(flowDetails.entityFilter) &&
              flowDetails.entityFilter.length > 0 && (
                <Typography variant="body2">
                  <strong>Entities:</strong>{" "}
                  {flowDetails.entityFilter
                    .map(entity => extractStringValue(entity, ""))
                    .join(", ")}
                </Typography>
              )}
            {flowDetails.description && (
              <Typography variant="body2">
                <strong>Description:</strong>{" "}
                {extractStringValue(flowDetails.description, "")}
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
                  checkFlowStatus();
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
