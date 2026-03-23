import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/components/BackfillPanel.tsx");import __vite__cjsImport0_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=19b14d95"; const Fragment = __vite__cjsImport0_react_jsxDevRuntime["Fragment"]; const jsxDEV = __vite__cjsImport0_react_jsxDevRuntime["jsxDEV"];
import * as RefreshRuntime from "/@react-refresh";
const inWebWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
let prevRefreshReg;
let prevRefreshSig;
if (import.meta.hot && !inWebWorker) {
  if (!window.$RefreshReg$) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong."
    );
  }
  prevRefreshReg = window.$RefreshReg$;
  prevRefreshSig = window.$RefreshSig$;
  window.$RefreshReg$ = RefreshRuntime.getRefreshReg("/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx");
  window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;
}
var _s = $RefreshSig$();
import __vite__cjsImport3_react from "/node_modules/.vite/deps/react.js?v=19b14d95"; const useEffect = __vite__cjsImport3_react["useEffect"]; const useState = __vite__cjsImport3_react["useState"]; const useRef = __vite__cjsImport3_react["useRef"]; const useCallback = __vite__cjsImport3_react["useCallback"];
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
  Tooltip
} from "/node_modules/.vite/deps/@mui_material.js?v=19b14d95";
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
  ContentCopy as CopyIcon
} from "/node_modules/.vite/deps/@mui_icons-material.js?v=19b14d95";
import { useFlowStore } from "/src/store/flowStore.ts";
function formatExecutionLog(log) {
  const meta = log.metadata && typeof log.metadata === "object" ? log.metadata : void 0;
  const entity = typeof meta?.entity === "string" ? meta.entity : void 0;
  if (log.message === "Close API request sent") {
    const method = typeof meta?.method === "string" ? meta.method.toUpperCase() : "GET";
    const endpoint = typeof meta?.endpoint === "string" ? meta.endpoint : "";
    return `-> Close request ${method} ${endpoint}${entity ? ` [${entity}]` : ""}`;
  }
  if (log.message === "Close API response received") {
    const status = typeof meta?.status === "number" ? meta.status : void 0;
    const durationMs = typeof meta?.durationMs === "number" ? Math.round(meta.durationMs) : void 0;
    return `<- Close response${status ? ` ${status}` : ""}${durationMs !== void 0 ? ` in ${durationMs}ms` : ""}${entity ? ` [${entity}]` : ""}`;
  }
  if (log.message === "Close API request failed") {
    const status = typeof meta?.status === "number" ? meta.status : void 0;
    const errorText = typeof meta?.error === "string" ? meta.error : "unknown error";
    return `!! Close request failed${status ? ` (${status})` : ""}: ${errorText}${entity ? ` [${entity}]` : ""}`;
  }
  if (log.message.includes("SQL chunk done") && entity) {
    const totalProcessed = typeof meta?.totalProcessed === "number" ? meta.totalProcessed.toLocaleString() : void 0;
    return `DB write complete for ${entity}${totalProcessed ? `: ${totalProcessed} total rows` : ""}`;
  }
  if (log.message.includes("sync in progress") && entity) {
    const totalProcessed = typeof meta?.totalProcessed === "number" ? meta.totalProcessed.toLocaleString() : void 0;
    return `${entity} syncing${totalProcessed ? `: ${totalProcessed} rows` : ""}`;
  }
  if (log.message === "SQL batch received from source") {
    const fetchedCount = typeof meta?.fetchedCount === "number" ? meta.fetchedCount : void 0;
    return `-> batch fetched${fetchedCount ? ` (${fetchedCount} rows)` : ""}${entity ? ` [${entity}]` : ""}`;
  }
  if (log.message === "SQL batch write succeeded") {
    const rowsWritten = typeof meta?.rowsWritten === "number" ? meta.rowsWritten : void 0;
    return `<- batch written${rowsWritten !== void 0 ? ` (${rowsWritten} rows)` : ""}${entity ? ` [${entity}]` : ""}`;
  }
  if (log.message === "SQL batch write failed") {
    const errorText = typeof meta?.error === "string" ? meta.error : "unknown error";
    return `!! batch write failed: ${errorText}${entity ? ` [${entity}]` : ""}`;
  }
  return log.message;
}
function toFiniteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}
function camelToSnake(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function formatEntityAsTableName(entity) {
  if (!entity.includes(":")) return entity;
  const [parent, subEntity] = entity.split(":");
  if (!parent || !subEntity) return entity;
  return `${camelToSnake(subEntity)}_${parent}`;
}
function deriveProgressFromLogs(logs) {
  const entityStats = {};
  const entityStatus = {};
  for (const log of logs) {
    if (!log.metadata || typeof log.metadata !== "object") {
      continue;
    }
    const metadata = log.metadata;
    const entity = typeof metadata.entity === "string" && metadata.entity || typeof metadata.table === "string" && metadata.table || void 0;
    if (!entity) {
      continue;
    }
    const candidates = [
      toFiniteNumber(metadata.totalProcessed),
      toFiniteNumber(metadata.rowsWritten),
      toFiniteNumber(metadata.rowsProcessed),
      toFiniteNumber(metadata.recordCount)
    ].filter((value) => value !== null);
    if (candidates.length > 0) {
      entityStats[entity] = Math.max(entityStats[entity] || 0, ...candidates);
    }
    if (log.message.toLowerCase().includes("sync completed") || log.message.toLowerCase().includes("chunk completed")) {
      entityStatus[entity] = "completed";
    } else if (!entityStatus[entity]) {
      entityStatus[entity] = "syncing";
    }
  }
  return {
    entityStats,
    entityStatus
  };
}
export function BackfillPanel({
  workspaceId,
  flowId,
  onEdit
}) {
  _s();
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
    retryFailedCdcMaterialization
  } = useFlowStore();
  const [isTriggering, setIsTriggering] = useState(false);
  const [status, setStatus] = useState(
    null
  );
  const [executionId, setExecutionId] = useState(null);
  const [entityStats, setEntityStats] = useState({});
  const [entityStatus, setEntityStatus] = useState({});
  const [plannedEntities, setPlannedEntities] = useState([]);
  const [startedAt, setStartedAt] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [lastHeartbeat, setLastHeartbeat] = useState(null);
  const [recentLogs, setRecentLogs] = useState([]);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [cdcSummary, setCdcSummary] = useState(null);
  const [cdcDiagnostics, setCdcDiagnostics] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [resyncDialogOpen, setResyncDialogOpen] = useState(false);
  const [deleteDestination, setDeleteDestination] = useState(false);
  const [clearWebhookEvents, setClearWebhookEvents] = useState(false);
  const [resyncConfirmText, setResyncConfirmText] = useState("");
  const [isResyncing, setIsResyncing] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [panelWidth, setPanelWidth] = useState(0);
  const panelContainerRef = useRef(null);
  const pollRef = useRef(null);
  const cdcPollRef = useRef(null);
  const kpiColumnCount = panelWidth >= 980 ? 4 : 2;
  const currentFlow = (flowsMap[workspaceId] || []).find((f) => f._id === flowId);
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
  useEffect(() => {
    if (!isCdcFlow) return;
    const element = panelContainerRef.current;
    if (!element) return;
    const updatePanelWidth = (width) => {
      const next = Math.round(width);
      setPanelWidth((prev) => prev === next ? prev : next);
    };
    updatePanelWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      const onResize = () => updatePanelWidth(element.getBoundingClientRect().width);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updatePanelWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [isCdcFlow]);
  const pollCdcOverview = useCallback(
    async () => {
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
    },
    [
      isCdcFlow,
      fetchCdcSummary,
      fetchCdcDiagnostics,
      workspaceId,
      flowId,
      showDiagnostics
    ]
  );
  const loadHistory = useCallback(async () => {
    const runs = await fetchFlowHistory(workspaceId, flowId, 10);
    if (runs) setHistory(runs);
    if (runs?.[0]) setLastRun(runs[0]);
  }, [workspaceId, flowId, fetchFlowHistory]);
  const pollExecution = useCallback(
    async () => {
      if (!executionId) return;
      try {
        const details = await fetchExecutionDetails(
          workspaceId,
          flowId,
          executionId
        );
        if (!details) return;
        if (wasCancelled) return;
        setLastHeartbeat(details.lastHeartbeat || null);
        const logs = details.logs || [];
        if (logs.length > 0) {
          setRecentLogs(logs.slice(-8).reverse());
        }
        const statsFromApi = details.stats && typeof details.stats === "object" ? details.stats : void 0;
        const contextFromApi = details.context && typeof details.context === "object" ? details.context : void 0;
        if (Array.isArray(statsFromApi?.plannedEntities)) {
          setPlannedEntities(statsFromApi.plannedEntities);
        } else if (Array.isArray(contextFromApi?.entityFilter) && contextFromApi.entityFilter.length > 0) {
          setPlannedEntities(contextFromApi.entityFilter);
        }
        const derived = logs.length > 0 ? deriveProgressFromLogs(logs) : void 0;
        const mergedEntityStats = {
          ...statsFromApi?.entityStats || {}
        };
        if (derived?.entityStats) {
          for (const [entity, value] of Object.entries(derived.entityStats)) {
            mergedEntityStats[entity] = Math.max(
              mergedEntityStats[entity] || 0,
              value
            );
          }
        }
        if (Object.keys(mergedEntityStats).length > 0) {
          setEntityStats(mergedEntityStats);
        }
        const mergedEntityStatus = {
          ...derived?.entityStatus || {},
          ...statsFromApi?.entityStatus || {}
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
      }
    },
    [
      executionId,
      workspaceId,
      flowId,
      fetchExecutionDetails,
      stopPolling,
      loadHistory,
      wasCancelled
    ]
  );
  const startPolling = useCallback(() => {
    stopPolling();
    pollExecution();
    pollRef.current = setInterval(pollExecution, 5e3);
  }, [stopPolling, pollExecution]);
  useEffect(
    () => {
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
    },
    [
      workspaceId,
      flowId,
      isCdcFlow,
      fetchFlowStatus,
      loadHistory,
      stopPolling
    ]
  );
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
    cdcPollRef.current = setInterval(pollCdcOverview, 5e3);
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
      const detectExecution = async (attempts = 0) => {
        if (attempts > 8) return;
        const statusResp = await fetchFlowStatus(workspaceId, flowId);
        if (statusResp?.isRunning && statusResp.runningExecution) {
          setStatus("running");
          setExecutionId(statusResp.runningExecution.executionId);
          setStartedAt(statusResp.runningExecution.startedAt);
          return;
        }
        await new Promise((r) => setTimeout(r, 2e3));
        return detectExecution(attempts + 1);
      };
      detectExecution();
      return;
    }
    if (!confirm(
      "Run a full backfill? This will sync all historical data for the enabled entities."
    )) {
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
      setTimeout(async () => {
        const statusResp = await fetchFlowStatus(workspaceId, flowId);
        if (statusResp?.runningExecution) {
          setExecutionId(statusResp.runningExecution.executionId);
          setStartedAt(statusResp.runningExecution.startedAt);
        }
        setIsTriggering(false);
      }, 3e3);
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
    const success = currentState === "paused" ? await resumeCdcFlow(workspaceId, flowId) : await pauseCdcFlow(workspaceId, flowId);
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
      clearWebhookEvents
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
      resumeBackfill: true
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
    const formatLagDuration = (lagSeconds) => {
      if (lagSeconds === null || !Number.isFinite(lagSeconds)) return "n/a";
      if (lagSeconds < 60) return `${lagSeconds}s`;
      if (lagSeconds < 3600) {
        const minutes2 = Math.floor(lagSeconds / 60);
        const seconds = lagSeconds % 60;
        return seconds > 0 ? `${minutes2}m ${seconds}s` : `${minutes2}m`;
      }
      const hours = Math.floor(lagSeconds / 3600);
      const minutes = Math.floor(lagSeconds % 3600 / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    };
    const stateColor = (state2) => {
      switch (state2) {
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
        return Math.max(Math.floor((Date.now() - lastWebhookTs) / 1e3), 0);
      })();
      if ((summary.failedCount ?? 0) === 0 && (summary.backlogCount ?? 0) === 0) {
        return "live";
      }
      if (webhookLagSeconds !== null) {
        return `lag ${formatLagDuration(webhookLagSeconds)}`;
      }
      return `lag ${formatLagDuration(summary.lagSeconds)}`;
    })();
    const entityBackfillStatus = (entity) => {
      if (entity.failedCount > 0) return "Failed";
      if (!entity.lastMaterializedAt && entity.backlogCount === 0) {
        return "Not started";
      }
      if (entity.backlogCount > 0) return "In progress";
      if (entity.droppedCount > 0) return "Filtered";
      return "Completed";
    };
    const entityObjectStatus = (entity) => {
      if (entity.failedCount > 0) {
        return { label: "Error", color: "error" };
      }
      if (entity.backlogCount > 0) {
        return { label: "Syncing", color: "info" };
      }
      if (entity.droppedCount > 0) {
        return { label: "Filtered", color: "warning" };
      }
      if (entity.lastMaterializedAt) {
        return { label: "Running", color: "success" };
      }
      return { label: "Pending", color: "default" };
    };
    const entityLagLabel = (entity) => {
      if (entity.lagSeconds === null) return "—";
      if (entity.backlogCount === 0 && entity.failedCount === 0) return "—";
      return formatLagDuration(entity.lagSeconds);
    };
    const connectorName = currentFlow?.dataSourceId ? typeof currentFlow.dataSourceId === "object" ? currentFlow.dataSourceId.name : void 0 : void 0;
    const connectorType = currentFlow?.dataSourceId ? typeof currentFlow.dataSourceId === "object" ? currentFlow.dataSourceId.type : void 0 : void 0;
    const destName = currentFlow?.destinationDatabaseId ? typeof currentFlow.destinationDatabaseId === "object" ? currentFlow.destinationDatabaseId.name : void 0 : void 0;
    const destType = currentFlow?.destinationDatabaseId ? typeof currentFlow.destinationDatabaseId === "object" ? currentFlow.destinationDatabaseId.type : void 0 : void 0;
    const dataset = currentFlow?.tableDestination?.schema;
    const webhookEndpoint = currentFlow?.webhookConfig?.endpoint;
    const copyWebhookUrl = async () => {
      if (!webhookEndpoint) return;
      try {
        await navigator.clipboard.writeText(webhookEndpoint);
        setWebhookCopied(true);
        setTimeout(() => setWebhookCopied(false), 1500);
      } catch {
        setWebhookCopied(false);
      }
    };
    const act = {
      fontSize: "0.8rem",
      textTransform: "none",
      fontWeight: 500,
      color: "primary.main",
      minWidth: 0,
      px: { xs: 1, sm: 1.5 },
      py: 0.5,
      gap: 0.5,
      whiteSpace: "nowrap",
      "&:hover": { bgcolor: "action.hover" },
      "& .MuiButton-startIcon": { mr: 0.5 }
    };
    const actDanger = { ...act, color: "error.main" };
    const state = summary?.syncState;
    const backfillRunning = status === "running" || state === "backfill";
    const isPaused = state === "paused" && !backfillRunning;
    const isDegraded = state === "degraded" && !backfillRunning;
    const isIdle = (!state || state === "idle") && !backfillRunning;
    const hasFailed = (summary?.failedCount ?? 0) > 0;
    const failedDroppedDetail = summary && ((summary.failedCount ?? 0) > 0 || (summary.backlogCount ?? 0) > 0) ? `Lag ${formatLagDuration(summary.lagSeconds)}` : "No queued or failed events";
    return /* @__PURE__ */ jsxDEV(
      Box,
      {
        ref: panelContainerRef,
        sx: {
          height: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "auto"
        },
        children: [
          /* @__PURE__ */ jsxDEV(
            Box,
            {
              sx: {
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                px: { xs: 1, sm: 1.5 },
                py: 0.75,
                borderBottom: 1,
                borderColor: "divider",
                columnGap: 0.5,
                rowGap: 0.75,
                minHeight: 40
              },
              children: [
                /* @__PURE__ */ jsxDEV(
                  Box,
                  {
                    sx: { display: "flex", flexWrap: "wrap", gap: 0.5, minWidth: 0 },
                    children: [
                      isIdle && /* @__PURE__ */ jsxDEV(
                        Button,
                        {
                          sx: act,
                          startIcon: /* @__PURE__ */ jsxDEV(SyncIcon, { sx: { fontSize: 18 } }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 804,
                            columnNumber: 26
                          }, this),
                          onClick: handleBackfill,
                          disabled: isTriggering,
                          children: "Start backfill"
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 802,
                          columnNumber: 13
                        },
                        this
                      ),
                      backfillRunning && /* @__PURE__ */ jsxDEV(Fragment, { children: [
                        /* @__PURE__ */ jsxDEV(
                          Button,
                          {
                            sx: act,
                            startIcon: /* @__PURE__ */ jsxDEV(SyncIcon, { sx: { fontSize: 18 } }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 815,
                              columnNumber: 28
                            }, this),
                            disabled: true,
                            children: "Backfilling…"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 813,
                            columnNumber: 17
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(
                          Button,
                          {
                            sx: actDanger,
                            startIcon: /* @__PURE__ */ jsxDEV(CancelIcon, { sx: { fontSize: 18 } }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 822,
                              columnNumber: 28
                            }, this),
                            onClick: handleCancel,
                            children: "Cancel"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 820,
                            columnNumber: 17
                          },
                          this
                        )
                      ] }, void 0, true, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 812,
                        columnNumber: 13
                      }, this),
                      (state === "catchup" || state === "live") && /* @__PURE__ */ jsxDEV(
                        Button,
                        {
                          sx: act,
                          startIcon: /* @__PURE__ */ jsxDEV(PauseIcon, { sx: { fontSize: 18 } }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 832,
                            columnNumber: 26
                          }, this),
                          onClick: handleCdcPauseResume,
                          children: "Pause stream"
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 830,
                          columnNumber: 13
                        },
                        this
                      ),
                      isPaused && /* @__PURE__ */ jsxDEV(Fragment, { children: [
                        /* @__PURE__ */ jsxDEV(
                          Button,
                          {
                            sx: act,
                            startIcon: /* @__PURE__ */ jsxDEV(ResumeIcon, { sx: { fontSize: 18 } }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 842,
                              columnNumber: 28
                            }, this),
                            onClick: handleCdcPauseResume,
                            children: "Resume stream"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 840,
                            columnNumber: 17
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(
                          Button,
                          {
                            sx: act,
                            startIcon: /* @__PURE__ */ jsxDEV(SyncIcon, { sx: { fontSize: 18 } }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 849,
                              columnNumber: 28
                            }, this),
                            onClick: handleBackfill,
                            disabled: isTriggering,
                            children: "Start backfill"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 847,
                            columnNumber: 17
                          },
                          this
                        )
                      ] }, void 0, true, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 839,
                        columnNumber: 13
                      }, this),
                      isDegraded && /* @__PURE__ */ jsxDEV(Fragment, { children: [
                        /* @__PURE__ */ jsxDEV(
                          Button,
                          {
                            sx: act,
                            startIcon: /* @__PURE__ */ jsxDEV(RecoverIcon, { sx: { fontSize: 18 } }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 861,
                              columnNumber: 28
                            }, this),
                            onClick: handleCdcRecover,
                            children: "Recover"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 859,
                            columnNumber: 17
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(
                          Button,
                          {
                            sx: act,
                            startIcon: /* @__PURE__ */ jsxDEV(SyncIcon, { sx: { fontSize: 18 } }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 868,
                              columnNumber: 28
                            }, this),
                            onClick: handleBackfill,
                            disabled: isTriggering,
                            children: "Start backfill"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 866,
                            columnNumber: 17
                          },
                          this
                        )
                      ] }, void 0, true, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 858,
                        columnNumber: 13
                      }, this),
                      hasFailed && /* @__PURE__ */ jsxDEV(
                        Button,
                        {
                          sx: act,
                          startIcon: /* @__PURE__ */ jsxDEV(RetryIcon, { sx: { fontSize: 18 } }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 881,
                            columnNumber: 26
                          }, this),
                          onClick: handleRetryFailedMaterialization,
                          children: [
                            "Retry ",
                            summary?.failedCount ?? 0,
                            " failed"
                          ]
                        },
                        void 0,
                        true,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 879,
                          columnNumber: 13
                        },
                        this
                      )
                    ]
                  },
                  void 0,
                  true,
                  {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 797,
                    columnNumber: 11
                  },
                  this
                ),
                /* @__PURE__ */ jsxDEV(
                  Box,
                  {
                    sx: {
                      ml: { md: "auto" },
                      width: { xs: "100%", md: "auto" },
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: { xs: "flex-start", md: "flex-end" },
                      gap: 0.5
                    },
                    children: [
                      /* @__PURE__ */ jsxDEV(
                        Button,
                        {
                          sx: actDanger,
                          startIcon: /* @__PURE__ */ jsxDEV(ResyncIcon, { sx: { fontSize: 18 } }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 902,
                            columnNumber: 26
                          }, this),
                          onClick: () => setResyncDialogOpen(true),
                          children: "Resync from scratch"
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 900,
                          columnNumber: 13
                        },
                        this
                      ),
                      onEdit && /* @__PURE__ */ jsxDEV(
                        Button,
                        {
                          sx: act,
                          startIcon: /* @__PURE__ */ jsxDEV(EditIcon, { sx: { fontSize: 18 } }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 910,
                            columnNumber: 26
                          }, this),
                          onClick: onEdit,
                          children: "Edit"
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 908,
                          columnNumber: 13
                        },
                        this
                      ),
                      /* @__PURE__ */ jsxDEV(
                        Button,
                        {
                          sx: act,
                          startIcon: /* @__PURE__ */ jsxDEV(DiagnosticsIcon, { sx: { fontSize: 18 } }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 918,
                            columnNumber: 26
                          }, this),
                          onClick: () => setShowDiagnostics((v) => !v),
                          children: showDiagnostics ? "Hide diagnostics" : "Diagnostics"
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 916,
                          columnNumber: 13
                        },
                        this
                      )
                    ]
                  },
                  void 0,
                  true,
                  {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 889,
                    columnNumber: 11
                  },
                  this
                )
              ]
            },
            void 0,
            true,
            {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 783,
              columnNumber: 9
            },
            this
          ),
          /* @__PURE__ */ jsxDEV(
            Box,
            {
              sx: {
                px: { xs: 1.5, sm: 2, md: 2.5 },
                py: 2,
                display: "grid",
                gap: { xs: 2, md: 2.5 }
              },
              children: [
                /* @__PURE__ */ jsxDEV(
                  Box,
                  {
                    sx: {
                      display: "grid",
                      gridTemplateColumns: {
                        xs: "88px minmax(0, 1fr)",
                        sm: "100px minmax(0, 1fr)"
                      },
                      rowGap: 0.5,
                      columnGap: 1.5,
                      "& .lbl": {
                        color: "text.secondary",
                        fontSize: "0.78rem",
                        lineHeight: 1.7
                      },
                      "& .val": { fontSize: "0.78rem", lineHeight: 1.7, minWidth: 0 }
                    },
                    children: [
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Engines" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 952,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "val", fontWeight: 600, children: "CDC" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 953,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Source" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 956,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(
                        Typography,
                        {
                          className: "val",
                          sx: { whiteSpace: { xs: "normal", sm: "nowrap" } },
                          children: [
                            connectorName || "—",
                            connectorType ? ` · ${connectorType}` : ""
                          ]
                        },
                        void 0,
                        true,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 957,
                          columnNumber: 13
                        },
                        this
                      ),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Destination" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 964,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(
                        Typography,
                        {
                          className: "val",
                          sx: { whiteSpace: { xs: "normal", sm: "nowrap" } },
                          children: [
                            destName || "—",
                            destType ? ` · ${destType}` : ""
                          ]
                        },
                        void 0,
                        true,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 965,
                          columnNumber: 13
                        },
                        this
                      ),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Dataset" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 972,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "val", sx: { fontFamily: "monospace" }, children: dataset || "—" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 973,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Webhook" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 976,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(
                        Box,
                        {
                          className: "val",
                          sx: {
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            width: "min(100%, 680px)",
                            minWidth: 0
                          },
                          children: [
                            /* @__PURE__ */ jsxDEV(
                              Typography,
                              {
                                title: webhookEndpoint || "",
                                sx: {
                                  fontFamily: "monospace",
                                  fontSize: "0.68rem",
                                  opacity: 0.75,
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap"
                                },
                                children: webhookEndpoint || "—"
                              },
                              void 0,
                              false,
                              {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 987,
                                columnNumber: 15
                              },
                              this
                            ),
                            /* @__PURE__ */ jsxDEV(Tooltip, { title: webhookCopied ? "Copied" : "Copy URL", children: /* @__PURE__ */ jsxDEV("span", { children: /* @__PURE__ */ jsxDEV(
                              IconButton,
                              {
                                size: "small",
                                onClick: copyWebhookUrl,
                                disabled: !webhookEndpoint,
                                "aria-label": "Copy webhook URL",
                                sx: { p: 0.25 },
                                children: /* @__PURE__ */ jsxDEV(CopyIcon, { sx: { fontSize: 14 } }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1011,
                                  columnNumber: 21
                                }, this)
                              },
                              void 0,
                              false,
                              {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 1004,
                                columnNumber: 19
                              },
                              this
                            ) }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1003,
                              columnNumber: 17
                            }, this) }, void 0, false, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1002,
                              columnNumber: 15
                            }, this)
                          ]
                        },
                        void 0,
                        true,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 977,
                          columnNumber: 13
                        },
                        this
                      ),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Created" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1016,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "val", children: currentFlow?.createdAt ? new Date(currentFlow.createdAt).toLocaleString() : "—" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1017,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "lbl", children: "Updated" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1022,
                        columnNumber: 13
                      }, this),
                      /* @__PURE__ */ jsxDEV(Typography, { className: "val", children: currentFlow?.updatedAt ? new Date(currentFlow.updatedAt).toLocaleString() : "—" }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1023,
                        columnNumber: 13
                      }, this)
                    ]
                  },
                  void 0,
                  true,
                  {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 935,
                    columnNumber: 11
                  },
                  this
                ),
                summary ? /* @__PURE__ */ jsxDEV(Fragment, { children: [
                  /* @__PURE__ */ jsxDEV(
                    Box,
                    {
                      sx: {
                        display: "grid",
                        gridTemplateColumns: `repeat(${kpiColumnCount}, minmax(0, 1fr))`,
                        gap: { xs: 1, sm: 1.5 }
                      },
                      children: [
                        /* @__PURE__ */ jsxDEV(
                          Box,
                          {
                            sx: {
                              borderRadius: 1.5,
                              p: 1.5,
                              bgcolor: "action.hover",
                              minWidth: 0
                            },
                            children: [
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { letterSpacing: 0.3, fontSize: "0.68rem" },
                                  children: "Stream status"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1049,
                                  columnNumber: 19
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(Box, { sx: { mt: 0.5 }, children: /* @__PURE__ */ jsxDEV(
                                Chip,
                                {
                                  size: "small",
                                  label: summary.syncState.charAt(0).toUpperCase() + summary.syncState.slice(1),
                                  color: stateColor(summary.syncState),
                                  icon: summary.syncState === "live" ? /* @__PURE__ */ jsxDEV(CheckIcon, {}, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1066,
                                    columnNumber: 21
                                  }, this) : summary.syncState === "degraded" ? /* @__PURE__ */ jsxDEV(ErrorIcon, {}, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1068,
                                    columnNumber: 21
                                  }, this) : /* @__PURE__ */ jsxDEV(SyncIcon, {}, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1070,
                                    columnNumber: 21
                                  }, this),
                                  sx: { fontWeight: 600, fontSize: "0.72rem" }
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1057,
                                  columnNumber: 21
                                },
                                this
                              ) }, void 0, false, {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 1056,
                                columnNumber: 19
                              }, this),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { display: "block", mt: 0.8, fontSize: "0.65rem" },
                                  children: [
                                    "Freshness: ",
                                    freshnessSummary
                                  ]
                                },
                                void 0,
                                true,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1076,
                                  columnNumber: 19
                                },
                                this
                              )
                            ]
                          },
                          void 0,
                          true,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1041,
                            columnNumber: 17
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(
                          Box,
                          {
                            sx: {
                              borderRadius: 1.5,
                              p: 1.5,
                              bgcolor: "action.hover",
                              minWidth: 0
                            },
                            children: [
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { letterSpacing: 0.3, fontSize: "0.68rem" },
                                  children: "Backfill status"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1093,
                                  columnNumber: 19
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  fontWeight: 700,
                                  sx: { mt: 0.25, fontSize: "0.95rem" },
                                  children: summary.backlogCount > 0 ? `${summary.backlogCount.toLocaleString()} pending` : summary.syncState === "backfill" ? "In progress" : summary.lastMaterializedAt ? "Completed" : "Not started"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1100,
                                  columnNumber: 19
                                },
                                this
                              )
                            ]
                          },
                          void 0,
                          true,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1085,
                            columnNumber: 17
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(
                          Box,
                          {
                            sx: {
                              borderRadius: 1.5,
                              p: 1.5,
                              bgcolor: "action.hover",
                              minWidth: 0
                            },
                            children: [
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { letterSpacing: 0.3, fontSize: "0.68rem" },
                                  children: "Events materialized"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1122,
                                  columnNumber: 19
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  fontWeight: 700,
                                  sx: { mt: 0.25, fontSize: "0.95rem" },
                                  children: (summary.appliedCount ?? 0).toLocaleString()
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1129,
                                  columnNumber: 19
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { display: "block", mt: 0.25, fontSize: "0.65rem" },
                                  children: summary.lastWebhookAt ? `Last webhook ${new Date(summary.lastWebhookAt).toLocaleString()}` : "No events yet"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1135,
                                  columnNumber: 19
                                },
                                this
                              )
                            ]
                          },
                          void 0,
                          true,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1114,
                            columnNumber: 17
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(
                          Box,
                          {
                            sx: {
                              borderRadius: 1.5,
                              p: 1.5,
                              bgcolor: summary.failedCount > 0 ? "error.50" : "action.hover",
                              minWidth: 0
                            },
                            children: [
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { letterSpacing: 0.3, fontSize: "0.68rem" },
                                  children: "Failed / dropped"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1155,
                                  columnNumber: 19
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  fontWeight: 700,
                                  sx: {
                                    mt: 0.25,
                                    fontSize: "0.95rem",
                                    color: summary.failedCount > 0 ? "error.main" : "text.primary"
                                  },
                                  children: [
                                    summary.failedCount.toLocaleString(),
                                    " /",
                                    " ",
                                    (summary.droppedCount ?? 0).toLocaleString()
                                  ]
                                },
                                void 0,
                                true,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1162,
                                  columnNumber: 19
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { display: "block", mt: 0.25, fontSize: "0.65rem" },
                                  children: failedDroppedDetail
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1174,
                                  columnNumber: 19
                                },
                                this
                              )
                            ]
                          },
                          void 0,
                          true,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1146,
                            columnNumber: 17
                          },
                          this
                        )
                      ]
                    },
                    void 0,
                    true,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1033,
                      columnNumber: 15
                    },
                    this
                  ),
                  status === "running" && /* @__PURE__ */ jsxDEV(
                    Box,
                    {
                      sx: {
                        borderRadius: 1.5,
                        border: 1,
                        borderColor: "divider",
                        p: 1.5
                      },
                      children: [
                        /* @__PURE__ */ jsxDEV(
                          Box,
                          {
                            sx: {
                              display: "flex",
                              alignItems: "center",
                              gap: 1,
                              mb: 1
                            },
                            children: [
                              /* @__PURE__ */ jsxDEV(
                                SyncIcon,
                                {
                                  sx: {
                                    fontSize: 16,
                                    animation: "spin 1s linear infinite",
                                    "@keyframes spin": {
                                      from: { transform: "rotate(0deg)" },
                                      to: { transform: "rotate(360deg)" }
                                    }
                                  }
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1202,
                                  columnNumber: 21
                                },
                                this
                              ),
                              /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  fontWeight: 600,
                                  sx: { textTransform: "uppercase", letterSpacing: 0.5 },
                                  children: "Backfill in progress"
                                },
                                void 0,
                                false,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1212,
                                  columnNumber: 21
                                },
                                this
                              ),
                              startedAt && /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  color: "text.secondary",
                                  sx: { ml: "auto" },
                                  children: [
                                    "Started ",
                                    new Date(startedAt).toLocaleTimeString(),
                                    lastHeartbeat ? ` · updated ${new Date(lastHeartbeat).toLocaleTimeString()}` : ""
                                  ]
                                },
                                void 0,
                                true,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1220,
                                  columnNumber: 17
                                },
                                this
                              )
                            ]
                          },
                          void 0,
                          true,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1194,
                            columnNumber: 19
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(LinearProgress, { sx: { mb: 1.5, borderRadius: 1 } }, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1232,
                          columnNumber: 19
                        }, this),
                        Object.keys(entityStats).length > 0 && /* @__PURE__ */ jsxDEV(
                          TableContainer,
                          {
                            sx: {
                              mb: 1.5,
                              borderRadius: 1,
                              border: 1,
                              borderColor: "divider"
                            },
                            children: /* @__PURE__ */ jsxDEV(Table, { size: "small", children: [
                              /* @__PURE__ */ jsxDEV(TableHead, { children: /* @__PURE__ */ jsxDEV(
                                TableRow,
                                {
                                  sx: {
                                    bgcolor: "action.hover",
                                    "& th": {
                                      fontSize: "0.68rem",
                                      fontWeight: 600,
                                      color: "text.secondary",
                                      textTransform: "uppercase",
                                      letterSpacing: 0.4,
                                      py: 0.5,
                                      px: 1
                                    }
                                  },
                                  children: [
                                    /* @__PURE__ */ jsxDEV(TableCell, { children: "Entity" }, void 0, false, {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1260,
                                      columnNumber: 29
                                    }, this),
                                    /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Records" }, void 0, false, {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1261,
                                      columnNumber: 29
                                    }, this),
                                    /* @__PURE__ */ jsxDEV(TableCell, { align: "center", children: "Status" }, void 0, false, {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1262,
                                      columnNumber: 29
                                    }, this)
                                  ]
                                },
                                void 0,
                                true,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1246,
                                  columnNumber: 27
                                },
                                this
                              ) }, void 0, false, {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 1245,
                                columnNumber: 25
                              }, this),
                              /* @__PURE__ */ jsxDEV(TableBody, { children: [
                                .../* @__PURE__ */ new Set(
                                  [
                                    ...plannedEntities,
                                    ...Object.keys(entityStats),
                                    ...Object.keys(entityStatus)
                                  ]
                                )
                              ].map(
                                (entity) => [entity, entityStats[entity] || 0]
                              ).sort(([, a], [, b]) => b - a).map(
                                ([entity, count]) => /* @__PURE__ */ jsxDEV(
                                  TableRow,
                                  {
                                    sx: { "&:last-child td": { borderBottom: 0 } },
                                    children: [
                                      /* @__PURE__ */ jsxDEV(
                                        TableCell,
                                        {
                                          sx: {
                                            fontFamily: "monospace",
                                            fontSize: "0.75rem",
                                            py: 0.5,
                                            px: 1
                                          },
                                          children: formatEntityAsTableName(entity)
                                        },
                                        void 0,
                                        false,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1283,
                                          columnNumber: 33
                                        },
                                        this
                                      ),
                                      /* @__PURE__ */ jsxDEV(
                                        TableCell,
                                        {
                                          align: "right",
                                          sx: {
                                            fontWeight: 600,
                                            fontSize: "0.78rem",
                                            py: 0.5,
                                            px: 1
                                          },
                                          children: count.toLocaleString()
                                        },
                                        void 0,
                                        false,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1293,
                                          columnNumber: 33
                                        },
                                        this
                                      ),
                                      /* @__PURE__ */ jsxDEV(
                                        TableCell,
                                        {
                                          align: "center",
                                          sx: { py: 0.5, px: 1 },
                                          children: /* @__PURE__ */ jsxDEV(
                                            Chip,
                                            {
                                              size: "small",
                                              label: entityStatus[entity] === "completed" ? "done" : entityStatus[entity] === "failed" ? "failed" : entityStatus[entity] === "pending" ? "pending" : "syncing",
                                              color: entityStatus[entity] === "completed" ? "success" : entityStatus[entity] === "failed" ? "error" : entityStatus[entity] === "pending" ? "default" : "info",
                                              variant: "outlined",
                                              sx: {
                                                height: 20,
                                                fontSize: "0.65rem",
                                                fontWeight: 500
                                              }
                                            },
                                            void 0,
                                            false,
                                            {
                                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                              lineNumber: 1308,
                                              columnNumber: 35
                                            },
                                            this
                                          )
                                        },
                                        void 0,
                                        false,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1304,
                                          columnNumber: 33
                                        },
                                        this
                                      )
                                    ]
                                  },
                                  entity,
                                  true,
                                  {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1279,
                                    columnNumber: 21
                                  },
                                  this
                                )
                              ) }, void 0, false, {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 1265,
                                columnNumber: 25
                              }, this)
                            ] }, void 0, true, {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1244,
                              columnNumber: 23
                            }, this)
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1236,
                            columnNumber: 15
                          },
                          this
                        ),
                        recentLogs.length > 0 && /* @__PURE__ */ jsxDEV(
                          Box,
                          {
                            sx: {
                              maxHeight: 120,
                              overflow: "auto",
                              borderRadius: 1,
                              bgcolor: "action.hover",
                              p: 1,
                              display: "grid",
                              gap: 0.25
                            },
                            children: recentLogs.map(
                              (log, idx) => /* @__PURE__ */ jsxDEV(
                                Typography,
                                {
                                  variant: "caption",
                                  sx: {
                                    fontFamily: "monospace",
                                    fontSize: "0.7rem",
                                    whiteSpace: "pre-wrap",
                                    color: log.level === "error" ? "error.main" : "text.secondary"
                                  },
                                  children: [
                                    "[",
                                    new Date(log.timestamp).toLocaleTimeString(),
                                    "]",
                                    " ",
                                    formatExecutionLog(log)
                                  ]
                                },
                                `${log.timestamp}-${idx}`,
                                true,
                                {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1357,
                                  columnNumber: 17
                                },
                                this
                              )
                            )
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1345,
                            columnNumber: 15
                          },
                          this
                        ),
                        recentLogs.length === 0 && Object.keys(entityStats).length === 0 && /* @__PURE__ */ jsxDEV(Typography, { variant: "caption", color: "text.secondary", children: "Waiting for backfill to start producing data..." }, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1379,
                          columnNumber: 15
                        }, this)
                      ]
                    },
                    void 0,
                    true,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1186,
                      columnNumber: 13
                    },
                    this
                  ),
                  status === "failed" && error && /* @__PURE__ */ jsxDEV(
                    Alert,
                    {
                      severity: "error",
                      sx: { borderRadius: 1.5 },
                      onClose: () => {
                        setStatus(null);
                        setError(null);
                      },
                      children: [
                        "Backfill failed: ",
                        error
                      ]
                    },
                    void 0,
                    true,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1387,
                      columnNumber: 13
                    },
                    this
                  ),
                  /* @__PURE__ */ jsxDEV(Box, { children: [
                    /* @__PURE__ */ jsxDEV(
                      Typography,
                      {
                        variant: "caption",
                        color: "text.secondary",
                        sx: {
                          mb: 0.75,
                          display: "block",
                          fontWeight: 600,
                          letterSpacing: 0.5,
                          textTransform: "uppercase"
                        },
                        children: [
                          summary.entityCounts.length,
                          " entities"
                        ]
                      },
                      void 0,
                      true,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1401,
                        columnNumber: 17
                      },
                      this
                    ),
                    /* @__PURE__ */ jsxDEV(
                      TableContainer,
                      {
                        sx: {
                          borderRadius: 1.5,
                          border: 1,
                          borderColor: "divider",
                          width: "100%",
                          maxWidth: "100%",
                          overflowX: "auto",
                          maxHeight: { xs: 320, sm: 380, lg: 520 },
                          "& .MuiTable-root": {
                            minWidth: 900
                          },
                          "& .MuiTableCell-root": {
                            py: { xs: 0.65, sm: 0.75 },
                            px: { xs: 0.75, sm: 1 },
                            fontSize: { xs: "0.72rem", sm: "0.78rem" },
                            whiteSpace: "nowrap"
                          }
                        },
                        children: /* @__PURE__ */ jsxDEV(Table, { stickyHeader: true, size: "small", children: [
                          /* @__PURE__ */ jsxDEV(TableHead, { children: /* @__PURE__ */ jsxDEV(
                            TableRow,
                            {
                              sx: {
                                bgcolor: "action.hover",
                                "& th": {
                                  fontWeight: 600,
                                  fontSize: "0.7rem",
                                  color: "text.secondary",
                                  textTransform: "uppercase",
                                  letterSpacing: 0.5,
                                  borderBottom: 1,
                                  borderColor: "divider"
                                }
                              },
                              children: [
                                /* @__PURE__ */ jsxDEV(TableCell, { children: "Entity name" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1450,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { children: "Status" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1451,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { children: "Backfill" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1452,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Applied" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1453,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Queued" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1454,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Failed" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1455,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Dropped" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1456,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Lag" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1457,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Last materialized" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1458,
                                  columnNumber: 25
                                }, this)
                              ]
                            },
                            void 0,
                            true,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1436,
                              columnNumber: 23
                            },
                            this
                          ) }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1435,
                            columnNumber: 21
                          }, this),
                          /* @__PURE__ */ jsxDEV(TableBody, { children: summary.entityCounts.map((entity) => {
                            const objStatus = entityObjectStatus(entity);
                            return /* @__PURE__ */ jsxDEV(
                              TableRow,
                              {
                                hover: true,
                                sx: { "&:last-child td": { borderBottom: 0 } },
                                children: [
                                  /* @__PURE__ */ jsxDEV(TableCell, { children: /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      sx: {
                                        fontFamily: "monospace",
                                        fontSize: "0.78rem",
                                        fontWeight: 500
                                      },
                                      children: formatEntityAsTableName(entity.entity)
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1471,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1470,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { children: /* @__PURE__ */ jsxDEV(
                                    Chip,
                                    {
                                      size: "small",
                                      label: objStatus.label,
                                      color: objStatus.color,
                                      variant: "outlined",
                                      sx: {
                                        height: 22,
                                        fontSize: "0.7rem",
                                        fontWeight: 500
                                      }
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1482,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1481,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { children: /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      fontSize: "0.78rem",
                                      color: entityBackfillStatus(entity) === "Failed" ? "error.main" : "text.primary",
                                      children: entityBackfillStatus(entity)
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1495,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1494,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      fontWeight: entity.appliedCount > 0 ? 600 : 400,
                                      color: entity.appliedCount > 0 ? "success.main" : "text.primary",
                                      fontSize: "0.8rem",
                                      children: (entity.appliedCount ?? 0).toLocaleString()
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1507,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1506,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: entity.backlogCount }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1519,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      fontWeight: entity.failedCount > 0 ? 700 : 400,
                                      color: entity.failedCount > 0 ? "error.main" : "text.primary",
                                      fontSize: "0.8rem",
                                      children: entity.failedCount
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1523,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1522,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      fontWeight: entity.droppedCount > 0 ? 700 : 400,
                                      color: entity.droppedCount > 0 ? "warning.main" : "text.primary",
                                      fontSize: "0.8rem",
                                      children: entity.droppedCount ?? 0
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1536,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1535,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: entityLagLabel(entity) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1548,
                                    columnNumber: 29
                                  }, this),
                                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      variant: "caption",
                                      color: "text.secondary",
                                      children: entity.lastMaterializedAt ? new Date(
                                        entity.lastMaterializedAt
                                      ).toLocaleString() : "—"
                                    },
                                    void 0,
                                    false,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1552,
                                      columnNumber: 31
                                    },
                                    this
                                  ) }, void 0, false, {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1551,
                                    columnNumber: 29
                                  }, this)
                                ]
                              },
                              entity.entity,
                              true,
                              {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 1465,
                                columnNumber: 25
                              },
                              this
                            );
                          }) }, void 0, false, {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1461,
                            columnNumber: 21
                          }, this)
                        ] }, void 0, true, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1434,
                          columnNumber: 19
                        }, this)
                      },
                      void 0,
                      false,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1414,
                        columnNumber: 17
                      },
                      this
                    )
                  ] }, void 0, true, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 1400,
                    columnNumber: 15
                  }, this),
                  showDiagnostics && cdcDiagnostics && /* @__PURE__ */ jsxDEV(
                    Box,
                    {
                      sx: {
                        display: "grid",
                        gap: 2,
                        borderRadius: 1.5,
                        border: 1,
                        borderColor: "divider",
                        p: 2,
                        bgcolor: "background.default"
                      },
                      children: [
                        /* @__PURE__ */ jsxDEV(
                          Typography,
                          {
                            variant: "caption",
                            color: "text.secondary",
                            sx: {
                              fontWeight: 600,
                              letterSpacing: 0.5,
                              textTransform: "uppercase"
                            },
                            children: "Diagnostics"
                          },
                          void 0,
                          false,
                          {
                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                            lineNumber: 1584,
                            columnNumber: 19
                          },
                          this
                        ),
                        /* @__PURE__ */ jsxDEV(Box, { children: [
                          /* @__PURE__ */ jsxDEV(
                            Typography,
                            {
                              variant: "subtitle2",
                              sx: { mb: 0.75, fontSize: "0.8rem" },
                              children: "Transition timeline"
                            },
                            void 0,
                            false,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1598,
                              columnNumber: 21
                            },
                            this
                          ),
                          /* @__PURE__ */ jsxDEV(
                            Box,
                            {
                              sx: {
                                maxHeight: 180,
                                overflow: "auto",
                                borderRadius: 1,
                                bgcolor: "action.hover",
                                p: 1,
                                display: "grid",
                                gap: 0.5
                              },
                              children: [
                                cdcDiagnostics.transitions.slice(0, 20).map(
                                  (transition, index) => /* @__PURE__ */ jsxDEV(
                                    Typography,
                                    {
                                      variant: "caption",
                                      sx: {
                                        fontFamily: "monospace",
                                        fontSize: "0.72rem"
                                      },
                                      children: [
                                        /* @__PURE__ */ jsxDEV(
                                          Typography,
                                          {
                                            component: "span",
                                            variant: "caption",
                                            color: "text.secondary",
                                            sx: {
                                              fontFamily: "monospace",
                                              fontSize: "0.72rem"
                                            },
                                            children: new Date(transition.at).toLocaleString()
                                          },
                                          void 0,
                                          false,
                                          {
                                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                            lineNumber: 1626,
                                            columnNumber: 29
                                          },
                                          this
                                        ),
                                        "  ",
                                        transition.fromState,
                                        " →",
                                        " ",
                                        /* @__PURE__ */ jsxDEV("strong", { children: transition.toState }, void 0, false, {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1639,
                                          columnNumber: 29
                                        }, this),
                                        "  ",
                                        /* @__PURE__ */ jsxDEV(
                                          Typography,
                                          {
                                            component: "span",
                                            variant: "caption",
                                            color: "text.secondary",
                                            sx: {
                                              fontFamily: "monospace",
                                              fontSize: "0.68rem"
                                            },
                                            children: [
                                              "(",
                                              transition.event,
                                              transition.reason ? `: ${transition.reason}` : "",
                                              ")"
                                            ]
                                          },
                                          void 0,
                                          true,
                                          {
                                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                            lineNumber: 1641,
                                            columnNumber: 29
                                          },
                                          this
                                        )
                                      ]
                                    },
                                    `${transition.at}-${index}`,
                                    true,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1618,
                                      columnNumber: 19
                                    },
                                    this
                                  )
                                ),
                                cdcDiagnostics.transitions.length === 0 && /* @__PURE__ */ jsxDEV(Typography, { variant: "caption", color: "text.secondary", children: "No transitions recorded" }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1659,
                                  columnNumber: 19
                                }, this)
                              ]
                            },
                            void 0,
                            true,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1604,
                              columnNumber: 21
                            },
                            this
                          )
                        ] }, void 0, true, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1597,
                          columnNumber: 19
                        }, this),
                        /* @__PURE__ */ jsxDEV(Box, { children: [
                          /* @__PURE__ */ jsxDEV(
                            Typography,
                            {
                              variant: "subtitle2",
                              sx: { mb: 0.75, fontSize: "0.8rem" },
                              children: "Entity cursors"
                            },
                            void 0,
                            false,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1668,
                              columnNumber: 21
                            },
                            this
                          ),
                          /* @__PURE__ */ jsxDEV(
                            TableContainer,
                            {
                              sx: {
                                borderRadius: 1,
                                border: 1,
                                borderColor: "divider"
                              },
                              children: /* @__PURE__ */ jsxDEV(Table, { size: "small", children: [
                                /* @__PURE__ */ jsxDEV(TableHead, { children: /* @__PURE__ */ jsxDEV(
                                  TableRow,
                                  {
                                    sx: {
                                      bgcolor: "action.hover",
                                      "& th": {
                                        fontSize: "0.68rem",
                                        color: "text.secondary",
                                        textTransform: "uppercase",
                                        letterSpacing: 0.4,
                                        fontWeight: 600
                                      }
                                    },
                                    children: [
                                      /* @__PURE__ */ jsxDEV(TableCell, { children: "Entity" }, void 0, false, {
                                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                        lineNumber: 1695,
                                        columnNumber: 29
                                      }, this),
                                      /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Ingest seq" }, void 0, false, {
                                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                        lineNumber: 1696,
                                        columnNumber: 29
                                      }, this),
                                      /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Materialized seq" }, void 0, false, {
                                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                        lineNumber: 1697,
                                        columnNumber: 29
                                      }, this),
                                      /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Backlog" }, void 0, false, {
                                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                        lineNumber: 1700,
                                        columnNumber: 29
                                      }, this),
                                      /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Lag" }, void 0, false, {
                                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                        lineNumber: 1701,
                                        columnNumber: 29
                                      }, this)
                                    ]
                                  },
                                  void 0,
                                  true,
                                  {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1683,
                                    columnNumber: 27
                                  },
                                  this
                                ) }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1682,
                                  columnNumber: 25
                                }, this),
                                /* @__PURE__ */ jsxDEV(TableBody, { children: cdcDiagnostics.cursors.map(
                                  (cursor) => /* @__PURE__ */ jsxDEV(
                                    TableRow,
                                    {
                                      sx: { "&:last-child td": { borderBottom: 0 } },
                                      children: [
                                        /* @__PURE__ */ jsxDEV(
                                          TableCell,
                                          {
                                            sx: {
                                              fontFamily: "monospace",
                                              fontSize: "0.75rem"
                                            },
                                            children: cursor.entity
                                          },
                                          void 0,
                                          false,
                                          {
                                            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                            lineNumber: 1710,
                                            columnNumber: 31
                                          },
                                          this
                                        ),
                                        /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: cursor.lastIngestSeq }, void 0, false, {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1718,
                                          columnNumber: 31
                                        }, this),
                                        /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: cursor.lastMaterializedSeq }, void 0, false, {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1721,
                                          columnNumber: 31
                                        }, this),
                                        /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: cursor.backlogCount }, void 0, false, {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1724,
                                          columnNumber: 31
                                        }, this),
                                        /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: cursor.lagSeconds ?? "—" }, void 0, false, {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1727,
                                          columnNumber: 31
                                        }, this)
                                      ]
                                    },
                                    cursor.entity,
                                    true,
                                    {
                                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                      lineNumber: 1706,
                                      columnNumber: 23
                                    },
                                    this
                                  )
                                ) }, void 0, false, {
                                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                  lineNumber: 1704,
                                  columnNumber: 25
                                }, this)
                              ] }, void 0, true, {
                                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                lineNumber: 1681,
                                columnNumber: 23
                              }, this)
                            },
                            void 0,
                            false,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1674,
                              columnNumber: 21
                            },
                            this
                          )
                        ] }, void 0, true, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1667,
                          columnNumber: 19
                        }, this),
                        /* @__PURE__ */ jsxDEV(Box, { children: [
                          /* @__PURE__ */ jsxDEV(
                            Typography,
                            {
                              variant: "subtitle2",
                              sx: { mb: 0.75, fontSize: "0.8rem" },
                              children: "Recent events"
                            },
                            void 0,
                            false,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1739,
                              columnNumber: 21
                            },
                            this
                          ),
                          /* @__PURE__ */ jsxDEV(
                            Box,
                            {
                              sx: {
                                maxHeight: 200,
                                overflow: "auto",
                                borderRadius: 1,
                                bgcolor: "action.hover",
                                p: 1,
                                display: "grid",
                                gap: 0.5
                              },
                              children: cdcDiagnostics.recentEvents.slice(0, 20).map(
                                (event, index) => /* @__PURE__ */ jsxDEV(
                                  Box,
                                  {
                                    sx: {
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 0.75
                                    },
                                    children: [
                                      /* @__PURE__ */ jsxDEV(
                                        Typography,
                                        {
                                          variant: "caption",
                                          sx: {
                                            fontFamily: "monospace",
                                            fontSize: "0.72rem",
                                            color: "text.secondary",
                                            minWidth: 32
                                          },
                                          children: [
                                            "#",
                                            event.ingestSeq
                                          ]
                                        },
                                        void 0,
                                        true,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1767,
                                          columnNumber: 29
                                        },
                                        this
                                      ),
                                      /* @__PURE__ */ jsxDEV(
                                        Typography,
                                        {
                                          variant: "caption",
                                          sx: {
                                            fontFamily: "monospace",
                                            fontSize: "0.72rem",
                                            flex: 1
                                          },
                                          children: [
                                            event.entity,
                                            " ",
                                            /* @__PURE__ */ jsxDEV("strong", { children: event.operation }, void 0, false, {
                                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                              lineNumber: 1786,
                                              columnNumber: 46
                                            }, this)
                                          ]
                                        },
                                        void 0,
                                        true,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1778,
                                          columnNumber: 29
                                        },
                                        this
                                      ),
                                      /* @__PURE__ */ jsxDEV(
                                        Chip,
                                        {
                                          size: "small",
                                          label: event.materializationStatus,
                                          color: event.materializationStatus === "applied" ? "success" : event.materializationStatus === "failed" ? "error" : "default",
                                          variant: "outlined",
                                          sx: {
                                            height: 18,
                                            fontSize: "0.62rem",
                                            fontWeight: 500,
                                            borderRadius: 0.75
                                          }
                                        },
                                        void 0,
                                        false,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1788,
                                          columnNumber: 29
                                        },
                                        this
                                      ),
                                      /* @__PURE__ */ jsxDEV(
                                        Typography,
                                        {
                                          variant: "caption",
                                          sx: {
                                            fontSize: "0.68rem",
                                            color: "text.secondary"
                                          },
                                          children: event.source
                                        },
                                        void 0,
                                        false,
                                        {
                                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                          lineNumber: 1806,
                                          columnNumber: 29
                                        },
                                        this
                                      )
                                    ]
                                  },
                                  `${event.ingestSeq}-${index}`,
                                  true,
                                  {
                                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                                    lineNumber: 1759,
                                    columnNumber: 19
                                  },
                                  this
                                )
                              )
                            },
                            void 0,
                            false,
                            {
                              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                              lineNumber: 1745,
                              columnNumber: 21
                            },
                            this
                          )
                        ] }, void 0, true, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1738,
                          columnNumber: 19
                        }, this)
                      ]
                    },
                    void 0,
                    true,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1573,
                      columnNumber: 13
                    },
                    this
                  )
                ] }, void 0, true, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 1032,
                  columnNumber: 11
                }, this) : /* @__PURE__ */ jsxDEV(
                  Box,
                  {
                    sx: {
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      py: 4,
                      justifyContent: "center"
                    },
                    children: [
                      /* @__PURE__ */ jsxDEV(
                        SyncIcon,
                        {
                          sx: {
                            fontSize: 16,
                            animation: "spin 1s linear infinite",
                            "@keyframes spin": {
                              from: { transform: "rotate(0deg)" },
                              to: { transform: "rotate(360deg)" }
                            }
                          }
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1832,
                          columnNumber: 15
                        },
                        this
                      ),
                      /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", color: "text.secondary", children: "Loading CDC summary..." }, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 1842,
                        columnNumber: 15
                      }, this)
                    ]
                  },
                  void 0,
                  true,
                  {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 1823,
                    columnNumber: 11
                  },
                  this
                )
              ]
            },
            void 0,
            true,
            {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 926,
              columnNumber: 9
            },
            this
          ),
          /* @__PURE__ */ jsxDEV(
            Dialog,
            {
              open: resyncDialogOpen,
              onClose: () => setResyncDialogOpen(false),
              children: [
                /* @__PURE__ */ jsxDEV(DialogTitle, { children: "Resync from scratch" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 1854,
                  columnNumber: 11
                }, this),
                /* @__PURE__ */ jsxDEV(DialogContent, { sx: { display: "grid", gap: 1, minWidth: 420 }, children: [
                  /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", children: "This will clear CDC state and restart backfill." }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 1856,
                    columnNumber: 13
                  }, this),
                  /* @__PURE__ */ jsxDEV(
                    FormControlLabel,
                    {
                      control: /* @__PURE__ */ jsxDEV(
                        Checkbox,
                        {
                          checked: deleteDestination,
                          onChange: (event) => setDeleteDestination(event.target.checked)
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1861,
                          columnNumber: 15
                        },
                        this
                      ),
                      label: "Delete destination tables"
                    },
                    void 0,
                    false,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1859,
                      columnNumber: 13
                    },
                    this
                  ),
                  /* @__PURE__ */ jsxDEV(
                    FormControlLabel,
                    {
                      control: /* @__PURE__ */ jsxDEV(
                        Checkbox,
                        {
                          checked: clearWebhookEvents,
                          onChange: (event) => setClearWebhookEvents(event.target.checked)
                        },
                        void 0,
                        false,
                        {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 1870,
                          columnNumber: 15
                        },
                        this
                      ),
                      label: "Clear stored webhook events"
                    },
                    void 0,
                    false,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1868,
                      columnNumber: 13
                    },
                    this
                  ),
                  /* @__PURE__ */ jsxDEV(
                    TextField,
                    {
                      label: "Type RESYNC to confirm",
                      value: resyncConfirmText,
                      onChange: (event) => setResyncConfirmText(event.target.value),
                      size: "small"
                    },
                    void 0,
                    false,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1879,
                      columnNumber: 13
                    },
                    this
                  )
                ] }, void 0, true, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 1855,
                  columnNumber: 11
                }, this),
                /* @__PURE__ */ jsxDEV(DialogActions, { children: [
                  /* @__PURE__ */ jsxDEV(
                    Button,
                    {
                      onClick: () => setResyncDialogOpen(false),
                      disabled: isResyncing,
                      children: "Cancel"
                    },
                    void 0,
                    false,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1887,
                      columnNumber: 13
                    },
                    this
                  ),
                  /* @__PURE__ */ jsxDEV(
                    Button,
                    {
                      variant: "contained",
                      color: "warning",
                      disabled: resyncConfirmText !== "RESYNC" || isResyncing,
                      onClick: handleCdcResync,
                      children: isResyncing ? "Resyncing…" : "Resync"
                    },
                    void 0,
                    false,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 1893,
                      columnNumber: 13
                    },
                    this
                  )
                ] }, void 0, true, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 1886,
                  columnNumber: 11
                }, this)
              ]
            },
            void 0,
            true,
            {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 1850,
              columnNumber: 9
            },
            this
          )
        ]
      },
      void 0,
      true,
      {
        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
        lineNumber: 774,
        columnNumber: 7
      },
      this
    );
  }
  const entityEntries = Array.from(
    /* @__PURE__ */ new Set(
      [
        ...plannedEntities,
        ...Object.keys(entityStats),
        ...Object.keys(entityStatus)
      ]
    )
  ).map((entity) => [entity, entityStats[entity] || 0]).sort(([, a], [, b]) => b - a);
  return /* @__PURE__ */ jsxDEV(
    Box,
    {
      sx: {
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "auto"
      },
      children: [
        /* @__PURE__ */ jsxDEV(
          Box,
          {
            sx: {
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 2,
              py: 1,
              borderBottom: 1,
              borderColor: "divider"
            },
            children: [
              /* @__PURE__ */ jsxDEV(
                Button,
                {
                  size: "small",
                  variant: "contained",
                  startIcon: /* @__PURE__ */ jsxDEV(SyncIcon, {}, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 1941,
                    columnNumber: 22
                  }, this),
                  onClick: handleBackfill,
                  disabled: isTriggering || status === "running",
                  children: status === "running" ? "Backfill running..." : "Run Backfill"
                },
                void 0,
                false,
                {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 1938,
                  columnNumber: 9
                },
                this
              ),
              status === "running" && /* @__PURE__ */ jsxDEV(
                Button,
                {
                  size: "small",
                  color: "error",
                  startIcon: /* @__PURE__ */ jsxDEV(CancelIcon, {}, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 1951,
                    columnNumber: 22
                  }, this),
                  onClick: handleCancel,
                  children: "Cancel"
                },
                void 0,
                false,
                {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 1948,
                  columnNumber: 9
                },
                this
              ),
              /* @__PURE__ */ jsxDEV(Box, { sx: { flex: 1 } }, void 0, false, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 1957,
                columnNumber: 9
              }, this),
              startedAt && status === "running" && /* @__PURE__ */ jsxDEV(Typography, { variant: "caption", color: "text.secondary", children: [
                "Started ",
                new Date(startedAt).toLocaleTimeString(),
                lastHeartbeat ? ` · last update ${new Date(lastHeartbeat).toLocaleTimeString()}` : ""
              ] }, void 0, true, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 1959,
                columnNumber: 9
              }, this)
            ]
          },
          void 0,
          true,
          {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 1927,
            columnNumber: 7
          },
          this
        ),
        /* @__PURE__ */ jsxDEV(Box, { sx: { flex: 1, overflow: "auto", p: 2 }, children: [
          status === "running" && /* @__PURE__ */ jsxDEV(Box, { sx: { mb: 2 }, children: /* @__PURE__ */ jsxDEV(LinearProgress, { sx: { mb: 1 } }, void 0, false, {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 1972,
            columnNumber: 13
          }, this) }, void 0, false, {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 1971,
            columnNumber: 9
          }, this),
          status === "completed" && !error && /* @__PURE__ */ jsxDEV(
            Alert,
            {
              severity: "success",
              sx: { mb: 2 },
              onClose: () => setStatus(null),
              children: [
                "Backfill completed",
                lastRun?.duration != null && ` in ${Math.round(lastRun.duration / 1e3)}s`
              ]
            },
            void 0,
            true,
            {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 1977,
              columnNumber: 9
            },
            this
          ),
          status === "failed" && error && /* @__PURE__ */ jsxDEV(
            Alert,
            {
              severity: "error",
              sx: { mb: 2 },
              onClose: () => {
                setStatus(null);
                setError(null);
              },
              children: [
                "Backfill failed: ",
                error
              ]
            },
            void 0,
            true,
            {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 1989,
              columnNumber: 9
            },
            this
          ),
          status === "cancelled" && /* @__PURE__ */ jsxDEV(Alert, { severity: "info", sx: { mb: 2 }, onClose: () => setStatus(null), children: "Backfill cancelled" }, void 0, false, {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 2002,
            columnNumber: 9
          }, this),
          status === "running" && recentLogs.length > 0 && /* @__PURE__ */ jsxDEV(Box, { sx: { mb: 3 }, children: [
            /* @__PURE__ */ jsxDEV(Typography, { variant: "subtitle2", sx: { mb: 1 }, children: "Live Activity" }, void 0, false, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2009,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV(
              Box,
              {
                sx: {
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 1,
                  bgcolor: "background.paper",
                  maxHeight: 96,
                  // ~4 lines of caption text
                  overflowY: "auto"
                },
                children: recentLogs.map(
                  (log, idx) => /* @__PURE__ */ jsxDEV(
                    Typography,
                    {
                      variant: "caption",
                      sx: {
                        display: "block",
                        fontFamily: "monospace",
                        whiteSpace: "pre-wrap",
                        color: log.level === "error" ? "error.main" : "text.secondary"
                      },
                      children: [
                        "[",
                        new Date(log.timestamp).toLocaleTimeString(),
                        "]",
                        " ",
                        formatExecutionLog(log)
                      ]
                    },
                    `${log.timestamp}-${idx}`,
                    true,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2024,
                      columnNumber: 13
                    },
                    this
                  )
                )
              },
              void 0,
              false,
              {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2012,
                columnNumber: 13
              },
              this
            )
          ] }, void 0, true, {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 2008,
            columnNumber: 9
          }, this),
          (status === "running" || (status === "completed" || status === "failed") && entityEntries.length > 0) && /* @__PURE__ */ jsxDEV(Box, { sx: { mb: 3 }, children: [
            /* @__PURE__ */ jsxDEV(Typography, { variant: "subtitle2", sx: { mb: 1 }, children: "Entity Progress" }, void 0, false, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2048,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV(TableContainer, { children: /* @__PURE__ */ jsxDEV(Table, { size: "small", children: [
              /* @__PURE__ */ jsxDEV(TableHead, { children: /* @__PURE__ */ jsxDEV(TableRow, { children: [
                /* @__PURE__ */ jsxDEV(TableCell, { children: "Entity" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2055,
                  columnNumber: 21
                }, this),
                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Records" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2056,
                  columnNumber: 21
                }, this),
                /* @__PURE__ */ jsxDEV(TableCell, { align: "center", children: "Status" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2057,
                  columnNumber: 21
                }, this)
              ] }, void 0, true, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2054,
                columnNumber: 19
              }, this) }, void 0, false, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2053,
                columnNumber: 17
              }, this),
              /* @__PURE__ */ jsxDEV(TableBody, { children: [
                entityEntries.map(
                  ([entity, count]) => /* @__PURE__ */ jsxDEV(TableRow, { children: [
                    /* @__PURE__ */ jsxDEV(TableCell, { children: /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", children: formatEntityAsTableName(entity) }, void 0, false, {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2064,
                      columnNumber: 25
                    }, this) }, void 0, false, {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2063,
                      columnNumber: 23
                    }, this),
                    /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", fontWeight: "bold", children: count.toLocaleString() }, void 0, false, {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2069,
                      columnNumber: 25
                    }, this) }, void 0, false, {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2068,
                      columnNumber: 23
                    }, this),
                    /* @__PURE__ */ jsxDEV(TableCell, { align: "center", children: status === "running" && entityStatus[entity] === "completed" ? /* @__PURE__ */ jsxDEV(
                      Chip,
                      {
                        icon: /* @__PURE__ */ jsxDEV(CheckIcon, {}, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 2077,
                          columnNumber: 29
                        }, this),
                        label: "done",
                        size: "small",
                        color: "success",
                        variant: "outlined"
                      },
                      void 0,
                      false,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2076,
                        columnNumber: 21
                      },
                      this
                    ) : status === "running" ? /* @__PURE__ */ jsxDEV(
                      Chip,
                      {
                        icon: /* @__PURE__ */ jsxDEV(PendingIcon, {}, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 2085,
                          columnNumber: 29
                        }, this),
                        label: entityStatus[entity] === "pending" ? "pending" : entityStatus[entity] === "failed" ? "failed" : "processing",
                        size: "small",
                        color: entityStatus[entity] === "failed" ? "error" : entityStatus[entity] === "pending" ? "default" : "info",
                        variant: "outlined"
                      },
                      void 0,
                      false,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2084,
                        columnNumber: 21
                      },
                      this
                    ) : entityStatus[entity] === "failed" ? /* @__PURE__ */ jsxDEV(
                      Chip,
                      {
                        icon: /* @__PURE__ */ jsxDEV(ErrorIcon, {}, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 2105,
                          columnNumber: 29
                        }, this),
                        label: "failed",
                        size: "small",
                        color: "error",
                        variant: "outlined"
                      },
                      void 0,
                      false,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2104,
                        columnNumber: 21
                      },
                      this
                    ) : entityStatus[entity] === "pending" ? /* @__PURE__ */ jsxDEV(
                      Chip,
                      {
                        icon: /* @__PURE__ */ jsxDEV(PendingIcon, {}, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 2113,
                          columnNumber: 29
                        }, this),
                        label: "pending",
                        size: "small",
                        color: "default",
                        variant: "outlined"
                      },
                      void 0,
                      false,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2112,
                        columnNumber: 21
                      },
                      this
                    ) : /* @__PURE__ */ jsxDEV(
                      Chip,
                      {
                        icon: /* @__PURE__ */ jsxDEV(CheckIcon, {}, void 0, false, {
                          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                          lineNumber: 2121,
                          columnNumber: 29
                        }, this),
                        label: "done",
                        size: "small",
                        color: "success",
                        variant: "outlined"
                      },
                      void 0,
                      false,
                      {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2120,
                        columnNumber: 21
                      },
                      this
                    ) }, void 0, false, {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2073,
                      columnNumber: 23
                    }, this)
                  ] }, entity, true, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2062,
                    columnNumber: 17
                  }, this)
                ),
                status === "running" && entityEntries.length === 0 && /* @__PURE__ */ jsxDEV(TableRow, { children: /* @__PURE__ */ jsxDEV(TableCell, { colSpan: 3, align: "center", children: /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", color: "text.secondary", children: "Waiting for first entity to start syncing..." }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2134,
                  columnNumber: 25
                }, this) }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2133,
                  columnNumber: 23
                }, this) }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2132,
                  columnNumber: 17
                }, this)
              ] }, void 0, true, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2060,
                columnNumber: 17
              }, this)
            ] }, void 0, true, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2052,
              columnNumber: 15
            }, this) }, void 0, false, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2051,
              columnNumber: 13
            }, this)
          ] }, void 0, true, {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 2047,
            columnNumber: 9
          }, this),
          history.length > 0 && /* @__PURE__ */ jsxDEV(Box, { children: [
            /* @__PURE__ */ jsxDEV(Typography, { variant: "subtitle2", sx: { mb: 1 }, children: "Run History" }, void 0, false, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2149,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV(TableContainer, { children: /* @__PURE__ */ jsxDEV(Table, { size: "small", children: [
              /* @__PURE__ */ jsxDEV(TableHead, { children: /* @__PURE__ */ jsxDEV(TableRow, { children: [
                /* @__PURE__ */ jsxDEV(TableCell, { children: "Date" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2156,
                  columnNumber: 21
                }, this),
                /* @__PURE__ */ jsxDEV(TableCell, { children: "Status" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2157,
                  columnNumber: 21
                }, this),
                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Duration" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2158,
                  columnNumber: 21
                }, this),
                /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: "Records" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2159,
                  columnNumber: 21
                }, this)
              ] }, void 0, true, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2155,
                columnNumber: 19
              }, this) }, void 0, false, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2154,
                columnNumber: 17
              }, this),
              /* @__PURE__ */ jsxDEV(TableBody, { children: history.map(
                (run) => /* @__PURE__ */ jsxDEV(TableRow, { children: [
                  /* @__PURE__ */ jsxDEV(TableCell, { children: /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", children: new Date(
                    run.startedAt || run.executedAt
                  ).toLocaleString() }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2166,
                    columnNumber: 25
                  }, this) }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2165,
                    columnNumber: 23
                  }, this),
                  /* @__PURE__ */ jsxDEV(TableCell, { children: /* @__PURE__ */ jsxDEV(
                    Chip,
                    {
                      icon: run.status === "completed" ? /* @__PURE__ */ jsxDEV(CheckIcon, {}, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2176,
                        columnNumber: 23
                      }, this) : run.status === "running" ? /* @__PURE__ */ jsxDEV(SyncIcon, {}, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2178,
                        columnNumber: 23
                      }, this) : /* @__PURE__ */ jsxDEV(ErrorIcon, {}, void 0, false, {
                        fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                        lineNumber: 2180,
                        columnNumber: 23
                      }, this),
                      label: run.status,
                      size: "small",
                      color: run.status === "completed" ? "success" : run.status === "running" ? "info" : "error",
                      variant: "outlined"
                    },
                    void 0,
                    false,
                    {
                      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                      lineNumber: 2173,
                      columnNumber: 25
                    },
                    this
                  ) }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2172,
                    columnNumber: 23
                  }, this),
                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", children: run.duration ? `${Math.round(run.duration / 1e3)}s` : "—" }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2196,
                    columnNumber: 25
                  }, this) }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2195,
                    columnNumber: 23
                  }, this),
                  /* @__PURE__ */ jsxDEV(TableCell, { align: "right", children: /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", children: run.stats?.recordsProcessed?.toLocaleString() || "—" }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2203,
                    columnNumber: 25
                  }, this) }, void 0, false, {
                    fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                    lineNumber: 2202,
                    columnNumber: 23
                  }, this)
                ] }, run.executionId, true, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2164,
                  columnNumber: 17
                }, this)
              ) }, void 0, false, {
                fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                lineNumber: 2162,
                columnNumber: 17
              }, this)
            ] }, void 0, true, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2153,
              columnNumber: 15
            }, this) }, void 0, false, {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2152,
              columnNumber: 13
            }, this)
          ] }, void 0, true, {
            fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
            lineNumber: 2148,
            columnNumber: 9
          }, this),
          !status && history.length === 0 && /* @__PURE__ */ jsxDEV(
            Box,
            {
              sx: {
                textAlign: "center",
                py: 6,
                color: "text.secondary"
              },
              children: [
                /* @__PURE__ */ jsxDEV(SyncIcon, { sx: { fontSize: 48, mb: 1, opacity: 0.3 } }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2228,
                  columnNumber: 13
                }, this),
                /* @__PURE__ */ jsxDEV(Typography, { variant: "body1", children: "No backfill runs yet" }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2229,
                  columnNumber: 13
                }, this),
                /* @__PURE__ */ jsxDEV(Typography, { variant: "body2", children: 'Click "Run Backfill" to sync historical data from Close to BigQuery' }, void 0, false, {
                  fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
                  lineNumber: 2230,
                  columnNumber: 13
                }, this)
              ]
            },
            void 0,
            true,
            {
              fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
              lineNumber: 2221,
              columnNumber: 9
            },
            this
          )
        ] }, void 0, true, {
          fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
          lineNumber: 1968,
          columnNumber: 7
        }, this)
      ]
    },
    void 0,
    true,
    {
      fileName: "/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx",
      lineNumber: 1918,
      columnNumber: 5
    },
    this
  );
}
_s(BackfillPanel, "HaSKJJqHB9knuYgqgOwFYJ9uIFY=", false, function() {
  return [useFlowStore];
});
_c = BackfillPanel;
var _c;
$RefreshReg$(_c, "BackfillPanel");
if (import.meta.hot && !inWebWorker) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
}
if (import.meta.hot && !inWebWorker) {
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh("/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("/Users/jonaswiesel/mono/app/src/components/BackfillPanel.tsx", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}

//# sourceMappingURL=data:application/json;base64,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QUFBLElBOVRGO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQStUQTtBQUVKO0FBQUN0TixHQS8rRGVKLGVBQWE7QUFBQSxVQW9CdkI1QyxZQUFZO0FBQUE7QUFBQWlVLEtBcEJGclI7QUFBYSxJQUFBcVI7QUFBQUMsYUFBQUQsSUFBQSIsIm5hbWVzIjpbInVzZUVmZmVjdCIsInVzZVN0YXRlIiwidXNlUmVmIiwidXNlQ2FsbGJhY2siLCJCb3giLCJCdXR0b24iLCJUeXBvZ3JhcGh5IiwiQWxlcnQiLCJMaW5lYXJQcm9ncmVzcyIsIkNoaXAiLCJUYWJsZSIsIlRhYmxlQm9keSIsIlRhYmxlQ2VsbCIsIlRhYmxlQ29udGFpbmVyIiwiVGFibGVIZWFkIiwiVGFibGVSb3ciLCJEaWFsb2ciLCJEaWFsb2dUaXRsZSIsIkRpYWxvZ0NvbnRlbnQiLCJEaWFsb2dBY3Rpb25zIiwiVGV4dEZpZWxkIiwiQ2hlY2tib3giLCJGb3JtQ29udHJvbExhYmVsIiwiSWNvbkJ1dHRvbiIsIlRvb2x0aXAiLCJTeW5jIiwiU3luY0ljb24iLCJDYW5jZWwiLCJDYW5jZWxJY29uIiwiQ2hlY2tDaXJjbGUiLCJDaGVja0ljb24iLCJFcnJvciIsIkVycm9ySWNvbiIsIkhvdXJnbGFzc0VtcHR5IiwiUGVuZGluZ0ljb24iLCJFZGl0IiwiRWRpdEljb24iLCJQYXVzZSIsIlBhdXNlSWNvbiIsIlBsYXlBcnJvdyIsIlJlc3VtZUljb24iLCJSZWZyZXNoIiwiUmV0cnlJY29uIiwiUmVzdGFydEFsdCIsIlJlc3luY0ljb24iLCJCdWdSZXBvcnQiLCJEaWFnbm9zdGljc0ljb24iLCJIZWFsaW5nIiwiUmVjb3Zlckljb24iLCJDb250ZW50Q29weSIsIkNvcHlJY29uIiwidXNlRmxvd1N0b3JlIiwiZm9ybWF0RXhlY3V0aW9uTG9nIiwibG9nIiwibWV0YSIsIm1ldGFkYXRhIiwidW5kZWZpbmVkIiwiZW50aXR5IiwibWVzc2FnZSIsIm1ldGhvZCIsInRvVXBwZXJDYXNlIiwiZW5kcG9pbnQiLCJzdGF0dXMiLCJkdXJhdGlvbk1zIiwiTWF0aCIsInJvdW5kIiwiZXJyb3JUZXh0IiwiZXJyb3IiLCJpbmNsdWRlcyIsInRvdGFsUHJvY2Vzc2VkIiwidG9Mb2NhbGVTdHJpbmciLCJmZXRjaGVkQ291bnQiLCJyb3dzV3JpdHRlbiIsInRvRmluaXRlTnVtYmVyIiwidmFsdWUiLCJOdW1iZXIiLCJpc0Zpbml0ZSIsImNhbWVsVG9TbmFrZSIsInJlcGxhY2UiLCJ0b0xvd2VyQ2FzZSIsImZvcm1hdEVudGl0eUFzVGFibGVOYW1lIiwicGFyZW50Iiwic3ViRW50aXR5Iiwic3BsaXQiLCJkZXJpdmVQcm9ncmVzc0Zyb21Mb2dzIiwibG9ncyIsImVudGl0eVN0YXRzIiwiZW50aXR5U3RhdHVzIiwidGFibGUiLCJjYW5kaWRhdGVzIiwicm93c1Byb2Nlc3NlZCIsInJlY29yZENvdW50IiwiZmlsdGVyIiwibGVuZ3RoIiwibWF4IiwiQmFja2ZpbGxQYW5lbCIsIndvcmtzcGFjZUlkIiwiZmxvd0lkIiwib25FZGl0IiwiX3MiLCJmbG93cyIsImZsb3dzTWFwIiwiYmFja2ZpbGxGbG93Iiwic3RhcnRDZGNCYWNrZmlsbCIsImZldGNoRmxvd1N0YXR1cyIsImZldGNoRmxvd0hpc3RvcnkiLCJmZXRjaEV4ZWN1dGlvbkRldGFpbHMiLCJjYW5jZWxGbG93RXhlY3V0aW9uIiwiZmV0Y2hDZGNTdW1tYXJ5IiwiZmV0Y2hDZGNEaWFnbm9zdGljcyIsInBhdXNlQ2RjRmxvdyIsInJlc3VtZUNkY0Zsb3ciLCJyZXN5bmNDZGNGbG93IiwicmVjb3ZlckNkY0Zsb3ciLCJyZXRyeUZhaWxlZENkY01hdGVyaWFsaXphdGlvbiIsImlzVHJpZ2dlcmluZyIsInNldElzVHJpZ2dlcmluZyIsInNldFN0YXR1cyIsImV4ZWN1dGlvbklkIiwic2V0RXhlY3V0aW9uSWQiLCJzZXRFbnRpdHlTdGF0cyIsInNldEVudGl0eVN0YXR1cyIsInBsYW5uZWRFbnRpdGllcyIsInNldFBsYW5uZWRFbnRpdGllcyIsInN0YXJ0ZWRBdCIsInNldFN0YXJ0ZWRBdCIsImxhc3RSdW4iLCJzZXRMYXN0UnVuIiwiaGlzdG9yeSIsInNldEhpc3RvcnkiLCJzZXRFcnJvciIsImxhc3RIZWFydGJlYXQiLCJzZXRMYXN0SGVhcnRiZWF0IiwicmVjZW50TG9ncyIsInNldFJlY2VudExvZ3MiLCJ3YXNDYW5jZWxsZWQiLCJzZXRXYXNDYW5jZWxsZWQiLCJjZGNTdW1tYXJ5Iiwic2V0Q2RjU3VtbWFyeSIsImNkY0RpYWdub3N0aWNzIiwic2V0Q2RjRGlhZ25vc3RpY3MiLCJzaG93RGlhZ25vc3RpY3MiLCJzZXRTaG93RGlhZ25vc3RpY3MiLCJyZXN5bmNEaWFsb2dPcGVuIiwic2V0UmVzeW5jRGlhbG9nT3BlbiIsImRlbGV0ZURlc3RpbmF0aW9uIiwic2V0RGVsZXRlRGVzdGluYXRpb24iLCJjbGVhcldlYmhvb2tFdmVudHMiLCJzZXRDbGVhcldlYmhvb2tFdmVudHMiLCJyZXN5bmNDb25maXJtVGV4dCIsInNldFJlc3luY0NvbmZpcm1UZXh0IiwiaXNSZXN5bmNpbmciLCJzZXRJc1Jlc3luY2luZyIsIndlYmhvb2tDb3BpZWQiLCJzZXRXZWJob29rQ29waWVkIiwicGFuZWxXaWR0aCIsInNldFBhbmVsV2lkdGgiLCJwYW5lbENvbnRhaW5lclJlZiIsInBvbGxSZWYiLCJjZGNQb2xsUmVmIiwia3BpQ29sdW1uQ291bnQiLCJjdXJyZW50RmxvdyIsImZpbmQiLCJmIiwiX2lkIiwiaXNDZGNGbG93Iiwic3luY0VuZ2luZSIsInN0b3BQb2xsaW5nIiwiY3VycmVudCIsImNsZWFySW50ZXJ2YWwiLCJzdG9wQ2RjUG9sbGluZyIsImVsZW1lbnQiLCJ1cGRhdGVQYW5lbFdpZHRoIiwid2lkdGgiLCJuZXh0IiwicHJldiIsImdldEJvdW5kaW5nQ2xpZW50UmVjdCIsIlJlc2l6ZU9ic2VydmVyIiwib25SZXNpemUiLCJ3aW5kb3ciLCJhZGRFdmVudExpc3RlbmVyIiwicmVtb3ZlRXZlbnRMaXN0ZW5lciIsIm9ic2VydmVyIiwiZW50cmllcyIsImVudHJ5IiwiY29udGVudFJlY3QiLCJvYnNlcnZlIiwiZGlzY29ubmVjdCIsInBvbGxDZGNPdmVydmlldyIsInN1bW1hcnkiLCJkaWFnbm9zdGljcyIsImxvYWRIaXN0b3J5IiwicnVucyIsInBvbGxFeGVjdXRpb24iLCJkZXRhaWxzIiwic2xpY2UiLCJyZXZlcnNlIiwic3RhdHNGcm9tQXBpIiwic3RhdHMiLCJjb250ZXh0RnJvbUFwaSIsImNvbnRleHQiLCJBcnJheSIsImlzQXJyYXkiLCJlbnRpdHlGaWx0ZXIiLCJkZXJpdmVkIiwibWVyZ2VkRW50aXR5U3RhdHMiLCJPYmplY3QiLCJrZXlzIiwibWVyZ2VkRW50aXR5U3RhdHVzIiwic3RhcnRQb2xsaW5nIiwic2V0SW50ZXJ2YWwiLCJpbml0Iiwic3RhdHVzUmVzcCIsImlzUnVubmluZyIsInJ1bm5pbmdFeGVjdXRpb24iLCJoYW5kbGVCYWNrZmlsbCIsIm9rIiwiZGV0ZWN0RXhlY3V0aW9uIiwiYXR0ZW1wdHMiLCJQcm9taXNlIiwiciIsInNldFRpbWVvdXQiLCJjb25maXJtIiwiZXJyIiwiaGFuZGxlQ2FuY2VsIiwiaGFuZGxlQ2RjUGF1c2VSZXN1bWUiLCJjdXJyZW50U3RhdGUiLCJzeW5jU3RhdGUiLCJzdWNjZXNzIiwiaGFuZGxlQ2RjUmVzeW5jIiwiaGFuZGxlQ2RjUmVjb3ZlciIsInJldHJ5RmFpbGVkTWF0ZXJpYWxpemF0aW9uIiwicmVzdW1lQmFja2ZpbGwiLCJoYW5kbGVSZXRyeUZhaWxlZE1hdGVyaWFsaXphdGlvbiIsImZvcm1hdExhZ0R1cmF0aW9uIiwibGFnU2Vjb25kcyIsIm1pbnV0ZXMiLCJmbG9vciIsInNlY29uZHMiLCJob3VycyIsInN0YXRlQ29sb3IiLCJzdGF0ZSIsImZyZXNobmVzc1N1bW1hcnkiLCJ3ZWJob29rTGFnU2Vjb25kcyIsImxhc3RXZWJob29rQXQiLCJsYXN0V2ViaG9va1RzIiwiRGF0ZSIsImdldFRpbWUiLCJub3ciLCJmYWlsZWRDb3VudCIsImJhY2tsb2dDb3VudCIsImVudGl0eUJhY2tmaWxsU3RhdHVzIiwibGFzdE1hdGVyaWFsaXplZEF0IiwiZHJvcHBlZENvdW50IiwiZW50aXR5T2JqZWN0U3RhdHVzIiwibGFiZWwiLCJjb2xvciIsImVudGl0eUxhZ0xhYmVsIiwiY29ubmVjdG9yTmFtZSIsImRhdGFTb3VyY2VJZCIsIm5hbWUiLCJjb25uZWN0b3JUeXBlIiwidHlwZSIsImRlc3ROYW1lIiwiZGVzdGluYXRpb25EYXRhYmFzZUlkIiwiZGVzdFR5cGUiLCJkYXRhc2V0IiwidGFibGVEZXN0aW5hdGlvbiIsInNjaGVtYSIsIndlYmhvb2tFbmRwb2ludCIsIndlYmhvb2tDb25maWciLCJjb3B5V2ViaG9va1VybCIsIm5hdmlnYXRvciIsImNsaXBib2FyZCIsIndyaXRlVGV4dCIsImFjdCIsImZvbnRTaXplIiwidGV4dFRyYW5zZm9ybSIsImZvbnRXZWlnaHQiLCJtaW5XaWR0aCIsInB4IiwieHMiLCJzbSIsInB5IiwiZ2FwIiwid2hpdGVTcGFjZSIsImJnY29sb3IiLCJtciIsImFjdERhbmdlciIsImJhY2tmaWxsUnVubmluZyIsImlzUGF1c2VkIiwiaXNEZWdyYWRlZCIsImlzSWRsZSIsImhhc0ZhaWxlZCIsImZhaWxlZERyb3BwZWREZXRhaWwiLCJoZWlnaHQiLCJkaXNwbGF5IiwiZmxleERpcmVjdGlvbiIsIm92ZXJmbG93IiwiYWxpZ25JdGVtcyIsImZsZXhXcmFwIiwiYm9yZGVyQm90dG9tIiwiYm9yZGVyQ29sb3IiLCJjb2x1bW5HYXAiLCJyb3dHYXAiLCJtaW5IZWlnaHQiLCJtbCIsIm1kIiwianVzdGlmeUNvbnRlbnQiLCJ2IiwiZ3JpZFRlbXBsYXRlQ29sdW1ucyIsImxpbmVIZWlnaHQiLCJmb250RmFtaWx5Iiwib3BhY2l0eSIsImZsZXgiLCJ0ZXh0T3ZlcmZsb3ciLCJwIiwiY3JlYXRlZEF0IiwidXBkYXRlZEF0IiwiYm9yZGVyUmFkaXVzIiwibGV0dGVyU3BhY2luZyIsIm10IiwiY2hhckF0IiwiYXBwbGllZENvdW50IiwiYm9yZGVyIiwibWIiLCJhbmltYXRpb24iLCJmcm9tIiwidHJhbnNmb3JtIiwidG8iLCJ0b0xvY2FsZVRpbWVTdHJpbmciLCJTZXQiLCJtYXAiLCJzb3J0IiwiYSIsImIiLCJjb3VudCIsIm1heEhlaWdodCIsImlkeCIsImxldmVsIiwidGltZXN0YW1wIiwiZW50aXR5Q291bnRzIiwibWF4V2lkdGgiLCJvdmVyZmxvd1giLCJsZyIsIm9ialN0YXR1cyIsInRyYW5zaXRpb25zIiwidHJhbnNpdGlvbiIsImluZGV4IiwiYXQiLCJmcm9tU3RhdGUiLCJ0b1N0YXRlIiwiZXZlbnQiLCJyZWFzb24iLCJjdXJzb3JzIiwiY3Vyc29yIiwibGFzdEluZ2VzdFNlcSIsImxhc3RNYXRlcmlhbGl6ZWRTZXEiLCJyZWNlbnRFdmVudHMiLCJpbmdlc3RTZXEiLCJvcGVyYXRpb24iLCJtYXRlcmlhbGl6YXRpb25TdGF0dXMiLCJzb3VyY2UiLCJ0YXJnZXQiLCJjaGVja2VkIiwiZW50aXR5RW50cmllcyIsImR1cmF0aW9uIiwib3ZlcmZsb3dZIiwicnVuIiwiZXhlY3V0ZWRBdCIsInJlY29yZHNQcm9jZXNzZWQiLCJ0ZXh0QWxpZ24iLCJfYyIsIiRSZWZyZXNoUmVnJCJdLCJpZ25vcmVMaXN0IjpbXSwic291cmNlcyI6WyJCYWNrZmlsbFBhbmVsLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyB1c2VFZmZlY3QsIHVzZVN0YXRlLCB1c2VSZWYsIHVzZUNhbGxiYWNrIH0gZnJvbSBcInJlYWN0XCI7XG5pbXBvcnQge1xuICBCb3gsXG4gIEJ1dHRvbixcbiAgVHlwb2dyYXBoeSxcbiAgQWxlcnQsXG4gIExpbmVhclByb2dyZXNzLFxuICBDaGlwLFxuICBUYWJsZSxcbiAgVGFibGVCb2R5LFxuICBUYWJsZUNlbGwsXG4gIFRhYmxlQ29udGFpbmVyLFxuICBUYWJsZUhlYWQsXG4gIFRhYmxlUm93LFxuICBEaWFsb2csXG4gIERpYWxvZ1RpdGxlLFxuICBEaWFsb2dDb250ZW50LFxuICBEaWFsb2dBY3Rpb25zLFxuICBUZXh0RmllbGQsXG4gIENoZWNrYm94LFxuICBGb3JtQ29udHJvbExhYmVsLFxuICBJY29uQnV0dG9uLFxuICBUb29sdGlwLFxufSBmcm9tIFwiQG11aS9tYXRlcmlhbFwiO1xuaW1wb3J0IHtcbiAgU3luYyBhcyBTeW5jSWNvbixcbiAgQ2FuY2VsIGFzIENhbmNlbEljb24sXG4gIENoZWNrQ2lyY2xlIGFzIENoZWNrSWNvbixcbiAgRXJyb3IgYXMgRXJyb3JJY29uLFxuICBIb3VyZ2xhc3NFbXB0eSBhcyBQZW5kaW5nSWNvbixcbiAgRWRpdCBhcyBFZGl0SWNvbixcbiAgUGF1c2UgYXMgUGF1c2VJY29uLFxuICBQbGF5QXJyb3cgYXMgUmVzdW1lSWNvbixcbiAgUmVmcmVzaCBhcyBSZXRyeUljb24sXG4gIFJlc3RhcnRBbHQgYXMgUmVzeW5jSWNvbixcbiAgQnVnUmVwb3J0IGFzIERpYWdub3N0aWNzSWNvbixcbiAgSGVhbGluZyBhcyBSZWNvdmVySWNvbixcbiAgQ29udGVudENvcHkgYXMgQ29weUljb24sXG59IGZyb20gXCJAbXVpL2ljb25zLW1hdGVyaWFsXCI7XG5pbXBvcnQgeyB1c2VGbG93U3RvcmUsIHR5cGUgRmxvd0V4ZWN1dGlvbkhpc3RvcnkgfSBmcm9tIFwiLi4vc3RvcmUvZmxvd1N0b3JlXCI7XG5cbmludGVyZmFjZSBCYWNrZmlsbFBhbmVsUHJvcHMge1xuICB3b3Jrc3BhY2VJZDogc3RyaW5nO1xuICBmbG93SWQ6IHN0cmluZztcbiAgb25FZGl0PzogKCkgPT4gdm9pZDtcbn1cblxudHlwZSBFeGVjdXRpb25Mb2cgPSB7XG4gIHRpbWVzdGFtcDogc3RyaW5nO1xuICBsZXZlbDogc3RyaW5nO1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIG1ldGFkYXRhPzogdW5rbm93bjtcbn07XG5cbmZ1bmN0aW9uIGZvcm1hdEV4ZWN1dGlvbkxvZyhsb2c6IEV4ZWN1dGlvbkxvZyk6IHN0cmluZyB7XG4gIGNvbnN0IG1ldGEgPVxuICAgIGxvZy5tZXRhZGF0YSAmJiB0eXBlb2YgbG9nLm1ldGFkYXRhID09PSBcIm9iamVjdFwiXG4gICAgICA/IChsb2cubWV0YWRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3QgZW50aXR5ID0gdHlwZW9mIG1ldGE/LmVudGl0eSA9PT0gXCJzdHJpbmdcIiA/IG1ldGEuZW50aXR5IDogdW5kZWZpbmVkO1xuXG4gIGlmIChsb2cubWVzc2FnZSA9PT0gXCJDbG9zZSBBUEkgcmVxdWVzdCBzZW50XCIpIHtcbiAgICBjb25zdCBtZXRob2QgPVxuICAgICAgdHlwZW9mIG1ldGE/Lm1ldGhvZCA9PT0gXCJzdHJpbmdcIiA/IG1ldGEubWV0aG9kLnRvVXBwZXJDYXNlKCkgOiBcIkdFVFwiO1xuICAgIGNvbnN0IGVuZHBvaW50ID0gdHlwZW9mIG1ldGE/LmVuZHBvaW50ID09PSBcInN0cmluZ1wiID8gbWV0YS5lbmRwb2ludCA6IFwiXCI7XG4gICAgcmV0dXJuIGAtPiBDbG9zZSByZXF1ZXN0ICR7bWV0aG9kfSAke2VuZHBvaW50fSR7ZW50aXR5ID8gYCBbJHtlbnRpdHl9XWAgOiBcIlwifWA7XG4gIH1cblxuICBpZiAobG9nLm1lc3NhZ2UgPT09IFwiQ2xvc2UgQVBJIHJlc3BvbnNlIHJlY2VpdmVkXCIpIHtcbiAgICBjb25zdCBzdGF0dXMgPSB0eXBlb2YgbWV0YT8uc3RhdHVzID09PSBcIm51bWJlclwiID8gbWV0YS5zdGF0dXMgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgZHVyYXRpb25NcyA9XG4gICAgICB0eXBlb2YgbWV0YT8uZHVyYXRpb25NcyA9PT0gXCJudW1iZXJcIlxuICAgICAgICA/IE1hdGgucm91bmQobWV0YS5kdXJhdGlvbk1zKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gYDwtIENsb3NlIHJlc3BvbnNlJHtzdGF0dXMgPyBgICR7c3RhdHVzfWAgOiBcIlwifSR7ZHVyYXRpb25NcyAhPT0gdW5kZWZpbmVkID8gYCBpbiAke2R1cmF0aW9uTXN9bXNgIDogXCJcIn0ke2VudGl0eSA/IGAgWyR7ZW50aXR5fV1gIDogXCJcIn1gO1xuICB9XG5cbiAgaWYgKGxvZy5tZXNzYWdlID09PSBcIkNsb3NlIEFQSSByZXF1ZXN0IGZhaWxlZFwiKSB7XG4gICAgY29uc3Qgc3RhdHVzID0gdHlwZW9mIG1ldGE/LnN0YXR1cyA9PT0gXCJudW1iZXJcIiA/IG1ldGEuc3RhdHVzIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGVycm9yVGV4dCA9XG4gICAgICB0eXBlb2YgbWV0YT8uZXJyb3IgPT09IFwic3RyaW5nXCIgPyBtZXRhLmVycm9yIDogXCJ1bmtub3duIGVycm9yXCI7XG4gICAgcmV0dXJuIGAhISBDbG9zZSByZXF1ZXN0IGZhaWxlZCR7c3RhdHVzID8gYCAoJHtzdGF0dXN9KWAgOiBcIlwifTogJHtlcnJvclRleHR9JHtlbnRpdHkgPyBgIFske2VudGl0eX1dYCA6IFwiXCJ9YDtcbiAgfVxuXG4gIGlmIChsb2cubWVzc2FnZS5pbmNsdWRlcyhcIlNRTCBjaHVuayBkb25lXCIpICYmIGVudGl0eSkge1xuICAgIGNvbnN0IHRvdGFsUHJvY2Vzc2VkID1cbiAgICAgIHR5cGVvZiBtZXRhPy50b3RhbFByb2Nlc3NlZCA9PT0gXCJudW1iZXJcIlxuICAgICAgICA/IG1ldGEudG90YWxQcm9jZXNzZWQudG9Mb2NhbGVTdHJpbmcoKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gYERCIHdyaXRlIGNvbXBsZXRlIGZvciAke2VudGl0eX0ke3RvdGFsUHJvY2Vzc2VkID8gYDogJHt0b3RhbFByb2Nlc3NlZH0gdG90YWwgcm93c2AgOiBcIlwifWA7XG4gIH1cblxuICBpZiAobG9nLm1lc3NhZ2UuaW5jbHVkZXMoXCJzeW5jIGluIHByb2dyZXNzXCIpICYmIGVudGl0eSkge1xuICAgIGNvbnN0IHRvdGFsUHJvY2Vzc2VkID1cbiAgICAgIHR5cGVvZiBtZXRhPy50b3RhbFByb2Nlc3NlZCA9PT0gXCJudW1iZXJcIlxuICAgICAgICA/IG1ldGEudG90YWxQcm9jZXNzZWQudG9Mb2NhbGVTdHJpbmcoKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gYCR7ZW50aXR5fSBzeW5jaW5nJHt0b3RhbFByb2Nlc3NlZCA/IGA6ICR7dG90YWxQcm9jZXNzZWR9IHJvd3NgIDogXCJcIn1gO1xuICB9XG5cbiAgaWYgKGxvZy5tZXNzYWdlID09PSBcIlNRTCBiYXRjaCByZWNlaXZlZCBmcm9tIHNvdXJjZVwiKSB7XG4gICAgY29uc3QgZmV0Y2hlZENvdW50ID1cbiAgICAgIHR5cGVvZiBtZXRhPy5mZXRjaGVkQ291bnQgPT09IFwibnVtYmVyXCIgPyBtZXRhLmZldGNoZWRDb3VudCA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gYC0+IGJhdGNoIGZldGNoZWQke2ZldGNoZWRDb3VudCA/IGAgKCR7ZmV0Y2hlZENvdW50fSByb3dzKWAgOiBcIlwifSR7ZW50aXR5ID8gYCBbJHtlbnRpdHl9XWAgOiBcIlwifWA7XG4gIH1cblxuICBpZiAobG9nLm1lc3NhZ2UgPT09IFwiU1FMIGJhdGNoIHdyaXRlIHN1Y2NlZWRlZFwiKSB7XG4gICAgY29uc3Qgcm93c1dyaXR0ZW4gPVxuICAgICAgdHlwZW9mIG1ldGE/LnJvd3NXcml0dGVuID09PSBcIm51bWJlclwiID8gbWV0YS5yb3dzV3JpdHRlbiA6IHVuZGVmaW5lZDtcbiAgICByZXR1cm4gYDwtIGJhdGNoIHdyaXR0ZW4ke3Jvd3NXcml0dGVuICE9PSB1bmRlZmluZWQgPyBgICgke3Jvd3NXcml0dGVufSByb3dzKWAgOiBcIlwifSR7ZW50aXR5ID8gYCBbJHtlbnRpdHl9XWAgOiBcIlwifWA7XG4gIH1cblxuICBpZiAobG9nLm1lc3NhZ2UgPT09IFwiU1FMIGJhdGNoIHdyaXRlIGZhaWxlZFwiKSB7XG4gICAgY29uc3QgZXJyb3JUZXh0ID1cbiAgICAgIHR5cGVvZiBtZXRhPy5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IG1ldGEuZXJyb3IgOiBcInVua25vd24gZXJyb3JcIjtcbiAgICByZXR1cm4gYCEhIGJhdGNoIHdyaXRlIGZhaWxlZDogJHtlcnJvclRleHR9JHtlbnRpdHkgPyBgIFske2VudGl0eX1dYCA6IFwiXCJ9YDtcbiAgfVxuXG4gIHJldHVybiBsb2cubWVzc2FnZTtcbn1cblxuZnVuY3Rpb24gdG9GaW5pdGVOdW1iZXIodmFsdWU6IHVua25vd24pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuZnVuY3Rpb24gY2FtZWxUb1NuYWtlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUucmVwbGFjZSgvKFthLXowLTldKShbQS1aXSkvZywgXCIkMV8kMlwiKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRFbnRpdHlBc1RhYmxlTmFtZShlbnRpdHk6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghZW50aXR5LmluY2x1ZGVzKFwiOlwiKSkgcmV0dXJuIGVudGl0eTtcbiAgY29uc3QgW3BhcmVudCwgc3ViRW50aXR5XSA9IGVudGl0eS5zcGxpdChcIjpcIik7XG4gIGlmICghcGFyZW50IHx8ICFzdWJFbnRpdHkpIHJldHVybiBlbnRpdHk7XG4gIHJldHVybiBgJHtjYW1lbFRvU25ha2Uoc3ViRW50aXR5KX1fJHtwYXJlbnR9YDtcbn1cblxuZnVuY3Rpb24gZGVyaXZlUHJvZ3Jlc3NGcm9tTG9ncyhsb2dzOiBFeGVjdXRpb25Mb2dbXSk6IHtcbiAgZW50aXR5U3RhdHM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj47XG4gIGVudGl0eVN0YXR1czogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn0ge1xuICBjb25zdCBlbnRpdHlTdGF0czogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICBjb25zdCBlbnRpdHlTdGF0dXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblxuICBmb3IgKGNvbnN0IGxvZyBvZiBsb2dzKSB7XG4gICAgaWYgKCFsb2cubWV0YWRhdGEgfHwgdHlwZW9mIGxvZy5tZXRhZGF0YSAhPT0gXCJvYmplY3RcIikge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgbWV0YWRhdGEgPSBsb2cubWV0YWRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29uc3QgZW50aXR5ID1cbiAgICAgICh0eXBlb2YgbWV0YWRhdGEuZW50aXR5ID09PSBcInN0cmluZ1wiICYmIG1ldGFkYXRhLmVudGl0eSkgfHxcbiAgICAgICh0eXBlb2YgbWV0YWRhdGEudGFibGUgPT09IFwic3RyaW5nXCIgJiYgbWV0YWRhdGEudGFibGUpIHx8XG4gICAgICB1bmRlZmluZWQ7XG5cbiAgICBpZiAoIWVudGl0eSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgICAgIHRvRmluaXRlTnVtYmVyKG1ldGFkYXRhLnRvdGFsUHJvY2Vzc2VkKSxcbiAgICAgIHRvRmluaXRlTnVtYmVyKG1ldGFkYXRhLnJvd3NXcml0dGVuKSxcbiAgICAgIHRvRmluaXRlTnVtYmVyKG1ldGFkYXRhLnJvd3NQcm9jZXNzZWQpLFxuICAgICAgdG9GaW5pdGVOdW1iZXIobWV0YWRhdGEucmVjb3JkQ291bnQpLFxuICAgIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIG51bWJlciA9PiB2YWx1ZSAhPT0gbnVsbCk7XG5cbiAgICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICBlbnRpdHlTdGF0c1tlbnRpdHldID0gTWF0aC5tYXgoZW50aXR5U3RhdHNbZW50aXR5XSB8fCAwLCAuLi5jYW5kaWRhdGVzKTtcbiAgICB9XG5cbiAgICBpZiAoXG4gICAgICBsb2cubWVzc2FnZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwic3luYyBjb21wbGV0ZWRcIikgfHxcbiAgICAgIGxvZy5tZXNzYWdlLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoXCJjaHVuayBjb21wbGV0ZWRcIilcbiAgICApIHtcbiAgICAgIGVudGl0eVN0YXR1c1tlbnRpdHldID0gXCJjb21wbGV0ZWRcIjtcbiAgICB9IGVsc2UgaWYgKCFlbnRpdHlTdGF0dXNbZW50aXR5XSkge1xuICAgICAgZW50aXR5U3RhdHVzW2VudGl0eV0gPSBcInN5bmNpbmdcIjtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGVudGl0eVN0YXRzLFxuICAgIGVudGl0eVN0YXR1cyxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIEJhY2tmaWxsUGFuZWwoe1xuICB3b3Jrc3BhY2VJZCxcbiAgZmxvd0lkLFxuICBvbkVkaXQsXG59OiBCYWNrZmlsbFBhbmVsUHJvcHMpIHtcbiAgY29uc3Qge1xuICAgIGZsb3dzOiBmbG93c01hcCxcbiAgICBiYWNrZmlsbEZsb3csXG4gICAgc3RhcnRDZGNCYWNrZmlsbCxcbiAgICBmZXRjaEZsb3dTdGF0dXMsXG4gICAgZmV0Y2hGbG93SGlzdG9yeSxcbiAgICBmZXRjaEV4ZWN1dGlvbkRldGFpbHMsXG4gICAgY2FuY2VsRmxvd0V4ZWN1dGlvbixcbiAgICBmZXRjaENkY1N1bW1hcnksXG4gICAgZmV0Y2hDZGNEaWFnbm9zdGljcyxcbiAgICBwYXVzZUNkY0Zsb3csXG4gICAgcmVzdW1lQ2RjRmxvdyxcbiAgICByZXN5bmNDZGNGbG93LFxuICAgIHJlY292ZXJDZGNGbG93LFxuICAgIHJldHJ5RmFpbGVkQ2RjTWF0ZXJpYWxpemF0aW9uLFxuICB9ID0gdXNlRmxvd1N0b3JlKCk7XG5cbiAgY29uc3QgW2lzVHJpZ2dlcmluZywgc2V0SXNUcmlnZ2VyaW5nXSA9IHVzZVN0YXRlKGZhbHNlKTtcbiAgY29uc3QgW3N0YXR1cywgc2V0U3RhdHVzXSA9IHVzZVN0YXRlPFxuICAgIG51bGwgfCBcInJ1bm5pbmdcIiB8IFwiY29tcGxldGVkXCIgfCBcImZhaWxlZFwiIHwgXCJjYW5jZWxsZWRcIlxuICA+KG51bGwpO1xuICBjb25zdCBbZXhlY3V0aW9uSWQsIHNldEV4ZWN1dGlvbklkXSA9IHVzZVN0YXRlPHN0cmluZyB8IG51bGw+KG51bGwpO1xuICBjb25zdCBbZW50aXR5U3RhdHMsIHNldEVudGl0eVN0YXRzXSA9IHVzZVN0YXRlPFJlY29yZDxzdHJpbmcsIG51bWJlcj4+KHt9KTtcbiAgY29uc3QgW2VudGl0eVN0YXR1cywgc2V0RW50aXR5U3RhdHVzXSA9IHVzZVN0YXRlPFJlY29yZDxzdHJpbmcsIHN0cmluZz4+KHt9KTtcbiAgY29uc3QgW3BsYW5uZWRFbnRpdGllcywgc2V0UGxhbm5lZEVudGl0aWVzXSA9IHVzZVN0YXRlPHN0cmluZ1tdPihbXSk7XG4gIGNvbnN0IFtzdGFydGVkQXQsIHNldFN0YXJ0ZWRBdF0gPSB1c2VTdGF0ZTxzdHJpbmcgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW2xhc3RSdW4sIHNldExhc3RSdW5dID0gdXNlU3RhdGU8Rmxvd0V4ZWN1dGlvbkhpc3RvcnkgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW2hpc3RvcnksIHNldEhpc3RvcnldID0gdXNlU3RhdGU8Rmxvd0V4ZWN1dGlvbkhpc3RvcnlbXT4oW10pO1xuICBjb25zdCBbZXJyb3IsIHNldEVycm9yXSA9IHVzZVN0YXRlPHN0cmluZyB8IG51bGw+KG51bGwpO1xuICBjb25zdCBbbGFzdEhlYXJ0YmVhdCwgc2V0TGFzdEhlYXJ0YmVhdF0gPSB1c2VTdGF0ZTxzdHJpbmcgfCBudWxsPihudWxsKTtcbiAgY29uc3QgW3JlY2VudExvZ3MsIHNldFJlY2VudExvZ3NdID0gdXNlU3RhdGU8RXhlY3V0aW9uTG9nW10+KFtdKTtcbiAgY29uc3QgW3dhc0NhbmNlbGxlZCwgc2V0V2FzQ2FuY2VsbGVkXSA9IHVzZVN0YXRlKGZhbHNlKTtcbiAgY29uc3QgW2NkY1N1bW1hcnksIHNldENkY1N1bW1hcnldID0gdXNlU3RhdGU8YW55IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IFtjZGNEaWFnbm9zdGljcywgc2V0Q2RjRGlhZ25vc3RpY3NdID0gdXNlU3RhdGU8YW55IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IFtzaG93RGlhZ25vc3RpY3MsIHNldFNob3dEaWFnbm9zdGljc10gPSB1c2VTdGF0ZShmYWxzZSk7XG4gIGNvbnN0IFtyZXN5bmNEaWFsb2dPcGVuLCBzZXRSZXN5bmNEaWFsb2dPcGVuXSA9IHVzZVN0YXRlKGZhbHNlKTtcbiAgY29uc3QgW2RlbGV0ZURlc3RpbmF0aW9uLCBzZXREZWxldGVEZXN0aW5hdGlvbl0gPSB1c2VTdGF0ZShmYWxzZSk7XG4gIGNvbnN0IFtjbGVhcldlYmhvb2tFdmVudHMsIHNldENsZWFyV2ViaG9va0V2ZW50c10gPSB1c2VTdGF0ZShmYWxzZSk7XG4gIGNvbnN0IFtyZXN5bmNDb25maXJtVGV4dCwgc2V0UmVzeW5jQ29uZmlybVRleHRdID0gdXNlU3RhdGUoXCJcIik7XG4gIGNvbnN0IFtpc1Jlc3luY2luZywgc2V0SXNSZXN5bmNpbmddID0gdXNlU3RhdGUoZmFsc2UpO1xuICBjb25zdCBbd2ViaG9va0NvcGllZCwgc2V0V2ViaG9va0NvcGllZF0gPSB1c2VTdGF0ZShmYWxzZSk7XG4gIGNvbnN0IFtwYW5lbFdpZHRoLCBzZXRQYW5lbFdpZHRoXSA9IHVzZVN0YXRlKDApO1xuICBjb25zdCBwYW5lbENvbnRhaW5lclJlZiA9IHVzZVJlZjxIVE1MRGl2RWxlbWVudCB8IG51bGw+KG51bGwpO1xuICBjb25zdCBwb2xsUmVmID0gdXNlUmVmPFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGw+KG51bGwpO1xuICBjb25zdCBjZGNQb2xsUmVmID0gdXNlUmVmPFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGw+KG51bGwpO1xuXG4gIGNvbnN0IGtwaUNvbHVtbkNvdW50ID0gcGFuZWxXaWR0aCA+PSA5ODAgPyA0IDogMjtcblxuICBjb25zdCBjdXJyZW50RmxvdyA9IChmbG93c01hcFt3b3Jrc3BhY2VJZF0gfHwgW10pLmZpbmQoZiA9PiBmLl9pZCA9PT0gZmxvd0lkKTtcbiAgY29uc3QgaXNDZGNGbG93ID0gY3VycmVudEZsb3c/LnN5bmNFbmdpbmUgPT09IFwiY2RjXCI7XG5cbiAgY29uc3Qgc3RvcFBvbGxpbmcgPSB1c2VDYWxsYmFjaygoKSA9PiB7XG4gICAgaWYgKHBvbGxSZWYuY3VycmVudCkge1xuICAgICAgY2xlYXJJbnRlcnZhbChwb2xsUmVmLmN1cnJlbnQpO1xuICAgICAgcG9sbFJlZi5jdXJyZW50ID0gbnVsbDtcbiAgICB9XG4gIH0sIFtdKTtcblxuICBjb25zdCBzdG9wQ2RjUG9sbGluZyA9IHVzZUNhbGxiYWNrKCgpID0+IHtcbiAgICBpZiAoY2RjUG9sbFJlZi5jdXJyZW50KSB7XG4gICAgICBjbGVhckludGVydmFsKGNkY1BvbGxSZWYuY3VycmVudCk7XG4gICAgICBjZGNQb2xsUmVmLmN1cnJlbnQgPSBudWxsO1xuICAgIH1cbiAgfSwgW10pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKCFpc0NkY0Zsb3cpIHJldHVybjtcblxuICAgIGNvbnN0IGVsZW1lbnQgPSBwYW5lbENvbnRhaW5lclJlZi5jdXJyZW50O1xuICAgIGlmICghZWxlbWVudCkgcmV0dXJuO1xuXG4gICAgY29uc3QgdXBkYXRlUGFuZWxXaWR0aCA9ICh3aWR0aDogbnVtYmVyKSA9PiB7XG4gICAgICBjb25zdCBuZXh0ID0gTWF0aC5yb3VuZCh3aWR0aCk7XG4gICAgICBzZXRQYW5lbFdpZHRoKHByZXYgPT4gKHByZXYgPT09IG5leHQgPyBwcmV2IDogbmV4dCkpO1xuICAgIH07XG5cbiAgICB1cGRhdGVQYW5lbFdpZHRoKGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkud2lkdGgpO1xuXG4gICAgaWYgKHR5cGVvZiBSZXNpemVPYnNlcnZlciA9PT0gXCJ1bmRlZmluZWRcIikge1xuICAgICAgY29uc3Qgb25SZXNpemUgPSAoKSA9PlxuICAgICAgICB1cGRhdGVQYW5lbFdpZHRoKGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkud2lkdGgpO1xuICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgb25SZXNpemUpO1xuICAgICAgcmV0dXJuICgpID0+IHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicmVzaXplXCIsIG9uUmVzaXplKTtcbiAgICB9XG5cbiAgICBjb25zdCBvYnNlcnZlciA9IG5ldyBSZXNpemVPYnNlcnZlcihlbnRyaWVzID0+IHtcbiAgICAgIGNvbnN0IGVudHJ5ID0gZW50cmllc1swXTtcbiAgICAgIGlmICghZW50cnkpIHJldHVybjtcbiAgICAgIHVwZGF0ZVBhbmVsV2lkdGgoZW50cnkuY29udGVudFJlY3Qud2lkdGgpO1xuICAgIH0pO1xuICAgIG9ic2VydmVyLm9ic2VydmUoZWxlbWVudCk7XG5cbiAgICByZXR1cm4gKCkgPT4gb2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICB9LCBbaXNDZGNGbG93XSk7XG5cbiAgY29uc3QgcG9sbENkY092ZXJ2aWV3ID0gdXNlQ2FsbGJhY2soYXN5bmMgKCkgPT4ge1xuICAgIGlmICghaXNDZGNGbG93KSByZXR1cm47XG4gICAgY29uc3Qgc3VtbWFyeSA9IGF3YWl0IGZldGNoQ2RjU3VtbWFyeSh3b3Jrc3BhY2VJZCwgZmxvd0lkKTtcbiAgICBpZiAoc3VtbWFyeSkge1xuICAgICAgc2V0Q2RjU3VtbWFyeShzdW1tYXJ5KTtcbiAgICB9XG4gICAgaWYgKHNob3dEaWFnbm9zdGljcykge1xuICAgICAgY29uc3QgZGlhZ25vc3RpY3MgPSBhd2FpdCBmZXRjaENkY0RpYWdub3N0aWNzKHdvcmtzcGFjZUlkLCBmbG93SWQpO1xuICAgICAgaWYgKGRpYWdub3N0aWNzKSB7XG4gICAgICAgIHNldENkY0RpYWdub3N0aWNzKGRpYWdub3N0aWNzKTtcbiAgICAgIH1cbiAgICB9XG4gIH0sIFtcbiAgICBpc0NkY0Zsb3csXG4gICAgZmV0Y2hDZGNTdW1tYXJ5LFxuICAgIGZldGNoQ2RjRGlhZ25vc3RpY3MsXG4gICAgd29ya3NwYWNlSWQsXG4gICAgZmxvd0lkLFxuICAgIHNob3dEaWFnbm9zdGljcyxcbiAgXSk7XG5cbiAgY29uc3QgbG9hZEhpc3RvcnkgPSB1c2VDYWxsYmFjayhhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcnVucyA9IGF3YWl0IGZldGNoRmxvd0hpc3Rvcnkod29ya3NwYWNlSWQsIGZsb3dJZCwgMTApO1xuICAgIGlmIChydW5zKSBzZXRIaXN0b3J5KHJ1bnMpO1xuICAgIGlmIChydW5zPy5bMF0pIHNldExhc3RSdW4ocnVuc1swXSk7XG4gIH0sIFt3b3Jrc3BhY2VJZCwgZmxvd0lkLCBmZXRjaEZsb3dIaXN0b3J5XSk7XG5cbiAgY29uc3QgcG9sbEV4ZWN1dGlvbiA9IHVzZUNhbGxiYWNrKGFzeW5jICgpID0+IHtcbiAgICBpZiAoIWV4ZWN1dGlvbklkKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRldGFpbHMgPSBhd2FpdCBmZXRjaEV4ZWN1dGlvbkRldGFpbHMoXG4gICAgICAgIHdvcmtzcGFjZUlkLFxuICAgICAgICBmbG93SWQsXG4gICAgICAgIGV4ZWN1dGlvbklkLFxuICAgICAgKTtcbiAgICAgIGlmICghZGV0YWlscykgcmV0dXJuO1xuICAgICAgaWYgKHdhc0NhbmNlbGxlZCkgcmV0dXJuO1xuXG4gICAgICBzZXRMYXN0SGVhcnRiZWF0KGRldGFpbHMubGFzdEhlYXJ0YmVhdCB8fCBudWxsKTtcblxuICAgICAgY29uc3QgbG9ncyA9IChkZXRhaWxzLmxvZ3MgfHwgW10pIGFzIEV4ZWN1dGlvbkxvZ1tdO1xuICAgICAgaWYgKGxvZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICBzZXRSZWNlbnRMb2dzKGxvZ3Muc2xpY2UoLTgpLnJldmVyc2UoKSk7XG4gICAgICB9XG5cbiAgICAgIC8vIFByZWZlciBiYWNrZW5kIHN0YXRzIHdoZW4gcHJlc2VudCwgYnV0IGZhbGwgYmFjayB0byBwYXJzaW5nIGxvZ3Mgc28gdXNlcnNcbiAgICAgIC8vIHN0aWxsIGdldCBmZWVkYmFjayB3aGlsZSBsb25nIGNodW5rcyBhcmUgcnVubmluZy5cbiAgICAgIGNvbnN0IHN0YXRzRnJvbUFwaSA9XG4gICAgICAgIGRldGFpbHMuc3RhdHMgJiYgdHlwZW9mIGRldGFpbHMuc3RhdHMgPT09IFwib2JqZWN0XCJcbiAgICAgICAgICA/IChkZXRhaWxzLnN0YXRzIGFzIHtcbiAgICAgICAgICAgICAgZW50aXR5U3RhdHM/OiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+O1xuICAgICAgICAgICAgICBlbnRpdHlTdGF0dXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgICAgICAgICAgICBwbGFubmVkRW50aXRpZXM/OiBzdHJpbmdbXTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgICAgIGNvbnN0IGNvbnRleHRGcm9tQXBpID1cbiAgICAgICAgZGV0YWlscy5jb250ZXh0ICYmIHR5cGVvZiBkZXRhaWxzLmNvbnRleHQgPT09IFwib2JqZWN0XCJcbiAgICAgICAgICA/IChkZXRhaWxzLmNvbnRleHQgYXMgeyBlbnRpdHlGaWx0ZXI/OiBzdHJpbmdbXSB9KVxuICAgICAgICAgIDogdW5kZWZpbmVkO1xuXG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShzdGF0c0Zyb21BcGk/LnBsYW5uZWRFbnRpdGllcykpIHtcbiAgICAgICAgc2V0UGxhbm5lZEVudGl0aWVzKHN0YXRzRnJvbUFwaS5wbGFubmVkRW50aXRpZXMpO1xuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgQXJyYXkuaXNBcnJheShjb250ZXh0RnJvbUFwaT8uZW50aXR5RmlsdGVyKSAmJlxuICAgICAgICBjb250ZXh0RnJvbUFwaS5lbnRpdHlGaWx0ZXIubGVuZ3RoID4gMFxuICAgICAgKSB7XG4gICAgICAgIHNldFBsYW5uZWRFbnRpdGllcyhjb250ZXh0RnJvbUFwaS5lbnRpdHlGaWx0ZXIpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkZXJpdmVkID1cbiAgICAgICAgbG9ncy5sZW5ndGggPiAwID8gZGVyaXZlUHJvZ3Jlc3NGcm9tTG9ncyhsb2dzKSA6IHVuZGVmaW5lZDtcblxuICAgICAgY29uc3QgbWVyZ2VkRW50aXR5U3RhdHM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7XG4gICAgICAgIC4uLihzdGF0c0Zyb21BcGk/LmVudGl0eVN0YXRzIHx8IHt9KSxcbiAgICAgIH07XG4gICAgICBpZiAoZGVyaXZlZD8uZW50aXR5U3RhdHMpIHtcbiAgICAgICAgZm9yIChjb25zdCBbZW50aXR5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoZGVyaXZlZC5lbnRpdHlTdGF0cykpIHtcbiAgICAgICAgICBtZXJnZWRFbnRpdHlTdGF0c1tlbnRpdHldID0gTWF0aC5tYXgoXG4gICAgICAgICAgICBtZXJnZWRFbnRpdHlTdGF0c1tlbnRpdHldIHx8IDAsXG4gICAgICAgICAgICB2YWx1ZSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoT2JqZWN0LmtleXMobWVyZ2VkRW50aXR5U3RhdHMpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgc2V0RW50aXR5U3RhdHMobWVyZ2VkRW50aXR5U3RhdHMpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtZXJnZWRFbnRpdHlTdGF0dXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gICAgICAgIC4uLihkZXJpdmVkPy5lbnRpdHlTdGF0dXMgfHwge30pLFxuICAgICAgICAuLi4oc3RhdHNGcm9tQXBpPy5lbnRpdHlTdGF0dXMgfHwge30pLFxuICAgICAgfTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyhtZXJnZWRFbnRpdHlTdGF0dXMpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgc2V0RW50aXR5U3RhdHVzKG1lcmdlZEVudGl0eVN0YXR1cyk7XG4gICAgICB9XG5cbiAgICAgIGlmIChkZXRhaWxzLnN0YXR1cyAhPT0gXCJydW5uaW5nXCIpIHtcbiAgICAgICAgc3RvcFBvbGxpbmcoKTtcbiAgICAgICAgc2V0U3RhdHVzKGRldGFpbHMuc3RhdHVzID09PSBcImNvbXBsZXRlZFwiID8gXCJjb21wbGV0ZWRcIiA6IFwiZmFpbGVkXCIpO1xuICAgICAgICBpZiAoZGV0YWlscy5lcnJvcikgc2V0RXJyb3IoZGV0YWlscy5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgbG9hZEhpc3RvcnkoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGlnbm9yZSBwb2xsaW5nIGVycm9yc1xuICAgIH1cbiAgfSwgW1xuICAgIGV4ZWN1dGlvbklkLFxuICAgIHdvcmtzcGFjZUlkLFxuICAgIGZsb3dJZCxcbiAgICBmZXRjaEV4ZWN1dGlvbkRldGFpbHMsXG4gICAgc3RvcFBvbGxpbmcsXG4gICAgbG9hZEhpc3RvcnksXG4gICAgd2FzQ2FuY2VsbGVkLFxuICBdKTtcblxuICBjb25zdCBzdGFydFBvbGxpbmcgPSB1c2VDYWxsYmFjaygoKSA9PiB7XG4gICAgc3RvcFBvbGxpbmcoKTtcbiAgICBwb2xsRXhlY3V0aW9uKCk7XG4gICAgcG9sbFJlZi5jdXJyZW50ID0gc2V0SW50ZXJ2YWwocG9sbEV4ZWN1dGlvbiwgNTAwMCk7XG4gIH0sIFtzdG9wUG9sbGluZywgcG9sbEV4ZWN1dGlvbl0pO1xuXG4gIC8vIE9uIG1vdW50OiBjaGVjayBpZiBydW5uaW5nICsgbG9hZCBoaXN0b3J5XG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgY29uc3QgaW5pdCA9IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHN0YXR1c1Jlc3AgPSBhd2FpdCBmZXRjaEZsb3dTdGF0dXMod29ya3NwYWNlSWQsIGZsb3dJZCk7XG4gICAgICBpZiAoc3RhdHVzUmVzcD8uaXNSdW5uaW5nICYmIHN0YXR1c1Jlc3AucnVubmluZ0V4ZWN1dGlvbikge1xuICAgICAgICBzZXRTdGF0dXMoXCJydW5uaW5nXCIpO1xuICAgICAgICBzZXRFeGVjdXRpb25JZChzdGF0dXNSZXNwLnJ1bm5pbmdFeGVjdXRpb24uZXhlY3V0aW9uSWQpO1xuICAgICAgICBzZXRTdGFydGVkQXQoc3RhdHVzUmVzcC5ydW5uaW5nRXhlY3V0aW9uLnN0YXJ0ZWRBdCk7XG4gICAgICB9XG4gICAgICBpZiAoIWlzQ2RjRmxvdykge1xuICAgICAgICBhd2FpdCBsb2FkSGlzdG9yeSgpO1xuICAgICAgfVxuICAgIH07XG4gICAgaW5pdCgpO1xuICAgIHJldHVybiBzdG9wUG9sbGluZztcbiAgfSwgW1xuICAgIHdvcmtzcGFjZUlkLFxuICAgIGZsb3dJZCxcbiAgICBpc0NkY0Zsb3csXG4gICAgZmV0Y2hGbG93U3RhdHVzLFxuICAgIGxvYWRIaXN0b3J5LFxuICAgIHN0b3BQb2xsaW5nLFxuICBdKTtcblxuICAvLyBTdGFydCBwb2xsaW5nIHdoZW4gZXhlY3V0aW9uSWQgaXMgc2V0IGFuZCBzdGF0dXMgaXMgcnVubmluZ1xuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmIChzdGF0dXMgPT09IFwicnVubmluZ1wiICYmIGV4ZWN1dGlvbklkKSB7XG4gICAgICBzdGFydFBvbGxpbmcoKTtcbiAgICB9XG4gICAgcmV0dXJuIHN0b3BQb2xsaW5nO1xuICB9LCBbc3RhdHVzLCBleGVjdXRpb25JZCwgc3RhcnRQb2xsaW5nLCBzdG9wUG9sbGluZ10pO1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgaWYgKCFpc0NkY0Zsb3cpIHtcbiAgICAgIHN0b3BDZGNQb2xsaW5nKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgcG9sbENkY092ZXJ2aWV3KCk7XG4gICAgY2RjUG9sbFJlZi5jdXJyZW50ID0gc2V0SW50ZXJ2YWwocG9sbENkY092ZXJ2aWV3LCA1MDAwKTtcbiAgICByZXR1cm4gc3RvcENkY1BvbGxpbmc7XG4gIH0sIFtpc0NkY0Zsb3csIHBvbGxDZGNPdmVydmlldywgc3RvcENkY1BvbGxpbmddKTtcblxuICBjb25zdCBoYW5kbGVCYWNrZmlsbCA9IGFzeW5jICgpID0+IHtcbiAgICBpZiAoaXNDZGNGbG93KSB7XG4gICAgICBzZXRJc1RyaWdnZXJpbmcodHJ1ZSk7XG4gICAgICBzZXRSZWNlbnRMb2dzKFtdKTtcbiAgICAgIHNldEVudGl0eVN0YXRzKHt9KTtcbiAgICAgIHNldEVudGl0eVN0YXR1cyh7fSk7XG4gICAgICBzZXRFcnJvcihudWxsKTtcbiAgICAgIGNvbnN0IG9rID0gYXdhaXQgc3RhcnRDZGNCYWNrZmlsbCh3b3Jrc3BhY2VJZCwgZmxvd0lkKTtcbiAgICAgIGlmICghb2spIHtcbiAgICAgICAgc2V0RXJyb3IoXCJGYWlsZWQgdG8gc3RhcnQgQ0RDIGJhY2tmaWxsXCIpO1xuICAgICAgICBzZXRJc1RyaWdnZXJpbmcoZmFsc2UpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBhd2FpdCBwb2xsQ2RjT3ZlcnZpZXcoKTtcbiAgICAgIHNldElzVHJpZ2dlcmluZyhmYWxzZSk7XG5cbiAgICAgIGNvbnN0IGRldGVjdEV4ZWN1dGlvbiA9IGFzeW5jIChhdHRlbXB0cyA9IDApOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICAgICAgaWYgKGF0dGVtcHRzID4gOCkgcmV0dXJuO1xuICAgICAgICBjb25zdCBzdGF0dXNSZXNwID0gYXdhaXQgZmV0Y2hGbG93U3RhdHVzKHdvcmtzcGFjZUlkLCBmbG93SWQpO1xuICAgICAgICBpZiAoc3RhdHVzUmVzcD8uaXNSdW5uaW5nICYmIHN0YXR1c1Jlc3AucnVubmluZ0V4ZWN1dGlvbikge1xuICAgICAgICAgIHNldFN0YXR1cyhcInJ1bm5pbmdcIik7XG4gICAgICAgICAgc2V0RXhlY3V0aW9uSWQoc3RhdHVzUmVzcC5ydW5uaW5nRXhlY3V0aW9uLmV4ZWN1dGlvbklkKTtcbiAgICAgICAgICBzZXRTdGFydGVkQXQoc3RhdHVzUmVzcC5ydW5uaW5nRXhlY3V0aW9uLnN0YXJ0ZWRBdCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAyMDAwKSk7XG4gICAgICAgIHJldHVybiBkZXRlY3RFeGVjdXRpb24oYXR0ZW1wdHMgKyAxKTtcbiAgICAgIH07XG4gICAgICBkZXRlY3RFeGVjdXRpb24oKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoXG4gICAgICAhY29uZmlybShcbiAgICAgICAgXCJSdW4gYSBmdWxsIGJhY2tmaWxsPyBUaGlzIHdpbGwgc3luYyBhbGwgaGlzdG9yaWNhbCBkYXRhIGZvciB0aGUgZW5hYmxlZCBlbnRpdGllcy5cIixcbiAgICAgIClcbiAgICApIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBzZXRJc1RyaWdnZXJpbmcodHJ1ZSk7XG4gICAgc2V0RXJyb3IobnVsbCk7XG4gICAgc2V0RW50aXR5U3RhdHMoe30pO1xuICAgIHNldEVudGl0eVN0YXR1cyh7fSk7XG4gICAgc2V0UGxhbm5lZEVudGl0aWVzKFtdKTtcbiAgICBzZXRSZWNlbnRMb2dzKFtdKTtcbiAgICBzZXRXYXNDYW5jZWxsZWQoZmFsc2UpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBiYWNrZmlsbEZsb3cod29ya3NwYWNlSWQsIGZsb3dJZCk7XG4gICAgICBzZXRTdGF0dXMoXCJydW5uaW5nXCIpO1xuICAgICAgLy8gR2l2ZSBJbm5nZXN0IGEgbW9tZW50IHRvIGNyZWF0ZSB0aGUgZXhlY3V0aW9uLCB0aGVuIGNoZWNrIHN0YXR1c1xuICAgICAgc2V0VGltZW91dChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHN0YXR1c1Jlc3AgPSBhd2FpdCBmZXRjaEZsb3dTdGF0dXMod29ya3NwYWNlSWQsIGZsb3dJZCk7XG4gICAgICAgIGlmIChzdGF0dXNSZXNwPy5ydW5uaW5nRXhlY3V0aW9uKSB7XG4gICAgICAgICAgc2V0RXhlY3V0aW9uSWQoc3RhdHVzUmVzcC5ydW5uaW5nRXhlY3V0aW9uLmV4ZWN1dGlvbklkKTtcbiAgICAgICAgICBzZXRTdGFydGVkQXQoc3RhdHVzUmVzcC5ydW5uaW5nRXhlY3V0aW9uLnN0YXJ0ZWRBdCk7XG4gICAgICAgIH1cbiAgICAgICAgc2V0SXNUcmlnZ2VyaW5nKGZhbHNlKTtcbiAgICAgIH0sIDMwMDApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgc2V0U3RhdHVzKFwiZmFpbGVkXCIpO1xuICAgICAgc2V0RXJyb3IoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFwiQmFja2ZpbGwgZmFpbGVkXCIpO1xuICAgICAgc2V0SXNUcmlnZ2VyaW5nKGZhbHNlKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2FuY2VsID0gYXN5bmMgKCkgPT4ge1xuICAgIHN0b3BQb2xsaW5nKCk7XG4gICAgc2V0V2FzQ2FuY2VsbGVkKHRydWUpO1xuICAgIHNldEV4ZWN1dGlvbklkKG51bGwpO1xuICAgIHNldEVudGl0eVN0YXRzKHt9KTtcbiAgICBzZXRFbnRpdHlTdGF0dXMoe30pO1xuICAgIHNldFBsYW5uZWRFbnRpdGllcyhbXSk7XG4gICAgc2V0UmVjZW50TG9ncyhbXSk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNhbmNlbEZsb3dFeGVjdXRpb24od29ya3NwYWNlSWQsIGZsb3dJZCwgZXhlY3V0aW9uSWQpO1xuICAgICAgc2V0U3RhdHVzKFwiY2FuY2VsbGVkXCIpO1xuICAgICAgc2V0RXJyb3IobnVsbCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBzZXRTdGF0dXMoXCJmYWlsZWRcIik7XG4gICAgICBzZXRFcnJvcihcIkZhaWxlZCB0byBjYW5jZWwgZmxvd1wiKTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2RjUGF1c2VSZXN1bWUgPSBhc3luYyAoKSA9PiB7XG4gICAgaWYgKCFpc0NkY0Zsb3cpIHJldHVybjtcbiAgICBjb25zdCBjdXJyZW50U3RhdGUgPSBjZGNTdW1tYXJ5Py5zeW5jU3RhdGU7XG4gICAgY29uc3Qgc3VjY2VzcyA9XG4gICAgICBjdXJyZW50U3RhdGUgPT09IFwicGF1c2VkXCJcbiAgICAgICAgPyBhd2FpdCByZXN1bWVDZGNGbG93KHdvcmtzcGFjZUlkLCBmbG93SWQpXG4gICAgICAgIDogYXdhaXQgcGF1c2VDZGNGbG93KHdvcmtzcGFjZUlkLCBmbG93SWQpO1xuICAgIGlmICghc3VjY2Vzcykge1xuICAgICAgc2V0RXJyb3IoXCJGYWlsZWQgdG8gdXBkYXRlIENEQyBzdGF0ZVwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgcG9sbENkY092ZXJ2aWV3KCk7XG4gIH07XG5cbiAgY29uc3QgaGFuZGxlQ2RjUmVzeW5jID0gYXN5bmMgKCkgPT4ge1xuICAgIGlmIChyZXN5bmNDb25maXJtVGV4dCAhPT0gXCJSRVNZTkNcIikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBzZXRJc1Jlc3luY2luZyh0cnVlKTtcbiAgICBjb25zdCBzdWNjZXNzID0gYXdhaXQgcmVzeW5jQ2RjRmxvdyh3b3Jrc3BhY2VJZCwgZmxvd0lkLCB7XG4gICAgICBkZWxldGVEZXN0aW5hdGlvbixcbiAgICAgIGNsZWFyV2ViaG9va0V2ZW50cyxcbiAgICB9KTtcbiAgICBzZXRJc1Jlc3luY2luZyhmYWxzZSk7XG4gICAgaWYgKCFzdWNjZXNzKSB7XG4gICAgICBzZXRFcnJvcihcIkZhaWxlZCB0byByZXN5bmMgQ0RDIGZsb3dcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHNldFJlc3luY0RpYWxvZ09wZW4oZmFsc2UpO1xuICAgIHNldFJlc3luY0NvbmZpcm1UZXh0KFwiXCIpO1xuICAgIGF3YWl0IHBvbGxDZGNPdmVydmlldygpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZUNkY1JlY292ZXIgPSBhc3luYyAoKSA9PiB7XG4gICAgaWYgKCFpc0NkY0Zsb3cpIHJldHVybjtcbiAgICBjb25zdCBzdWNjZXNzID0gYXdhaXQgcmVjb3ZlckNkY0Zsb3cod29ya3NwYWNlSWQsIGZsb3dJZCwge1xuICAgICAgcmV0cnlGYWlsZWRNYXRlcmlhbGl6YXRpb246IHRydWUsXG4gICAgICByZXN1bWVCYWNrZmlsbDogdHJ1ZSxcbiAgICB9KTtcbiAgICBpZiAoIXN1Y2Nlc3MpIHtcbiAgICAgIHNldEVycm9yKFwiRmFpbGVkIHRvIHJlY292ZXIgQ0RDIGZsb3dcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGF3YWl0IHBvbGxDZGNPdmVydmlldygpO1xuICB9O1xuXG4gIGNvbnN0IGhhbmRsZVJldHJ5RmFpbGVkTWF0ZXJpYWxpemF0aW9uID0gYXN5bmMgKCkgPT4ge1xuICAgIGlmICghaXNDZGNGbG93KSByZXR1cm47XG4gICAgY29uc3Qgc3VjY2VzcyA9IGF3YWl0IHJldHJ5RmFpbGVkQ2RjTWF0ZXJpYWxpemF0aW9uKHdvcmtzcGFjZUlkLCBmbG93SWQpO1xuICAgIGlmICghc3VjY2Vzcykge1xuICAgICAgc2V0RXJyb3IoXCJGYWlsZWQgdG8gcXVldWUgZmFpbGVkIENEQyByb3dzIGZvciByZXRyeVwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgcG9sbENkY092ZXJ2aWV3KCk7XG4gIH07XG5cbiAgaWYgKGlzQ2RjRmxvdykge1xuICAgIGNvbnN0IHN1bW1hcnkgPSBjZGNTdW1tYXJ5O1xuXG4gICAgY29uc3QgZm9ybWF0TGFnRHVyYXRpb24gPSAobGFnU2Vjb25kczogbnVtYmVyIHwgbnVsbCkgPT4ge1xuICAgICAgaWYgKGxhZ1NlY29uZHMgPT09IG51bGwgfHwgIU51bWJlci5pc0Zpbml0ZShsYWdTZWNvbmRzKSkgcmV0dXJuIFwibi9hXCI7XG4gICAgICBpZiAobGFnU2Vjb25kcyA8IDYwKSByZXR1cm4gYCR7bGFnU2Vjb25kc31zYDtcbiAgICAgIGlmIChsYWdTZWNvbmRzIDwgMzYwMCkge1xuICAgICAgICBjb25zdCBtaW51dGVzID0gTWF0aC5mbG9vcihsYWdTZWNvbmRzIC8gNjApO1xuICAgICAgICBjb25zdCBzZWNvbmRzID0gbGFnU2Vjb25kcyAlIDYwO1xuICAgICAgICByZXR1cm4gc2Vjb25kcyA+IDAgPyBgJHttaW51dGVzfW0gJHtzZWNvbmRzfXNgIDogYCR7bWludXRlc31tYDtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihsYWdTZWNvbmRzIC8gMzYwMCk7XG4gICAgICBjb25zdCBtaW51dGVzID0gTWF0aC5mbG9vcigobGFnU2Vjb25kcyAlIDM2MDApIC8gNjApO1xuICAgICAgcmV0dXJuIG1pbnV0ZXMgPiAwID8gYCR7aG91cnN9aCAke21pbnV0ZXN9bWAgOiBgJHtob3Vyc31oYDtcbiAgICB9O1xuXG4gICAgY29uc3Qgc3RhdGVDb2xvciA9IChzdGF0ZT86IHN0cmluZykgPT4ge1xuICAgICAgc3dpdGNoIChzdGF0ZSkge1xuICAgICAgICBjYXNlIFwibGl2ZVwiOlxuICAgICAgICAgIHJldHVybiBcInN1Y2Nlc3NcIjtcbiAgICAgICAgY2FzZSBcImJhY2tmaWxsXCI6XG4gICAgICAgIGNhc2UgXCJjYXRjaHVwXCI6XG4gICAgICAgICAgcmV0dXJuIFwiaW5mb1wiO1xuICAgICAgICBjYXNlIFwicGF1c2VkXCI6XG4gICAgICAgICAgcmV0dXJuIFwiZGVmYXVsdFwiO1xuICAgICAgICBjYXNlIFwiZGVncmFkZWRcIjpcbiAgICAgICAgICByZXR1cm4gXCJlcnJvclwiO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIHJldHVybiBcImRlZmF1bHRcIjtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3QgZnJlc2huZXNzU3VtbWFyeSA9ICgoKSA9PiB7XG4gICAgICBpZiAoIXN1bW1hcnkpIHJldHVybiBcInVua25vd25cIjtcbiAgICAgIGNvbnN0IHdlYmhvb2tMYWdTZWNvbmRzID0gKCgpID0+IHtcbiAgICAgICAgaWYgKCFzdW1tYXJ5Lmxhc3RXZWJob29rQXQpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCBsYXN0V2ViaG9va1RzID0gbmV3IERhdGUoc3VtbWFyeS5sYXN0V2ViaG9va0F0KS5nZXRUaW1lKCk7XG4gICAgICAgIGlmICghTnVtYmVyLmlzRmluaXRlKGxhc3RXZWJob29rVHMpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmV0dXJuIE1hdGgubWF4KE1hdGguZmxvb3IoKERhdGUubm93KCkgLSBsYXN0V2ViaG9va1RzKSAvIDEwMDApLCAwKTtcbiAgICAgIH0pKCk7XG5cbiAgICAgIGlmIChcbiAgICAgICAgKHN1bW1hcnkuZmFpbGVkQ291bnQgPz8gMCkgPT09IDAgJiZcbiAgICAgICAgKHN1bW1hcnkuYmFja2xvZ0NvdW50ID8/IDApID09PSAwXG4gICAgICApIHtcbiAgICAgICAgcmV0dXJuIFwibGl2ZVwiO1xuICAgICAgfVxuICAgICAgaWYgKHdlYmhvb2tMYWdTZWNvbmRzICE9PSBudWxsKSB7XG4gICAgICAgIHJldHVybiBgbGFnICR7Zm9ybWF0TGFnRHVyYXRpb24od2ViaG9va0xhZ1NlY29uZHMpfWA7XG4gICAgICB9XG4gICAgICByZXR1cm4gYGxhZyAke2Zvcm1hdExhZ0R1cmF0aW9uKHN1bW1hcnkubGFnU2Vjb25kcyl9YDtcbiAgICB9KSgpO1xuXG4gICAgY29uc3QgZW50aXR5QmFja2ZpbGxTdGF0dXMgPSAoZW50aXR5OiB7XG4gICAgICBiYWNrbG9nQ291bnQ6IG51bWJlcjtcbiAgICAgIGZhaWxlZENvdW50OiBudW1iZXI7XG4gICAgICBkcm9wcGVkQ291bnQ6IG51bWJlcjtcbiAgICAgIGxhc3RNYXRlcmlhbGl6ZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgICB9KSA9PiB7XG4gICAgICBpZiAoZW50aXR5LmZhaWxlZENvdW50ID4gMCkgcmV0dXJuIFwiRmFpbGVkXCI7XG4gICAgICBpZiAoIWVudGl0eS5sYXN0TWF0ZXJpYWxpemVkQXQgJiYgZW50aXR5LmJhY2tsb2dDb3VudCA9PT0gMCkge1xuICAgICAgICByZXR1cm4gXCJOb3Qgc3RhcnRlZFwiO1xuICAgICAgfVxuICAgICAgaWYgKGVudGl0eS5iYWNrbG9nQ291bnQgPiAwKSByZXR1cm4gXCJJbiBwcm9ncmVzc1wiO1xuICAgICAgaWYgKGVudGl0eS5kcm9wcGVkQ291bnQgPiAwKSByZXR1cm4gXCJGaWx0ZXJlZFwiO1xuICAgICAgcmV0dXJuIFwiQ29tcGxldGVkXCI7XG4gICAgfTtcblxuICAgIGNvbnN0IGVudGl0eU9iamVjdFN0YXR1cyA9IChlbnRpdHk6IHtcbiAgICAgIGJhY2tsb2dDb3VudDogbnVtYmVyO1xuICAgICAgZmFpbGVkQ291bnQ6IG51bWJlcjtcbiAgICAgIGRyb3BwZWRDb3VudDogbnVtYmVyO1xuICAgICAgbGFzdE1hdGVyaWFsaXplZEF0OiBzdHJpbmcgfCBudWxsO1xuICAgIH0pID0+IHtcbiAgICAgIGlmIChlbnRpdHkuZmFpbGVkQ291bnQgPiAwKSB7XG4gICAgICAgIHJldHVybiB7IGxhYmVsOiBcIkVycm9yXCIsIGNvbG9yOiBcImVycm9yXCIgYXMgY29uc3QgfTtcbiAgICAgIH1cbiAgICAgIGlmIChlbnRpdHkuYmFja2xvZ0NvdW50ID4gMCkge1xuICAgICAgICByZXR1cm4geyBsYWJlbDogXCJTeW5jaW5nXCIsIGNvbG9yOiBcImluZm9cIiBhcyBjb25zdCB9O1xuICAgICAgfVxuICAgICAgaWYgKGVudGl0eS5kcm9wcGVkQ291bnQgPiAwKSB7XG4gICAgICAgIHJldHVybiB7IGxhYmVsOiBcIkZpbHRlcmVkXCIsIGNvbG9yOiBcIndhcm5pbmdcIiBhcyBjb25zdCB9O1xuICAgICAgfVxuICAgICAgaWYgKGVudGl0eS5sYXN0TWF0ZXJpYWxpemVkQXQpIHtcbiAgICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiUnVubmluZ1wiLCBjb2xvcjogXCJzdWNjZXNzXCIgYXMgY29uc3QgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlBlbmRpbmdcIiwgY29sb3I6IFwiZGVmYXVsdFwiIGFzIGNvbnN0IH07XG4gICAgfTtcblxuICAgIGNvbnN0IGVudGl0eUxhZ0xhYmVsID0gKGVudGl0eToge1xuICAgICAgYmFja2xvZ0NvdW50OiBudW1iZXI7XG4gICAgICBmYWlsZWRDb3VudDogbnVtYmVyO1xuICAgICAgbGFnU2Vjb25kczogbnVtYmVyIHwgbnVsbDtcbiAgICB9KSA9PiB7XG4gICAgICBpZiAoZW50aXR5LmxhZ1NlY29uZHMgPT09IG51bGwpIHJldHVybiBcIuKAlFwiO1xuICAgICAgLy8gRm9yIGVudGl0aWVzIHdpdGggbm8gcXVldWVkL2ZhaWxlZCBldmVudHMsIGEgZ3Jvd2luZyBsYWcgbW9zdGx5IG1lYW5zXG4gICAgICAvLyBcIm5vIHJlY2VudCBldmVudHNcIiByYXRoZXIgdGhhbiBcInBpcGVsaW5lIGRlbGF5XCIuXG4gICAgICBpZiAoZW50aXR5LmJhY2tsb2dDb3VudCA9PT0gMCAmJiBlbnRpdHkuZmFpbGVkQ291bnQgPT09IDApIHJldHVybiBcIuKAlFwiO1xuICAgICAgcmV0dXJuIGZvcm1hdExhZ0R1cmF0aW9uKGVudGl0eS5sYWdTZWNvbmRzKTtcbiAgICB9O1xuXG4gICAgY29uc3QgY29ubmVjdG9yTmFtZSA9IGN1cnJlbnRGbG93Py5kYXRhU291cmNlSWRcbiAgICAgID8gdHlwZW9mIGN1cnJlbnRGbG93LmRhdGFTb3VyY2VJZCA9PT0gXCJvYmplY3RcIlxuICAgICAgICA/IChjdXJyZW50Rmxvdy5kYXRhU291cmNlSWQgYXMgYW55KS5uYW1lXG4gICAgICAgIDogdW5kZWZpbmVkXG4gICAgICA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb25uZWN0b3JUeXBlID0gY3VycmVudEZsb3c/LmRhdGFTb3VyY2VJZFxuICAgICAgPyB0eXBlb2YgY3VycmVudEZsb3cuZGF0YVNvdXJjZUlkID09PSBcIm9iamVjdFwiXG4gICAgICAgID8gKGN1cnJlbnRGbG93LmRhdGFTb3VyY2VJZCBhcyBhbnkpLnR5cGVcbiAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGRlc3ROYW1lID0gY3VycmVudEZsb3c/LmRlc3RpbmF0aW9uRGF0YWJhc2VJZFxuICAgICAgPyB0eXBlb2YgY3VycmVudEZsb3cuZGVzdGluYXRpb25EYXRhYmFzZUlkID09PSBcIm9iamVjdFwiXG4gICAgICAgID8gKGN1cnJlbnRGbG93LmRlc3RpbmF0aW9uRGF0YWJhc2VJZCBhcyBhbnkpLm5hbWVcbiAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGRlc3RUeXBlID0gY3VycmVudEZsb3c/LmRlc3RpbmF0aW9uRGF0YWJhc2VJZFxuICAgICAgPyB0eXBlb2YgY3VycmVudEZsb3cuZGVzdGluYXRpb25EYXRhYmFzZUlkID09PSBcIm9iamVjdFwiXG4gICAgICAgID8gKGN1cnJlbnRGbG93LmRlc3RpbmF0aW9uRGF0YWJhc2VJZCBhcyBhbnkpLnR5cGVcbiAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGRhdGFzZXQgPSBjdXJyZW50Rmxvdz8udGFibGVEZXN0aW5hdGlvbj8uc2NoZW1hO1xuICAgIGNvbnN0IHdlYmhvb2tFbmRwb2ludCA9IGN1cnJlbnRGbG93Py53ZWJob29rQ29uZmlnPy5lbmRwb2ludDtcbiAgICBjb25zdCBjb3B5V2ViaG9va1VybCA9IGFzeW5jICgpID0+IHtcbiAgICAgIGlmICghd2ViaG9va0VuZHBvaW50KSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh3ZWJob29rRW5kcG9pbnQpO1xuICAgICAgICBzZXRXZWJob29rQ29waWVkKHRydWUpO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHNldFdlYmhvb2tDb3BpZWQoZmFsc2UpLCAxNTAwKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBzZXRXZWJob29rQ29waWVkKGZhbHNlKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3QgYWN0ID0ge1xuICAgICAgZm9udFNpemU6IFwiMC44cmVtXCIsXG4gICAgICB0ZXh0VHJhbnNmb3JtOiBcIm5vbmVcIiBhcyBjb25zdCxcbiAgICAgIGZvbnRXZWlnaHQ6IDUwMCxcbiAgICAgIGNvbG9yOiBcInByaW1hcnkubWFpblwiLFxuICAgICAgbWluV2lkdGg6IDAsXG4gICAgICBweDogeyB4czogMSwgc206IDEuNSB9LFxuICAgICAgcHk6IDAuNSxcbiAgICAgIGdhcDogMC41LFxuICAgICAgd2hpdGVTcGFjZTogXCJub3dyYXBcIixcbiAgICAgIFwiJjpob3ZlclwiOiB7IGJnY29sb3I6IFwiYWN0aW9uLmhvdmVyXCIgfSxcbiAgICAgIFwiJiAuTXVpQnV0dG9uLXN0YXJ0SWNvblwiOiB7IG1yOiAwLjUgfSxcbiAgICB9O1xuICAgIGNvbnN0IGFjdERhbmdlciA9IHsgLi4uYWN0LCBjb2xvcjogXCJlcnJvci5tYWluXCIgfTtcblxuICAgIGNvbnN0IHN0YXRlID0gc3VtbWFyeT8uc3luY1N0YXRlO1xuICAgIGNvbnN0IGJhY2tmaWxsUnVubmluZyA9IHN0YXR1cyA9PT0gXCJydW5uaW5nXCIgfHwgc3RhdGUgPT09IFwiYmFja2ZpbGxcIjtcbiAgICBjb25zdCBpc1BhdXNlZCA9IHN0YXRlID09PSBcInBhdXNlZFwiICYmICFiYWNrZmlsbFJ1bm5pbmc7XG4gICAgY29uc3QgaXNEZWdyYWRlZCA9IHN0YXRlID09PSBcImRlZ3JhZGVkXCIgJiYgIWJhY2tmaWxsUnVubmluZztcbiAgICBjb25zdCBpc0lkbGUgPSAoIXN0YXRlIHx8IHN0YXRlID09PSBcImlkbGVcIikgJiYgIWJhY2tmaWxsUnVubmluZztcbiAgICBjb25zdCBoYXNGYWlsZWQgPSAoc3VtbWFyeT8uZmFpbGVkQ291bnQgPz8gMCkgPiAwO1xuICAgIGNvbnN0IGZhaWxlZERyb3BwZWREZXRhaWwgPVxuICAgICAgc3VtbWFyeSAmJlxuICAgICAgKChzdW1tYXJ5LmZhaWxlZENvdW50ID8/IDApID4gMCB8fCAoc3VtbWFyeS5iYWNrbG9nQ291bnQgPz8gMCkgPiAwKVxuICAgICAgICA/IGBMYWcgJHtmb3JtYXRMYWdEdXJhdGlvbihzdW1tYXJ5LmxhZ1NlY29uZHMpfWBcbiAgICAgICAgOiBcIk5vIHF1ZXVlZCBvciBmYWlsZWQgZXZlbnRzXCI7XG5cbiAgICByZXR1cm4gKFxuICAgICAgPEJveFxuICAgICAgICByZWY9e3BhbmVsQ29udGFpbmVyUmVmfVxuICAgICAgICBzeD17e1xuICAgICAgICAgIGhlaWdodDogXCIxMDAlXCIsXG4gICAgICAgICAgZGlzcGxheTogXCJmbGV4XCIsXG4gICAgICAgICAgZmxleERpcmVjdGlvbjogXCJjb2x1bW5cIixcbiAgICAgICAgICBvdmVyZmxvdzogXCJhdXRvXCIsXG4gICAgICAgIH19XG4gICAgICA+XG4gICAgICAgIDxCb3hcbiAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgZGlzcGxheTogXCJmbGV4XCIsXG4gICAgICAgICAgICBhbGlnbkl0ZW1zOiBcImNlbnRlclwiLFxuICAgICAgICAgICAgZmxleFdyYXA6IFwid3JhcFwiLFxuICAgICAgICAgICAgcHg6IHsgeHM6IDEsIHNtOiAxLjUgfSxcbiAgICAgICAgICAgIHB5OiAwLjc1LFxuICAgICAgICAgICAgYm9yZGVyQm90dG9tOiAxLFxuICAgICAgICAgICAgYm9yZGVyQ29sb3I6IFwiZGl2aWRlclwiLFxuICAgICAgICAgICAgY29sdW1uR2FwOiAwLjUsXG4gICAgICAgICAgICByb3dHYXA6IDAuNzUsXG4gICAgICAgICAgICBtaW5IZWlnaHQ6IDQwLFxuICAgICAgICAgIH19XG4gICAgICAgID5cbiAgICAgICAgICA8Qm94XG4gICAgICAgICAgICBzeD17eyBkaXNwbGF5OiBcImZsZXhcIiwgZmxleFdyYXA6IFwid3JhcFwiLCBnYXA6IDAuNSwgbWluV2lkdGg6IDAgfX1cbiAgICAgICAgICA+XG4gICAgICAgICAgICB7LyogUHJpbWFyeSBhY3Rpb24g4oCUIGNoYW5nZXMgYmFzZWQgb24gc3RhdGUgKi99XG4gICAgICAgICAgICB7aXNJZGxlICYmIChcbiAgICAgICAgICAgICAgPEJ1dHRvblxuICAgICAgICAgICAgICAgIHN4PXthY3R9XG4gICAgICAgICAgICAgICAgc3RhcnRJY29uPXs8U3luY0ljb24gc3g9e3sgZm9udFNpemU6IDE4IH19IC8+fVxuICAgICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUJhY2tmaWxsfVxuICAgICAgICAgICAgICAgIGRpc2FibGVkPXtpc1RyaWdnZXJpbmd9XG4gICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICBTdGFydCBiYWNrZmlsbFxuICAgICAgICAgICAgICA8L0J1dHRvbj5cbiAgICAgICAgICAgICl9XG4gICAgICAgICAgICB7YmFja2ZpbGxSdW5uaW5nICYmIChcbiAgICAgICAgICAgICAgPD5cbiAgICAgICAgICAgICAgICA8QnV0dG9uXG4gICAgICAgICAgICAgICAgICBzeD17YWN0fVxuICAgICAgICAgICAgICAgICAgc3RhcnRJY29uPXs8U3luY0ljb24gc3g9e3sgZm9udFNpemU6IDE4IH19IC8+fVxuICAgICAgICAgICAgICAgICAgZGlzYWJsZWRcbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICBCYWNrZmlsbGluZ+KAplxuICAgICAgICAgICAgICAgIDwvQnV0dG9uPlxuICAgICAgICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgICAgICAgIHN4PXthY3REYW5nZXJ9XG4gICAgICAgICAgICAgICAgICBzdGFydEljb249ezxDYW5jZWxJY29uIHN4PXt7IGZvbnRTaXplOiAxOCB9fSAvPn1cbiAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUNhbmNlbH1cbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICBDYW5jZWxcbiAgICAgICAgICAgICAgICA8L0J1dHRvbj5cbiAgICAgICAgICAgICAgPC8+XG4gICAgICAgICAgICApfVxuICAgICAgICAgICAgeyhzdGF0ZSA9PT0gXCJjYXRjaHVwXCIgfHwgc3RhdGUgPT09IFwibGl2ZVwiKSAmJiAoXG4gICAgICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgICAgICBzeD17YWN0fVxuICAgICAgICAgICAgICAgIHN0YXJ0SWNvbj17PFBhdXNlSWNvbiBzeD17eyBmb250U2l6ZTogMTggfX0gLz59XG4gICAgICAgICAgICAgICAgb25DbGljaz17aGFuZGxlQ2RjUGF1c2VSZXN1bWV9XG4gICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICBQYXVzZSBzdHJlYW1cbiAgICAgICAgICAgICAgPC9CdXR0b24+XG4gICAgICAgICAgICApfVxuICAgICAgICAgICAge2lzUGF1c2VkICYmIChcbiAgICAgICAgICAgICAgPD5cbiAgICAgICAgICAgICAgICA8QnV0dG9uXG4gICAgICAgICAgICAgICAgICBzeD17YWN0fVxuICAgICAgICAgICAgICAgICAgc3RhcnRJY29uPXs8UmVzdW1lSWNvbiBzeD17eyBmb250U2l6ZTogMTggfX0gLz59XG4gICAgICAgICAgICAgICAgICBvbkNsaWNrPXtoYW5kbGVDZGNQYXVzZVJlc3VtZX1cbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICBSZXN1bWUgc3RyZWFtXG4gICAgICAgICAgICAgICAgPC9CdXR0b24+XG4gICAgICAgICAgICAgICAgPEJ1dHRvblxuICAgICAgICAgICAgICAgICAgc3g9e2FjdH1cbiAgICAgICAgICAgICAgICAgIHN0YXJ0SWNvbj17PFN5bmNJY29uIHN4PXt7IGZvbnRTaXplOiAxOCB9fSAvPn1cbiAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUJhY2tmaWxsfVxuICAgICAgICAgICAgICAgICAgZGlzYWJsZWQ9e2lzVHJpZ2dlcmluZ31cbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICBTdGFydCBiYWNrZmlsbFxuICAgICAgICAgICAgICAgIDwvQnV0dG9uPlxuICAgICAgICAgICAgICA8Lz5cbiAgICAgICAgICAgICl9XG4gICAgICAgICAgICB7aXNEZWdyYWRlZCAmJiAoXG4gICAgICAgICAgICAgIDw+XG4gICAgICAgICAgICAgICAgPEJ1dHRvblxuICAgICAgICAgICAgICAgICAgc3g9e2FjdH1cbiAgICAgICAgICAgICAgICAgIHN0YXJ0SWNvbj17PFJlY292ZXJJY29uIHN4PXt7IGZvbnRTaXplOiAxOCB9fSAvPn1cbiAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUNkY1JlY292ZXJ9XG4gICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgUmVjb3ZlclxuICAgICAgICAgICAgICAgIDwvQnV0dG9uPlxuICAgICAgICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgICAgICAgIHN4PXthY3R9XG4gICAgICAgICAgICAgICAgICBzdGFydEljb249ezxTeW5jSWNvbiBzeD17eyBmb250U2l6ZTogMTggfX0gLz59XG4gICAgICAgICAgICAgICAgICBvbkNsaWNrPXtoYW5kbGVCYWNrZmlsbH1cbiAgICAgICAgICAgICAgICAgIGRpc2FibGVkPXtpc1RyaWdnZXJpbmd9XG4gICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgU3RhcnQgYmFja2ZpbGxcbiAgICAgICAgICAgICAgICA8L0J1dHRvbj5cbiAgICAgICAgICAgICAgPC8+XG4gICAgICAgICAgICApfVxuXG4gICAgICAgICAgICB7LyogU2Vjb25kYXJ5IGFjdGlvbnMg4oCUIGNvbnRleHR1YWwgKi99XG4gICAgICAgICAgICB7aGFzRmFpbGVkICYmIChcbiAgICAgICAgICAgICAgPEJ1dHRvblxuICAgICAgICAgICAgICAgIHN4PXthY3R9XG4gICAgICAgICAgICAgICAgc3RhcnRJY29uPXs8UmV0cnlJY29uIHN4PXt7IGZvbnRTaXplOiAxOCB9fSAvPn1cbiAgICAgICAgICAgICAgICBvbkNsaWNrPXtoYW5kbGVSZXRyeUZhaWxlZE1hdGVyaWFsaXphdGlvbn1cbiAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgIFJldHJ5IHtzdW1tYXJ5Py5mYWlsZWRDb3VudCA/PyAwfSBmYWlsZWRcbiAgICAgICAgICAgICAgPC9CdXR0b24+XG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvQm94PlxuXG4gICAgICAgICAgPEJveFxuICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgbWw6IHsgbWQ6IFwiYXV0b1wiIH0sXG4gICAgICAgICAgICAgIHdpZHRoOiB7IHhzOiBcIjEwMCVcIiwgbWQ6IFwiYXV0b1wiIH0sXG4gICAgICAgICAgICAgIGRpc3BsYXk6IFwiZmxleFwiLFxuICAgICAgICAgICAgICBmbGV4V3JhcDogXCJ3cmFwXCIsXG4gICAgICAgICAgICAgIGp1c3RpZnlDb250ZW50OiB7IHhzOiBcImZsZXgtc3RhcnRcIiwgbWQ6IFwiZmxleC1lbmRcIiB9LFxuICAgICAgICAgICAgICBnYXA6IDAuNSxcbiAgICAgICAgICAgIH19XG4gICAgICAgICAgPlxuICAgICAgICAgICAgey8qIEFsd2F5cy1hdmFpbGFibGUgYWN0aW9ucyAqL31cbiAgICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgICAgc3g9e2FjdERhbmdlcn1cbiAgICAgICAgICAgICAgc3RhcnRJY29uPXs8UmVzeW5jSWNvbiBzeD17eyBmb250U2l6ZTogMTggfX0gLz59XG4gICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHNldFJlc3luY0RpYWxvZ09wZW4odHJ1ZSl9XG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIFJlc3luYyBmcm9tIHNjcmF0Y2hcbiAgICAgICAgICAgIDwvQnV0dG9uPlxuICAgICAgICAgICAge29uRWRpdCAmJiAoXG4gICAgICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgICAgICBzeD17YWN0fVxuICAgICAgICAgICAgICAgIHN0YXJ0SWNvbj17PEVkaXRJY29uIHN4PXt7IGZvbnRTaXplOiAxOCB9fSAvPn1cbiAgICAgICAgICAgICAgICBvbkNsaWNrPXtvbkVkaXR9XG4gICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICBFZGl0XG4gICAgICAgICAgICAgIDwvQnV0dG9uPlxuICAgICAgICAgICAgKX1cbiAgICAgICAgICAgIDxCdXR0b25cbiAgICAgICAgICAgICAgc3g9e2FjdH1cbiAgICAgICAgICAgICAgc3RhcnRJY29uPXs8RGlhZ25vc3RpY3NJY29uIHN4PXt7IGZvbnRTaXplOiAxOCB9fSAvPn1cbiAgICAgICAgICAgICAgb25DbGljaz17KCkgPT4gc2V0U2hvd0RpYWdub3N0aWNzKHYgPT4gIXYpfVxuICAgICAgICAgICAgPlxuICAgICAgICAgICAgICB7c2hvd0RpYWdub3N0aWNzID8gXCJIaWRlIGRpYWdub3N0aWNzXCIgOiBcIkRpYWdub3N0aWNzXCJ9XG4gICAgICAgICAgICA8L0J1dHRvbj5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAgPEJveFxuICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICBweDogeyB4czogMS41LCBzbTogMiwgbWQ6IDIuNSB9LFxuICAgICAgICAgICAgcHk6IDIsXG4gICAgICAgICAgICBkaXNwbGF5OiBcImdyaWRcIixcbiAgICAgICAgICAgIGdhcDogeyB4czogMiwgbWQ6IDIuNSB9LFxuICAgICAgICAgIH19XG4gICAgICAgID5cbiAgICAgICAgICB7LyogUHJvcGVydGllcyDigJQgY29tcGFjdCAyLWNvbCBrZXkvdmFsdWUgKi99XG4gICAgICAgICAgPEJveFxuICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgZGlzcGxheTogXCJncmlkXCIsXG4gICAgICAgICAgICAgIGdyaWRUZW1wbGF0ZUNvbHVtbnM6IHtcbiAgICAgICAgICAgICAgICB4czogXCI4OHB4IG1pbm1heCgwLCAxZnIpXCIsXG4gICAgICAgICAgICAgICAgc206IFwiMTAwcHggbWlubWF4KDAsIDFmcilcIixcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcm93R2FwOiAwLjUsXG4gICAgICAgICAgICAgIGNvbHVtbkdhcDogMS41LFxuICAgICAgICAgICAgICBcIiYgLmxibFwiOiB7XG4gICAgICAgICAgICAgICAgY29sb3I6IFwidGV4dC5zZWNvbmRhcnlcIixcbiAgICAgICAgICAgICAgICBmb250U2l6ZTogXCIwLjc4cmVtXCIsXG4gICAgICAgICAgICAgICAgbGluZUhlaWdodDogMS43LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBcIiYgLnZhbFwiOiB7IGZvbnRTaXplOiBcIjAuNzhyZW1cIiwgbGluZUhlaWdodDogMS43LCBtaW5XaWR0aDogMCB9LFxuICAgICAgICAgICAgfX1cbiAgICAgICAgICA+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSBjbGFzc05hbWU9XCJsYmxcIj5FbmdpbmVzPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPFR5cG9ncmFwaHkgY2xhc3NOYW1lPVwidmFsXCIgZm9udFdlaWdodD17NjAwfT5cbiAgICAgICAgICAgICAgQ0RDXG4gICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSBjbGFzc05hbWU9XCJsYmxcIj5Tb3VyY2U8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICBjbGFzc05hbWU9XCJ2YWxcIlxuICAgICAgICAgICAgICBzeD17eyB3aGl0ZVNwYWNlOiB7IHhzOiBcIm5vcm1hbFwiLCBzbTogXCJub3dyYXBcIiB9IH19XG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIHtjb25uZWN0b3JOYW1lIHx8IFwi4oCUXCJ9XG4gICAgICAgICAgICAgIHtjb25uZWN0b3JUeXBlID8gYCDCtyAke2Nvbm5lY3RvclR5cGV9YCA6IFwiXCJ9XG4gICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSBjbGFzc05hbWU9XCJsYmxcIj5EZXN0aW5hdGlvbjwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgIGNsYXNzTmFtZT1cInZhbFwiXG4gICAgICAgICAgICAgIHN4PXt7IHdoaXRlU3BhY2U6IHsgeHM6IFwibm9ybWFsXCIsIHNtOiBcIm5vd3JhcFwiIH0gfX1cbiAgICAgICAgICAgID5cbiAgICAgICAgICAgICAge2Rlc3ROYW1lIHx8IFwi4oCUXCJ9XG4gICAgICAgICAgICAgIHtkZXN0VHlwZSA/IGAgwrcgJHtkZXN0VHlwZX1gIDogXCJcIn1cbiAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgIDxUeXBvZ3JhcGh5IGNsYXNzTmFtZT1cImxibFwiPkRhdGFzZXQ8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSBjbGFzc05hbWU9XCJ2YWxcIiBzeD17eyBmb250RmFtaWx5OiBcIm1vbm9zcGFjZVwiIH19PlxuICAgICAgICAgICAgICB7ZGF0YXNldCB8fCBcIuKAlFwifVxuICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPFR5cG9ncmFwaHkgY2xhc3NOYW1lPVwibGJsXCI+V2ViaG9vazwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgICAgY2xhc3NOYW1lPVwidmFsXCJcbiAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICBkaXNwbGF5OiBcImZsZXhcIixcbiAgICAgICAgICAgICAgICBhbGlnbkl0ZW1zOiBcImNlbnRlclwiLFxuICAgICAgICAgICAgICAgIGdhcDogMC41LFxuICAgICAgICAgICAgICAgIHdpZHRoOiBcIm1pbigxMDAlLCA2ODBweClcIixcbiAgICAgICAgICAgICAgICBtaW5XaWR0aDogMCxcbiAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICB0aXRsZT17d2ViaG9va0VuZHBvaW50IHx8IFwiXCJ9XG4gICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgIGZvbnRGYW1pbHk6IFwibW9ub3NwYWNlXCIsXG4gICAgICAgICAgICAgICAgICBmb250U2l6ZTogXCIwLjY4cmVtXCIsXG4gICAgICAgICAgICAgICAgICBvcGFjaXR5OiAwLjc1LFxuICAgICAgICAgICAgICAgICAgZmxleDogMSxcbiAgICAgICAgICAgICAgICAgIG1pbldpZHRoOiAwLFxuICAgICAgICAgICAgICAgICAgb3ZlcmZsb3c6IFwiaGlkZGVuXCIsXG4gICAgICAgICAgICAgICAgICB0ZXh0T3ZlcmZsb3c6IFwiZWxsaXBzaXNcIixcbiAgICAgICAgICAgICAgICAgIHdoaXRlU3BhY2U6IFwibm93cmFwXCIsXG4gICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgIHt3ZWJob29rRW5kcG9pbnQgfHwgXCLigJRcIn1cbiAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICA8VG9vbHRpcCB0aXRsZT17d2ViaG9va0NvcGllZCA/IFwiQ29waWVkXCIgOiBcIkNvcHkgVVJMXCJ9PlxuICAgICAgICAgICAgICAgIDxzcGFuPlxuICAgICAgICAgICAgICAgICAgPEljb25CdXR0b25cbiAgICAgICAgICAgICAgICAgICAgc2l6ZT1cInNtYWxsXCJcbiAgICAgICAgICAgICAgICAgICAgb25DbGljaz17Y29weVdlYmhvb2tVcmx9XG4gICAgICAgICAgICAgICAgICAgIGRpc2FibGVkPXshd2ViaG9va0VuZHBvaW50fVxuICAgICAgICAgICAgICAgICAgICBhcmlhLWxhYmVsPVwiQ29weSB3ZWJob29rIFVSTFwiXG4gICAgICAgICAgICAgICAgICAgIHN4PXt7IHA6IDAuMjUgfX1cbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgPENvcHlJY29uIHN4PXt7IGZvbnRTaXplOiAxNCB9fSAvPlxuICAgICAgICAgICAgICAgICAgPC9JY29uQnV0dG9uPlxuICAgICAgICAgICAgICAgIDwvc3Bhbj5cbiAgICAgICAgICAgICAgPC9Ub29sdGlwPlxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSBjbGFzc05hbWU9XCJsYmxcIj5DcmVhdGVkPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPFR5cG9ncmFwaHkgY2xhc3NOYW1lPVwidmFsXCI+XG4gICAgICAgICAgICAgIHtjdXJyZW50Rmxvdz8uY3JlYXRlZEF0XG4gICAgICAgICAgICAgICAgPyBuZXcgRGF0ZShjdXJyZW50Rmxvdy5jcmVhdGVkQXQpLnRvTG9jYWxlU3RyaW5nKClcbiAgICAgICAgICAgICAgICA6IFwi4oCUXCJ9XG4gICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSBjbGFzc05hbWU9XCJsYmxcIj5VcGRhdGVkPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPFR5cG9ncmFwaHkgY2xhc3NOYW1lPVwidmFsXCI+XG4gICAgICAgICAgICAgIHtjdXJyZW50Rmxvdz8udXBkYXRlZEF0XG4gICAgICAgICAgICAgICAgPyBuZXcgRGF0ZShjdXJyZW50Rmxvdy51cGRhdGVkQXQpLnRvTG9jYWxlU3RyaW5nKClcbiAgICAgICAgICAgICAgICA6IFwi4oCUXCJ9XG4gICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAgICB7LyogTWV0cmljIGNhcmRzICovfVxuICAgICAgICAgIHtzdW1tYXJ5ID8gKFxuICAgICAgICAgICAgPD5cbiAgICAgICAgICAgICAgPEJveFxuICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICBkaXNwbGF5OiBcImdyaWRcIixcbiAgICAgICAgICAgICAgICAgIGdyaWRUZW1wbGF0ZUNvbHVtbnM6IGByZXBlYXQoJHtrcGlDb2x1bW5Db3VudH0sIG1pbm1heCgwLCAxZnIpKWAsXG4gICAgICAgICAgICAgICAgICBnYXA6IHsgeHM6IDEsIHNtOiAxLjUgfSxcbiAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgey8qIFN0cmVhbSBzdGF0dXMgKi99XG4gICAgICAgICAgICAgICAgPEJveFxuICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyUmFkaXVzOiAxLjUsXG4gICAgICAgICAgICAgICAgICAgIHA6IDEuNSxcbiAgICAgICAgICAgICAgICAgICAgYmdjb2xvcjogXCJhY3Rpb24uaG92ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgbWluV2lkdGg6IDAsXG4gICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJjYXB0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiXG4gICAgICAgICAgICAgICAgICAgIHN4PXt7IGxldHRlclNwYWNpbmc6IDAuMywgZm9udFNpemU6IFwiMC42OHJlbVwiIH19XG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIFN0cmVhbSBzdGF0dXNcbiAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgIDxCb3ggc3g9e3sgbXQ6IDAuNSB9fT5cbiAgICAgICAgICAgICAgICAgICAgPENoaXBcbiAgICAgICAgICAgICAgICAgICAgICBzaXplPVwic21hbGxcIlxuICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPXtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1bW1hcnkuc3luY1N0YXRlLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1bW1hcnkuc3luY1N0YXRlLnNsaWNlKDEpXG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgIGNvbG9yPXtzdGF0ZUNvbG9yKHN1bW1hcnkuc3luY1N0YXRlKX1cbiAgICAgICAgICAgICAgICAgICAgICBpY29uPXtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1bW1hcnkuc3luY1N0YXRlID09PSBcImxpdmVcIiA/IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPENoZWNrSWNvbiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgKSA6IHN1bW1hcnkuc3luY1N0YXRlID09PSBcImRlZ3JhZGVkXCIgPyAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxFcnJvckljb24gLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxTeW5jSWNvbiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICBzeD17eyBmb250V2VpZ2h0OiA2MDAsIGZvbnRTaXplOiBcIjAuNzJyZW1cIiB9fVxuICAgICAgICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgIGNvbG9yPVwidGV4dC5zZWNvbmRhcnlcIlxuICAgICAgICAgICAgICAgICAgICBzeD17eyBkaXNwbGF5OiBcImJsb2NrXCIsIG10OiAwLjgsIGZvbnRTaXplOiBcIjAuNjVyZW1cIiB9fVxuICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICBGcmVzaG5lc3M6IHtmcmVzaG5lc3NTdW1tYXJ5fVxuICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgIDwvQm94PlxuICAgICAgICAgICAgICAgIHsvKiBCYWNrZmlsbCBzdGF0dXMgKi99XG4gICAgICAgICAgICAgICAgPEJveFxuICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyUmFkaXVzOiAxLjUsXG4gICAgICAgICAgICAgICAgICAgIHA6IDEuNSxcbiAgICAgICAgICAgICAgICAgICAgYmdjb2xvcjogXCJhY3Rpb24uaG92ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgbWluV2lkdGg6IDAsXG4gICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJjYXB0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiXG4gICAgICAgICAgICAgICAgICAgIHN4PXt7IGxldHRlclNwYWNpbmc6IDAuMywgZm9udFNpemU6IFwiMC42OHJlbVwiIH19XG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIEJhY2tmaWxsIHN0YXR1c1xuICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodD17NzAwfVxuICAgICAgICAgICAgICAgICAgICBzeD17eyBtdDogMC4yNSwgZm9udFNpemU6IFwiMC45NXJlbVwiIH19XG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIHtzdW1tYXJ5LmJhY2tsb2dDb3VudCA+IDBcbiAgICAgICAgICAgICAgICAgICAgICA/IGAke3N1bW1hcnkuYmFja2xvZ0NvdW50LnRvTG9jYWxlU3RyaW5nKCl9IHBlbmRpbmdgXG4gICAgICAgICAgICAgICAgICAgICAgOiBzdW1tYXJ5LnN5bmNTdGF0ZSA9PT0gXCJiYWNrZmlsbFwiXG4gICAgICAgICAgICAgICAgICAgICAgICA/IFwiSW4gcHJvZ3Jlc3NcIlxuICAgICAgICAgICAgICAgICAgICAgICAgOiBzdW1tYXJ5Lmxhc3RNYXRlcmlhbGl6ZWRBdFxuICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiQ29tcGxldGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgOiBcIk5vdCBzdGFydGVkXCJ9XG4gICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgICAgey8qIEV2ZW50cyBwcm9jZXNzZWQgKi99XG4gICAgICAgICAgICAgICAgPEJveFxuICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyUmFkaXVzOiAxLjUsXG4gICAgICAgICAgICAgICAgICAgIHA6IDEuNSxcbiAgICAgICAgICAgICAgICAgICAgYmdjb2xvcjogXCJhY3Rpb24uaG92ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgbWluV2lkdGg6IDAsXG4gICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJjYXB0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiXG4gICAgICAgICAgICAgICAgICAgIHN4PXt7IGxldHRlclNwYWNpbmc6IDAuMywgZm9udFNpemU6IFwiMC42OHJlbVwiIH19XG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIEV2ZW50cyBtYXRlcmlhbGl6ZWRcbiAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ9ezcwMH1cbiAgICAgICAgICAgICAgICAgICAgc3g9e3sgbXQ6IDAuMjUsIGZvbnRTaXplOiBcIjAuOTVyZW1cIiB9fVxuICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICB7KHN1bW1hcnkuYXBwbGllZENvdW50ID8/IDApLnRvTG9jYWxlU3RyaW5nKCl9XG4gICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgIGNvbG9yPVwidGV4dC5zZWNvbmRhcnlcIlxuICAgICAgICAgICAgICAgICAgICBzeD17eyBkaXNwbGF5OiBcImJsb2NrXCIsIG10OiAwLjI1LCBmb250U2l6ZTogXCIwLjY1cmVtXCIgfX1cbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAge3N1bW1hcnkubGFzdFdlYmhvb2tBdFxuICAgICAgICAgICAgICAgICAgICAgID8gYExhc3Qgd2ViaG9vayAke25ldyBEYXRlKHN1bW1hcnkubGFzdFdlYmhvb2tBdCkudG9Mb2NhbGVTdHJpbmcoKX1gXG4gICAgICAgICAgICAgICAgICAgICAgOiBcIk5vIGV2ZW50cyB5ZXRcIn1cbiAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICAgICB7LyogRmFpbGVkICovfVxuICAgICAgICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMS41LFxuICAgICAgICAgICAgICAgICAgICBwOiAxLjUsXG4gICAgICAgICAgICAgICAgICAgIGJnY29sb3I6XG4gICAgICAgICAgICAgICAgICAgICAgc3VtbWFyeS5mYWlsZWRDb3VudCA+IDAgPyBcImVycm9yLjUwXCIgOiBcImFjdGlvbi5ob3ZlclwiLFxuICAgICAgICAgICAgICAgICAgICBtaW5XaWR0aDogMCxcbiAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cImNhcHRpb25cIlxuICAgICAgICAgICAgICAgICAgICBjb2xvcj1cInRleHQuc2Vjb25kYXJ5XCJcbiAgICAgICAgICAgICAgICAgICAgc3g9e3sgbGV0dGVyU3BhY2luZzogMC4zLCBmb250U2l6ZTogXCIwLjY4cmVtXCIgfX1cbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgRmFpbGVkIC8gZHJvcHBlZFxuICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodD17NzAwfVxuICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgIG10OiAwLjI1LFxuICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuOTVyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICBjb2xvcjpcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1bW1hcnkuZmFpbGVkQ291bnQgPiAwID8gXCJlcnJvci5tYWluXCIgOiBcInRleHQucHJpbWFyeVwiLFxuICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICB7c3VtbWFyeS5mYWlsZWRDb3VudC50b0xvY2FsZVN0cmluZygpfSAve1wiIFwifVxuICAgICAgICAgICAgICAgICAgICB7KHN1bW1hcnkuZHJvcHBlZENvdW50ID8/IDApLnRvTG9jYWxlU3RyaW5nKCl9XG4gICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgIGNvbG9yPVwidGV4dC5zZWNvbmRhcnlcIlxuICAgICAgICAgICAgICAgICAgICBzeD17eyBkaXNwbGF5OiBcImJsb2NrXCIsIG10OiAwLjI1LCBmb250U2l6ZTogXCIwLjY1cmVtXCIgfX1cbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAge2ZhaWxlZERyb3BwZWREZXRhaWx9XG4gICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgIDwvQm94PlxuXG4gICAgICAgICAgICAgIHsvKiBMaXZlIGV4ZWN1dGlvbiBwcm9ncmVzcyAqL31cbiAgICAgICAgICAgICAge3N0YXR1cyA9PT0gXCJydW5uaW5nXCIgJiYgKFxuICAgICAgICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMS41LFxuICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDEsXG4gICAgICAgICAgICAgICAgICAgIGJvcmRlckNvbG9yOiBcImRpdmlkZXJcIixcbiAgICAgICAgICAgICAgICAgICAgcDogMS41LFxuICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICA8Qm94XG4gICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogXCJmbGV4XCIsXG4gICAgICAgICAgICAgICAgICAgICAgYWxpZ25JdGVtczogXCJjZW50ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICBnYXA6IDEsXG4gICAgICAgICAgICAgICAgICAgICAgbWI6IDEsXG4gICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgIDxTeW5jSWNvblxuICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICBmb250U2l6ZTogMTYsXG4gICAgICAgICAgICAgICAgICAgICAgICBhbmltYXRpb246IFwic3BpbiAxcyBsaW5lYXIgaW5maW5pdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQGtleWZyYW1lcyBzcGluXCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgZnJvbTogeyB0cmFuc2Zvcm06IFwicm90YXRlKDBkZWcpXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgdG86IHsgdHJhbnNmb3JtOiBcInJvdGF0ZSgzNjBkZWcpXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodD17NjAwfVxuICAgICAgICAgICAgICAgICAgICAgIHN4PXt7IHRleHRUcmFuc2Zvcm06IFwidXBwZXJjYXNlXCIsIGxldHRlclNwYWNpbmc6IDAuNSB9fVxuICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgQmFja2ZpbGwgaW4gcHJvZ3Jlc3NcbiAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICB7c3RhcnRlZEF0ICYmIChcbiAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cImNhcHRpb25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiXG4gICAgICAgICAgICAgICAgICAgICAgICBzeD17eyBtbDogXCJhdXRvXCIgfX1cbiAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICBTdGFydGVkIHtuZXcgRGF0ZShzdGFydGVkQXQpLnRvTG9jYWxlVGltZVN0cmluZygpfVxuICAgICAgICAgICAgICAgICAgICAgICAge2xhc3RIZWFydGJlYXRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPyBgIMK3IHVwZGF0ZWQgJHtuZXcgRGF0ZShsYXN0SGVhcnRiZWF0KS50b0xvY2FsZVRpbWVTdHJpbmcoKX1gXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDogXCJcIn1cbiAgICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICAgICAgIDxMaW5lYXJQcm9ncmVzcyBzeD17eyBtYjogMS41LCBib3JkZXJSYWRpdXM6IDEgfX0gLz5cblxuICAgICAgICAgICAgICAgICAgey8qIFBlci1lbnRpdHkgcHJvZ3Jlc3MgKi99XG4gICAgICAgICAgICAgICAgICB7T2JqZWN0LmtleXMoZW50aXR5U3RhdHMpLmxlbmd0aCA+IDAgJiYgKFxuICAgICAgICAgICAgICAgICAgICA8VGFibGVDb250YWluZXJcbiAgICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgICAgbWI6IDEuNSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlckNvbG9yOiBcImRpdmlkZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgPFRhYmxlIHNpemU9XCJzbWFsbFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlSGVhZD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlUm93XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJnY29sb3I6IFwiYWN0aW9uLmhvdmVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIiYgdGhcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250U2l6ZTogXCIwLjY4cmVtXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ6IDYwMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6IFwidGV4dC5zZWNvbmRhcnlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGV4dFRyYW5zZm9ybTogXCJ1cHBlcmNhc2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0dGVyU3BhY2luZzogMC40LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBweTogMC41LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBweDogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGw+RW50aXR5PC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+UmVjb3JkczwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgYWxpZ249XCJjZW50ZXJcIj5TdGF0dXM8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZVJvdz5cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVIZWFkPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQm9keT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAge1tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi5uZXcgU2V0KFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLnBsYW5uZWRFbnRpdGllcyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLk9iamVjdC5rZXlzKGVudGl0eVN0YXRzKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLk9iamVjdC5rZXlzKGVudGl0eVN0YXR1cyksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgIF1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAubWFwKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5ID0+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFtlbnRpdHksIGVudGl0eVN0YXRzW2VudGl0eV0gfHwgMF0gYXMgY29uc3QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5zb3J0KChbLCBhXSwgWywgYl0pID0+IGIgLSBhKVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC5tYXAoKFtlbnRpdHksIGNvdW50XSkgPT4gKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlUm93XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleT17ZW50aXR5fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzeD17eyBcIiY6bGFzdC1jaGlsZCB0ZFwiOiB7IGJvcmRlckJvdHRvbTogMCB9IH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udEZhbWlseTogXCJtb25vc3BhY2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNzVyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHB5OiAwLjUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBweDogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2Zvcm1hdEVudGl0eUFzVGFibGVOYW1lKGVudGl0eSl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpZ249XCJyaWdodFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ6IDYwMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNzhyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHB5OiAwLjUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBweDogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2NvdW50LnRvTG9jYWxlU3RyaW5nKCl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpZ249XCJjZW50ZXJcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7IHB5OiAwLjUsIHB4OiAxIH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8Q2hpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2l6ZT1cInNtYWxsXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5U3RhdHVzW2VudGl0eV0gPT09IFwiY29tcGxldGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiZG9uZVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBlbnRpdHlTdGF0dXNbZW50aXR5XSA9PT0gXCJmYWlsZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBcImZhaWxlZFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IGVudGl0eVN0YXR1c1tlbnRpdHldID09PSBcInBlbmRpbmdcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwicGVuZGluZ1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogXCJzeW5jaW5nXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yPXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5U3RhdHVzW2VudGl0eV0gPT09IFwiY29tcGxldGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwic3VjY2Vzc1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBlbnRpdHlTdGF0dXNbZW50aXR5XSA9PT0gXCJmYWlsZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBcImVycm9yXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogZW50aXR5U3RhdHVzW2VudGl0eV0gPT09IFwicGVuZGluZ1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gXCJkZWZhdWx0XCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBcImluZm9cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cIm91dGxpbmVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGhlaWdodDogMjAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNjVyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodDogNTAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVSb3c+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSl9XG4gICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQm9keT5cbiAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlPlxuICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ29udGFpbmVyPlxuICAgICAgICAgICAgICAgICAgKX1cblxuICAgICAgICAgICAgICAgICAgey8qIExpdmUgbG9ncyAqL31cbiAgICAgICAgICAgICAgICAgIHtyZWNlbnRMb2dzLmxlbmd0aCA+IDAgJiYgKFxuICAgICAgICAgICAgICAgICAgICA8Qm94XG4gICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgIG1heEhlaWdodDogMTIwLFxuICAgICAgICAgICAgICAgICAgICAgICAgb3ZlcmZsb3c6IFwiYXV0b1wiLFxuICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyUmFkaXVzOiAxLFxuICAgICAgICAgICAgICAgICAgICAgICAgYmdjb2xvcjogXCJhY3Rpb24uaG92ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHA6IDEsXG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBcImdyaWRcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIGdhcDogMC4yNSxcbiAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAge3JlY2VudExvZ3MubWFwKChsb2csIGlkeCkgPT4gKFxuICAgICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICAgICAga2V5PXtgJHtsb2cudGltZXN0YW1wfS0ke2lkeH1gfVxuICAgICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udEZhbWlseTogXCJtb25vc3BhY2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250U2l6ZTogXCIwLjdyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aGl0ZVNwYWNlOiBcInByZS13cmFwXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2cubGV2ZWwgPT09IFwiZXJyb3JcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiZXJyb3IubWFpblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogXCJ0ZXh0LnNlY29uZGFyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICBbe25ldyBEYXRlKGxvZy50aW1lc3RhbXApLnRvTG9jYWxlVGltZVN0cmluZygpfV17XCIgXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIHtmb3JtYXRFeGVjdXRpb25Mb2cobG9nKX1cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICApKX1cbiAgICAgICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgICAgICApfVxuXG4gICAgICAgICAgICAgICAgICB7cmVjZW50TG9ncy5sZW5ndGggPT09IDAgJiZcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXMoZW50aXR5U3RhdHMpLmxlbmd0aCA9PT0gMCAmJiAoXG4gICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHkgdmFyaWFudD1cImNhcHRpb25cIiBjb2xvcj1cInRleHQuc2Vjb25kYXJ5XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICBXYWl0aW5nIGZvciBiYWNrZmlsbCB0byBzdGFydCBwcm9kdWNpbmcgZGF0YS4uLlxuICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICAgKX1cblxuICAgICAgICAgICAgICB7c3RhdHVzID09PSBcImZhaWxlZFwiICYmIGVycm9yICYmIChcbiAgICAgICAgICAgICAgICA8QWxlcnRcbiAgICAgICAgICAgICAgICAgIHNldmVyaXR5PVwiZXJyb3JcIlxuICAgICAgICAgICAgICAgICAgc3g9e3sgYm9yZGVyUmFkaXVzOiAxLjUgfX1cbiAgICAgICAgICAgICAgICAgIG9uQ2xvc2U9eygpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgc2V0U3RhdHVzKG51bGwpO1xuICAgICAgICAgICAgICAgICAgICBzZXRFcnJvcihudWxsKTtcbiAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgQmFja2ZpbGwgZmFpbGVkOiB7ZXJyb3J9XG4gICAgICAgICAgICAgICAgPC9BbGVydD5cbiAgICAgICAgICAgICAgKX1cblxuICAgICAgICAgICAgICB7LyogRW50aXR5IHRhYmxlICovfVxuICAgICAgICAgICAgICA8Qm94PlxuICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICBjb2xvcj1cInRleHQuc2Vjb25kYXJ5XCJcbiAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgIG1iOiAwLjc1LFxuICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBcImJsb2NrXCIsXG4gICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ6IDYwMCxcbiAgICAgICAgICAgICAgICAgICAgbGV0dGVyU3BhY2luZzogMC41LFxuICAgICAgICAgICAgICAgICAgICB0ZXh0VHJhbnNmb3JtOiBcInVwcGVyY2FzZVwiLFxuICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICB7c3VtbWFyeS5lbnRpdHlDb3VudHMubGVuZ3RofSBlbnRpdGllc1xuICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICA8VGFibGVDb250YWluZXJcbiAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMS41LFxuICAgICAgICAgICAgICAgICAgICBib3JkZXI6IDEsXG4gICAgICAgICAgICAgICAgICAgIGJvcmRlckNvbG9yOiBcImRpdmlkZXJcIixcbiAgICAgICAgICAgICAgICAgICAgd2lkdGg6IFwiMTAwJVwiLFxuICAgICAgICAgICAgICAgICAgICBtYXhXaWR0aDogXCIxMDAlXCIsXG4gICAgICAgICAgICAgICAgICAgIG92ZXJmbG93WDogXCJhdXRvXCIsXG4gICAgICAgICAgICAgICAgICAgIG1heEhlaWdodDogeyB4czogMzIwLCBzbTogMzgwLCBsZzogNTIwIH0sXG4gICAgICAgICAgICAgICAgICAgIFwiJiAuTXVpVGFibGUtcm9vdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgbWluV2lkdGg6IDkwMCxcbiAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgXCImIC5NdWlUYWJsZUNlbGwtcm9vdFwiOiB7XG4gICAgICAgICAgICAgICAgICAgICAgcHk6IHsgeHM6IDAuNjUsIHNtOiAwLjc1IH0sXG4gICAgICAgICAgICAgICAgICAgICAgcHg6IHsgeHM6IDAuNzUsIHNtOiAxIH0sXG4gICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU6IHsgeHM6IFwiMC43MnJlbVwiLCBzbTogXCIwLjc4cmVtXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgICB3aGl0ZVNwYWNlOiBcIm5vd3JhcFwiLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICA8VGFibGUgc3RpY2t5SGVhZGVyIHNpemU9XCJzbWFsbFwiPlxuICAgICAgICAgICAgICAgICAgICA8VGFibGVIZWFkPlxuICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZVJvd1xuICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgYmdjb2xvcjogXCJhY3Rpb24uaG92ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgXCImIHRoXCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250V2VpZ2h0OiA2MDAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU6IFwiMC43cmVtXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6IFwidGV4dC5zZWNvbmRhcnlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0ZXh0VHJhbnNmb3JtOiBcInVwcGVyY2FzZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldHRlclNwYWNpbmc6IDAuNSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3JkZXJCb3R0b206IDEsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYm9yZGVyQ29sb3I6IFwiZGl2aWRlclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsPkVudGl0eSBuYW1lPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsPlN0YXR1czwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbD5CYWNrZmlsbDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+QXBwbGllZDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+UXVldWVkPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5GYWlsZWQ8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgYWxpZ249XCJyaWdodFwiPkRyb3BwZWQ8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgYWxpZ249XCJyaWdodFwiPkxhZzwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+TGFzdCBtYXRlcmlhbGl6ZWQ8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlUm93PlxuICAgICAgICAgICAgICAgICAgICA8L1RhYmxlSGVhZD5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQm9keT5cbiAgICAgICAgICAgICAgICAgICAgICB7c3VtbWFyeS5lbnRpdHlDb3VudHMubWFwKChlbnRpdHk6IGFueSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc3Qgb2JqU3RhdHVzID0gZW50aXR5T2JqZWN0U3RhdHVzKGVudGl0eSk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVSb3dcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk9e2VudGl0eS5lbnRpdHl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaG92ZXJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzeD17eyBcIiY6bGFzdC1jaGlsZCB0ZFwiOiB7IGJvcmRlckJvdHRvbTogMCB9IH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250RmFtaWx5OiBcIm1vbm9zcGFjZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNzhyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250V2VpZ2h0OiA1MDAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtmb3JtYXRFbnRpdHlBc1RhYmxlTmFtZShlbnRpdHkuZW50aXR5KX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPENoaXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2l6ZT1cInNtYWxsXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWw9e29ialN0YXR1cy5sYWJlbH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9e29ialN0YXR1cy5jb2xvcn1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cIm91dGxpbmVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBoZWlnaHQ6IDIyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuN3JlbVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ6IDUwMCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplPVwiMC43OHJlbVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yPXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlCYWNrZmlsbFN0YXR1cyhlbnRpdHkpID09PSBcIkZhaWxlZFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiZXJyb3IubWFpblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IFwidGV4dC5wcmltYXJ5XCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7ZW50aXR5QmFja2ZpbGxTdGF0dXMoZW50aXR5KX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ9e2VudGl0eS5hcHBsaWVkQ291bnQgPiAwID8gNjAwIDogNDAwfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcj17XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFwcGxpZWRDb3VudCA+IDBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gXCJzdWNjZXNzLm1haW5cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBcInRleHQucHJpbWFyeVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU9XCIwLjhyZW1cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7KGVudGl0eS5hcHBsaWVkQ291bnQgPz8gMCkudG9Mb2NhbGVTdHJpbmcoKX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtlbnRpdHkuYmFja2xvZ0NvdW50fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgYWxpZ249XCJyaWdodFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodD17ZW50aXR5LmZhaWxlZENvdW50ID4gMCA/IDcwMCA6IDQwMH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9e1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5mYWlsZWRDb3VudCA+IDBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gXCJlcnJvci5tYWluXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogXCJ0ZXh0LnByaW1hcnlcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplPVwiMC44cmVtXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2VudGl0eS5mYWlsZWRDb3VudH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRXZWlnaHQ9e2VudGl0eS5kcm9wcGVkQ291bnQgPiAwID8gNzAwIDogNDAwfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcj17XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmRyb3BwZWRDb3VudCA+IDBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gXCJ3YXJuaW5nLm1haW5cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBcInRleHQucHJpbWFyeVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU9XCIwLjhyZW1cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7ZW50aXR5LmRyb3BwZWRDb3VudCA/PyAwfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgYWxpZ249XCJyaWdodFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2VudGl0eUxhZ0xhYmVsKGVudGl0eSl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yPVwidGV4dC5zZWNvbmRhcnlcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7ZW50aXR5Lmxhc3RNYXRlcmlhbGl6ZWRBdFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gbmV3IERhdGUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5sYXN0TWF0ZXJpYWxpemVkQXQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLnRvTG9jYWxlU3RyaW5nKClcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IFwi4oCUXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVSb3c+XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgIH0pfVxuICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQm9keT5cbiAgICAgICAgICAgICAgICAgIDwvVGFibGU+XG4gICAgICAgICAgICAgICAgPC9UYWJsZUNvbnRhaW5lcj5cbiAgICAgICAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAgICAgICAgey8qIERpYWdub3N0aWNzICovfVxuICAgICAgICAgICAgICB7c2hvd0RpYWdub3N0aWNzICYmIGNkY0RpYWdub3N0aWNzICYmIChcbiAgICAgICAgICAgICAgICA8Qm94XG4gICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBcImdyaWRcIixcbiAgICAgICAgICAgICAgICAgICAgZ2FwOiAyLFxuICAgICAgICAgICAgICAgICAgICBib3JkZXJSYWRpdXM6IDEuNSxcbiAgICAgICAgICAgICAgICAgICAgYm9yZGVyOiAxLFxuICAgICAgICAgICAgICAgICAgICBib3JkZXJDb2xvcjogXCJkaXZpZGVyXCIsXG4gICAgICAgICAgICAgICAgICAgIHA6IDIsXG4gICAgICAgICAgICAgICAgICAgIGJnY29sb3I6IFwiYmFja2dyb3VuZC5kZWZhdWx0XCIsXG4gICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJjYXB0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiXG4gICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodDogNjAwLFxuICAgICAgICAgICAgICAgICAgICAgIGxldHRlclNwYWNpbmc6IDAuNSxcbiAgICAgICAgICAgICAgICAgICAgICB0ZXh0VHJhbnNmb3JtOiBcInVwcGVyY2FzZVwiLFxuICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICBEaWFnbm9zdGljc1xuICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuXG4gICAgICAgICAgICAgICAgICB7LyogVHJhbnNpdGlvbnMgKi99XG4gICAgICAgICAgICAgICAgICA8Qm94PlxuICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJzdWJ0aXRsZTJcIlxuICAgICAgICAgICAgICAgICAgICAgIHN4PXt7IG1iOiAwLjc1LCBmb250U2l6ZTogXCIwLjhyZW1cIiB9fVxuICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgVHJhbnNpdGlvbiB0aW1lbGluZVxuICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgICAgbWF4SGVpZ2h0OiAxODAsXG4gICAgICAgICAgICAgICAgICAgICAgICBvdmVyZmxvdzogXCJhdXRvXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBib3JkZXJSYWRpdXM6IDEsXG4gICAgICAgICAgICAgICAgICAgICAgICBiZ2NvbG9yOiBcImFjdGlvbi5ob3ZlclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcDogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IFwiZ3JpZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2FwOiAwLjUsXG4gICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgIHtjZGNEaWFnbm9zdGljcy50cmFuc2l0aW9uc1xuICAgICAgICAgICAgICAgICAgICAgICAgLnNsaWNlKDAsIDIwKVxuICAgICAgICAgICAgICAgICAgICAgICAgLm1hcCgodHJhbnNpdGlvbjogYW55LCBpbmRleDogbnVtYmVyKSA9PiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5PXtgJHt0cmFuc2l0aW9uLmF0fS0ke2luZGV4fWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cImNhcHRpb25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250RmFtaWx5OiBcIm1vbm9zcGFjZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU6IFwiMC43MnJlbVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcG9uZW50PVwic3BhblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwiY2FwdGlvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcj1cInRleHQuc2Vjb25kYXJ5XCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRGYW1pbHk6IFwibW9ub3NwYWNlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNzJyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge25ldyBEYXRlKHRyYW5zaXRpb24uYXQpLnRvTG9jYWxlU3RyaW5nKCl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcIiAgXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge3RyYW5zaXRpb24uZnJvbVN0YXRlfSDihpJ7XCIgXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPHN0cm9uZz57dHJhbnNpdGlvbi50b1N0YXRlfTwvc3Ryb25nPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcIiAgXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBvbmVudD1cInNwYW5cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cImNhcHRpb25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250RmFtaWx5OiBcIm1vbm9zcGFjZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250U2l6ZTogXCIwLjY4cmVtXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICh7dHJhbnNpdGlvbi5ldmVudH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHt0cmFuc2l0aW9uLnJlYXNvblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGA6ICR7dHJhbnNpdGlvbi5yZWFzb259YFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IFwiXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgICAgICApKX1cbiAgICAgICAgICAgICAgICAgICAgICB7Y2RjRGlhZ25vc3RpY3MudHJhbnNpdGlvbnMubGVuZ3RoID09PSAwICYmIChcbiAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5IHZhcmlhbnQ9XCJjYXB0aW9uXCIgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICBObyB0cmFuc2l0aW9ucyByZWNvcmRlZFxuICAgICAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgICAgIDwvQm94PlxuICAgICAgICAgICAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAgICAgICAgICAgIHsvKiBDdXJzb3JzICovfVxuICAgICAgICAgICAgICAgICAgPEJveD5cbiAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwic3VidGl0bGUyXCJcbiAgICAgICAgICAgICAgICAgICAgICBzeD17eyBtYjogMC43NSwgZm9udFNpemU6IFwiMC44cmVtXCIgfX1cbiAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgIEVudGl0eSBjdXJzb3JzXG4gICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ29udGFpbmVyXG4gICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlcjogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlckNvbG9yOiBcImRpdmlkZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgPFRhYmxlIHNpemU9XCJzbWFsbFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlSGVhZD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlUm93XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJnY29sb3I6IFwiYWN0aW9uLmhvdmVyXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcIiYgdGhcIjoge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250U2l6ZTogXCIwLjY4cmVtXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yOiBcInRleHQuc2Vjb25kYXJ5XCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRleHRUcmFuc2Zvcm06IFwidXBwZXJjYXNlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldHRlclNwYWNpbmc6IDAuNCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFdlaWdodDogNjAwLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbD5FbnRpdHk8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5Jbmdlc3Qgc2VxPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBNYXRlcmlhbGl6ZWQgc2VxXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+QmFja2xvZzwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgYWxpZ249XCJyaWdodFwiPkxhZzwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlUm93PlxuICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUhlYWQ+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVCb2R5PlxuICAgICAgICAgICAgICAgICAgICAgICAgICB7Y2RjRGlhZ25vc3RpY3MuY3Vyc29ycy5tYXAoKGN1cnNvcjogYW55KSA9PiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlUm93XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk9e2N1cnNvci5lbnRpdHl9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzeD17eyBcIiY6bGFzdC1jaGlsZCB0ZFwiOiB7IGJvcmRlckJvdHRvbTogMCB9IH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRGYW1pbHk6IFwibW9ub3NwYWNlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU6IFwiMC43NXJlbVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7Y3Vyc29yLmVudGl0eX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtjdXJzb3IubGFzdEluZ2VzdFNlcX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtjdXJzb3IubGFzdE1hdGVyaWFsaXplZFNlcX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtjdXJzb3IuYmFja2xvZ0NvdW50fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2N1cnNvci5sYWdTZWNvbmRzID8/IFwi4oCUXCJ9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlUm93PlxuICAgICAgICAgICAgICAgICAgICAgICAgICApKX1cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVCb2R5PlxuICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGU+XG4gICAgICAgICAgICAgICAgICAgIDwvVGFibGVDb250YWluZXI+XG4gICAgICAgICAgICAgICAgICA8L0JveD5cblxuICAgICAgICAgICAgICAgICAgey8qIFJlY2VudCBldmVudHMgKi99XG4gICAgICAgICAgICAgICAgICA8Qm94PlxuICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJzdWJ0aXRsZTJcIlxuICAgICAgICAgICAgICAgICAgICAgIHN4PXt7IG1iOiAwLjc1LCBmb250U2l6ZTogXCIwLjhyZW1cIiB9fVxuICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgUmVjZW50IGV2ZW50c1xuICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgICAgICAgICAgICBzeD17e1xuICAgICAgICAgICAgICAgICAgICAgICAgbWF4SGVpZ2h0OiAyMDAsXG4gICAgICAgICAgICAgICAgICAgICAgICBvdmVyZmxvdzogXCJhdXRvXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBib3JkZXJSYWRpdXM6IDEsXG4gICAgICAgICAgICAgICAgICAgICAgICBiZ2NvbG9yOiBcImFjdGlvbi5ob3ZlclwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcDogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IFwiZ3JpZFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgZ2FwOiAwLjUsXG4gICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgIHtjZGNEaWFnbm9zdGljcy5yZWNlbnRFdmVudHNcbiAgICAgICAgICAgICAgICAgICAgICAgIC5zbGljZSgwLCAyMClcbiAgICAgICAgICAgICAgICAgICAgICAgIC5tYXAoKGV2ZW50OiBhbnksIGluZGV4OiBudW1iZXIpID0+IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgPEJveFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleT17YCR7ZXZlbnQuaW5nZXN0U2VxfS0ke2luZGV4fWB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IFwiZmxleFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWxpZ25JdGVtczogXCJjZW50ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGdhcDogMC43NSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJjYXB0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRGYW1pbHk6IFwibW9ub3NwYWNlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNzJyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I6IFwidGV4dC5zZWNvbmRhcnlcIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbWluV2lkdGg6IDMyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAje2V2ZW50LmluZ2VzdFNlcX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPFR5cG9ncmFwaHlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJjYXB0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRGYW1pbHk6IFwibW9ub3NwYWNlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZvbnRTaXplOiBcIjAuNzJyZW1cIixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmxleDogMSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge2V2ZW50LmVudGl0eX0gPHN0cm9uZz57ZXZlbnQub3BlcmF0aW9ufTwvc3Ryb25nPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8Q2hpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc2l6ZT1cInNtYWxsXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPXtldmVudC5tYXRlcmlhbGl6YXRpb25TdGF0dXN9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcj17XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV2ZW50Lm1hdGVyaWFsaXphdGlvblN0YXR1cyA9PT0gXCJhcHBsaWVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwic3VjY2Vzc1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBldmVudC5tYXRlcmlhbGl6YXRpb25TdGF0dXMgPT09IFwiZmFpbGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gXCJlcnJvclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IFwiZGVmYXVsdFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwib3V0bGluZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaGVpZ2h0OiAxOCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU6IFwiMC42MnJlbVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmb250V2VpZ2h0OiA1MDAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMC43NSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH19XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cImNhcHRpb25cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZm9udFNpemU6IFwiMC42OHJlbVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcjogXCJ0ZXh0LnNlY29uZGFyeVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7ZXZlbnQuc291cmNlfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgICAgICAgICAgICApKX1cbiAgICAgICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgIDwvPlxuICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICA8Qm94XG4gICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgZGlzcGxheTogXCJmbGV4XCIsXG4gICAgICAgICAgICAgICAgYWxpZ25JdGVtczogXCJjZW50ZXJcIixcbiAgICAgICAgICAgICAgICBnYXA6IDEsXG4gICAgICAgICAgICAgICAgcHk6IDQsXG4gICAgICAgICAgICAgICAganVzdGlmeUNvbnRlbnQ6IFwiY2VudGVyXCIsXG4gICAgICAgICAgICAgIH19XG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIDxTeW5jSWNvblxuICAgICAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgICAgICBmb250U2l6ZTogMTYsXG4gICAgICAgICAgICAgICAgICBhbmltYXRpb246IFwic3BpbiAxcyBsaW5lYXIgaW5maW5pdGVcIixcbiAgICAgICAgICAgICAgICAgIFwiQGtleWZyYW1lcyBzcGluXCI6IHtcbiAgICAgICAgICAgICAgICAgICAgZnJvbTogeyB0cmFuc2Zvcm06IFwicm90YXRlKDBkZWcpXCIgfSxcbiAgICAgICAgICAgICAgICAgICAgdG86IHsgdHJhbnNmb3JtOiBcInJvdGF0ZSgzNjBkZWcpXCIgfSxcbiAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgfX1cbiAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgPFR5cG9ncmFwaHkgdmFyaWFudD1cImJvZHkyXCIgY29sb3I9XCJ0ZXh0LnNlY29uZGFyeVwiPlxuICAgICAgICAgICAgICAgIExvYWRpbmcgQ0RDIHN1bW1hcnkuLi5cbiAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgKX1cbiAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAgey8qIFJlc3luYyBkaWFsb2cgKi99XG4gICAgICAgIDxEaWFsb2dcbiAgICAgICAgICBvcGVuPXtyZXN5bmNEaWFsb2dPcGVufVxuICAgICAgICAgIG9uQ2xvc2U9eygpID0+IHNldFJlc3luY0RpYWxvZ09wZW4oZmFsc2UpfVxuICAgICAgICA+XG4gICAgICAgICAgPERpYWxvZ1RpdGxlPlJlc3luYyBmcm9tIHNjcmF0Y2g8L0RpYWxvZ1RpdGxlPlxuICAgICAgICAgIDxEaWFsb2dDb250ZW50IHN4PXt7IGRpc3BsYXk6IFwiZ3JpZFwiLCBnYXA6IDEsIG1pbldpZHRoOiA0MjAgfX0+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwiYm9keTJcIj5cbiAgICAgICAgICAgICAgVGhpcyB3aWxsIGNsZWFyIENEQyBzdGF0ZSBhbmQgcmVzdGFydCBiYWNrZmlsbC5cbiAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgIDxGb3JtQ29udHJvbExhYmVsXG4gICAgICAgICAgICAgIGNvbnRyb2w9e1xuICAgICAgICAgICAgICAgIDxDaGVja2JveFxuICAgICAgICAgICAgICAgICAgY2hlY2tlZD17ZGVsZXRlRGVzdGluYXRpb259XG4gICAgICAgICAgICAgICAgICBvbkNoYW5nZT17ZXZlbnQgPT4gc2V0RGVsZXRlRGVzdGluYXRpb24oZXZlbnQudGFyZ2V0LmNoZWNrZWQpfVxuICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgbGFiZWw9XCJEZWxldGUgZGVzdGluYXRpb24gdGFibGVzXCJcbiAgICAgICAgICAgIC8+XG4gICAgICAgICAgICA8Rm9ybUNvbnRyb2xMYWJlbFxuICAgICAgICAgICAgICBjb250cm9sPXtcbiAgICAgICAgICAgICAgICA8Q2hlY2tib3hcbiAgICAgICAgICAgICAgICAgIGNoZWNrZWQ9e2NsZWFyV2ViaG9va0V2ZW50c31cbiAgICAgICAgICAgICAgICAgIG9uQ2hhbmdlPXtldmVudCA9PlxuICAgICAgICAgICAgICAgICAgICBzZXRDbGVhcldlYmhvb2tFdmVudHMoZXZlbnQudGFyZ2V0LmNoZWNrZWQpXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBsYWJlbD1cIkNsZWFyIHN0b3JlZCB3ZWJob29rIGV2ZW50c1wiXG4gICAgICAgICAgICAvPlxuICAgICAgICAgICAgPFRleHRGaWVsZFxuICAgICAgICAgICAgICBsYWJlbD1cIlR5cGUgUkVTWU5DIHRvIGNvbmZpcm1cIlxuICAgICAgICAgICAgICB2YWx1ZT17cmVzeW5jQ29uZmlybVRleHR9XG4gICAgICAgICAgICAgIG9uQ2hhbmdlPXtldmVudCA9PiBzZXRSZXN5bmNDb25maXJtVGV4dChldmVudC50YXJnZXQudmFsdWUpfVxuICAgICAgICAgICAgICBzaXplPVwic21hbGxcIlxuICAgICAgICAgICAgLz5cbiAgICAgICAgICA8L0RpYWxvZ0NvbnRlbnQ+XG4gICAgICAgICAgPERpYWxvZ0FjdGlvbnM+XG4gICAgICAgICAgICA8QnV0dG9uXG4gICAgICAgICAgICAgIG9uQ2xpY2s9eygpID0+IHNldFJlc3luY0RpYWxvZ09wZW4oZmFsc2UpfVxuICAgICAgICAgICAgICBkaXNhYmxlZD17aXNSZXN5bmNpbmd9XG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIENhbmNlbFxuICAgICAgICAgICAgPC9CdXR0b24+XG4gICAgICAgICAgICA8QnV0dG9uXG4gICAgICAgICAgICAgIHZhcmlhbnQ9XCJjb250YWluZWRcIlxuICAgICAgICAgICAgICBjb2xvcj1cIndhcm5pbmdcIlxuICAgICAgICAgICAgICBkaXNhYmxlZD17cmVzeW5jQ29uZmlybVRleHQgIT09IFwiUkVTWU5DXCIgfHwgaXNSZXN5bmNpbmd9XG4gICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUNkY1Jlc3luY31cbiAgICAgICAgICAgID5cbiAgICAgICAgICAgICAge2lzUmVzeW5jaW5nID8gXCJSZXN5bmNpbmfigKZcIiA6IFwiUmVzeW5jXCJ9XG4gICAgICAgICAgICA8L0J1dHRvbj5cbiAgICAgICAgICA8L0RpYWxvZ0FjdGlvbnM+XG4gICAgICAgIDwvRGlhbG9nPlxuICAgICAgPC9Cb3g+XG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGVudGl0eUVudHJpZXMgPSBBcnJheS5mcm9tKFxuICAgIG5ldyBTZXQoW1xuICAgICAgLi4ucGxhbm5lZEVudGl0aWVzLFxuICAgICAgLi4uT2JqZWN0LmtleXMoZW50aXR5U3RhdHMpLFxuICAgICAgLi4uT2JqZWN0LmtleXMoZW50aXR5U3RhdHVzKSxcbiAgICBdKSxcbiAgKVxuICAgIC5tYXAoZW50aXR5ID0+IFtlbnRpdHksIGVudGl0eVN0YXRzW2VudGl0eV0gfHwgMF0gYXMgY29uc3QpXG4gICAgLnNvcnQoKFssIGFdLCBbLCBiXSkgPT4gYiAtIGEpO1xuXG4gIHJldHVybiAoXG4gICAgPEJveFxuICAgICAgc3g9e3tcbiAgICAgICAgaGVpZ2h0OiBcIjEwMCVcIixcbiAgICAgICAgZGlzcGxheTogXCJmbGV4XCIsXG4gICAgICAgIGZsZXhEaXJlY3Rpb246IFwiY29sdW1uXCIsXG4gICAgICAgIG92ZXJmbG93OiBcImF1dG9cIixcbiAgICAgIH19XG4gICAgPlxuICAgICAgey8qIFRvcCBiYXIgKi99XG4gICAgICA8Qm94XG4gICAgICAgIHN4PXt7XG4gICAgICAgICAgZGlzcGxheTogXCJmbGV4XCIsXG4gICAgICAgICAgYWxpZ25JdGVtczogXCJjZW50ZXJcIixcbiAgICAgICAgICBnYXA6IDEsXG4gICAgICAgICAgcHg6IDIsXG4gICAgICAgICAgcHk6IDEsXG4gICAgICAgICAgYm9yZGVyQm90dG9tOiAxLFxuICAgICAgICAgIGJvcmRlckNvbG9yOiBcImRpdmlkZXJcIixcbiAgICAgICAgfX1cbiAgICAgID5cbiAgICAgICAgPEJ1dHRvblxuICAgICAgICAgIHNpemU9XCJzbWFsbFwiXG4gICAgICAgICAgdmFyaWFudD1cImNvbnRhaW5lZFwiXG4gICAgICAgICAgc3RhcnRJY29uPXs8U3luY0ljb24gLz59XG4gICAgICAgICAgb25DbGljaz17aGFuZGxlQmFja2ZpbGx9XG4gICAgICAgICAgZGlzYWJsZWQ9e2lzVHJpZ2dlcmluZyB8fCBzdGF0dXMgPT09IFwicnVubmluZ1wifVxuICAgICAgICA+XG4gICAgICAgICAge3N0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyBcIkJhY2tmaWxsIHJ1bm5pbmcuLi5cIiA6IFwiUnVuIEJhY2tmaWxsXCJ9XG4gICAgICAgIDwvQnV0dG9uPlxuICAgICAgICB7c3RhdHVzID09PSBcInJ1bm5pbmdcIiAmJiAoXG4gICAgICAgICAgPEJ1dHRvblxuICAgICAgICAgICAgc2l6ZT1cInNtYWxsXCJcbiAgICAgICAgICAgIGNvbG9yPVwiZXJyb3JcIlxuICAgICAgICAgICAgc3RhcnRJY29uPXs8Q2FuY2VsSWNvbiAvPn1cbiAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUNhbmNlbH1cbiAgICAgICAgICA+XG4gICAgICAgICAgICBDYW5jZWxcbiAgICAgICAgICA8L0J1dHRvbj5cbiAgICAgICAgKX1cbiAgICAgICAgPEJveCBzeD17eyBmbGV4OiAxIH19IC8+XG4gICAgICAgIHtzdGFydGVkQXQgJiYgc3RhdHVzID09PSBcInJ1bm5pbmdcIiAmJiAoXG4gICAgICAgICAgPFR5cG9ncmFwaHkgdmFyaWFudD1cImNhcHRpb25cIiBjb2xvcj1cInRleHQuc2Vjb25kYXJ5XCI+XG4gICAgICAgICAgICBTdGFydGVkIHtuZXcgRGF0ZShzdGFydGVkQXQpLnRvTG9jYWxlVGltZVN0cmluZygpfVxuICAgICAgICAgICAge2xhc3RIZWFydGJlYXRcbiAgICAgICAgICAgICAgPyBgIMK3IGxhc3QgdXBkYXRlICR7bmV3IERhdGUobGFzdEhlYXJ0YmVhdCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9YFxuICAgICAgICAgICAgICA6IFwiXCJ9XG4gICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICApfVxuICAgICAgPC9Cb3g+XG5cbiAgICAgIDxCb3ggc3g9e3sgZmxleDogMSwgb3ZlcmZsb3c6IFwiYXV0b1wiLCBwOiAyIH19PlxuICAgICAgICB7LyogU3RhdHVzIGJhbm5lciAqL31cbiAgICAgICAge3N0YXR1cyA9PT0gXCJydW5uaW5nXCIgJiYgKFxuICAgICAgICAgIDxCb3ggc3g9e3sgbWI6IDIgfX0+XG4gICAgICAgICAgICA8TGluZWFyUHJvZ3Jlc3Mgc3g9e3sgbWI6IDEgfX0gLz5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgKX1cblxuICAgICAgICB7c3RhdHVzID09PSBcImNvbXBsZXRlZFwiICYmICFlcnJvciAmJiAoXG4gICAgICAgICAgPEFsZXJ0XG4gICAgICAgICAgICBzZXZlcml0eT1cInN1Y2Nlc3NcIlxuICAgICAgICAgICAgc3g9e3sgbWI6IDIgfX1cbiAgICAgICAgICAgIG9uQ2xvc2U9eygpID0+IHNldFN0YXR1cyhudWxsKX1cbiAgICAgICAgICA+XG4gICAgICAgICAgICBCYWNrZmlsbCBjb21wbGV0ZWRcbiAgICAgICAgICAgIHtsYXN0UnVuPy5kdXJhdGlvbiAhPSBudWxsICYmXG4gICAgICAgICAgICAgIGAgaW4gJHtNYXRoLnJvdW5kKGxhc3RSdW4uZHVyYXRpb24gLyAxMDAwKX1zYH1cbiAgICAgICAgICA8L0FsZXJ0PlxuICAgICAgICApfVxuXG4gICAgICAgIHtzdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgZXJyb3IgJiYgKFxuICAgICAgICAgIDxBbGVydFxuICAgICAgICAgICAgc2V2ZXJpdHk9XCJlcnJvclwiXG4gICAgICAgICAgICBzeD17eyBtYjogMiB9fVxuICAgICAgICAgICAgb25DbG9zZT17KCkgPT4ge1xuICAgICAgICAgICAgICBzZXRTdGF0dXMobnVsbCk7XG4gICAgICAgICAgICAgIHNldEVycm9yKG51bGwpO1xuICAgICAgICAgICAgfX1cbiAgICAgICAgICA+XG4gICAgICAgICAgICBCYWNrZmlsbCBmYWlsZWQ6IHtlcnJvcn1cbiAgICAgICAgICA8L0FsZXJ0PlxuICAgICAgICApfVxuXG4gICAgICAgIHtzdGF0dXMgPT09IFwiY2FuY2VsbGVkXCIgJiYgKFxuICAgICAgICAgIDxBbGVydCBzZXZlcml0eT1cImluZm9cIiBzeD17eyBtYjogMiB9fSBvbkNsb3NlPXsoKSA9PiBzZXRTdGF0dXMobnVsbCl9PlxuICAgICAgICAgICAgQmFja2ZpbGwgY2FuY2VsbGVkXG4gICAgICAgICAgPC9BbGVydD5cbiAgICAgICAgKX1cblxuICAgICAgICB7c3RhdHVzID09PSBcInJ1bm5pbmdcIiAmJiByZWNlbnRMb2dzLmxlbmd0aCA+IDAgJiYgKFxuICAgICAgICAgIDxCb3ggc3g9e3sgbWI6IDMgfX0+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwic3VidGl0bGUyXCIgc3g9e3sgbWI6IDEgfX0+XG4gICAgICAgICAgICAgIExpdmUgQWN0aXZpdHlcbiAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICBib3JkZXI6IDEsXG4gICAgICAgICAgICAgICAgYm9yZGVyQ29sb3I6IFwiZGl2aWRlclwiLFxuICAgICAgICAgICAgICAgIGJvcmRlclJhZGl1czogMSxcbiAgICAgICAgICAgICAgICBwOiAxLFxuICAgICAgICAgICAgICAgIGJnY29sb3I6IFwiYmFja2dyb3VuZC5wYXBlclwiLFxuICAgICAgICAgICAgICAgIG1heEhlaWdodDogOTYsIC8vIH40IGxpbmVzIG9mIGNhcHRpb24gdGV4dFxuICAgICAgICAgICAgICAgIG92ZXJmbG93WTogXCJhdXRvXCIsXG4gICAgICAgICAgICAgIH19XG4gICAgICAgICAgICA+XG4gICAgICAgICAgICAgIHtyZWNlbnRMb2dzLm1hcCgobG9nLCBpZHgpID0+IChcbiAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeVxuICAgICAgICAgICAgICAgICAga2V5PXtgJHtsb2cudGltZXN0YW1wfS0ke2lkeH1gfVxuICAgICAgICAgICAgICAgICAgdmFyaWFudD1cImNhcHRpb25cIlxuICAgICAgICAgICAgICAgICAgc3g9e3tcbiAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogXCJibG9ja1wiLFxuICAgICAgICAgICAgICAgICAgICBmb250RmFtaWx5OiBcIm1vbm9zcGFjZVwiLFxuICAgICAgICAgICAgICAgICAgICB3aGl0ZVNwYWNlOiBcInByZS13cmFwXCIsXG4gICAgICAgICAgICAgICAgICAgIGNvbG9yOlxuICAgICAgICAgICAgICAgICAgICAgIGxvZy5sZXZlbCA9PT0gXCJlcnJvclwiID8gXCJlcnJvci5tYWluXCIgOiBcInRleHQuc2Vjb25kYXJ5XCIsXG4gICAgICAgICAgICAgICAgICB9fVxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIFt7bmV3IERhdGUobG9nLnRpbWVzdGFtcCkudG9Mb2NhbGVUaW1lU3RyaW5nKCl9XXtcIiBcIn1cbiAgICAgICAgICAgICAgICAgIHtmb3JtYXRFeGVjdXRpb25Mb2cobG9nKX1cbiAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICkpfVxuICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgICl9XG5cbiAgICAgICAgey8qIEVudGl0eSBwcm9ncmVzcyB0YWJsZSAqL31cbiAgICAgICAgeyhzdGF0dXMgPT09IFwicnVubmluZ1wiIHx8XG4gICAgICAgICAgKChzdGF0dXMgPT09IFwiY29tcGxldGVkXCIgfHwgc3RhdHVzID09PSBcImZhaWxlZFwiKSAmJlxuICAgICAgICAgICAgZW50aXR5RW50cmllcy5sZW5ndGggPiAwKSkgJiYgKFxuICAgICAgICAgIDxCb3ggc3g9e3sgbWI6IDMgfX0+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwic3VidGl0bGUyXCIgc3g9e3sgbWI6IDEgfX0+XG4gICAgICAgICAgICAgIEVudGl0eSBQcm9ncmVzc1xuICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPFRhYmxlQ29udGFpbmVyPlxuICAgICAgICAgICAgICA8VGFibGUgc2l6ZT1cInNtYWxsXCI+XG4gICAgICAgICAgICAgICAgPFRhYmxlSGVhZD5cbiAgICAgICAgICAgICAgICAgIDxUYWJsZVJvdz5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbD5FbnRpdHk8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+UmVjb3JkczwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwiY2VudGVyXCI+U3RhdHVzPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICA8L1RhYmxlUm93PlxuICAgICAgICAgICAgICAgIDwvVGFibGVIZWFkPlxuICAgICAgICAgICAgICAgIDxUYWJsZUJvZHk+XG4gICAgICAgICAgICAgICAgICB7ZW50aXR5RW50cmllcy5tYXAoKFtlbnRpdHksIGNvdW50XSkgPT4gKFxuICAgICAgICAgICAgICAgICAgICA8VGFibGVSb3cga2V5PXtlbnRpdHl9PlxuICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwiYm9keTJcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAge2Zvcm1hdEVudGl0eUFzVGFibGVOYW1lKGVudGl0eSl9XG4gICAgICAgICAgICAgICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwiYm9keTJcIiBmb250V2VpZ2h0PVwiYm9sZFwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICB7Y291bnQudG9Mb2NhbGVTdHJpbmcoKX1cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwiY2VudGVyXCI+XG4gICAgICAgICAgICAgICAgICAgICAgICB7c3RhdHVzID09PSBcInJ1bm5pbmdcIiAmJlxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5U3RhdHVzW2VudGl0eV0gPT09IFwiY29tcGxldGVkXCIgPyAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxDaGlwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWNvbj17PENoZWNrSWNvbiAvPn1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsYWJlbD1cImRvbmVcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNpemU9XCJzbWFsbFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJzdWNjZXNzXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwib3V0bGluZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgKSA6IHN0YXR1cyA9PT0gXCJydW5uaW5nXCIgPyAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxDaGlwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWNvbj17PFBlbmRpbmdJY29uIC8+fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eVN0YXR1c1tlbnRpdHldID09PSBcInBlbmRpbmdcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwicGVuZGluZ1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogZW50aXR5U3RhdHVzW2VudGl0eV0gPT09IFwiZmFpbGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiZmFpbGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IFwicHJvY2Vzc2luZ1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNpemU9XCJzbWFsbFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9e1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5U3RhdHVzW2VudGl0eV0gPT09IFwiZmFpbGVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBcImVycm9yXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBlbnRpdHlTdGF0dXNbZW50aXR5XSA9PT0gXCJwZW5kaW5nXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiZGVmYXVsdFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBcImluZm9cIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YXJpYW50PVwib3V0bGluZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgKSA6IGVudGl0eVN0YXR1c1tlbnRpdHldID09PSBcImZhaWxlZFwiID8gKFxuICAgICAgICAgICAgICAgICAgICAgICAgICA8Q2hpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGljb249ezxFcnJvckljb24gLz59XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWw9XCJmYWlsZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNpemU9XCJzbWFsbFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29sb3I9XCJlcnJvclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cIm91dGxpbmVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICkgOiBlbnRpdHlTdGF0dXNbZW50aXR5XSA9PT0gXCJwZW5kaW5nXCIgPyAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIDxDaGlwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWNvbj17PFBlbmRpbmdJY29uIC8+fVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPVwicGVuZGluZ1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2l6ZT1cInNtYWxsXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcj1cImRlZmF1bHRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhcmlhbnQ9XCJvdXRsaW5lZFwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICApIDogKFxuICAgICAgICAgICAgICAgICAgICAgICAgICA8Q2hpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGljb249ezxDaGVja0ljb24gLz59XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGFiZWw9XCJkb25lXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzaXplPVwic21hbGxcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbG9yPVwic3VjY2Vzc1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cIm91dGxpbmVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgLz5cbiAgICAgICAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgIDwvVGFibGVSb3c+XG4gICAgICAgICAgICAgICAgICApKX1cbiAgICAgICAgICAgICAgICAgIHtzdGF0dXMgPT09IFwicnVubmluZ1wiICYmIGVudGl0eUVudHJpZXMubGVuZ3RoID09PSAwICYmIChcbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlUm93PlxuICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGwgY29sU3Bhbj17M30gYWxpZ249XCJjZW50ZXJcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5IHZhcmlhbnQ9XCJib2R5MlwiIGNvbG9yPVwidGV4dC5zZWNvbmRhcnlcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgV2FpdGluZyBmb3IgZmlyc3QgZW50aXR5IHRvIHN0YXJ0IHN5bmNpbmcuLi5cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgPC9UYWJsZVJvdz5cbiAgICAgICAgICAgICAgICAgICl9XG4gICAgICAgICAgICAgICAgPC9UYWJsZUJvZHk+XG4gICAgICAgICAgICAgIDwvVGFibGU+XG4gICAgICAgICAgICA8L1RhYmxlQ29udGFpbmVyPlxuICAgICAgICAgIDwvQm94PlxuICAgICAgICApfVxuXG4gICAgICAgIHsvKiBQYXN0IHJ1bnMgKi99XG4gICAgICAgIHtoaXN0b3J5Lmxlbmd0aCA+IDAgJiYgKFxuICAgICAgICAgIDxCb3g+XG4gICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwic3VidGl0bGUyXCIgc3g9e3sgbWI6IDEgfX0+XG4gICAgICAgICAgICAgIFJ1biBIaXN0b3J5XG4gICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgICA8VGFibGVDb250YWluZXI+XG4gICAgICAgICAgICAgIDxUYWJsZSBzaXplPVwic21hbGxcIj5cbiAgICAgICAgICAgICAgICA8VGFibGVIZWFkPlxuICAgICAgICAgICAgICAgICAgPFRhYmxlUm93PlxuICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsPkRhdGU8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbD5TdGF0dXM8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+RHVyYXRpb248L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+UmVjb3JkczwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgPC9UYWJsZVJvdz5cbiAgICAgICAgICAgICAgICA8L1RhYmxlSGVhZD5cbiAgICAgICAgICAgICAgICA8VGFibGVCb2R5PlxuICAgICAgICAgICAgICAgICAge2hpc3RvcnkubWFwKHJ1biA9PiAoXG4gICAgICAgICAgICAgICAgICAgIDxUYWJsZVJvdyBrZXk9e3J1bi5leGVjdXRpb25JZH0+XG4gICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5IHZhcmlhbnQ9XCJib2R5MlwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICB7bmV3IERhdGUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcnVuLnN0YXJ0ZWRBdCB8fCBydW4uZXhlY3V0ZWRBdCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKS50b0xvY2FsZVN0cmluZygpfVxuICAgICAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICAgIDxUYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgICA8Q2hpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICBpY29uPXtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW4uc3RhdHVzID09PSBcImNvbXBsZXRlZFwiID8gKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPENoZWNrSWNvbiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgOiBydW4uc3RhdHVzID09PSBcInJ1bm5pbmdcIiA/IChcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxTeW5jSWNvbiAvPlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgOiAoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8RXJyb3JJY29uIC8+XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgIGxhYmVsPXtydW4uc3RhdHVzfVxuICAgICAgICAgICAgICAgICAgICAgICAgICBzaXplPVwic21hbGxcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICBjb2xvcj17XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcnVuLnN0YXR1cyA9PT0gXCJjb21wbGV0ZWRcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBcInN1Y2Nlc3NcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiBydW4uc3RhdHVzID09PSBcInJ1bm5pbmdcIlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IFwiaW5mb1wiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogXCJlcnJvclwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgdmFyaWFudD1cIm91dGxpbmVkXCJcbiAgICAgICAgICAgICAgICAgICAgICAgIC8+XG4gICAgICAgICAgICAgICAgICAgICAgPC9UYWJsZUNlbGw+XG4gICAgICAgICAgICAgICAgICAgICAgPFRhYmxlQ2VsbCBhbGlnbj1cInJpZ2h0XCI+XG4gICAgICAgICAgICAgICAgICAgICAgICA8VHlwb2dyYXBoeSB2YXJpYW50PVwiYm9keTJcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgICAge3J1bi5kdXJhdGlvblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gYCR7TWF0aC5yb3VuZChydW4uZHVyYXRpb24gLyAxMDAwKX1zYFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDogXCLigJRcIn1cbiAgICAgICAgICAgICAgICAgICAgICAgIDwvVHlwb2dyYXBoeT5cbiAgICAgICAgICAgICAgICAgICAgICA8L1RhYmxlQ2VsbD5cbiAgICAgICAgICAgICAgICAgICAgICA8VGFibGVDZWxsIGFsaWduPVwicmlnaHRcIj5cbiAgICAgICAgICAgICAgICAgICAgICAgIDxUeXBvZ3JhcGh5IHZhcmlhbnQ9XCJib2R5MlwiPlxuICAgICAgICAgICAgICAgICAgICAgICAgICB7KFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ1bi5zdGF0cyBhc1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfCB7IHJlY29yZHNQcm9jZXNzZWQ/OiBudW1iZXIgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfCB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgKT8ucmVjb3Jkc1Byb2Nlc3NlZD8udG9Mb2NhbGVTdHJpbmcoKSB8fCBcIuKAlFwifVxuICAgICAgICAgICAgICAgICAgICAgICAgPC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgICAgICAgICAgIDwvVGFibGVDZWxsPlxuICAgICAgICAgICAgICAgICAgICA8L1RhYmxlUm93PlxuICAgICAgICAgICAgICAgICAgKSl9XG4gICAgICAgICAgICAgICAgPC9UYWJsZUJvZHk+XG4gICAgICAgICAgICAgIDwvVGFibGU+XG4gICAgICAgICAgICA8L1RhYmxlQ29udGFpbmVyPlxuICAgICAgICAgIDwvQm94PlxuICAgICAgICApfVxuXG4gICAgICAgIHsvKiBFbXB0eSBzdGF0ZSAqL31cbiAgICAgICAgeyFzdGF0dXMgJiYgaGlzdG9yeS5sZW5ndGggPT09IDAgJiYgKFxuICAgICAgICAgIDxCb3hcbiAgICAgICAgICAgIHN4PXt7XG4gICAgICAgICAgICAgIHRleHRBbGlnbjogXCJjZW50ZXJcIixcbiAgICAgICAgICAgICAgcHk6IDYsXG4gICAgICAgICAgICAgIGNvbG9yOiBcInRleHQuc2Vjb25kYXJ5XCIsXG4gICAgICAgICAgICB9fVxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxTeW5jSWNvbiBzeD17eyBmb250U2l6ZTogNDgsIG1iOiAxLCBvcGFjaXR5OiAwLjMgfX0gLz5cbiAgICAgICAgICAgIDxUeXBvZ3JhcGh5IHZhcmlhbnQ9XCJib2R5MVwiPk5vIGJhY2tmaWxsIHJ1bnMgeWV0PC9UeXBvZ3JhcGh5PlxuICAgICAgICAgICAgPFR5cG9ncmFwaHkgdmFyaWFudD1cImJvZHkyXCI+XG4gICAgICAgICAgICAgIENsaWNrICZxdW90O1J1biBCYWNrZmlsbCZxdW90OyB0byBzeW5jIGhpc3RvcmljYWwgZGF0YSBmcm9tIENsb3NlXG4gICAgICAgICAgICAgIHRvIEJpZ1F1ZXJ5XG4gICAgICAgICAgICA8L1R5cG9ncmFwaHk+XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgICl9XG4gICAgICA8L0JveD5cbiAgICA8L0JveD5cbiAgKTtcbn1cbiJdLCJmaWxlIjoiL1VzZXJzL2pvbmFzd2llc2VsL21vbm8vYXBwL3NyYy9jb21wb25lbnRzL0JhY2tmaWxsUGFuZWwudHN4In0=