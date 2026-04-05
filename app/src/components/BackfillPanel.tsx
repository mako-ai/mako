import React, { useEffect, useState, useRef, useCallback } from "react";
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
  Pause as PauseIcon,
  Stop as CancelIcon,
  PlayArrow as ResumeIcon,
  RestartAlt as ResyncIcon,
  Healing as RecoverIcon,
  ContentCopy as CopyIcon,
  Edit as EditIcon,
  DeleteSweep as ResetTableIcon,
  ArrowBack as ArrowBackIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Replay as RetryIcon,
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
    fetchCdcDestinationCounts,
    fetchFlowStatus,
    fetchExecutionDetails,
    fetchFlowHistory,
    fetchWebhookEvents,
    fetchEntitySchema,
    startCdcStream,
    pauseCdcStream,
    pauseCdcFlow,
    cancelCdcBackfill,
    resumeCdcFlow,
    resetCdcEntityTable,
    resyncCdcFlow,
    recoverCdcFlow,
    retryAllFailedWebhookEvents,
  } = useFlowStore();

  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [entitySchemaCache, setEntitySchemaCache] = useState<
    Record<
      string,
      {
        fields: Record<
          string,
          { type: string; nullable?: boolean; required?: boolean }
        >;
        loading: boolean;
      }
    >
  >({});

  const toggleEntitySchema = useCallback(
    async (entity: string) => {
      if (expandedEntity === entity) {
        setExpandedEntity(null);
        return;
      }
      setExpandedEntity(entity);
      const cached = entitySchemaCache[entity];
      if (cached && (cached.loading || Object.keys(cached.fields).length > 0)) {
        return;
      }
      setEntitySchemaCache(prev => ({
        ...prev,
        [entity]: { fields: {}, loading: true },
      }));
      const schema = await fetchEntitySchema(workspaceId, flowId, entity);
      if (schema?.fields && Object.keys(schema.fields).length > 0) {
        setEntitySchemaCache(prev => ({
          ...prev,
          [entity]: { fields: schema.fields, loading: false },
        }));
      } else {
        setEntitySchemaCache(prev => {
          const next = { ...prev };
          delete next[entity];
          return next;
        });
      }
    },
    [expandedEntity, entitySchemaCache, fetchEntitySchema, workspaceId, flowId],
  );

  const [cdc, setCdc] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
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
  const [webhookEventsTotalAll, setWebhookEventsTotalAll] = useState(0);
  const [eventsFilter, setEventsFilter] = useState<string>("all");
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [entityResetOpen, setEntityResetOpen] = useState(false);
  const [entityResetEntity, setEntityResetEntity] = useState("");
  const [runs, setRuns] = useState<
    Array<{
      executionId: string;
      executedAt: string;
      status: string;
      success: boolean;
      error?:
        | string
        | { message: string; stack?: string; code?: string }
        | null;
      duration?: number;
    }>
  >([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunLogs, setSelectedRunLogs] = useState<LogEntry[] | null>(
    null,
  );
  const [destinationCounts, setDestinationCounts] = useState<Record<
    string,
    number | null
  > | null>(null);

  const cdcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const executionIdRef = useRef(executionId);
  executionIdRef.current = executionId;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const eventsFilterRef = useRef(eventsFilter);
  eventsFilterRef.current = eventsFilter;

  const flow = (flowsMap[workspaceId] || []).find(f => f._id === flowId);

  const streamState: StreamState = cdc?.streamState || "idle";
  const bfStatus: BackfillStatus = cdc?.backfillStatus || "idle";
  const isActive =
    streamState === "active" || bfStatus === "running" || executionId !== null;

  const pollCdc = useCallback(async () => {
    const activeTab = tabRef.current;
    const promises: Promise<unknown>[] = [fetchCdcStatus(workspaceId, flowId)];
    const shouldPollEvents = activeTab === 2;
    const shouldPollHistory = activeTab === 1;
    if (shouldPollEvents) {
      const filter = eventsFilterRef.current;
      const filterParams =
        filter !== "all" ? { applyStatus: filter } : undefined;
      promises.push(
        fetchWebhookEvents(workspaceId, flowId, 50, 0, filterParams),
      );
    }
    if (shouldPollHistory) {
      promises.push(fetchFlowHistory(workspaceId, flowId, 20));
    }

    const results = await Promise.all(promises);
    const status = results[0] as Awaited<ReturnType<typeof fetchCdcStatus>>;
    if (status) setCdc(status);
    if (shouldPollEvents) {
      const eventsResult = results[shouldPollHistory ? 2 : 1] as Awaited<
        ReturnType<typeof fetchWebhookEvents>
      >;
      if (eventsResult) {
        setWebhookEvents(eventsResult.events);
        if (eventsFilterRef.current === "all") {
          setWebhookEventsTotalAll(eventsResult.total);
        }
      }
    }
    if (shouldPollHistory) {
      const history = results[1] as Awaited<
        ReturnType<typeof fetchFlowHistory>
      >;
      if (history) setRuns(history as typeof runs);
    }
  }, [
    fetchCdcStatus,
    fetchWebhookEvents,
    fetchFlowHistory,
    workspaceId,
    flowId,
  ]);

  const pollLogs = useCallback(async () => {
    const currentExecId = executionIdRef.current;
    if (!currentExecId) {
      const statusResp = await fetchFlowStatus(workspaceId, flowId);
      if (statusResp?.isRunning && statusResp.runningExecution) {
        setExecutionId(statusResp.runningExecution.executionId);
        setLiveLogs([]);
      }
      return;
    }
    const details = await fetchExecutionDetails(
      workspaceId,
      flowId,
      currentExecId,
    );
    if (details?.logs && details.logs.length > 0) {
      setLiveLogs(details.logs as LogEntry[]);
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
  }, [workspaceId, flowId, fetchFlowStatus, fetchExecutionDetails]);

  const loadRunLogs = useCallback(
    async (runId: string) => {
      setSelectedRunId(runId);
      setSelectedRunLogs(null);
      const details = await fetchExecutionDetails(workspaceId, flowId, runId);
      if (details?.logs && details.logs.length > 0) {
        setSelectedRunLogs(details.logs as LogEntry[]);
      } else {
        setSelectedRunLogs([]);
      }
    },
    [fetchExecutionDetails, workspaceId, flowId],
  );

  useEffect(() => {
    pollCdc();
    const interval = isActive ? 3_000 : 8_000;
    cdcPollRef.current = setInterval(pollCdc, interval);
    return () => {
      if (cdcPollRef.current) clearInterval(cdcPollRef.current);
    };
  }, [pollCdc, isActive]);

  useEffect(() => {
    if (!isActive) return;
    pollLogs();
    logPollRef.current = setInterval(pollLogs, 2_000);
    return () => {
      if (logPollRef.current) clearInterval(logPollRef.current);
    };
  }, [pollLogs, isActive]);

  useEffect(() => {
    pollCdc();
  }, [tab, eventsFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const pollDestCounts = useCallback(async () => {
    const counts = await fetchCdcDestinationCounts(workspaceId, flowId);
    if (counts) setDestinationCounts(counts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, flowId]);

  useEffect(() => {
    pollDestCounts();
    const id = setInterval(pollDestCounts, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, flowId]);

  const withBusy = async (
    fn: () => Promise<unknown>,
    optimisticCdcPatch?: Partial<typeof cdc>,
  ) => {
    setBusy(true);
    setError(null);
    if (optimisticCdcPatch && cdc) {
      setCdc((prev: any) => (prev ? { ...prev, ...optimisticCdcPatch } : prev));
    }
    try {
      await fn();
      pollCdc();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (optimisticCdcPatch && cdc) {
        pollCdc();
      }
    } finally {
      setBusy(false);
    }
  };

  const handleStartBackfill = (entities?: string[]) =>
    withBusy(
      async () => {
        const ok = await startCdcBackfill(workspaceId, flowId, entities);
        if (!ok) throw new Error("Failed to start backfill");
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
        setTimeout(() => pollLogs(), 500);
      },
      { backfillStatus: "running" },
    );

  const handleStartStream = () =>
    withBusy(
      async () => {
        const ok = await startCdcStream(workspaceId, flowId);
        if (!ok) throw new Error("Failed to start stream");
      },
      { streamState: "active" },
    );

  const handlePauseStream = () =>
    withBusy(
      async () => {
        const ok = await pauseCdcStream(workspaceId, flowId);
        if (!ok) throw new Error("Failed to pause stream");
      },
      { streamState: "paused" },
    );

  const handleResumeStream = () =>
    withBusy(
      async () => {
        const ok = await startCdcStream(workspaceId, flowId);
        if (!ok) throw new Error("Failed to resume stream");
      },
      { streamState: "active" },
    );

  const handleRecoverStream = () =>
    withBusy(
      async () => {
        const ok = await recoverCdcFlow(workspaceId, flowId, {
          retryFailedMaterialization: true,
          resumeBackfill: false,
        });
        if (!ok) throw new Error("Failed to recover stream");
      },
      { streamState: "active" },
    );

  const handleRetryAllFailed = async () => {
    setRetryingFailed(true);
    try {
      await retryAllFailedWebhookEvents(workspaceId, flowId);
      await pollCdc();
    } finally {
      setRetryingFailed(false);
    }
  };

  const handlePauseBackfill = () =>
    withBusy(
      async () => {
        const ok = await pauseCdcFlow(workspaceId, flowId);
        if (!ok) throw new Error("Failed to pause backfill");
      },
      { backfillStatus: "paused" },
    );

  const handleCancelBackfill = () =>
    withBusy(
      async () => {
        const ok = await cancelCdcBackfill(workspaceId, flowId);
        if (!ok) throw new Error("Failed to cancel backfill");
      },
      { backfillStatus: "idle" },
    );

  const handleResumeBackfill = () =>
    withBusy(
      async () => {
        const ok = await resumeCdcFlow(workspaceId, flowId);
        if (!ok) throw new Error("Failed to resume backfill");
      },
      { backfillStatus: "running" },
    );

  const handleRecoverBackfill = () =>
    withBusy(
      async () => {
        const ok = await recoverCdcFlow(workspaceId, flowId, {
          retryFailedMaterialization: true,
          resumeBackfill: true,
        });
        if (!ok) throw new Error("Failed to recover backfill");
      },
      { backfillStatus: "running" },
    );

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
    setDestinationCounts(null);
    pollCdc();
    pollDestCounts();
  };

  const openEntityResetDialog = (entity: string) => {
    setEntityResetEntity(entity);
    setEntityResetOpen(true);
  };

  const handleResetEntityTable = () =>
    withBusy(
      async () => {
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
        setTimeout(() => pollLogs(), 500);
      },
      { backfillStatus: "running" },
    );

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
        destinationCounts?.[name] ??
        (typeof s?.destinationRowCount === "number"
          ? s.destinationRowCount
          : null),
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
    (sum, e) => sum + (e.lifetimeEventsProcessed || 0),
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
                {cdc.lagSeconds !== null && (
                  <Typography
                    variant="caption"
                    color={
                      cdc.lagSeconds >= 0 && cdc.lagSeconds <= 5
                        ? "success.main"
                        : "text.secondary"
                    }
                    sx={{
                      fontSize: "0.72rem",
                      fontWeight:
                        cdc.lagSeconds >= 0 && cdc.lagSeconds <= 5 ? 600 : 400,
                    }}
                  >
                    {cdc.lagSeconds < 0
                      ? "catching up"
                      : cdc.lagSeconds <= 5
                        ? "live"
                        : `${formatLag(cdc.lagSeconds)} lag`}
                  </Typography>
                )}
              </Box>
              {(cdc as any).failedWebhookCount > 0 && (
                <Typography
                  variant="caption"
                  color="error.main"
                  sx={{ fontSize: "0.72rem", fontWeight: 600, mb: 0.5 }}
                >
                  {(cdc as any).failedWebhookCount} webhook
                  {(cdc as any).failedWebhookCount === 1 ? "" : "s"} failed to
                  enqueue
                </Typography>
              )}
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                {streamState === "idle" && (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                    onClick={handleStartStream}
                    disabled={busy}
                    sx={{ textTransform: "none", fontSize: "0.72rem" }}
                  >
                    Start
                  </Button>
                )}
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
                {cdc.backlogCount > 0 && streamState !== "idle" && (
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
                  <>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                      onClick={handleResumeBackfill}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Resume
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<CancelIcon sx={{ fontSize: 14 }} />}
                      onClick={handleCancelBackfill}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Cancel
                    </Button>
                  </>
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

      {/* Tabs — Objects / Backfill runs / Events */}
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
          label={`Backfills (${runs.length})`}
          sx={{
            minHeight: 36,
            py: 0.5,
            textTransform: "none",
            fontSize: "0.82rem",
          }}
        />
        <Tab
          label={`Events (${webhookEventsTotalAll})`}
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
                      const eventCount = e.lifetimeEventsProcessed || 0;
                      const isExpanded = expandedEntity === e.entity;
                      const schemaData = entitySchemaCache[e.entity];
                      return (
                        <React.Fragment key={e.entity}>
                          <TableRow
                            sx={{
                              "&:last-child td": { borderBottom: 0 },
                              cursor: "pointer",
                              "&:hover": { bgcolor: "action.hover" },
                            }}
                            onClick={() => toggleEntitySchema(e.entity)}
                          >
                            <TableCell
                              sx={{
                                fontFamily: "monospace",
                                fontSize: "0.78rem",
                                fontWeight: 500,
                              }}
                            >
                              <Box
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 0.5,
                                }}
                              >
                                {isExpanded ? (
                                  <ExpandLessIcon
                                    sx={{
                                      fontSize: 16,
                                      color: "text.secondary",
                                    }}
                                  />
                                ) : (
                                  <ExpandMoreIcon
                                    sx={{
                                      fontSize: 16,
                                      color: "text.secondary",
                                    }}
                                  />
                                )}
                                {entityLabel(e.entity)}
                              </Box>
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
                                    {syncingRowsWritten.toLocaleString()}{" "}
                                    written
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
                                        onClick={ev => {
                                          ev.stopPropagation();
                                          openEntityResetDialog(e.entity);
                                        }}
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
                                        onClick={ev => {
                                          ev.stopPropagation();
                                          handleStartBackfill([e.entity]);
                                        }}
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
                          {isExpanded && (
                            <TableRow key={`${e.entity}-schema`}>
                              <TableCell
                                colSpan={6}
                                sx={{
                                  py: 0,
                                  px: 0,
                                  borderBottom: "none",
                                }}
                              >
                                {schemaData?.loading ? (
                                  <Box sx={{ py: 1.5, px: 2 }}>
                                    <LinearProgress
                                      sx={{ height: 2, borderRadius: 1 }}
                                    />
                                  </Box>
                                ) : schemaData?.fields &&
                                  Object.keys(schemaData.fields).length > 0 ? (
                                  <Box
                                    sx={{
                                      mx: 2,
                                      my: 1.5,
                                      border: 1,
                                      borderColor: "divider",
                                      borderRadius: 1,
                                      overflow: "hidden",
                                    }}
                                  >
                                    <Box
                                      sx={{
                                        px: 1.5,
                                        py: 0.75,
                                        bgcolor: "action.hover",
                                        borderBottom: 1,
                                        borderColor: "divider",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                      }}
                                    >
                                      <Typography
                                        sx={{
                                          fontSize: "0.7rem",
                                          fontWeight: 600,
                                          color: "text.secondary",
                                          textTransform: "uppercase",
                                          letterSpacing: 0.5,
                                        }}
                                      >
                                        Schema
                                      </Typography>
                                      <Chip
                                        label={`${Object.keys(schemaData.fields).length} columns`}
                                        size="small"
                                        sx={{
                                          height: 18,
                                          fontSize: "0.62rem",
                                          fontWeight: 600,
                                        }}
                                      />
                                    </Box>
                                    <Box>
                                      {Object.entries(schemaData.fields).map(
                                        ([fieldName, fieldDef]) => (
                                          <Box
                                            key={fieldName}
                                            sx={{
                                              display: "flex",
                                              alignItems: "center",
                                              justifyContent: "space-between",
                                              gap: 1,
                                              px: 1.5,
                                              py: 0.5,
                                              borderBottom: 1,
                                              borderColor: "divider",
                                              "&:hover": {
                                                bgcolor: "action.hover",
                                              },
                                            }}
                                          >
                                            <Typography
                                              sx={{
                                                fontFamily: "monospace",
                                                fontSize: "0.72rem",
                                                fontWeight: fieldDef.required
                                                  ? 600
                                                  : 400,
                                                color: fieldName.startsWith(
                                                  "_mako_",
                                                )
                                                  ? "text.disabled"
                                                  : "text.primary",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}
                                            >
                                              {fieldName}
                                            </Typography>
                                            <Chip
                                              label={fieldDef.type}
                                              size="small"
                                              variant="outlined"
                                              color={
                                                fieldDef.type === "timestamp"
                                                  ? "info"
                                                  : fieldDef.type === "number"
                                                    ? "warning"
                                                    : fieldDef.type ===
                                                        "boolean"
                                                      ? "success"
                                                      : fieldDef.type === "json"
                                                        ? "secondary"
                                                        : "default"
                                              }
                                              sx={{
                                                height: 18,
                                                fontSize: "0.6rem",
                                                fontWeight: 600,
                                                flexShrink: 0,
                                                minWidth: 52,
                                                justifyContent: "center",
                                              }}
                                            />
                                          </Box>
                                        ),
                                      )}
                                    </Box>
                                  </Box>
                                ) : (
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    sx={{ py: 1.5, px: 2, display: "block" }}
                                  >
                                    No schema available for this entity
                                  </Typography>
                                )}
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
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
            {/* Live running execution */}
            {(executionId || liveLogs.length > 0) && !selectedRunId && (
              <Box>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 0.75,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      fontSize: "0.72rem",
                      textTransform: "uppercase",
                      letterSpacing: 0.3,
                      color: "text.secondary",
                    }}
                  >
                    {executionId ? "Running" : "Last run"}
                  </Typography>
                  {executionId && (
                    <LinearProgress sx={{ width: 40, height: 3 }} />
                  )}
                </Box>
                <Box
                  sx={{
                    borderRadius: 1,
                    border: 1,
                    borderColor: executionId ? "info.main" : "divider",
                    bgcolor: "grey.950",
                    p: 1.5,
                    height: 200,
                    overflow: "auto",
                  }}
                >
                  {liveLogs.length === 0 ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: "monospace" }}
                    >
                      Waiting for logs…
                    </Typography>
                  ) : (
                    liveLogs.map((log, i) => (
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
                </Box>
              </Box>
            )}

            {/* Selected historical run logs */}
            {selectedRunId && selectedRunLogs !== null ? (
              <Box>
                <Button
                  size="small"
                  startIcon={<ArrowBackIcon sx={{ fontSize: 14 }} />}
                  onClick={() => {
                    setSelectedRunId(null);
                    setSelectedRunLogs(null);
                  }}
                  sx={{ textTransform: "none", fontSize: "0.75rem", mb: 1 }}
                >
                  Back to runs
                </Button>
                <Box
                  sx={{
                    borderRadius: 1,
                    border: 1,
                    borderColor: "divider",
                    bgcolor: "grey.950",
                    p: 1.5,
                    maxHeight: 400,
                    overflow: "auto",
                    minHeight: 80,
                  }}
                >
                  {selectedRunLogs.length === 0 ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontFamily: "monospace" }}
                    >
                      No logs recorded for this run.
                    </Typography>
                  ) : (
                    selectedRunLogs.map((log, i) => (
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
                </Box>
              </Box>
            ) : selectedRunId ? (
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
                  Loading logs…
                </Typography>
              </Box>
            ) : runs.length === 0 && !executionId && liveLogs.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                py={2}
              >
                No execution history yet.
              </Typography>
            ) : runs.length > 0 ? (
              <Box>
                {(executionId || liveLogs.length > 0) && (
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 600,
                      fontSize: "0.72rem",
                      textTransform: "uppercase",
                      letterSpacing: 0.3,
                      color: "text.secondary",
                      mb: 0.75,
                      display: "block",
                    }}
                  >
                    Past runs
                  </Typography>
                )}
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
                        <TableCell>Status</TableCell>
                        <TableCell>Started</TableCell>
                        <TableCell align="right">Duration</TableCell>
                        <TableCell align="right">Logs</TableCell>
                        <TableCell>Error</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {runs.map(run => {
                        const chipColor =
                          run.status === "completed"
                            ? ("success" as const)
                            : run.status === "failed"
                              ? ("error" as const)
                              : run.status === "abandoned"
                                ? ("warning" as const)
                                : run.status === "running"
                                  ? ("info" as const)
                                  : ("default" as const);
                        const durationStr = run.duration
                          ? run.duration < 60000
                            ? `${Math.round(run.duration / 1000)}s`
                            : run.duration < 3600000
                              ? `${Math.floor(run.duration / 60000)}m ${Math.round((run.duration % 60000) / 1000)}s`
                              : `${Math.floor(run.duration / 3600000)}h ${Math.floor((run.duration % 3600000) / 60000)}m`
                          : "—";
                        return (
                          <TableRow
                            key={run.executionId}
                            hover
                            onClick={() => loadRunLogs(run.executionId)}
                            sx={{
                              cursor: "pointer",
                              "&:last-child td": { borderBottom: 0 },
                            }}
                          >
                            <TableCell>
                              <Chip
                                label={run.status}
                                color={chipColor}
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
                              <Typography
                                variant="caption"
                                color="text.secondary"
                              >
                                {new Date(run.executedAt).toLocaleString()}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontFamily: "monospace" }}
                              >
                                {durationStr}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                sx={{ fontFamily: "monospace" }}
                              >
                                {(run as any).logCount ?? "—"}
                              </Typography>
                            </TableCell>
                            <TableCell sx={{ maxWidth: 280 }}>
                              {run.error && (
                                <Tooltip
                                  title={
                                    typeof run.error === "string"
                                      ? run.error
                                      : run.error.message
                                  }
                                  placement="bottom-start"
                                  slotProps={{
                                    tooltip: {
                                      sx: {
                                        maxWidth: 420,
                                        fontFamily: "monospace",
                                        fontSize: "0.72rem",
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                      },
                                    },
                                  }}
                                >
                                  <Typography
                                    variant="caption"
                                    color="error.main"
                                    sx={{
                                      fontSize: "0.68rem",
                                      display: "-webkit-box",
                                      WebkitLineClamp: 2,
                                      WebkitBoxOrient: "vertical",
                                      overflow: "hidden",
                                      wordBreak: "break-word",
                                      cursor: "help",
                                    }}
                                  >
                                    {typeof run.error === "string"
                                      ? run.error
                                      : run.error.message}
                                  </Typography>
                                </Tooltip>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            ) : null}
          </Box>
        )}

        {tab === 2 && (
          <Box sx={{ p: 2 }}>
            {cdc?.lastError &&
              (streamState === "error" || bfStatus === "error") && (
                <Alert
                  severity="error"
                  sx={{
                    mb: 1.5,
                    "& .MuiAlert-message": { width: "100%" },
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{ fontWeight: 600, fontSize: "0.8rem", mb: 0.25 }}
                  >
                    {streamState === "error" && bfStatus === "error"
                      ? "Stream & backfill error"
                      : streamState === "error"
                        ? "Stream error"
                        : "Backfill error"}
                    {cdc.consecutiveFailures > 0 && (
                      <Chip
                        label={`${cdc.consecutiveFailures} consecutive failures`}
                        size="small"
                        color="error"
                        variant="outlined"
                        sx={{
                          ml: 1,
                          height: 18,
                          fontSize: "0.65rem",
                          fontWeight: 500,
                        }}
                      />
                    )}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "0.72rem",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      display: "block",
                    }}
                  >
                    {cdc.lastError.message ||
                      cdc.lastError.code ||
                      "Unknown error"}
                  </Typography>
                  {cdc.lastError.reason &&
                    cdc.lastError.reason !== cdc.lastError.message && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{
                          fontSize: "0.68rem",
                          display: "block",
                          mt: 0.25,
                        }}
                      >
                        Reason: {cdc.lastError.reason}
                      </Typography>
                    )}
                </Alert>
              )}
            <Box
              sx={{
                display: "flex",
                gap: 0.5,
                mb: 1.5,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              {(
                [
                  { key: "all", label: "All" },
                  { key: "applied", label: "Applied" },
                  { key: "pending", label: "Pending" },
                  { key: "failed", label: "Failed" },
                  { key: "dropped", label: "Dropped" },
                ] as const
              ).map(f => (
                <Chip
                  key={f.key}
                  label={
                    f.key === "all" ? `All (${webhookEventsTotalAll})` : f.label
                  }
                  size="small"
                  variant={eventsFilter === f.key ? "filled" : "outlined"}
                  color={
                    eventsFilter === f.key
                      ? f.key === "failed"
                        ? "error"
                        : f.key === "dropped"
                          ? "warning"
                          : f.key === "pending"
                            ? "info"
                            : f.key === "applied"
                              ? "success"
                              : "default"
                      : "default"
                  }
                  onClick={() => setEventsFilter(f.key)}
                  sx={{
                    fontSize: "0.72rem",
                    fontWeight: eventsFilter === f.key ? 600 : 400,
                    cursor: "pointer",
                  }}
                />
              ))}
              {(cdc as any)?.failedWebhookCount > 0 && (
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  startIcon={<RetryIcon sx={{ fontSize: 14 }} />}
                  onClick={handleRetryAllFailed}
                  disabled={retryingFailed}
                  sx={{
                    textTransform: "none",
                    fontSize: "0.72rem",
                    ml: "auto",
                  }}
                >
                  {retryingFailed
                    ? "Retrying..."
                    : `Retry ${(cdc as any).failedWebhookCount} failed`}
                </Button>
              )}
            </Box>
            {webhookEvents.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                py={2}
              >
                {eventsFilter === "all"
                  ? "No webhook events received yet."
                  : `No ${eventsFilter} events.`}
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
                      <TableCell>Error</TableCell>
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
                        <TableCell sx={{ maxWidth: 240 }}>
                          {(evt.applyError?.message || evt.error?.message) && (
                            <Tooltip
                              title={
                                evt.applyError?.message ||
                                evt.error?.message ||
                                ""
                              }
                              placement="bottom-start"
                              slotProps={{
                                tooltip: {
                                  sx: {
                                    maxWidth: 420,
                                    fontFamily: "monospace",
                                    fontSize: "0.72rem",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                  },
                                },
                              }}
                            >
                              <Typography
                                variant="caption"
                                color="error.main"
                                sx={{
                                  fontSize: "0.68rem",
                                  display: "-webkit-box",
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: "vertical",
                                  overflow: "hidden",
                                  wordBreak: "break-word",
                                  cursor: "help",
                                }}
                              >
                                {evt.applyError?.message || evt.error?.message}
                              </Typography>
                            </Tooltip>
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
