import { useCallback, useEffect, useRef, useState } from "react";
import { useFlowStore } from "../../store/flowStore";
import {
  useLatestRequest,
  useOnDocumentVisible,
} from "../../hooks/useLatestRequest";
import type {
  BackfillRun,
  BackfillStatus,
  EntityDriftMap,
  EventFilterKey,
  LogEntry,
  StreamState,
} from "./backfill-helpers";

export const BACKFILL_TABS = { objects: 0, runs: 1, events: 2 } as const;

const EMPTY_EVENT_COUNTS: Record<EventFilterKey, number> = {
  all: 0,
  applied: 0,
  pending: 0,
  failed: 0,
  dropped: 0,
};

interface BackfillPollingOptions {
  workspaceId: string;
  flowId: string;
  /** Active panel tab: the runs / events lists only poll while visible. */
  tab: number;
  eventsFilter: string;
}

/**
 * Every poller behind the backfill panel: CDC status (+ the visible tab's
 * list), the running execution's logs, webhook-event counts, destination
 * row counts and schema drift.
 *
 * Guards, per poller: only the newest call applies its response (a slower,
 * older one must not overwrite newer data), interval ticks skip while a call
 * is in flight or the browser tab is hidden, and returning to the tab
 * catches up immediately.
 */
export function useBackfillPolling({
  workspaceId,
  flowId,
  tab,
  eventsFilter,
}: BackfillPollingOptions) {
  const fetchCdcStatus = useFlowStore(s => s.fetchCdcStatus);
  const fetchCdcDestinationCounts = useFlowStore(
    s => s.fetchCdcDestinationCounts,
  );
  const fetchFlowStatus = useFlowStore(s => s.fetchFlowStatus);
  const fetchExecutionDetails = useFlowStore(s => s.fetchExecutionDetails);
  const fetchFlowHistory = useFlowStore(s => s.fetchFlowHistory);
  const fetchWebhookEvents = useFlowStore(s => s.fetchWebhookEvents);
  const fetchEntitySchemaHealth = useFlowStore(s => s.fetchEntitySchemaHealth);

  const [entityDrift, setEntityDrift] = useState<EntityDriftMap>({});
  // The CDC status payload is untyped upstream.
  const [cdc, setCdc] = useState<any | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);
  const [execStats, setExecStats] = useState<Record<string, number | null>>({});
  const [execStatus, setExecStatus] = useState<Record<string, string>>({});
  // Webhook event rows are untyped upstream.
  const [webhookEvents, setWebhookEvents] = useState<any[]>([]);
  const [webhookEventsTotalAll, setWebhookEventsTotalAll] = useState(0);
  const [eventCounts, setEventCounts] =
    useState<Record<EventFilterKey, number>>(EMPTY_EVENT_COUNTS);
  const [runs, setRuns] = useState<BackfillRun[]>([]);
  const [destinationCounts, setDestinationCounts] = useState<Record<
    string,
    number | null
  > | null>(null);
  const [destCountsLoading, setDestCountsLoading] = useState(false);

  const executionIdRef = useRef(executionId);
  executionIdRef.current = executionId;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const eventsFilterRef = useRef(eventsFilter);
  eventsFilterRef.current = eventsFilter;

  const streamState: StreamState = cdc?.streamState || "idle";
  const bfStatus: BackfillStatus = cdc?.backfillStatus || "idle";
  const isActive =
    streamState === "active" || bfStatus === "running" || executionId !== null;

  const cdcRequest = useLatestRequest();
  const logsRequest = useLatestRequest();
  const countsRequest = useLatestRequest();

  const pollCdc = useCallback(async () => {
    const ticket = cdcRequest.begin();
    try {
      const activeTab = tabRef.current;
      const promises: Promise<unknown>[] = [
        fetchCdcStatus(workspaceId, flowId),
      ];
      const shouldPollEvents = activeTab === BACKFILL_TABS.events;
      const shouldPollHistory = activeTab === BACKFILL_TABS.runs;
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
      if (!ticket.isLatest()) return;
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
        if (history) setRuns(history as BackfillRun[]);
      }
    } finally {
      ticket.done();
    }
  }, [
    cdcRequest,
    fetchCdcStatus,
    fetchWebhookEvents,
    fetchFlowHistory,
    workspaceId,
    flowId,
  ]);

  const fetchEventCounts = useCallback(async () => {
    const ticket = countsRequest.begin();
    try {
      const [
        allResult,
        appliedResult,
        pendingResult,
        failedResult,
        droppedResult,
      ] = await Promise.all([
        fetchWebhookEvents(workspaceId, flowId, 1, 0),
        fetchWebhookEvents(workspaceId, flowId, 1, 0, {
          applyStatus: "applied",
        }),
        fetchWebhookEvents(workspaceId, flowId, 1, 0, {
          applyStatus: "pending",
        }),
        fetchWebhookEvents(workspaceId, flowId, 1, 0, {
          applyStatus: "failed",
        }),
        fetchWebhookEvents(workspaceId, flowId, 1, 0, {
          applyStatus: "dropped",
        }),
      ]);
      if (!ticket.isLatest()) return;

      const all = allResult?.total ?? 0;
      setEventCounts({
        all,
        applied: appliedResult?.total ?? 0,
        pending: pendingResult?.total ?? 0,
        failed: failedResult?.total ?? 0,
        dropped: droppedResult?.total ?? 0,
      });
      setWebhookEventsTotalAll(all);
    } finally {
      ticket.done();
    }
  }, [countsRequest, fetchWebhookEvents, workspaceId, flowId]);

  const pollLogs = useCallback(async () => {
    const ticket = logsRequest.begin();
    try {
      const currentExecId = executionIdRef.current;
      if (!currentExecId) {
        const statusResp = await fetchFlowStatus(workspaceId, flowId);
        if (!ticket.isLatest()) return;
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
      if (!ticket.isLatest() || executionIdRef.current !== currentExecId) {
        return;
      }
      if (details?.logs && details.logs.length > 0) {
        setLiveLogs(details.logs as LogEntry[]);
      }
      if (details?.stats) {
        const es = details.stats.entityStats as
          Record<string, number | null> | undefined;
        const est = details.stats.entityStatus as
          Record<string, string> | undefined;
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
    } finally {
      ticket.done();
    }
  }, [
    logsRequest,
    workspaceId,
    flowId,
    fetchFlowStatus,
    fetchExecutionDetails,
  ]);

  // CDC status: fast while something is running, slow otherwise.
  useEffect(() => {
    void pollCdc();
    const interval = isActive ? 3_000 : 8_000;
    const id = setInterval(() => {
      if (cdcRequest.shouldTick()) void pollCdc();
    }, interval);
    return () => clearInterval(id);
  }, [pollCdc, isActive, cdcRequest]);

  useEffect(() => {
    let cancelled = false;
    void fetchEntitySchemaHealth(workspaceId, flowId).then(result => {
      if (cancelled || !result) return;
      const driftMap: EntityDriftMap = {};
      for (const ent of result.entities) {
        if (ent.hasDrift) {
          driftMap[ent.entity] = ent.columns.filter(c => c.status === "drift");
        }
      }
      setEntityDrift(driftMap);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchEntitySchemaHealth, workspaceId, flowId]);

  // Live logs of the running execution.
  useEffect(() => {
    if (!isActive) return;
    void pollLogs();
    const id = setInterval(() => {
      if (logsRequest.shouldTick()) void pollLogs();
    }, 2_000);
    return () => clearInterval(id);
  }, [pollLogs, isActive, logsRequest]);

  // Re-poll when the tab or filter changes — but not on mount, where the
  // interval effect above already polled (it used to poll twice).
  const skipFirstFilterPollRef = useRef(true);
  useEffect(() => {
    if (skipFirstFilterPollRef.current) {
      skipFirstFilterPollRef.current = false;
      return;
    }
    void pollCdc();
  }, [tab, eventsFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Polling pauses while the browser tab is hidden; catch up on return.
  useOnDocumentVisible(() => {
    void pollCdc();
    if (isActive) void pollLogs();
  });

  useEffect(() => {
    if (tab !== BACKFILL_TABS.events) return;
    void fetchEventCounts();
    const id = setInterval(() => {
      if (countsRequest.shouldTick()) void fetchEventCounts();
    }, 15000);
    return () => clearInterval(id);
  }, [tab, fetchEventCounts, countsRequest]);

  const pollDestCounts = useCallback(async () => {
    setDestCountsLoading(true);
    try {
      const counts = await fetchCdcDestinationCounts(workspaceId, flowId);
      if (counts) setDestinationCounts(counts);
    } finally {
      setDestCountsLoading(false);
    }
  }, [fetchCdcDestinationCounts, workspaceId, flowId]);

  // Destination row counts are slow-moving and require a destination round
  // trip. Fetch once when the panel opens for a flow; otherwise the user
  // refreshes manually via the button next to "Destination rows".
  useEffect(() => {
    setDestinationCounts(null);
    void pollDestCounts();
  }, [workspaceId, flowId, pollDestCounts]);

  return {
    cdc,
    setCdc,
    streamState,
    bfStatus,
    isActive,
    executionId,
    liveLogs,
    execStats,
    setExecStats,
    execStatus,
    setExecStatus,
    webhookEvents,
    webhookEventsTotalAll,
    eventCounts,
    runs,
    destinationCounts,
    setDestinationCounts,
    destCountsLoading,
    entityDrift,
    pollCdc,
    pollLogs,
    fetchEventCounts,
    pollDestCounts,
  };
}
