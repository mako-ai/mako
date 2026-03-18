import { useEffect, useState, useRef, useCallback } from "react";
import {
  Box,
  Button,
  Typography,
  Alert,
  LinearProgress,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Checkbox,
  FormControlLabel,
} from "@mui/material";
import {
  Sync as SyncIcon,
  Cancel as CancelIcon,
  CheckCircle as CheckIcon,
  Error as ErrorIcon,
  HourglassEmpty as PendingIcon,
} from "@mui/icons-material";
import { useFlowStore, type FlowExecutionHistory } from "../store/flowStore";

interface BackfillPanelProps {
  workspaceId: string;
  flowId: string;
}

type ExecutionLog = {
  timestamp: string;
  level: string;
  message: string;
  metadata?: unknown;
};

function formatExecutionLog(log: ExecutionLog): string {
  const meta =
    log.metadata && typeof log.metadata === "object"
      ? (log.metadata as Record<string, unknown>)
      : undefined;
  const entity = typeof meta?.entity === "string" ? meta.entity : undefined;

  if (log.message === "Close API request sent") {
    const method =
      typeof meta?.method === "string" ? meta.method.toUpperCase() : "GET";
    const endpoint = typeof meta?.endpoint === "string" ? meta.endpoint : "";
    return `-> Close request ${method} ${endpoint}${entity ? ` [${entity}]` : ""}`;
  }

  if (log.message === "Close API response received") {
    const status = typeof meta?.status === "number" ? meta.status : undefined;
    const durationMs =
      typeof meta?.durationMs === "number"
        ? Math.round(meta.durationMs)
        : undefined;
    return `<- Close response${status ? ` ${status}` : ""}${durationMs !== undefined ? ` in ${durationMs}ms` : ""}${entity ? ` [${entity}]` : ""}`;
  }

  if (log.message === "Close API request failed") {
    const status = typeof meta?.status === "number" ? meta.status : undefined;
    const errorText =
      typeof meta?.error === "string" ? meta.error : "unknown error";
    return `!! Close request failed${status ? ` (${status})` : ""}: ${errorText}${entity ? ` [${entity}]` : ""}`;
  }

  if (log.message.includes("SQL chunk done") && entity) {
    const totalProcessed =
      typeof meta?.totalProcessed === "number"
        ? meta.totalProcessed.toLocaleString()
        : undefined;
    return `DB write complete for ${entity}${totalProcessed ? `: ${totalProcessed} total rows` : ""}`;
  }

  if (log.message.includes("sync in progress") && entity) {
    const totalProcessed =
      typeof meta?.totalProcessed === "number"
        ? meta.totalProcessed.toLocaleString()
        : undefined;
    return `${entity} syncing${totalProcessed ? `: ${totalProcessed} rows` : ""}`;
  }

  if (log.message === "SQL batch received from source") {
    const fetchedCount =
      typeof meta?.fetchedCount === "number" ? meta.fetchedCount : undefined;
    return `-> batch fetched${fetchedCount ? ` (${fetchedCount} rows)` : ""}${entity ? ` [${entity}]` : ""}`;
  }

  if (log.message === "SQL batch write succeeded") {
    const rowsWritten =
      typeof meta?.rowsWritten === "number" ? meta.rowsWritten : undefined;
    return `<- batch written${rowsWritten !== undefined ? ` (${rowsWritten} rows)` : ""}${entity ? ` [${entity}]` : ""}`;
  }

  if (log.message === "SQL batch write failed") {
    const errorText =
      typeof meta?.error === "string" ? meta.error : "unknown error";
    return `!! batch write failed: ${errorText}${entity ? ` [${entity}]` : ""}`;
  }

  return log.message;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function camelToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function formatEntityAsTableName(entity: string): string {
  if (!entity.includes(":")) return entity;
  const [parent, subEntity] = entity.split(":");
  if (!parent || !subEntity) return entity;
  return `${camelToSnake(subEntity)}_${parent}`;
}

function deriveProgressFromLogs(logs: ExecutionLog[]): {
  entityStats: Record<string, number>;
  entityStatus: Record<string, string>;
} {
  const entityStats: Record<string, number> = {};
  const entityStatus: Record<string, string> = {};

  for (const log of logs) {
    if (!log.metadata || typeof log.metadata !== "object") {
      continue;
    }

    const metadata = log.metadata as Record<string, unknown>;
    const entity =
      (typeof metadata.entity === "string" && metadata.entity) ||
      (typeof metadata.table === "string" && metadata.table) ||
      undefined;

    if (!entity) {
      continue;
    }

    const candidates = [
      toFiniteNumber(metadata.totalProcessed),
      toFiniteNumber(metadata.rowsWritten),
      toFiniteNumber(metadata.rowsProcessed),
      toFiniteNumber(metadata.recordCount),
    ].filter((value): value is number => value !== null);

    if (candidates.length > 0) {
      entityStats[entity] = Math.max(entityStats[entity] || 0, ...candidates);
    }

    if (
      log.message.toLowerCase().includes("sync completed") ||
      log.message.toLowerCase().includes("chunk completed")
    ) {
      entityStatus[entity] = "completed";
    } else if (!entityStatus[entity]) {
      entityStatus[entity] = "syncing";
    }
  }

  return {
    entityStats,
    entityStatus,
  };
}

export function BackfillPanel({ workspaceId, flowId }: BackfillPanelProps) {
  const {
    flows: flowsMap,
    backfillFlow,
    startCdcBackfill,
    fetchFlowStatus,
    fetchFlowHistory,
    fetchExecutionDetails,
    cancelFlowExecution,
    fetchCdcSummary,
    fetchCdcDiagnostics,
    pauseCdcFlow,
    resumeCdcFlow,
    resyncCdcFlow,
  } = useFlowStore();

  const [isTriggering, setIsTriggering] = useState(false);
  const [status, setStatus] = useState<
    null | "running" | "completed" | "failed" | "cancelled"
  >(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [entityStats, setEntityStats] = useState<Record<string, number>>({});
  const [entityStatus, setEntityStatus] = useState<Record<string, string>>({});
  const [plannedEntities, setPlannedEntities] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<FlowExecutionHistory | null>(null);
  const [history, setHistory] = useState<FlowExecutionHistory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [recentLogs, setRecentLogs] = useState<ExecutionLog[]>([]);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [cdcSummary, setCdcSummary] = useState<any | null>(null);
  const [cdcDiagnostics, setCdcDiagnostics] = useState<any | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [resyncDialogOpen, setResyncDialogOpen] = useState(false);
  const [deleteDestination, setDeleteDestination] = useState(false);
  const [clearWebhookEvents, setClearWebhookEvents] = useState(false);
  const [resyncConfirmText, setResyncConfirmText] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cdcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentFlow = (flowsMap[workspaceId] || []).find(f => f._id === flowId);
  const isCdcFlow = currentFlow?.syncEngine === "cdc";

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopCdcPolling = useCallback(() => {
    if (cdcPollRef.current) {
      clearInterval(cdcPollRef.current);
      cdcPollRef.current = null;
    }
  }, []);

  const pollCdcOverview = useCallback(async () => {
    if (!isCdcFlow) return;
    const summary = await fetchCdcSummary(workspaceId, flowId);
    if (summary) {
      setCdcSummary(summary);
    }
    if (showDiagnostics) {
      const diagnostics = await fetchCdcDiagnostics(workspaceId, flowId);
      if (diagnostics) {
        setCdcDiagnostics(diagnostics);
      }
    }
  }, [
    isCdcFlow,
    fetchCdcSummary,
    fetchCdcDiagnostics,
    workspaceId,
    flowId,
    showDiagnostics,
  ]);

  const loadHistory = useCallback(async () => {
    const runs = await fetchFlowHistory(workspaceId, flowId, 10);
    if (runs) setHistory(runs);
    if (runs?.[0]) setLastRun(runs[0]);
  }, [workspaceId, flowId, fetchFlowHistory]);

  const pollExecution = useCallback(async () => {
    if (!executionId) return;
    try {
      const details = await fetchExecutionDetails(
        workspaceId,
        flowId,
        executionId,
      );
      if (!details) return;
      if (wasCancelled) return;

      setLastHeartbeat(details.lastHeartbeat || null);

      const logs = (details.logs || []) as ExecutionLog[];
      if (logs.length > 0) {
        setRecentLogs(logs.slice(-8).reverse());
      }

      // Prefer backend stats when present, but fall back to parsing logs so users
      // still get feedback while long chunks are running.
      const statsFromApi =
        details.stats && typeof details.stats === "object"
          ? (details.stats as {
              entityStats?: Record<string, number>;
              entityStatus?: Record<string, string>;
              plannedEntities?: string[];
            })
          : undefined;

      const contextFromApi =
        details.context && typeof details.context === "object"
          ? (details.context as { entityFilter?: string[] })
          : undefined;

      if (Array.isArray(statsFromApi?.plannedEntities)) {
        setPlannedEntities(statsFromApi.plannedEntities);
      } else if (
        Array.isArray(contextFromApi?.entityFilter) &&
        contextFromApi.entityFilter.length > 0
      ) {
        setPlannedEntities(contextFromApi.entityFilter);
      }

      const derived =
        logs.length > 0 ? deriveProgressFromLogs(logs) : undefined;

      const mergedEntityStats: Record<string, number> = {
        ...(statsFromApi?.entityStats || {}),
      };
      if (derived?.entityStats) {
        for (const [entity, value] of Object.entries(derived.entityStats)) {
          mergedEntityStats[entity] = Math.max(
            mergedEntityStats[entity] || 0,
            value,
          );
        }
      }
      if (Object.keys(mergedEntityStats).length > 0) {
        setEntityStats(mergedEntityStats);
      }

      const mergedEntityStatus: Record<string, string> = {
        ...(derived?.entityStatus || {}),
        ...(statsFromApi?.entityStatus || {}),
      };
      if (Object.keys(mergedEntityStatus).length > 0) {
        setEntityStatus(mergedEntityStatus);
      }

      if (details.status !== "running") {
        stopPolling();
        setStatus(details.status === "completed" ? "completed" : "failed");
        if (details.error) setError(details.error.message);
        loadHistory();
      }
    } catch {
      // ignore polling errors
    }
  }, [
    executionId,
    workspaceId,
    flowId,
    fetchExecutionDetails,
    stopPolling,
    loadHistory,
    wasCancelled,
  ]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollExecution();
    pollRef.current = setInterval(pollExecution, 5000);
  }, [stopPolling, pollExecution]);

  // On mount: check if running + load history
  useEffect(() => {
    if (isCdcFlow) {
      return;
    }
    const init = async () => {
      const statusResp = await fetchFlowStatus(workspaceId, flowId);
      if (statusResp?.isRunning && statusResp.runningExecution) {
        setStatus("running");
        setExecutionId(statusResp.runningExecution.executionId);
        setStartedAt(statusResp.runningExecution.startedAt);
      }
      await loadHistory();
    };
    init();
    return stopPolling;
  }, [workspaceId, flowId, isCdcFlow, fetchFlowStatus, loadHistory, stopPolling]);

  // Start polling when executionId is set and status is running
  useEffect(() => {
    if (isCdcFlow) {
      return stopPolling;
    }
    if (status === "running" && executionId) {
      startPolling();
    }
    return stopPolling;
  }, [status, executionId, startPolling, stopPolling, isCdcFlow]);

  useEffect(() => {
    if (!isCdcFlow) {
      stopCdcPolling();
      return;
    }

    pollCdcOverview();
    cdcPollRef.current = setInterval(pollCdcOverview, 5000);
    return stopCdcPolling;
  }, [isCdcFlow, pollCdcOverview, stopCdcPolling]);

  const handleBackfill = async () => {
    if (isCdcFlow) {
      setIsTriggering(true);
      const ok = await startCdcBackfill(workspaceId, flowId);
      if (!ok) {
        setError("Failed to start CDC backfill");
      }
      await pollCdcOverview();
      setIsTriggering(false);
      return;
    }

    if (
      !confirm(
        "Run a full backfill? This will sync all historical data for the enabled entities.",
      )
    ) {
      return;
    }

    setIsTriggering(true);
    setError(null);
    setEntityStats({});
    setEntityStatus({});
    setPlannedEntities([]);
    setRecentLogs([]);
    setWasCancelled(false);
    try {
      await backfillFlow(workspaceId, flowId);
      setStatus("running");
      // Give Inngest a moment to create the execution, then check status
      setTimeout(async () => {
        const statusResp = await fetchFlowStatus(workspaceId, flowId);
        if (statusResp?.runningExecution) {
          setExecutionId(statusResp.runningExecution.executionId);
          setStartedAt(statusResp.runningExecution.startedAt);
        }
        setIsTriggering(false);
      }, 3000);
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Backfill failed");
      setIsTriggering(false);
    }
  };

  const handleCancel = async () => {
    stopPolling();
    setWasCancelled(true);
    setExecutionId(null);
    setEntityStats({});
    setEntityStatus({});
    setPlannedEntities([]);
    setRecentLogs([]);
    try {
      await cancelFlowExecution(workspaceId, flowId, executionId);
      setStatus("cancelled");
      setError(null);
    } catch {
      setStatus("failed");
      setError("Failed to cancel flow");
    }
  };

  const handleCdcPauseResume = async () => {
    if (!isCdcFlow) return;
    const currentState = cdcSummary?.syncState;
    const success =
      currentState === "paused"
        ? await resumeCdcFlow(workspaceId, flowId)
        : await pauseCdcFlow(workspaceId, flowId);
    if (!success) {
      setError("Failed to update CDC state");
      return;
    }
    await pollCdcOverview();
  };

  const handleCdcResync = async () => {
    if (resyncConfirmText !== "RESYNC") {
      return;
    }
    const success = await resyncCdcFlow(workspaceId, flowId, {
      deleteDestination,
      clearWebhookEvents,
    });
    if (!success) {
      setError("Failed to resync CDC flow");
      return;
    }
    setResyncDialogOpen(false);
    setResyncConfirmText("");
    await pollCdcOverview();
  };

  if (isCdcFlow) {
    const summary = cdcSummary;
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<SyncIcon />}
            onClick={handleBackfill}
            disabled={isTriggering}
          >
            Sync now
          </Button>
          <Button
            size="small"
            onClick={handleCdcPauseResume}
            disabled={!summary}
            startIcon={summary?.syncState === "paused" ? <SyncIcon /> : <CancelIcon />}
          >
            {summary?.syncState === "paused" ? "Resume" : "Pause"}
          </Button>
          <Button size="small" color="warning" onClick={() => setResyncDialogOpen(true)}>
            Resync from scratch
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button size="small" onClick={() => setShowDiagnostics(value => !value)}>
            {showDiagnostics ? "Hide diagnostics" : "View diagnostics"}
          </Button>
        </Box>

        <Box sx={{ p: 2, display: "grid", gap: 2 }}>
          {summary ? (
            <>
              <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                <Chip label={`State: ${summary.syncState.toUpperCase()}`} />
                <Chip label={`Backlog: ${summary.backlogCount}`} />
                <Chip
                  label={`Lag: ${summary.lagSeconds === null ? "n/a" : `${summary.lagSeconds}s`}`}
                />
                <Chip label="Engine: cdc" color="primary" variant="outlined" />
              </Box>

              <Typography variant="body2" color="text.secondary">
                Last webhook:{" "}
                {summary.lastWebhookAt
                  ? new Date(summary.lastWebhookAt).toLocaleString()
                  : "Never"}
                {" · "}Last materialized:{" "}
                {summary.lastMaterializedAt
                  ? new Date(summary.lastMaterializedAt).toLocaleString()
                  : "Never"}
              </Typography>

              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Entity</TableCell>
                      <TableCell align="right">Queued</TableCell>
                      <TableCell align="right">Lag</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {summary.entityCounts.map(entity => (
                      <TableRow key={entity.entity}>
                        <TableCell>{formatEntityAsTableName(entity.entity)}</TableCell>
                        <TableCell align="right">{entity.backlogCount}</TableCell>
                        <TableCell align="right">
                          {entity.lagSeconds === null ? "n/a" : `${entity.lagSeconds}s`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {showDiagnostics && cdcDiagnostics && (
                <Box sx={{ display: "grid", gap: 1 }}>
                  <Typography variant="subtitle2">Transition timeline</Typography>
                  {cdcDiagnostics.transitions.slice(0, 10).map((transition, index) => (
                    <Typography
                      key={`${transition.at}-${index}`}
                      variant="caption"
                      sx={{ fontFamily: "monospace" }}
                    >
                      {new Date(transition.at).toLocaleTimeString()} {transition.event} →{" "}
                      {transition.toState}
                      {transition.reason ? ` (${transition.reason})` : ""}
                    </Typography>
                  ))}
                  <Typography variant="subtitle2" sx={{ mt: 1 }}>
                    Recent events
                  </Typography>
                  {cdcDiagnostics.recentEvents.slice(0, 10).map((event, index) => (
                    <Typography
                      key={`${event.ingestSeq}-${index}`}
                      variant="caption"
                      sx={{ fontFamily: "monospace" }}
                    >
                      {event.entity} {event.operation} #{event.ingestSeq} [{event.materializationStatus}]
                    </Typography>
                  ))}
                </Box>
              )}
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Loading CDC summary...
            </Typography>
          )}
        </Box>

        <Dialog open={resyncDialogOpen} onClose={() => setResyncDialogOpen(false)}>
          <DialogTitle>Resync from scratch</DialogTitle>
          <DialogContent sx={{ display: "grid", gap: 1, minWidth: 420 }}>
            <Typography variant="body2">
              This will clear CDC state and restart backfill.
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={deleteDestination}
                  onChange={event => setDeleteDestination(event.target.checked)}
                />
              }
              label="Delete destination tables"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={clearWebhookEvents}
                  onChange={event => setClearWebhookEvents(event.target.checked)}
                />
              }
              label="Clear stored webhook events"
            />
            <TextField
              label="Type RESYNC to confirm"
              value={resyncConfirmText}
              onChange={event => setResyncConfirmText(event.target.value)}
              size="small"
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setResyncDialogOpen(false)}>Cancel</Button>
            <Button
              variant="contained"
              color="warning"
              disabled={resyncConfirmText !== "RESYNC"}
              onClick={handleCdcResync}
            >
              Resync
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    );
  }

  const entityEntries = Array.from(
    new Set([
      ...plannedEntities,
      ...Object.keys(entityStats),
      ...Object.keys(entityStatus),
    ]),
  )
    .map(entity => [entity, entityStats[entity] || 0] as const)
    .sort(([, a], [, b]) => b - a);

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      {/* Top bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Button
          size="small"
          variant="contained"
          startIcon={<SyncIcon />}
          onClick={handleBackfill}
          disabled={isTriggering || status === "running"}
        >
          {status === "running" ? "Backfill running..." : "Run Backfill"}
        </Button>
        {status === "running" && (
          <Button
            size="small"
            color="error"
            startIcon={<CancelIcon />}
            onClick={handleCancel}
          >
            Cancel
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        {startedAt && status === "running" && (
          <Typography variant="caption" color="text.secondary">
            Started {new Date(startedAt).toLocaleTimeString()}
            {lastHeartbeat
              ? ` · last update ${new Date(lastHeartbeat).toLocaleTimeString()}`
              : ""}
          </Typography>
        )}
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
        {/* Status banner */}
        {status === "running" && (
          <Box sx={{ mb: 2 }}>
            <LinearProgress sx={{ mb: 1 }} />
          </Box>
        )}

        {status === "completed" && !error && (
          <Alert
            severity="success"
            sx={{ mb: 2 }}
            onClose={() => setStatus(null)}
          >
            Backfill completed
            {lastRun?.duration != null &&
              ` in ${Math.round(lastRun.duration / 1000)}s`}
          </Alert>
        )}

        {status === "failed" && error && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            onClose={() => {
              setStatus(null);
              setError(null);
            }}
          >
            Backfill failed: {error}
          </Alert>
        )}

        {status === "cancelled" && (
          <Alert severity="info" sx={{ mb: 2 }} onClose={() => setStatus(null)}>
            Backfill cancelled
          </Alert>
        )}

        {status === "running" && recentLogs.length > 0 && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Live Activity
            </Typography>
            <Box
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                p: 1,
                bgcolor: "background.paper",
                maxHeight: 96, // ~4 lines of caption text
                overflowY: "auto",
              }}
            >
              {recentLogs.map((log, idx) => (
                <Typography
                  key={`${log.timestamp}-${idx}`}
                  variant="caption"
                  sx={{
                    display: "block",
                    fontFamily: "monospace",
                    whiteSpace: "pre-wrap",
                    color:
                      log.level === "error" ? "error.main" : "text.secondary",
                  }}
                >
                  [{new Date(log.timestamp).toLocaleTimeString()}]{" "}
                  {formatExecutionLog(log)}
                </Typography>
              ))}
            </Box>
          </Box>
        )}

        {/* Entity progress table */}
        {(status === "running" ||
          ((status === "completed" || status === "failed") &&
            entityEntries.length > 0)) && (
          <Box sx={{ mb: 3 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Entity Progress
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Entity</TableCell>
                    <TableCell align="right">Records</TableCell>
                    <TableCell align="center">Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {entityEntries.map(([entity, count]) => (
                    <TableRow key={entity}>
                      <TableCell>
                        <Typography variant="body2">
                          {formatEntityAsTableName(entity)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2" fontWeight="bold">
                          {count.toLocaleString()}
                        </Typography>
                      </TableCell>
                      <TableCell align="center">
                        {status === "running" &&
                        entityStatus[entity] === "completed" ? (
                          <Chip
                            icon={<CheckIcon />}
                            label="done"
                            size="small"
                            color="success"
                            variant="outlined"
                          />
                        ) : status === "running" ? (
                          <Chip
                            icon={<PendingIcon />}
                            label={
                              entityStatus[entity] === "pending"
                                ? "pending"
                                : entityStatus[entity] === "failed"
                                  ? "failed"
                                  : "processing"
                            }
                            size="small"
                            color={
                              entityStatus[entity] === "failed"
                                ? "error"
                                : entityStatus[entity] === "pending"
                                  ? "default"
                                  : "info"
                            }
                            variant="outlined"
                          />
                        ) : entityStatus[entity] === "failed" ? (
                          <Chip
                            icon={<ErrorIcon />}
                            label="failed"
                            size="small"
                            color="error"
                            variant="outlined"
                          />
                        ) : entityStatus[entity] === "pending" ? (
                          <Chip
                            icon={<PendingIcon />}
                            label="pending"
                            size="small"
                            color="default"
                            variant="outlined"
                          />
                        ) : (
                          <Chip
                            icon={<CheckIcon />}
                            label="done"
                            size="small"
                            color="success"
                            variant="outlined"
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {status === "running" && entityEntries.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} align="center">
                        <Typography variant="body2" color="text.secondary">
                          Waiting for first entity to start syncing...
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {/* Past runs */}
        {history.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Run History
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Duration</TableCell>
                    <TableCell align="right">Records</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {history.map(run => (
                    <TableRow key={run.executionId}>
                      <TableCell>
                        <Typography variant="body2">
                          {new Date(
                            run.startedAt || run.executedAt,
                          ).toLocaleString()}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          icon={
                            run.status === "completed" ? (
                              <CheckIcon />
                            ) : run.status === "running" ? (
                              <SyncIcon />
                            ) : (
                              <ErrorIcon />
                            )
                          }
                          label={run.status}
                          size="small"
                          color={
                            run.status === "completed"
                              ? "success"
                              : run.status === "running"
                                ? "info"
                                : "error"
                          }
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2">
                          {run.duration
                            ? `${Math.round(run.duration / 1000)}s`
                            : "—"}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="body2">
                          {(
                            run.stats as
                              | { recordsProcessed?: number }
                              | undefined
                          )?.recordsProcessed?.toLocaleString() || "—"}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {/* Empty state */}
        {!status && history.length === 0 && (
          <Box
            sx={{
              textAlign: "center",
              py: 6,
              color: "text.secondary",
            }}
          >
            <SyncIcon sx={{ fontSize: 48, mb: 1, opacity: 0.3 }} />
            <Typography variant="body1">No backfill runs yet</Typography>
            <Typography variant="body2">
              Click "Run Backfill" to sync historical data from Close to
              BigQuery
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
