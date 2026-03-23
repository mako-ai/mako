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
  IconButton,
  Tooltip,
  Tabs,
  Tab,
} from "@mui/material";
import {
  History as BackfillIcon,
  Cancel as CancelIcon,
  Pause as PauseIcon,
  PlayArrow as ResumeIcon,
  RestartAlt as ResyncIcon,
  Healing as RecoverIcon,
  ContentCopy as CopyIcon,
  Edit as EditIcon,
  DeleteSweep as ResetTableIcon,
} from "@mui/icons-material";
import { useFlowStore } from "../store/flowStore";

interface BackfillPanelProps {
  workspaceId: string;
  flowId: string;
  onEdit?: () => void;
}

type StreamState = "idle" | "active" | "paused" | "error";
type BackfillStatus = "idle" | "running" | "paused" | "completed" | "error";

function formatLag(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function camelToSnake(v: string): string {
  return v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function entityLabel(entity: string): string {
  if (!entity.includes(":")) return entity;
  const [parent, sub] = entity.split(":");
  return parent && sub ? `${camelToSnake(sub)}_${parent}` : entity;
}

function streamChipProps(state: StreamState): {
  label: string;
  color: "success" | "info" | "error" | "warning" | "default";
} {
  switch (state) {
    case "active":
      return { label: "Active", color: "success" };
    case "paused":
      return { label: "Paused", color: "warning" };
    case "error":
      return { label: "Error", color: "error" };
    default:
      return { label: "Idle", color: "default" };
  }
}

function backfillChipProps(status: BackfillStatus): {
  label: string;
  color: "success" | "info" | "error" | "warning" | "default";
} {
  switch (status) {
    case "running":
      return { label: "Running", color: "info" };
    case "paused":
      return { label: "Paused", color: "warning" };
    case "completed":
      return { label: "Complete", color: "success" };
    case "error":
      return { label: "Error", color: "error" };
    default:
      return { label: "Not started", color: "default" };
  }
}

function entityStreamChip(e: {
  backlogCount: number;
  lastMaterializedAt: string | null;
}): { label: string; color: "success" | "info" | "default" } {
  if (e.backlogCount > 0) return { label: "Syncing", color: "info" };
  if (e.lastMaterializedAt) return { label: "Live", color: "success" };
  return { label: "Pending", color: "default" };
}

function entityBackfillChip(e: {
  backlogCount: number;
  backfillDone?: boolean;
}): {
  label: string;
  color: "success" | "info" | "default";
} {
  if (e.backlogCount > 0) return { label: "In progress", color: "info" };
  if (e.backfillDone) return { label: "Done", color: "success" };
  return { label: "Not started", color: "default" };
}

type LogEntry = {
  timestamp: string;
  level: string;
  message: string;
  metadata?: Record<string, unknown>;
};

function formatMetadataValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === "{}" || serialized === "[]") {
      return undefined;
    }
    return serialized.length > 220
      ? `${serialized.slice(0, 217)}...`
      : serialized;
  } catch {
    return undefined;
  }
}

function readMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return formatMetadataValue(metadata?.[key]);
}

function formatLog(log: LogEntry): string {
  const m = log.metadata;
  const entity = typeof m?.entity === "string" ? m.entity : undefined;
  const totalWritten =
    typeof m?.totalWritten === "number" ? m.totalWritten : undefined;
  const totalFetched =
    typeof m?.totalFetched === "number" ? m.totalFetched : undefined;
  const rows =
    typeof m?.totalProcessed === "number"
      ? m.totalProcessed
      : typeof m?.rowsWritten === "number"
        ? m.rowsWritten
        : undefined;
  const fetchedCount =
    typeof m?.fetchedCount === "number" ? m.fetchedCount : undefined;

  const parts: string[] = [];
  if (entity) {
    parts.push(`[${entityLabel(entity)}]`);
  }
  parts.push(log.message);
  if (totalWritten !== undefined && totalFetched !== undefined) {
    parts.push(
      `(${totalWritten.toLocaleString()} written / ${totalFetched.toLocaleString()} fetched)`,
    );
  } else if (rows !== undefined) {
    parts.push(`(${rows.toLocaleString()} rows)`);
  } else if (fetchedCount !== undefined) {
    parts.push(`(${fetchedCount.toLocaleString()} fetched)`);
  }

  const level = log.level.toLowerCase();
  if ((level === "warn" || level === "error") && m) {
    const details: string[] = [];
    const status = readMetadataValue(m, "status");
    const method = readMetadataValue(m, "method");
    const endpoint = readMetadataValue(m, "endpoint");
    const error = readMetadataValue(m, "error");
    const errorCode = readMetadataValue(m, "errorCode");
    const errorName = readMetadataValue(m, "errorName");
    const requestId = readMetadataValue(m, "requestId");
    const chunkIndex = readMetadataValue(m, "chunkIndex");
    const syncMode = readMetadataValue(m, "syncMode");

    if (status) {
      details.push(`status=${status}`);
    }
    if (method && endpoint) {
      details.push(`${method} ${endpoint}`);
    } else if (endpoint) {
      details.push(endpoint);
    }
    if (error && !log.message.toLowerCase().includes(error.toLowerCase())) {
      details.push(`error=${error}`);
    }
    if (errorCode) {
      details.push(`code=${errorCode}`);
    }
    if (errorName) {
      details.push(`name=${errorName}`);
    }
    if (requestId) {
      details.push(`requestId=${requestId}`);
    }
    if (chunkIndex) {
      details.push(`chunk=${chunkIndex}`);
    }
    if (syncMode) {
      details.push(`mode=${syncMode}`);
    }

    if (details.length > 0) {
      parts.push(`- ${details.join(" | ")}`);
    }
  }

  return parts.join(" ");
}

export function BackfillPanel({
  workspaceId,
  flowId,
  onEdit,
}: BackfillPanelProps) {
  const {
    flows: flowsMap,
    startCdcBackfill,
    fetchCdcStatus,
    fetchFlowStatus,
    fetchExecutionDetails,
    fetchWebhookEvents,
    pauseCdcFlow,
    resumeCdcFlow,
    resetCdcEntityTable,
    resyncCdcFlow,
    recoverCdcFlow,
  } = useFlowStore();

  const [cdc, setCdc] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [execStats, setExecStats] = useState<Record<string, number>>({});
  const [execStatus, setExecStatus] = useState<Record<string, string>>({});
  const [resyncOpen, setResyncOpen] = useState(false);
  const [resyncConfirm, setResyncConfirm] = useState("");
  const [resyncOpts, setResyncOpts] = useState({
    deleteDestination: false,
    clearWebhookEvents: false,
  });
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [webhookEvents, setWebhookEvents] = useState<any[]>([]);
  const [webhookEventsTotal, setWebhookEventsTotal] = useState(0);
  const [entityResetOpen, setEntityResetOpen] = useState(false);
  const [entityResetEntity, setEntityResetEntity] = useState("");

  const cdcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const flow = (flowsMap[workspaceId] || []).find(f => f._id === flowId);

  const streamState: StreamState = cdc?.streamState || "idle";
  const bfStatus: BackfillStatus = cdc?.backfillStatus || "idle";

  const pollCdc = useCallback(async () => {
    const [status, eventsResult] = await Promise.all([
      fetchCdcStatus(workspaceId, flowId),
      fetchWebhookEvents(workspaceId, flowId, 50, 0),
    ]);
    if (status) setCdc(status);
    if (eventsResult) {
      setWebhookEvents(eventsResult.events);
      setWebhookEventsTotal(eventsResult.total);
    }
  }, [fetchCdcStatus, fetchWebhookEvents, workspaceId, flowId]);

  const pollLogs = useCallback(async () => {
    if (!executionId) {
      const statusResp = await fetchFlowStatus(workspaceId, flowId);
      if (statusResp?.isRunning && statusResp.runningExecution) {
        setExecutionId(statusResp.runningExecution.executionId);
      }
      return;
    }
    const details = await fetchExecutionDetails(
      workspaceId,
      flowId,
      executionId,
    );
    if (details?.logs && details.logs.length > 0) {
      setLogs(details.logs as LogEntry[]);
    }
    if (details?.stats) {
      const es = details.stats.entityStats as
        | Record<string, number>
        | undefined;
      const est = details.stats.entityStatus as
        | Record<string, string>
        | undefined;
      if (es) {
        setExecStats(prev => ({ ...prev, ...es }));
      }
      if (est) {
        setExecStatus(prev => ({ ...prev, ...est }));
      }
    }
    if (details?.status && details.status !== "running") {
      setExecutionId(null);
    }
  }, [
    executionId,
    workspaceId,
    flowId,
    fetchFlowStatus,
    fetchExecutionDetails,
  ]);

  useEffect(() => {
    pollCdc();
    cdcPollRef.current = setInterval(pollCdc, 5000);
    return () => {
      if (cdcPollRef.current) clearInterval(cdcPollRef.current);
    };
  }, [pollCdc]);

  useEffect(() => {
    pollLogs();
    logPollRef.current = setInterval(pollLogs, 3000);
    return () => {
      if (logPollRef.current) clearInterval(logPollRef.current);
    };
  }, [pollLogs]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await pollCdc();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStartBackfill = (entities?: string[]) =>
    withBusy(async () => {
      const ok = await startCdcBackfill(workspaceId, flowId, entities);
      if (!ok) throw new Error("Failed to start backfill");
      setLogs([]);
      if (entities?.length) {
        setExecStats(prev => {
          const next = { ...prev };
          for (const entity of entities) {
            next[entity] = 0;
          }
          return next;
        });
        setExecStatus(prev => {
          const next = { ...prev };
          for (const entity of entities) {
            next[entity] = "pending";
          }
          return next;
        });
      } else {
        setExecStats({});
        setExecStatus({});
      }
      setTimeout(() => pollLogs(), 3000);
    });

  const handlePauseStream = () =>
    withBusy(async () => {
      const ok = await pauseCdcFlow(workspaceId, flowId);
      if (!ok) throw new Error("Failed to pause stream");
    });

  const handleResumeStream = () =>
    withBusy(async () => {
      const ok = await resumeCdcFlow(workspaceId, flowId);
      if (!ok) throw new Error("Failed to resume stream");
    });

  const handleRecoverStream = () =>
    withBusy(async () => {
      const ok = await recoverCdcFlow(workspaceId, flowId, {
        retryFailedMaterialization: true,
        resumeBackfill: false,
      });
      if (!ok) throw new Error("Failed to recover stream");
    });

  const handlePauseBackfill = () =>
    withBusy(async () => {
      const ok = await pauseCdcFlow(workspaceId, flowId);
      if (!ok) throw new Error("Failed to pause backfill");
    });

  const handleRecoverBackfill = () =>
    withBusy(async () => {
      const ok = await recoverCdcFlow(workspaceId, flowId, {
        retryFailedMaterialization: true,
        resumeBackfill: true,
      });
      if (!ok) throw new Error("Failed to recover backfill");
    });

  const handleResync = async () => {
    if (resyncConfirm !== "RESET") return;
    setBusy(true);
    const ok = await resyncCdcFlow(workspaceId, flowId, resyncOpts);
    setBusy(false);
    if (!ok) {
      setError("Failed to reset sync");
      return;
    }
    setResyncOpen(false);
    setResyncConfirm("");
    setResyncOpts({ deleteDestination: false, clearWebhookEvents: false });
    setLogs([]);
    await pollCdc();
  };

  const openEntityResetDialog = (entity: string) => {
    setEntityResetEntity(entity);
    setEntityResetOpen(true);
  };

  const handleResetEntityTable = () =>
    withBusy(async () => {
      const ok = await resetCdcEntityTable(
        workspaceId,
        flowId,
        entityResetEntity,
      );
      if (!ok) {
        throw new Error("Failed to reset table and start backfill");
      }
      setEntityResetOpen(false);
      setEntityResetEntity("");
      setLogs([]);
      setTimeout(() => pollLogs(), 3000);
    });

  const webhookUrl = flow?.webhookConfig?.endpoint;
  const copyWebhook = async () => {
    if (!webhookUrl) return;
    await navigator.clipboard.writeText(webhookUrl);
    setWebhookCopied(true);
    setTimeout(() => setWebhookCopied(false), 1500);
  };

  const connectorName =
    typeof flow?.dataSourceId === "object"
      ? (flow.dataSourceId as any).name
      : undefined;
  const destName =
    typeof flow?.destinationDatabaseId === "object"
      ? (flow.destinationDatabaseId as any).name
      : undefined;
  const dataset = flow?.tableDestination?.schema;

  const cdcEntities: any[] = cdc?.entities || [];
  const transitions: any[] = cdc?.transitions || [];

  const configuredEntityNames: string[] = (() => {
    const layouts = flow?.entityLayouts as
      | Array<{ entity: string; enabled?: boolean }>
      | undefined;
    if (layouts && layouts.length > 0) {
      return layouts
        .filter(l => l.enabled !== false && l.entity)
        .map(l => l.entity);
    }
    const filter = flow?.entityFilter as string[] | undefined;
    if (filter && filter.length > 0) {
      return filter.filter(e => typeof e === "string" && e.trim().length > 0);
    }
    return [];
  })();

  const cdcByEntity = new Map(cdcEntities.map((e: any) => [e.entity, e]));
  const allEntityNames = Array.from(
    new Set([
      ...configuredEntityNames,
      ...cdcEntities.map((e: any) => e.entity),
    ]),
  );
  const entities = allEntityNames.map(name => {
    const s = cdcByEntity.get(name);
    return {
      entity: name,
      backlogCount: s?.backlogCount || 0,
      lastIngestSeq: s?.lastIngestSeq || 0,
      lastMaterializedSeq: s?.lastMaterializedSeq || 0,
      lagSeconds: s?.lagSeconds ?? null,
      lastMaterializedAt: s?.lastMaterializedAt || null,
      destinationRowCount:
        typeof s?.destinationRowCount === "number"
          ? s.destinationRowCount
          : null,
      lifetimeEventsProcessed:
        typeof s?.lifetimeEventsProcessed === "number"
          ? s.lifetimeEventsProcessed
          : 0,
      lifetimeRowsApplied:
        typeof s?.lifetimeRowsApplied === "number" ? s.lifetimeRowsApplied : 0,
      backfillDone: s?.backfillDone === true,
      execRows: execStats[name] || 0,
      execStatus: execStatus[name] || null,
    };
  });

  const totalEventsProcessed = entities.reduce(
    (sum, e) =>
      sum +
      Math.max(e.lifetimeEventsProcessed || 0, e.lastMaterializedSeq || 0),
    0,
  );
  const totalRowsApplied = entities.reduce(
    (sum, e) => sum + Math.max(e.lifetimeRowsApplied || 0, e.execRows || 0),
    0,
  );
  const totalDestinationRows = entities.reduce(
    (sum, e) => sum + Math.max(e.destinationRowCount || 0, 0),
    0,
  );

  const ss = streamChipProps(streamState);
  const bs = backfillChipProps(bfStatus);

  const kpi = {
    borderRadius: 1.5,
    p: 1.5,
    bgcolor: "background.paper",
    border: 1,
    borderColor: "divider",
    minWidth: 0,
  };
  const kpiLabel = {
    fontSize: "0.68rem",
    letterSpacing: 0.3,
    color: "text.secondary",
    mb: 0.25,
  };
  const kpiValue = { fontWeight: 700, fontSize: "1rem", lineHeight: 1.3 };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Top bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 1.5,
          py: 0.5,
          borderBottom: 1,
          borderColor: "divider",
          gap: 0.5,
          minHeight: 36,
          flexShrink: 0,
        }}
      >
        {connectorName && (
          <Typography variant="caption" color="text.secondary">
            {connectorName}
          </Typography>
        )}
        {connectorName && destName && (
          <Typography variant="caption" color="text.secondary">
            →
          </Typography>
        )}
        {destName && (
          <Typography variant="caption" color="text.secondary">
            {destName}
            {dataset ? ` / ${dataset}` : ""}
          </Typography>
        )}
        {webhookUrl && (
          <Tooltip title={webhookCopied ? "Copied!" : webhookUrl}>
            <IconButton size="small" onClick={copyWebhook} sx={{ ml: 0.5 }}>
              <CopyIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          color="error"
          startIcon={<ResyncIcon sx={{ fontSize: 16 }} />}
          onClick={() => setResyncOpen(true)}
          sx={{ textTransform: "none", fontSize: "0.75rem" }}
        >
          Reset
        </Button>
        {onEdit && (
          <Button
            size="small"
            startIcon={<EditIcon sx={{ fontSize: 16 }} />}
            onClick={onEdit}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            Edit
          </Button>
        )}
      </Box>

      {/* KPI cards + error */}
      <Box sx={{ px: 2, pt: 2, pb: 1, flexShrink: 0 }}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        {busy && <LinearProgress sx={{ mb: 1 }} />}

        {cdc ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 1.5,
            }}
          >
            {/* Stream */}
            <Box sx={kpi}>
              <Typography sx={kpiLabel}>Stream</Typography>
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}
              >
                <Chip
                  label={ss.label}
                  color={ss.color}
                  size="small"
                  sx={{ fontWeight: 600, fontSize: "0.75rem" }}
                />
                {cdc.lagSeconds !== null && cdc.lagSeconds > 0 && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontSize: "0.72rem" }}
                  >
                    {formatLag(cdc.lagSeconds)} lag
                  </Typography>
                )}
              </Box>
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                {streamState === "active" && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<PauseIcon sx={{ fontSize: 14 }} />}
                    onClick={handlePauseStream}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Pause
                  </Button>
                )}
                {streamState === "paused" && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                    onClick={handleResumeStream}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Resume
                  </Button>
                )}
                {streamState === "error" && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<RecoverIcon sx={{ fontSize: 14 }} />}
                    onClick={handleRecoverStream}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Recover
                  </Button>
                )}
              </Box>
            </Box>

            {/* Backfill */}
            <Box sx={kpi}>
              <Typography sx={kpiLabel}>Backfill</Typography>
              <Box sx={{ mb: 0.75 }}>
                <Chip
                  label={bs.label}
                  color={bs.color}
                  size="small"
                  sx={{ fontWeight: 600, fontSize: "0.75rem" }}
                />
              </Box>
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                {(bfStatus === "idle" || bfStatus === "completed") && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<BackfillIcon sx={{ fontSize: 14 }} />}
                    onClick={() => handleStartBackfill()}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    {bfStatus === "completed" ? "Re-run" : "Start"}
                  </Button>
                )}
                {bfStatus === "running" && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<PauseIcon sx={{ fontSize: 14 }} />}
                    onClick={handlePauseBackfill}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Pause
                  </Button>
                )}
                {bfStatus === "paused" && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                    onClick={() => handleStartBackfill()}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Resume
                  </Button>
                )}
                {bfStatus === "error" && (
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    startIcon={<RecoverIcon sx={{ fontSize: 14 }} />}
                    onClick={handleRecoverBackfill}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Recover
                  </Button>
                )}
                {cdc.backlogCount > 0 && bfStatus !== "running" && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ alignSelf: "center", fontSize: "0.72rem" }}
                  >
                    {cdc.backlogCount.toLocaleString()} pending
                  </Typography>
                )}
              </Box>
            </Box>

            {/* Events processed */}
            <Box sx={kpi}>
              <Typography sx={kpiLabel}>Events processed</Typography>
              <Typography sx={kpiValue}>
                {totalEventsProcessed.toLocaleString()}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.25, fontSize: "0.68rem" }}
              >
                Rows applied: {totalRowsApplied.toLocaleString()}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.1, fontSize: "0.68rem" }}
              >
                Destination rows: {totalDestinationRows.toLocaleString()}
              </Typography>
              {cdc.lastMaterializedAt && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mt: 0.25, fontSize: "0.68rem" }}
                >
                  Last {new Date(cdc.lastMaterializedAt).toLocaleString()}
                </Typography>
              )}
            </Box>
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              py: 3,
              justifyContent: "center",
            }}
          >
            <LinearProgress sx={{ width: 24 }} />
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          </Box>
        )}
      </Box>

      {/* Tabs — Objects / Logs */}
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          minHeight: 36,
          flexShrink: 0,
          px: 2,
        }}
      >
        <Tab
          label="Objects"
          sx={{
            minHeight: 36,
            py: 0.5,
            textTransform: "none",
            fontSize: "0.82rem",
          }}
        />
        <Tab
          label="Logs"
          sx={{
            minHeight: 36,
            py: 0.5,
            textTransform: "none",
            fontSize: "0.82rem",
          }}
        />
        <Tab
          label={`Events (${webhookEventsTotal})`}
          sx={{
            minHeight: 36,
            py: 0.5,
            textTransform: "none",
            fontSize: "0.82rem",
          }}
        />
      </Tabs>

      {/* Tab content — scrollable */}
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {tab === 0 && (
          <Box sx={{ p: 2 }}>
            {entities.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                py={2}
              >
                No entities configured yet.
              </Typography>
            ) : (
              <TableContainer
                sx={{ borderRadius: 1, border: 1, borderColor: "divider" }}
              >
                <Table size="small">
                  <TableHead>
                    <TableRow
                      sx={{
                        "& th": {
                          fontSize: "0.72rem",
                          color: "text.secondary",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        },
                      }}
                    >
                      <TableCell>Entity</TableCell>
                      <TableCell>Stream</TableCell>
                      <TableCell>Backfill</TableCell>
                      <TableCell align="right">Destination rows</TableCell>
                      <TableCell align="right">Events processed</TableCell>
                      <TableCell align="right" sx={{ width: 60 }} />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {entities.map(e => {
                      const sc = entityStreamChip(e);
                      const bc = entityBackfillChip(e);
                      const backfillChip =
                        e.execStatus === "syncing"
                          ? { label: "Syncing…", color: "info" as const }
                          : e.execStatus === "completed"
                            ? { label: "Done", color: "success" as const }
                            : e.execStatus === "pending"
                              ? { label: "Queued", color: "default" as const }
                              : bc;
                      const destinationRows = Math.max(
                        e.destinationRowCount || 0,
                        0,
                      );
                      const syncingRowsWritten = Math.max(e.execRows || 0, 0);
                      const eventCount = Math.max(
                        e.lifetimeEventsProcessed || 0,
                        e.lastMaterializedSeq || 0,
                      );
                      return (
                        <TableRow
                          key={e.entity}
                          sx={{ "&:last-child td": { borderBottom: 0 } }}
                        >
                          <TableCell
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "0.78rem",
                              fontWeight: 500,
                            }}
                          >
                            {entityLabel(e.entity)}
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={sc.label}
                              color={sc.color}
                              size="small"
                              variant="outlined"
                              sx={{
                                height: 22,
                                fontSize: "0.68rem",
                                fontWeight: 500,
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Box
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 0.75,
                              }}
                            >
                              <Chip
                                label={backfillChip.label}
                                color={backfillChip.color}
                                size="small"
                                variant="outlined"
                                sx={{
                                  height: 22,
                                  fontSize: "0.68rem",
                                  fontWeight: 500,
                                }}
                              />
                              {e.execStatus === "syncing" && (
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    fontSize: "0.68rem",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {syncingRowsWritten.toLocaleString()} written
                                </Typography>
                              )}
                            </Box>
                          </TableCell>
                          <TableCell align="right">
                            <Typography
                              fontSize="0.8rem"
                              fontWeight={destinationRows > 0 ? 600 : 400}
                            >
                              {destinationRows.toLocaleString()}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Typography
                              fontSize="0.8rem"
                              fontWeight={eventCount > 0 ? 600 : 400}
                            >
                              {eventCount.toLocaleString()}
                            </Typography>
                          </TableCell>
                          <TableCell align="right">
                            <Box
                              sx={{
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "flex-end",
                                gap: 0.25,
                              }}
                            >
                              {bfStatus !== "running" && (
                                <>
                                  <Tooltip
                                    title={`Reset table and rebackfill ${entityLabel(e.entity)}`}
                                  >
                                    <IconButton
                                      size="small"
                                      onClick={() =>
                                        openEntityResetDialog(e.entity)
                                      }
                                      disabled={busy}
                                      sx={{ p: 0.25 }}
                                    >
                                      <ResetTableIcon sx={{ fontSize: 16 }} />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip
                                    title={`Sync ${entityLabel(e.entity)}`}
                                  >
                                    <IconButton
                                      size="small"
                                      onClick={() =>
                                        handleStartBackfill([e.entity])
                                      }
                                      disabled={busy}
                                      sx={{ p: 0.25 }}
                                    >
                                      <BackfillIcon sx={{ fontSize: 16 }} />
                                    </IconButton>
                                  </Tooltip>
                                </>
                              )}
                            </Box>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        )}

        {tab === 1 && (
          <Box sx={{ p: 2, display: "grid", gap: 2 }}>
            {/* Live execution logs */}
            <Box
              sx={{
                borderRadius: 1,
                border: 1,
                borderColor: "divider",
                bgcolor: "grey.950",
                p: 1.5,
                maxHeight: 300,
                overflow: "auto",
                minHeight: 80,
              }}
            >
              {logs.length === 0 ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: "monospace" }}
                >
                  {executionId
                    ? "Waiting for logs…"
                    : "No active execution. Start a backfill to see logs."}
                </Typography>
              ) : (
                logs.map((log, i) => (
                  <Typography
                    key={`${log.timestamp}-${i}`}
                    variant="caption"
                    sx={{
                      display: "block",
                      fontFamily: "monospace",
                      fontSize: "0.72rem",
                      whiteSpace: "pre-wrap",
                      color:
                        log.level === "error"
                          ? "error.main"
                          : log.level === "warn"
                            ? "warning.main"
                            : "text.secondary",
                      lineHeight: 1.6,
                    }}
                  >
                    <Typography
                      component="span"
                      sx={{
                        fontFamily: "monospace",
                        fontSize: "0.68rem",
                        color: "text.disabled",
                      }}
                    >
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </Typography>{" "}
                    {formatLog(log)}
                  </Typography>
                ))
              )}
              <div ref={logsEndRef} />
            </Box>

            {/* Transition history */}
            {transitions.length > 0 && (
              <Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    fontWeight: 600,
                    fontSize: "0.72rem",
                    textTransform: "uppercase",
                    letterSpacing: 0.3,
                    mb: 0.5,
                    display: "block",
                  }}
                >
                  State transitions
                </Typography>
                <Box
                  sx={{
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    p: 1,
                    maxHeight: 160,
                    overflow: "auto",
                    display: "grid",
                    gap: 0.25,
                  }}
                >
                  {transitions.map((t: any, i: number) => (
                    <Typography
                      key={`${t.at}-${i}`}
                      variant="caption"
                      sx={{ fontFamily: "monospace", fontSize: "0.72rem" }}
                    >
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: "monospace", fontSize: "0.72rem" }}
                      >
                        {new Date(t.at).toLocaleString()}
                      </Typography>
                      {"  "}
                      {t.machine && (
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: "monospace", fontSize: "0.68rem" }}
                        >
                          [{t.machine}]{" "}
                        </Typography>
                      )}
                      {t.fromState} → <strong>{t.toState}</strong>
                      {"  "}
                      <Typography
                        component="span"
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontFamily: "monospace", fontSize: "0.68rem" }}
                      >
                        ({t.event}
                        {t.reason ? `: ${t.reason}` : ""})
                      </Typography>
                    </Typography>
                  ))}
                </Box>
              </Box>
            )}
          </Box>
        )}

        {tab === 2 && (
          <Box sx={{ p: 2 }}>
            {webhookEvents.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                py={2}
              >
                No webhook events received yet.
              </Typography>
            ) : (
              <TableContainer
                sx={{ borderRadius: 1, border: 1, borderColor: "divider" }}
              >
                <Table size="small">
                  <TableHead>
                    <TableRow
                      sx={{
                        "& th": {
                          fontSize: "0.72rem",
                          color: "text.secondary",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        },
                      }}
                    >
                      <TableCell>Event type</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Apply</TableCell>
                      <TableCell>Received</TableCell>
                      <TableCell align="right">Duration</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {webhookEvents.map((evt: any) => (
                      <TableRow
                        key={evt.eventId || evt.id}
                        sx={{ "&:last-child td": { borderBottom: 0 } }}
                      >
                        <TableCell
                          sx={{
                            fontFamily: "monospace",
                            fontSize: "0.75rem",
                          }}
                        >
                          {evt.eventType}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={evt.status}
                            size="small"
                            variant="outlined"
                            color={
                              evt.status === "completed"
                                ? "success"
                                : evt.status === "failed"
                                  ? "error"
                                  : evt.status === "processing"
                                    ? "info"
                                    : "default"
                            }
                            sx={{
                              height: 22,
                              fontSize: "0.68rem",
                              fontWeight: 500,
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          {evt.applyStatus && (
                            <Chip
                              label={evt.applyStatus}
                              size="small"
                              variant="outlined"
                              color={
                                evt.applyStatus === "applied"
                                  ? "success"
                                  : evt.applyStatus === "failed"
                                    ? "error"
                                    : evt.applyStatus === "dropped"
                                      ? "warning"
                                      : "default"
                              }
                              sx={{
                                height: 22,
                                fontSize: "0.68rem",
                                fontWeight: 500,
                              }}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {new Date(evt.receivedAt).toLocaleString()}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="caption" color="text.secondary">
                            {evt.processingDurationMs != null
                              ? `${evt.processingDurationMs}ms`
                              : "—"}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        )}
      </Box>

      {/* Reset entity table dialog */}
      <Dialog
        open={entityResetOpen}
        onClose={() => !busy && setEntityResetOpen(false)}
      >
        <DialogTitle>Reset table and rebackfill</DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 1, minWidth: 420 }}>
          <Typography variant="body2">
            Entity:{" "}
            <Box
              component="span"
              sx={{ fontFamily: "monospace", fontWeight: 600 }}
            >
              {entityResetEntity ? entityLabel(entityResetEntity) : "—"}
            </Box>
          </Typography>
          <Typography variant="caption" color="text.secondary">
            This drops the destination table for this entity, clears its CDC
            state, and starts a fresh backfill.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEntityResetOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!entityResetEntity || busy}
            onClick={handleResetEntityTable}
          >
            {busy ? "Resetting…" : "Reset + rebackfill"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Reset dialog */}
      <Dialog open={resyncOpen} onClose={() => setResyncOpen(false)}>
        <DialogTitle>Reset sync</DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 1, minWidth: 400 }}>
          <Typography variant="body2">
            This will clear all CDC state and restart a full backfill.
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={resyncOpts.deleteDestination}
                onChange={e =>
                  setResyncOpts(o => ({
                    ...o,
                    deleteDestination: e.target.checked,
                  }))
                }
              />
            }
            label="Delete destination tables"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={resyncOpts.clearWebhookEvents}
                onChange={e =>
                  setResyncOpts(o => ({
                    ...o,
                    clearWebhookEvents: e.target.checked,
                  }))
                }
              />
            }
            label="Clear stored webhook events"
          />
          <TextField
            label="Type RESET to confirm"
            value={resyncConfirm}
            onChange={e => setResyncConfirm(e.target.value)}
            size="small"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResyncOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={resyncConfirm !== "RESET" || busy}
            onClick={handleResync}
          >
            {busy ? "Resetting…" : "Reset sync"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
