import { useCallback, useEffect, useState } from "react";
import { useConsoleStore } from "../../../store/consoleStore";
import type { ScheduledQueryRunItem } from "../../../lib/api-types";
import type { ConsoleExecutionRow } from "../../ConsoleExecutionsPanel";
import type { ConsoleTab } from "../../../store/lib/types";
import type { BottomPanel } from "../types";
import type { EditorFeedback } from "./useEditorFeedback";
import { useStableCallback } from "./useStableCallback";

interface UseConsoleRunsArgs {
  workspaceId: string | undefined;
  activeTabId: string | null;
  tabs: Record<string, ConsoleTab>;
  feedback: EditorFeedback;
}

/**
 * Per-tab bottom panel (Results / Runs), the Runs panel data (executions and
 * scheduled runs) and the schedule modal.
 */
export function useConsoleRuns({
  workspaceId,
  activeTabId,
  tabs,
  feedback,
}: UseConsoleRunsArgs) {
  const setSchedule = useConsoleStore(state => state.setSchedule);
  const removeSchedule = useConsoleStore(state => state.removeSchedule);
  const runScheduledNow = useConsoleStore(state => state.runScheduledNow);
  const listScheduledRuns = useConsoleStore(state => state.listScheduledRuns);
  const fetchConsoleExecutions = useConsoleStore(
    state => state.fetchConsoleExecutions,
  );
  const updateTabScheduledRun = useConsoleStore(
    state => state.updateTabScheduledRun,
  );
  const updateMetadata = useConsoleStore(state => state.updateMetadata);

  const [scheduleModalTabId, setScheduleModalTabId] = useState<string | null>(
    null,
  );
  const [scheduleModalMode, setScheduleModalMode] = useState<
    "create" | "update"
  >("create");
  const [tabBottomPanel, setTabBottomPanel] = useState<
    Record<string, BottomPanel>
  >({});
  const [tabScheduledRuns, setTabScheduledRuns] = useState<
    Record<string, ScheduledQueryRunItem[]>
  >({});
  const [tabScheduledRunsLoading, setTabScheduledRunsLoading] = useState<
    Record<string, boolean>
  >({});
  const [tabScheduledRunsError, setTabScheduledRunsError] = useState<
    Record<string, string | null>
  >({});
  const [tabExecutions, setTabExecutions] = useState<
    Record<string, ConsoleExecutionRow[]>
  >({});
  const [tabExecutionsLoading, setTabExecutionsLoading] = useState<
    Record<string, boolean>
  >({});
  const [tabExecutionsError, setTabExecutionsError] = useState<
    Record<string, string | null>
  >({});

  const loadScheduledRunsForTab = useCallback(
    async (tabId: string) => {
      if (!workspaceId) return;

      setTabScheduledRunsLoading(prev => ({ ...prev, [tabId]: true }));
      setTabScheduledRunsError(prev => ({ ...prev, [tabId]: null }));

      const response = await listScheduledRuns(workspaceId, tabId, 50);
      if (response.success) {
        setTabScheduledRuns(prev => ({ ...prev, [tabId]: response.runs }));
        updateTabScheduledRun(tabId, response.scheduledRun);
      } else {
        setTabScheduledRunsError(prev => ({
          ...prev,
          [tabId]: response.error || "Failed to load scheduled runs",
        }));
      }

      setTabScheduledRunsLoading(prev => ({ ...prev, [tabId]: false }));
    },
    [workspaceId, listScheduledRuns, updateTabScheduledRun],
  );

  const loadExecutionsForTab = useCallback(
    async (tabId: string) => {
      if (!workspaceId) return;

      setTabExecutionsLoading(prev => ({ ...prev, [tabId]: true }));
      setTabExecutionsError(prev => ({ ...prev, [tabId]: null }));

      try {
        const rows = await fetchConsoleExecutions(workspaceId, tabId, {
          limit: 25,
        });
        setTabExecutions(prev => ({ ...prev, [tabId]: rows }));
      } catch (error) {
        setTabExecutionsError(prev => ({
          ...prev,
          [tabId]:
            error instanceof Error
              ? error.message
              : "Failed to load executions",
        }));
      }

      setTabExecutionsLoading(prev => ({ ...prev, [tabId]: false }));
    },
    [workspaceId, fetchConsoleExecutions],
  );

  const loadRunsPanelForTab = useCallback(
    async (tabId: string) => {
      const tab = useConsoleStore.getState().tabs[tabId];
      await loadExecutionsForTab(tabId);
      if (tab?.schedule) {
        await loadScheduledRunsForTab(tabId);
      }
    },
    [loadExecutionsForTab, loadScheduledRunsForTab],
  );

  // Keep the Runs panel fresh after a run when it's open (fire-and-forget).
  const refreshExecutionsIfOpen = useStableCallback((tabId: string) => {
    if (workspaceId && tabBottomPanel[tabId] === "runs") {
      void fetchConsoleExecutions(workspaceId, tabId, {
        limit: 25,
      }).then(rows => {
        setTabExecutions(prev => ({ ...prev, [tabId]: rows }));
      });
    }
  });

  const selectBottomPanel = useStableCallback(
    (tabId: string, value: BottomPanel) => {
      setTabBottomPanel(prev => ({ ...prev, [tabId]: value }));
      if (value === "runs") {
        void loadRunsPanelForTab(tabId);
      }
    },
  );

  // A tab opened with `metadata.openScheduledRuns` lands on its Runs panel.
  useEffect(() => {
    if (!activeTabId) return;

    const activeTab = tabs[activeTabId];
    if (!activeTab?.metadata?.openScheduledRuns) return;

    setTabBottomPanel(prev =>
      prev[activeTabId] === "runs" ? prev : { ...prev, [activeTabId]: "runs" },
    );
    void loadRunsPanelForTab(activeTabId);

    const nextMetadata = { ...(activeTab.metadata || {}) };
    delete nextMetadata.openScheduledRuns;
    updateMetadata(
      activeTabId,
      Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined,
    );
  }, [activeTabId, tabs, loadRunsPanelForTab, updateMetadata]);

  const openScheduleModal = useStableCallback(
    (tabId: string, mode: "create" | "update") => {
      setScheduleModalTabId(tabId);
      setScheduleModalMode(mode);
    },
  );

  const closeScheduleModal = useCallback(() => setScheduleModalTabId(null), []);

  const handleSaveSchedule = useCallback(
    async (input: { cron: string; timezone: string }) => {
      if (!workspaceId || !scheduleModalTabId) {
        throw new Error("No workspace selected");
      }

      const response = await setSchedule(
        workspaceId,
        scheduleModalTabId,
        input,
      );
      if (!response.success) {
        throw new Error(response.error || "Failed to save schedule");
      }

      if (tabBottomPanel[scheduleModalTabId] === "runs") {
        await loadScheduledRunsForTab(scheduleModalTabId);
      }
    },
    [
      workspaceId,
      scheduleModalTabId,
      setSchedule,
      tabBottomPanel,
      loadScheduledRunsForTab,
    ],
  );

  const handleRemoveSchedule = useCallback(
    async (tabId: string) => {
      if (!workspaceId) return;
      const response = await removeSchedule(workspaceId, tabId);
      if (!response.success) {
        throw new Error(response.error || "Failed to remove schedule");
      }
    },
    [workspaceId, removeSchedule],
  );

  const { showSnackbar } = feedback;
  const handleRunScheduledNow = useCallback(
    async (tabId: string) => {
      if (!workspaceId) return;
      const response = await runScheduledNow(workspaceId, tabId);
      if (!response.success) {
        throw new Error(response.error || "Failed to run scheduled query");
      }
      setTabBottomPanel(prev => ({ ...prev, [tabId]: "runs" }));
      showSnackbar("Async query run queued");
      await loadRunsPanelForTab(tabId);
    },
    [workspaceId, runScheduledNow, loadRunsPanelForTab, showSnackbar],
  );

  return {
    tabBottomPanel,
    tabScheduledRuns,
    tabScheduledRunsLoading,
    tabScheduledRunsError,
    tabExecutions,
    tabExecutionsLoading,
    tabExecutionsError,
    selectBottomPanel,
    refreshExecutionsIfOpen,
    scheduleModalTabId,
    scheduleModalMode,
    setScheduleModalTabId,
    setScheduleModalMode,
    openScheduleModal,
    closeScheduleModal,
    handleSaveSchedule,
    handleRemoveSchedule,
    handleRunScheduledNow,
  };
}
