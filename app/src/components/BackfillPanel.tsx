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
  Edit as EditIcon,
  Pause as PauseIcon,
  PlayArrow as ResumeIcon,
  Refresh as RetryIcon,
  RestartAlt as ResyncIcon,
  BugReport as DiagnosticsIcon,
  Healing as RecoverIcon,
} from "@mui/icons-material";
import { useFlowStore, type FlowExecutionHistory } from "../store/flowStore";

interface BackfillPanelProps {
  workspaceId: string;
  flowId: string;
  onEdit?: () => void;
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

export function BackfillPanel({
  workspaceId,
  flowId,
  onEdit,
}: BackfillPanelProps) {
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
    recoverCdcFlow,
    retryFailedCdcMaterialization,
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
  const [isResyncing, setIsResyncing] = useState(false);
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
    const init = async () => {
      const statusResp = await fetchFlowStatus(workspaceId, flowId);
      if (statusResp?.isRunning && statusResp.runningExecution) {
        setStatus("running");
        setExecutionId(statusResp.runningExecution.executionId);
        setStartedAt(statusResp.runningExecution.startedAt);
      }
      if (!isCdcFlow) {
        await loadHistory();
      }
    };
    init();
    return stopPolling;
  }, [
    workspaceId,
    flowId,
    isCdcFlow,
    fetchFlowStatus,
    loadHistory,
    stopPolling,
  ]);

  // Start polling when executionId is set and status is running
  useEffect(() => {
    if (status === "running" && executionId) {
      startPolling();
    }
    return stopPolling;
  }, [status, executionId, startPolling, stopPolling]);

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
      setRecentLogs([]);
      setEntityStats({});
      setEntityStatus({});
      setError(null);
      const ok = await startCdcBackfill(workspaceId, flowId);
      if (!ok) {
        setError("Failed to start CDC backfill");
        setIsTriggering(false);
        return;
      }
      await pollCdcOverview();
      setIsTriggering(false);

      const detectExecution = async (attempts = 0): Promise<void> => {
        if (attempts > 8) return;
        const statusResp = await fetchFlowStatus(workspaceId, flowId);
        if (statusResp?.isRunning && statusResp.runningExecution) {
          setStatus("running");
          setExecutionId(statusResp.runningExecution.executionId);
          setStartedAt(statusResp.runningExecution.startedAt);
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
        return detectExecution(attempts + 1);
      };
      detectExecution();
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
    setIsResyncing(true);
    const success = await resyncCdcFlow(workspaceId, flowId, {
      deleteDestination,
      clearWebhookEvents,
    });
    setIsResyncing(false);
    if (!success) {
      setError("Failed to resync CDC flow");
      return;
    }
    setResyncDialogOpen(false);
    setResyncConfirmText("");
    await pollCdcOverview();
  };

  const handleCdcRecover = async () => {
    if (!isCdcFlow) return;
    const success = await recoverCdcFlow(workspaceId, flowId, {
      retryFailedMaterialization: true,
      resumeBackfill: true,
    });
    if (!success) {
      setError("Failed to recover CDC flow");
      return;
    }
    await pollCdcOverview();
  };

  const handleRetryFailedMaterialization = async () => {
    if (!isCdcFlow) return;
    const success = await retryFailedCdcMaterialization(workspaceId, flowId);
    if (!success) {
      setError("Failed to queue failed CDC rows for retry");
      return;
    }
    await pollCdcOverview();
  };

  if (isCdcFlow) {
    const summary = cdcSummary;

    const formatLagDuration = (lagSeconds: number | null) => {
      if (lagSeconds === null || !Number.isFinite(lagSeconds)) return "n/a";
      if (lagSeconds < 60) return `${lagSeconds}s`;
      if (lagSeconds < 3600) {
        const minutes = Math.floor(lagSeconds / 60);
        const seconds = lagSeconds % 60;
        return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
      }
      const hours = Math.floor(lagSeconds / 3600);
      const minutes = Math.floor((lagSeconds % 3600) / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    };

    const stateColor = (state?: string) => {
      switch (state) {
        case "live":
          return "success";
        case "backfill":
        case "catchup":
          return "info";
        case "paused":
          return "default";
        case "degraded":
          return "error";
        default:
          return "default";
      }
    };

    const freshnessSummary = (() => {
      if (!summary) return "unknown";
      const webhookLagSeconds = (() => {
        if (!summary.lastWebhookAt) return null;
        const lastWebhookTs = new Date(summary.lastWebhookAt).getTime();
        if (!Number.isFinite(lastWebhookTs)) return null;
        return Math.max(Math.floor((Date.now() - lastWebhookTs) / 1000), 0);
      })();

      if (
        (summary.failedCount ?? 0) === 0 &&
        (summary.backlogCount ?? 0) === 0
      ) {
        return "live";
      }
      if (webhookLagSeconds !== null) {
        return `lag ${formatLagDuration(webhookLagSeconds)}`;
      }
      return `lag ${formatLagDuration(summary.lagSeconds)}`;
    })();

    const entityBackfillStatus = (entity: {
      backlogCount: number;
      failedCount: number;
      droppedCount: number;
      lastMaterializedAt: string | null;
    }) => {
      if (entity.failedCount > 0) return "Failed";
      if (!entity.lastMaterializedAt && entity.backlogCount === 0) {
        return "Not started";
      }
      if (entity.backlogCount > 0) return "In progress";
      if (entity.droppedCount > 0) return "Filtered";
      return "Completed";
    };

    const entityObjectStatus = (entity: {
      backlogCount: number;
      failedCount: number;
      droppedCount: number;
      lastMaterializedAt: string | null;
    }) => {
      if (entity.failedCount > 0) {
        return { label: "Error", color: "error" as const };
      }
      if (entity.backlogCount > 0) {
        return { label: "Syncing", color: "info" as const };
      }
      if (entity.droppedCount > 0) {
        return { label: "Filtered", color: "warning" as const };
      }
      if (entity.lastMaterializedAt) {
        return { label: "Running", color: "success" as const };
      }
      return { label: "Pending", color: "default" as const };
    };

    const entityLagLabel = (entity: {
      backlogCount: number;
      failedCount: number;
      lagSeconds: number | null;
    }) => {
      if (entity.lagSeconds === null) return "—";
      // For entities with no queued/failed events, a growing lag mostly means
      // "no recent events" rather than "pipeline delay".
      if (entity.backlogCount === 0 && entity.failedCount === 0) return "—";
      return formatLagDuration(entity.lagSeconds);
    };

    const connectorName = currentFlow?.dataSourceId
      ? typeof currentFlow.dataSourceId === "object"
        ? (currentFlow.dataSourceId as any).name
        : undefined
      : undefined;
    const connectorType = currentFlow?.dataSourceId
      ? typeof currentFlow.dataSourceId === "object"
        ? (currentFlow.dataSourceId as any).type
        : undefined
      : undefined;
    const destName = currentFlow?.destinationDatabaseId
      ? typeof currentFlow.destinationDatabaseId === "object"
        ? (currentFlow.destinationDatabaseId as any).name
        : undefined
      : undefined;
    const destType = currentFlow?.destinationDatabaseId
      ? typeof currentFlow.destinationDatabaseId === "object"
        ? (currentFlow.destinationDatabaseId as any).type
        : undefined
      : undefined;
    const dataset = currentFlow?.tableDestination?.schema;
    const webhookEndpoint = currentFlow?.webhookConfig?.endpoint;

    const act = {
      fontSize: "0.8rem",
      textTransform: "none" as const,
      fontWeight: 500,
      color: "primary.main",
      minWidth: 0,
      px: 1.5,
      gap: 0.5,
      "&:hover": { bgcolor: "action.hover" },
      "& .MuiButton-startIcon": { mr: 0.5 },
    };
    const actDanger = { ...act, color: "error.main" };

    const state = summary?.syncState;
    const backfillRunning = status === "running" || state === "backfill";
    const isPaused = state === "paused" && !backfillRunning;
    const isDegraded = state === "degraded" && !backfillRunning;
    const isIdle = (!state || state === "idle") && !backfillRunning;
    const hasFailed = (summary?.failedCount ?? 0) > 0;
    const failedDroppedDetail =
      summary &&
      ((summary.failedCount ?? 0) > 0 || (summary.backlogCount ?? 0) > 0)
        ? `Lag ${formatLagDuration(summary.lagSeconds)}`
        : "No queued or failed events";

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
            flexWrap: "wrap",
            px: 1,
            py: 0.5,
            borderBottom: 1,
            borderColor: "divider",
            gap: 0,
            minHeight: 40,
          }}
        >
          {/* Primary action — changes based on state */}
          {isIdle && (
            <Button
              sx={act}
              startIcon={<SyncIcon sx={{ fontSize: 18 }} />}
              onClick={handleBackfill}
              disabled={isTriggering}
            >
              Start backfill
            </Button>
          )}
          {backfillRunning && (
            <>
              <Button
                sx={act}
                startIcon={<SyncIcon sx={{ fontSize: 18 }} />}
                disabled
              >
                Backfilling…
              </Button>
              <Button
                sx={actDanger}
                startIcon={<CancelIcon sx={{ fontSize: 18 }} />}
                onClick={handleCancel}
              >
                Cancel
              </Button>
            </>
          )}
          {(state === "catchup" || state === "live") && (
            <Button
              sx={act}
              startIcon={<PauseIcon sx={{ fontSize: 18 }} />}
              onClick={handleCdcPauseResume}
            >
              Pause stream
            </Button>
          )}
          {isPaused && (
            <>
              <Button
                sx={act}
                startIcon={<ResumeIcon sx={{ fontSize: 18 }} />}
                onClick={handleCdcPauseResume}
              >
                Resume stream
              </Button>
              <Button
                sx={act}
                startIcon={<SyncIcon sx={{ fontSize: 18 }} />}
                onClick={handleBackfill}
                disabled={isTriggering}
              >
                Start backfill
              </Button>
            </>
          )}
          {isDegraded && (
            <>
              <Button
                sx={act}
                startIcon={<RecoverIcon sx={{ fontSize: 18 }} />}
                onClick={handleCdcRecover}
              >
                Recover
              </Button>
              <Button
                sx={act}
                startIcon={<SyncIcon sx={{ fontSize: 18 }} />}
                onClick={handleBackfill}
                disabled={isTriggering}
              >
                Start backfill
              </Button>
            </>
          )}

          {/* Secondary actions — contextual */}
          {hasFailed && (
            <Button
              sx={act}
              startIcon={<RetryIcon sx={{ fontSize: 18 }} />}
              onClick={handleRetryFailedMaterialization}
            >
              Retry {summary!.failedCount} failed
            </Button>
          )}

          {/* Spacer */}
          <Box sx={{ flex: 1 }} />

          {/* Always-available actions */}
          <Button
            sx={actDanger}
            startIcon={<ResyncIcon sx={{ fontSize: 18 }} />}
            onClick={() => setResyncDialogOpen(true)}
          >
            Resync from scratch
          </Button>
          {onEdit && (
            <Button
              sx={act}
              startIcon={<EditIcon sx={{ fontSize: 18 }} />}
              onClick={onEdit}
            >
              Edit
            </Button>
          )}
          <Button
            sx={act}
            startIcon={<DiagnosticsIcon sx={{ fontSize: 18 }} />}
            onClick={() => setShowDiagnostics(v => !v)}
          >
            {showDiagnostics ? "Hide diagnostics" : "Diagnostics"}
          </Button>
        </Box>

        <Box sx={{ px: 2.5, py: 2, display: "grid", gap: 2.5 }}>
          {/* Properties — compact 2-col key/value */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "100px 1fr",
              rowGap: 0.5,
              columnGap: 1.5,
              "& .lbl": {
                color: "text.secondary",
                fontSize: "0.78rem",
                lineHeight: 1.7,
              },
              "& .val": { fontSize: "0.78rem", lineHeight: 1.7, minWidth: 0 },
            }}
          >
            <Typography className="lbl">Engine</Typography>
            <Typography className="val" fontWeight={600}>
              CDC
            </Typography>
            <Typography className="lbl">Source</Typography>
            <Typography className="val" noWrap>
              {connectorName || "—"}
              {connectorType ? ` · ${connectorType}` : ""}
            </Typography>
            <Typography className="lbl">Destination</Typography>
            <Typography className="val" noWrap>
              {destName || "—"}
              {destType ? ` · ${destType}` : ""}
            </Typography>
            <Typography className="lbl">Dataset</Typography>
            <Typography className="val" sx={{ fontFamily: "monospace" }}>
              {dataset || "—"}
            </Typography>
            <Typography className="lbl">Webhook</Typography>
            <Typography
              className="val"
              title={webhookEndpoint || ""}
              sx={{
                fontFamily: "monospace",
                fontSize: "0.68rem",
                opacity: 0.75,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {webhookEndpoint || "—"}
            </Typography>
            <Typography className="lbl">Created</Typography>
            <Typography className="val">
              {currentFlow?.createdAt
                ? new Date(currentFlow.createdAt).toLocaleString()
                : "—"}
            </Typography>
            <Typography className="lbl">Updated</Typography>
            <Typography className="val">
              {currentFlow?.updatedAt
                ? new Date(currentFlow.updatedAt).toLocaleString()
                : "—"}
            </Typography>
          </Box>

          {/* Metric cards */}
          {summary ? (
            <>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "repeat(2, 1fr)",
                    md: "repeat(4, 1fr)",
                  },
                  gap: 1.5,
                }}
              >
                {/* Stream status */}
                <Box
                  sx={{
                    borderRadius: 1.5,
                    p: 1.5,
                    bgcolor: "action.hover",
                    minWidth: 0,
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ letterSpacing: 0.3, fontSize: "0.68rem" }}
                  >
                    Stream status
                  </Typography>
                  <Box sx={{ mt: 0.5 }}>
                    <Chip
                      size="small"
                      label={
                        summary.syncState.charAt(0).toUpperCase() +
                        summary.syncState.slice(1)
                      }
                      color={stateColor(summary.syncState)}
                      icon={
                        summary.syncState === "live" ? (
                          <CheckIcon />
                        ) : summary.syncState === "degraded" ? (
                          <ErrorIcon />
                        ) : (
                          <SyncIcon />
                        )
                      }
                      sx={{ fontWeight: 600, fontSize: "0.72rem" }}
                    />
                  </Box>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 0.8, fontSize: "0.65rem" }}
                  >
                    Freshness: {freshnessSummary}
                  </Typography>
                </Box>
                {/* Backfill status */}
                <Box
                  sx={{
                    borderRadius: 1.5,
                    p: 1.5,
                    bgcolor: "action.hover",
                    minWidth: 0,
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ letterSpacing: 0.3, fontSize: "0.68rem" }}
                  >
                    Backfill status
                  </Typography>
                  <Typography
                    fontWeight={700}
                    sx={{ mt: 0.25, fontSize: "0.95rem" }}
                  >
                    {summary.backlogCount > 0
                      ? `${summary.backlogCount.toLocaleString()} pending`
                      : summary.syncState === "backfill"
                        ? "In progress"
                        : summary.lastMaterializedAt
                          ? "Completed"
                          : "Not started"}
                  </Typography>
                </Box>
                {/* Events processed */}
                <Box
                  sx={{
                    borderRadius: 1.5,
                    p: 1.5,
                    bgcolor: "action.hover",
                    minWidth: 0,
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ letterSpacing: 0.3, fontSize: "0.68rem" }}
                  >
                    Events materialized
                  </Typography>
                  <Typography
                    fontWeight={700}
                    sx={{ mt: 0.25, fontSize: "0.95rem" }}
                  >
                    {(summary.appliedCount ?? 0).toLocaleString()}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 0.25, fontSize: "0.65rem" }}
                  >
                    {summary.lastWebhookAt
                      ? `Last webhook ${new Date(summary.lastWebhookAt).toLocaleString()}`
                      : "No events yet"}
                  </Typography>
                </Box>
                {/* Failed */}
                <Box
                  sx={{
                    borderRadius: 1.5,
                    p: 1.5,
                    bgcolor:
                      summary.failedCount > 0 ? "error.50" : "action.hover",
                    minWidth: 0,
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ letterSpacing: 0.3, fontSize: "0.68rem" }}
                  >
                    Failed / dropped
                  </Typography>
                  <Typography
                    fontWeight={700}
                    sx={{
                      mt: 0.25,
                      fontSize: "0.95rem",
                      color:
                        summary.failedCount > 0 ? "error.main" : "text.primary",
                    }}
                  >
                    {summary.failedCount.toLocaleString()} /{" "}
                    {(summary.droppedCount ?? 0).toLocaleString()}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 0.25, fontSize: "0.65rem" }}
                  >
                    {failedDroppedDetail}
                  </Typography>
                </Box>
              </Box>

              {/* Live execution progress */}
              {status === "running" && (
                <Box
                  sx={{
                    borderRadius: 1.5,
                    border: 1,
                    borderColor: "divider",
                    p: 1.5,
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      mb: 1,
                    }}
                  >
                    <SyncIcon
                      sx={{
                        fontSize: 16,
                        animation: "spin 1s linear infinite",
                        "@keyframes spin": {
                          from: { transform: "rotate(0deg)" },
                          to: { transform: "rotate(360deg)" },
                        },
                      }}
                    />
                    <Typography
                      variant="caption"
                      fontWeight={600}
                      sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
                    >
                      Backfill in progress
                    </Typography>
                    {startedAt && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ ml: "auto" }}
                      >
                        Started {new Date(startedAt).toLocaleTimeString()}
                        {lastHeartbeat
                          ? ` · updated ${new Date(lastHeartbeat).toLocaleTimeString()}`
                          : ""}
                      </Typography>
                    )}
                  </Box>
                  <LinearProgress sx={{ mb: 1.5, borderRadius: 1 }} />

                  {/* Per-entity progress */}
                  {Object.keys(entityStats).length > 0 && (
                    <TableContainer
                      sx={{
                        mb: 1.5,
                        borderRadius: 1,
                        border: 1,
                        borderColor: "divider",
                      }}
                    >
                      <Table size="small">
                        <TableHead>
                          <TableRow
                            sx={{
                              bgcolor: "action.hover",
                              "& th": {
                                fontSize: "0.68rem",
                                fontWeight: 600,
                                color: "text.secondary",
                                textTransform: "uppercase",
                                letterSpacing: 0.4,
                                py: 0.5,
                                px: 1,
                              },
                            }}
                          >
                            <TableCell>Entity</TableCell>
                            <TableCell align="right">Records</TableCell>
                            <TableCell align="center">Status</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {[
                            ...new Set([
                              ...plannedEntities,
                              ...Object.keys(entityStats),
                              ...Object.keys(entityStatus),
                            ]),
                          ]
                            .map(
                              entity =>
                                [entity, entityStats[entity] || 0] as const,
                            )
                            .sort(([, a], [, b]) => b - a)
                            .map(([entity, count]) => (
                              <TableRow
                                key={entity}
                                sx={{ "&:last-child td": { borderBottom: 0 } }}
                              >
                                <TableCell
                                  sx={{
                                    fontFamily: "monospace",
                                    fontSize: "0.75rem",
                                    py: 0.5,
                                    px: 1,
                                  }}
                                >
                                  {formatEntityAsTableName(entity)}
                                </TableCell>
                                <TableCell
                                  align="right"
                                  sx={{
                                    fontWeight: 600,
                                    fontSize: "0.78rem",
                                    py: 0.5,
                                    px: 1,
                                  }}
                                >
                                  {count.toLocaleString()}
                                </TableCell>
                                <TableCell
                                  align="center"
                                  sx={{ py: 0.5, px: 1 }}
                                >
                                  <Chip
                                    size="small"
                                    label={
                                      entityStatus[entity] === "completed"
                                        ? "done"
                                        : entityStatus[entity] === "failed"
                                          ? "failed"
                                          : entityStatus[entity] === "pending"
                                            ? "pending"
                                            : "syncing"
                                    }
                                    color={
                                      entityStatus[entity] === "completed"
                                        ? "success"
                                        : entityStatus[entity] === "failed"
                                          ? "error"
                                          : entityStatus[entity] === "pending"
                                            ? "default"
                                            : "info"
                                    }
                                    variant="outlined"
                                    sx={{
                                      height: 20,
                                      fontSize: "0.65rem",
                                      fontWeight: 500,
                                    }}
                                  />
                                </TableCell>
                              </TableRow>
                            ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}

                  {/* Live logs */}
                  {recentLogs.length > 0 && (
                    <Box
                      sx={{
                        maxHeight: 120,
                        overflow: "auto",
                        borderRadius: 1,
                        bgcolor: "action.hover",
                        p: 1,
                        display: "grid",
                        gap: 0.25,
                      }}
                    >
                      {recentLogs.map((log, idx) => (
                        <Typography
                          key={`${log.timestamp}-${idx}`}
                          variant="caption"
                          sx={{
                            fontFamily: "monospace",
                            fontSize: "0.7rem",
                            whiteSpace: "pre-wrap",
                            color:
                              log.level === "error"
                                ? "error.main"
                                : "text.secondary",
                          }}
                        >
                          [{new Date(log.timestamp).toLocaleTimeString()}]{" "}
                          {formatExecutionLog(log)}
                        </Typography>
                      ))}
                    </Box>
                  )}

                  {recentLogs.length === 0 &&
                    Object.keys(entityStats).length === 0 && (
                      <Typography variant="caption" color="text.secondary">
                        Waiting for backfill to start producing data...
                      </Typography>
                    )}
                </Box>
              )}

              {status === "failed" && error && (
                <Alert
                  severity="error"
                  sx={{ borderRadius: 1.5 }}
                  onClose={() => {
                    setStatus(null);
                    setError(null);
                  }}
                >
                  Backfill failed: {error}
                </Alert>
              )}

              {/* Entity table */}
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    mb: 0.75,
                    display: "block",
                    fontWeight: 600,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  {summary.entityCounts.length} entities
                </Typography>
                <TableContainer
                  sx={{
                    borderRadius: 1.5,
                    border: 1,
                    borderColor: "divider",
                    overflowX: "auto",
                    "& .MuiTableCell-root": {
                      py: 0.75,
                      px: 1,
                      fontSize: "0.78rem",
                      whiteSpace: "nowrap",
                    },
                  }}
                >
                  <Table size="small">
                    <TableHead>
                      <TableRow
                        sx={{
                          bgcolor: "action.hover",
                          "& th": {
                            fontWeight: 600,
                            fontSize: "0.7rem",
                            color: "text.secondary",
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                            borderBottom: 1,
                            borderColor: "divider",
                          },
                        }}
                      >
                        <TableCell>Entity name</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell>Backfill</TableCell>
                        <TableCell align="right">Applied</TableCell>
                        <TableCell align="right">Queued</TableCell>
                        <TableCell align="right">Failed</TableCell>
                        <TableCell align="right">Dropped</TableCell>
                        <TableCell align="right">Lag</TableCell>
                        <TableCell align="right">Last materialized</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {summary.entityCounts.map((entity: any) => {
                        const objStatus = entityObjectStatus(entity);
                        return (
                          <TableRow
                            key={entity.entity}
                            hover
                            sx={{ "&:last-child td": { borderBottom: 0 } }}
                          >
                            <TableCell>
                              <Typography
                                sx={{
                                  fontFamily: "monospace",
                                  fontSize: "0.78rem",
                                  fontWeight: 500,
                                }}
                              >
                                {formatEntityAsTableName(entity.entity)}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              <Chip
                                size="small"
                                label={objStatus.label}
                                color={objStatus.color}
                                variant="outlined"
                                sx={{
                                  height: 22,
                                  fontSize: "0.7rem",
                                  fontWeight: 500,
                                }}
                              />
                            </TableCell>
                            <TableCell>
                              <Typography
                                fontSize="0.78rem"
                                color={
                                  entityBackfillStatus(entity) === "Failed"
                                    ? "error.main"
                                    : "text.primary"
                                }
                              >
                                {entityBackfillStatus(entity)}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography
                                fontWeight={entity.appliedCount > 0 ? 600 : 400}
                                color={
                                  entity.appliedCount > 0
                                    ? "success.main"
                                    : "text.primary"
                                }
                                fontSize="0.8rem"
                              >
                                {(entity.appliedCount ?? 0).toLocaleString()}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              {entity.backlogCount}
                            </TableCell>
                            <TableCell align="right">
                              <Typography
                                fontWeight={entity.failedCount > 0 ? 700 : 400}
                                color={
                                  entity.failedCount > 0
                                    ? "error.main"
                                    : "text.primary"
                                }
                                fontSize="0.8rem"
                              >
                                {entity.failedCount}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography
                                fontWeight={entity.droppedCount > 0 ? 700 : 400}
                                color={
                                  entity.droppedCount > 0
                                    ? "warning.main"
                                    : "text.primary"
                                }
                                fontSize="0.8rem"
                              >
                                {entity.droppedCount ?? 0}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              {entityLagLabel(entity)}
                            </TableCell>
                            <TableCell align="right">
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {entity.lastMaterializedAt
                                  ? new Date(
                                      entity.lastMaterializedAt,
                                    ).toLocaleString()
                                  : "—"}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>

              {/* Diagnostics */}
              {showDiagnostics && cdcDiagnostics && (
                <Box
                  sx={{
                    display: "grid",
                    gap: 2,
                    borderRadius: 1.5,
                    border: 1,
                    borderColor: "divider",
                    p: 2,
                    bgcolor: "background.default",
                  }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      fontWeight: 600,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                    }}
                  >
                    Diagnostics
                  </Typography>

                  {/* Transitions */}
                  <Box>
                    <Typography
                      variant="subtitle2"
                      sx={{ mb: 0.75, fontSize: "0.8rem" }}
                    >
                      Transition timeline
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 180,
                        overflow: "auto",
                        borderRadius: 1,
                        bgcolor: "action.hover",
                        p: 1,
                        display: "grid",
                        gap: 0.5,
                      }}
                    >
                      {cdcDiagnostics.transitions
                        .slice(0, 20)
                        .map((transition: any, index: number) => (
                          <Typography
                            key={`${transition.at}-${index}`}
                            variant="caption"
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "0.72rem",
                            }}
                          >
                            <Typography
                              component="span"
                              variant="caption"
                              color="text.secondary"
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "0.72rem",
                              }}
                            >
                              {new Date(transition.at).toLocaleString()}
                            </Typography>
                            {"  "}
                            {transition.fromState} →{" "}
                            <strong>{transition.toState}</strong>
                            {"  "}
                            <Typography
                              component="span"
                              variant="caption"
                              color="text.secondary"
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "0.68rem",
                              }}
                            >
                              ({transition.event}
                              {transition.reason
                                ? `: ${transition.reason}`
                                : ""}
                              )
                            </Typography>
                          </Typography>
                        ))}
                      {cdcDiagnostics.transitions.length === 0 && (
                        <Typography variant="caption" color="text.secondary">
                          No transitions recorded
                        </Typography>
                      )}
                    </Box>
                  </Box>

                  {/* Cursors */}
                  <Box>
                    <Typography
                      variant="subtitle2"
                      sx={{ mb: 0.75, fontSize: "0.8rem" }}
                    >
                      Entity cursors
                    </Typography>
                    <TableContainer
                      sx={{
                        borderRadius: 1,
                        border: 1,
                        borderColor: "divider",
                      }}
                    >
                      <Table size="small">
                        <TableHead>
                          <TableRow
                            sx={{
                              bgcolor: "action.hover",
                              "& th": {
                                fontSize: "0.68rem",
                                color: "text.secondary",
                                textTransform: "uppercase",
                                letterSpacing: 0.4,
                                fontWeight: 600,
                              },
                            }}
                          >
                            <TableCell>Entity</TableCell>
                            <TableCell align="right">Ingest seq</TableCell>
                            <TableCell align="right">
                              Materialized seq
                            </TableCell>
                            <TableCell align="right">Backlog</TableCell>
                            <TableCell align="right">Lag</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {cdcDiagnostics.cursors.map((cursor: any) => (
                            <TableRow
                              key={cursor.entity}
                              sx={{ "&:last-child td": { borderBottom: 0 } }}
                            >
                              <TableCell
                                sx={{
                                  fontFamily: "monospace",
                                  fontSize: "0.75rem",
                                }}
                              >
                                {cursor.entity}
                              </TableCell>
                              <TableCell align="right">
                                {cursor.lastIngestSeq}
                              </TableCell>
                              <TableCell align="right">
                                {cursor.lastMaterializedSeq}
                              </TableCell>
                              <TableCell align="right">
                                {cursor.backlogCount}
                              </TableCell>
                              <TableCell align="right">
                                {cursor.lagSeconds ?? "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Box>

                  {/* Recent events */}
                  <Box>
                    <Typography
                      variant="subtitle2"
                      sx={{ mb: 0.75, fontSize: "0.8rem" }}
                    >
                      Recent events
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 200,
                        overflow: "auto",
                        borderRadius: 1,
                        bgcolor: "action.hover",
                        p: 1,
                        display: "grid",
                        gap: 0.5,
                      }}
                    >
                      {cdcDiagnostics.recentEvents
                        .slice(0, 20)
                        .map((event: any, index: number) => (
                          <Box
                            key={`${event.ingestSeq}-${index}`}
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.75,
                            }}
                          >
                            <Typography
                              variant="caption"
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "0.72rem",
                                color: "text.secondary",
                                minWidth: 32,
                              }}
                            >
                              #{event.ingestSeq}
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "0.72rem",
                                flex: 1,
                              }}
                            >
                              {event.entity} <strong>{event.operation}</strong>
                            </Typography>
                            <Chip
                              size="small"
                              label={event.materializationStatus}
                              color={
                                event.materializationStatus === "applied"
                                  ? "success"
                                  : event.materializationStatus === "failed"
                                    ? "error"
                                    : "default"
                              }
                              variant="outlined"
                              sx={{
                                height: 18,
                                fontSize: "0.62rem",
                                fontWeight: 500,
                                borderRadius: 0.75,
                              }}
                            />
                            <Typography
                              variant="caption"
                              sx={{
                                fontSize: "0.68rem",
                                color: "text.secondary",
                              }}
                            >
                              {event.source}
                            </Typography>
                          </Box>
                        ))}
                    </Box>
                  </Box>
                </Box>
              )}
            </>
          ) : (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                py: 4,
                justifyContent: "center",
              }}
            >
              <SyncIcon
                sx={{
                  fontSize: 16,
                  animation: "spin 1s linear infinite",
                  "@keyframes spin": {
                    from: { transform: "rotate(0deg)" },
                    to: { transform: "rotate(360deg)" },
                  },
                }}
              />
              <Typography variant="body2" color="text.secondary">
                Loading CDC summary...
              </Typography>
            </Box>
          )}
        </Box>

        {/* Resync dialog */}
        <Dialog
          open={resyncDialogOpen}
          onClose={() => setResyncDialogOpen(false)}
        >
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
                  onChange={event =>
                    setClearWebhookEvents(event.target.checked)
                  }
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
            <Button
              onClick={() => setResyncDialogOpen(false)}
              disabled={isResyncing}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="warning"
              disabled={resyncConfirmText !== "RESYNC" || isResyncing}
              onClick={handleCdcResync}
            >
              {isResyncing ? "Resyncing…" : "Resync"}
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
