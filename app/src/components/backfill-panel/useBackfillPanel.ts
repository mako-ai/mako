import { useCallback, useState } from "react";
import { useFlowStore } from "../../store/flowStore";
import {
  backfillChipProps,
  buildEntityRows,
  entityTotals,
  streamChipProps,
  type EntitySchemaFields,
  type LogEntry,
} from "./backfill-helpers";
import { useBackfillPolling } from "./useBackfillPolling";

export interface BackfillPanelProps {
  workspaceId: string;
  flowId: string;
  onEdit?: () => void;
}

const NO_RESYNC_OPTS = { deleteDestination: false, clearWebhookEvents: false };

/**
 * Per-entity schema rows, fetched on first expand and cached for the life of
 * the panel (so switching tabs keeps what was already loaded).
 */
function useEntitySchemas(workspaceId: string, flowId: string) {
  const fetchEntitySchema = useFlowStore(s => s.fetchEntitySchema);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);
  const [entitySchemaCache, setEntitySchemaCache] = useState<
    Record<string, { fields: EntitySchemaFields; loading: boolean }>
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

  return { expandedEntity, entitySchemaCache, toggleEntitySchema };
}

/** All state, polling and actions behind the backfill panel. */
export function useBackfillPanel({
  workspaceId,
  flowId,
  onEdit,
}: BackfillPanelProps) {
  const flowsMap = useFlowStore(s => s.flows);
  const startCdcBackfill = useFlowStore(s => s.startCdcBackfill);
  const startCdcStream = useFlowStore(s => s.startCdcStream);
  const pauseCdcStream = useFlowStore(s => s.pauseCdcStream);
  const pauseCdcFlow = useFlowStore(s => s.pauseCdcFlow);
  const cancelCdcBackfill = useFlowStore(s => s.cancelCdcBackfill);
  const resumeCdcFlow = useFlowStore(s => s.resumeCdcFlow);
  const resetCdcEntityTable = useFlowStore(s => s.resetCdcEntityTable);
  const resyncCdcFlow = useFlowStore(s => s.resyncCdcFlow);
  const recoverCdcStream = useFlowStore(s => s.recoverCdcStream);
  const recoverCdcBackfill = useFlowStore(s => s.recoverCdcBackfill);
  const reprocessStaleEvents = useFlowStore(s => s.reprocessStaleEvents);
  const retryAllFailedWebhookEvents = useFlowStore(
    s => s.retryAllFailedWebhookEvents,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [resyncOpen, setResyncOpen] = useState(false);
  const [resyncConfirm, setResyncConfirm] = useState("");
  const [resyncOpts, setResyncOpts] = useState(NO_RESYNC_OPTS);
  const [eventsFilter, setEventsFilter] = useState<string>("all");
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [entityResetOpen, setEntityResetOpen] = useState(false);
  const [entityResetEntity, setEntityResetEntity] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunLogs, setSelectedRunLogs] = useState<LogEntry[] | null>(
    null,
  );

  const schemas = useEntitySchemas(workspaceId, flowId);
  const polling = useBackfillPolling({
    workspaceId,
    flowId,
    tab,
    eventsFilter,
  });
  const {
    cdc,
    setCdc,
    pollCdc,
    pollLogs,
    pollDestCounts,
    fetchEventCounts,
    setExecStats,
    setExecStatus,
    setDestinationCounts,
  } = polling;

  const fetchExecutionDetails = useFlowStore(s => s.fetchExecutionDetails);
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

  const flow = (flowsMap[workspaceId] || []).find(f => f._id === flowId);

  // A stream (continuous ingest) only exists when the flow has a webhook or
  // poll-schedule trigger. Reconcile-only flows (e.g. migrated legacy
  // full-refresh syncs) run entirely on the periodic full backfill — showing
  // a stream status for them is misleading.
  const hasWebhookTrigger = Boolean(
    flow?.webhookConfig?.enabled && flow?.webhookConfig?.endpoint,
  );
  const hasPollTrigger = Boolean(
    flow?.schedule?.enabled && flow?.schedule?.cron,
  );
  const hasReconcileTrigger = Boolean(
    flow?.backfillSchedule?.enabled && flow?.backfillSchedule?.cron,
  );
  const isReconcileOnly =
    hasReconcileTrigger && !hasWebhookTrigger && !hasPollTrigger;

  const withBusy = async (
    fn: () => Promise<unknown>,
    optimisticCdcPatch?: Record<string, unknown>,
  ) => {
    setBusy(true);
    setError(null);
    if (optimisticCdcPatch && cdc) {
      setCdc((prev: any) => (prev ? { ...prev, ...optimisticCdcPatch } : prev));
    }
    try {
      await fn();
      void pollCdc();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (optimisticCdcPatch && cdc) {
        void pollCdc();
      }
    } finally {
      setBusy(false);
    }
  };

  /** Run a store action that reports success as a boolean. */
  const run =
    (
      action: () => Promise<boolean>,
      failure: string,
      optimisticCdcPatch: Record<string, unknown>,
    ) =>
    () =>
      withBusy(async () => {
        if (!(await action())) throw new Error(failure);
      }, optimisticCdcPatch);

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

  const handleStartStream = run(
    () => startCdcStream(workspaceId, flowId),
    "Failed to start stream",
    { streamState: "active" },
  );
  const handlePauseStream = run(
    () => pauseCdcStream(workspaceId, flowId),
    "Failed to pause stream",
    { streamState: "paused" },
  );
  const handleResumeStream = run(
    () => startCdcStream(workspaceId, flowId),
    "Failed to resume stream",
    { streamState: "active" },
  );
  const handleRecoverStream = run(
    () =>
      recoverCdcStream(workspaceId, flowId, {
        retryFailedMaterialization: true,
      }),
    "Failed to recover stream",
    { streamState: "active" },
  );
  const handlePauseBackfill = run(
    () => pauseCdcFlow(workspaceId, flowId),
    "Failed to pause backfill",
    { backfillStatus: "paused" },
  );
  const handleCancelBackfill = run(
    () => cancelCdcBackfill(workspaceId, flowId),
    "Failed to cancel backfill",
    { backfillStatus: "idle" },
  );
  const handleResumeBackfill = run(
    () => resumeCdcFlow(workspaceId, flowId),
    "Failed to resume backfill",
    { backfillStatus: "running" },
  );
  const handleRecoverBackfill = run(
    () => recoverCdcBackfill(workspaceId, flowId),
    "Failed to recover backfill",
    { backfillStatus: "running" },
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

  const handleReprocessStale = async () => {
    setReprocessing(true);
    try {
      await reprocessStaleEvents(workspaceId, flowId);
      await pollCdc();
      await fetchEventCounts();
    } finally {
      setReprocessing(false);
    }
  };

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
    setResyncOpts(NO_RESYNC_OPTS);
    setDestinationCounts(null);
    void pollCdc();
    void pollDestCounts();
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

  const entities = buildEntityRows(
    flow,
    cdc?.entities || [],
    polling.destinationCounts,
    polling.execStats,
    polling.execStatus,
  );

  return {
    ...polling,
    ...schemas,
    ...entityTotals(entities),
    workspaceId,
    flowId,
    onEdit,
    flow,
    webhookUrl: flow?.webhookConfig?.endpoint,
    connectorName:
      typeof flow?.dataSourceId === "object"
        ? (flow.dataSourceId as any).name
        : undefined,
    destName:
      typeof flow?.destinationDatabaseId === "object"
        ? (flow.destinationDatabaseId as any).name
        : undefined,
    dataset: flow?.tableDestination?.schema,
    isReconcileOnly,
    entities,
    ss: streamChipProps(polling.streamState),
    bs: backfillChipProps(polling.bfStatus),
    busy,
    error,
    setError,
    tab,
    setTab,
    eventsFilter,
    setEventsFilter,
    resyncOpen,
    setResyncOpen,
    resyncConfirm,
    setResyncConfirm,
    resyncOpts,
    setResyncOpts,
    retryingFailed,
    reprocessing,
    entityResetOpen,
    setEntityResetOpen,
    entityResetEntity,
    selectedRunId,
    setSelectedRunId,
    selectedRunLogs,
    setSelectedRunLogs,
    loadRunLogs,
    handleStartBackfill,
    handleStartStream,
    handlePauseStream,
    handleResumeStream,
    handleRecoverStream,
    handlePauseBackfill,
    handleCancelBackfill,
    handleResumeBackfill,
    handleRecoverBackfill,
    handleRetryAllFailed,
    handleReprocessStale,
    handleResync,
    openEntityResetDialog,
    handleResetEntityTable,
  };
}

export type BackfillPanelModel = ReturnType<typeof useBackfillPanel>;
