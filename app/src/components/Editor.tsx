import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import EntityBreadcrumbs from "./EntityBreadcrumbs";
import type { DbFlowFormRef } from "./DbFlowForm";
import { useConsoleStore, selectConsoleTabs } from "../store/consoleStore";
import { useShallow } from "zustand/react/shallow";
import { useUIStore } from "../store/uiStore";
import { useSchemaStore } from "../store/schemaStore";
import { useDatabaseCatalogStore } from "../store/databaseCatalogStore";
import { useWorkspace } from "../contexts/workspace-context";
import { useAuth } from "../contexts/auth-context";
import { useIsWorkspaceAdmin } from "../hooks/useIsWorkspaceAdmin";
import { useIsMobile } from "../hooks/useIsMobile";
import { useMountedTabs } from "../lib/tab-mount-policy";
import type { ConsoleTab } from "../store/lib/types";
import { useRenderCount, useWhyChanged } from "../utils/renderDebug";
import { EditorTabBar } from "./editor/EditorTabBar";
import { MobileEditorHeader } from "./editor/MobileEditorHeader";
import { EditorTabPanels } from "./editor/EditorTabPanels";
import {
  ConsoleTabPanel,
  type ConsoleTabActions,
} from "./editor/ConsoleTabPanel";
import { EditorDialogs } from "./editor/EditorDialogs";
import { FILL_COLUMN_SX } from "./editor/styles";
import { useEditorFeedback } from "./editor/hooks/useEditorFeedback";
import { useConsoleRuns } from "./editor/hooks/useConsoleRuns";
import { useConsoleExecution } from "./editor/hooks/useConsoleExecution";
import { useResultsViewState } from "./editor/hooks/useResultsViewState";
import { useConsoleSave } from "./editor/hooks/useConsoleSave";
import { useConsoleRefs } from "./editor/hooks/useConsoleRefs";
import { useEditorSqlAutocomplete } from "./editor/hooks/useEditorSqlAutocomplete";
import { useStableCallback } from "./editor/hooks/useStableCallback";
import type {
  ChartSpecChangePayload,
  ConsoleResultsContext,
} from "./editor/types";

export type { ChartSpecChangePayload, ConsoleResultsContext };

interface EditorProps {
  dbFlowFormRef?: React.RefObject<DbFlowFormRef | null>;
  onChartSpecChangeRef?: React.MutableRefObject<
    ((payload: ChartSpecChangePayload) => void) | undefined
  >;
  resultsContextRef?: React.MutableRefObject<ConsoleResultsContext | null>;
}

const EMPTY_LIST: never[] = [];

function Editor({
  dbFlowFormRef,
  onChartSpecChangeRef,
  resultsContextRef,
}: EditorProps = {}) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const { user } = useAuth();
  const isWorkspaceAdmin = useIsWorkspaceAdmin();
  const isMobile = useIsMobile();

  // Tab store — individual selectors to avoid full-store re-renders
  const tabs = useConsoleStore(state => state.tabs);
  const activeTabId = useConsoleStore(state => state.activeTabId);
  const closeTab = useConsoleStore(state => state.closeTab);
  const updateContent = useConsoleStore(state => state.updateContent);
  const updateConnection = useConsoleStore(state => state.updateConnection);
  const updateDatabase = useConsoleStore(state => state.updateDatabase);
  const updateDirty = useConsoleStore(state => state.updateDirty);
  const setActiveTab = useConsoleStore(state => state.setActiveTab);
  const openTab = useConsoleStore(state => state.openTab);
  const reorderTabs = useConsoleStore(state => state.reorderTabs);
  const reloadConsole = useConsoleStore(state => state.reloadConsole);
  // useShallow prevents infinite re-renders: selectConsoleTabs returns a new
  // array on every call; without shallow comparison useSyncExternalStore would
  // detect a change every render and trigger a re-render loop.
  const consoleTabs = useConsoleStore(useShallow(selectConsoleTabs));
  const activeConsoleId = activeTabId;
  // Lazy kinds (apps, notebooks) render nothing until first shown, then stay
  // mounted; app tabs are capped (lib/tab-mount-policy). Only one tab is on
  // screen in this Editor, so the active tab is the visible set.
  const mountedLazyTabs = useMountedTabs(consoleTabs, [activeConsoleId]);
  const activeTab = activeConsoleId ? tabs[activeConsoleId] : undefined;

  const connectionsMap = useSchemaStore(state => state.connections);
  const ensureConnections = useSchemaStore(state => state.ensureConnections);
  const availableDatabases = useMemo(
    () => (workspaceId ? connectionsMap[workspaceId] || [] : []),
    [workspaceId, connectionsMap],
  );

  // Database type → iconUrl map for rendering per-connection icons in console tabs.
  const dbTypes = useDatabaseCatalogStore(state => state.types);
  const fetchDbTypes = useDatabaseCatalogStore(state => state.fetchTypes);
  useEffect(() => {
    fetchDbTypes().catch(() => undefined);
  }, [fetchDbTypes]);
  const connectionIconById = useMemo(() => {
    const typeToIcon = new Map<string, string>();
    for (const t of dbTypes || []) {
      if (t.iconUrl) typeToIcon.set(t.type, t.iconUrl);
    }
    const map = new Map<string, string>();
    for (const c of availableDatabases) {
      const icon = typeToIcon.get(c.type);
      if (icon) map.set(c.id, icon);
    }
    return map;
  }, [dbTypes, availableDatabases]);

  // Fetch connections when workspace changes
  useEffect(() => {
    if (workspaceId) {
      ensureConnections(workspaceId);
    }
  }, [workspaceId, ensureConnections]);

  useEditorSqlAutocomplete(workspaceId, availableDatabases);

  const mobileConsolePane = useUIStore(state => state.mobileConsolePane);
  const setMobileConsolePane = useUIStore(state => state.setMobileConsolePane);
  const mobileResultsView = isMobile && mobileConsolePane === "results";

  const { getConsoleRef, dropConsoleRef, setActiveEditorContent } =
    useConsoleRefs(activeConsoleId, consoleTabs.length);

  const feedback = useEditorFeedback();
  const runs = useConsoleRuns({
    workspaceId,
    activeTabId,
    tabs,
    feedback,
  });
  const { refreshExecutionsIfOpen } = runs;
  const onExecuted = useStableCallback((tabId: string) => {
    // On mobile, flip the console to its results pane so the answer is
    // visible without the user having to switch manually.
    if (isMobile) {
      setMobileConsolePane("results");
    }
    refreshExecutionsIfOpen(tabId);
  });
  const execution = useConsoleExecution({
    workspaceId,
    consoleTabs,
    feedback,
    onExecuted,
  });
  const { tabResults, executingTabs, cancellingTabs } = execution;
  const view = useResultsViewState({
    tabs,
    consoleTabs,
    activeTabId,
    tabResults,
    onChartSpecChangeRef,
    resultsContextRef,
  });
  const save = useConsoleSave({
    workspaceId,
    tabChartSpecs: view.tabChartSpecs,
    tabViewModes: view.tabViewModes,
    getConsoleRef,
    feedback,
    openScheduleModal: runs.openScheduleModal,
  });

  // Console history popover (git-backed, apps.md §16) — anchored to the
  // toolbar button of the tab that opened it.
  const [consoleHistory, setConsoleHistory] = useState<{
    anchor: HTMLElement;
    tabId: string;
  } | null>(null);
  // Unified share dialog state (consoles)
  const [shareConsoleTabId, setShareConsoleTabId] = useState<string | null>(
    null,
  );

  useRenderCount("Editor", {
    activeConsoleId,
    tabCount: consoleTabs.length,
  });
  useWhyChanged("Editor", {
    currentWorkspaceId: workspaceId,
    tabsRef: tabs,
    consoleTabsRef: consoleTabs,
    tabCount: consoleTabs.length,
    activeConsoleId,
    activeTabKind: activeTab?.kind,
    activeTabContentRef: activeTab?.content,
    activeTabResultsRef: activeConsoleId ? tabResults[activeConsoleId] : null,
    activeTabResultsExecutedAt: activeConsoleId
      ? tabResults[activeConsoleId]?.executedAt
      : undefined,
    executingTabsRef: executingTabs,
    cancellingTabsRef: cancellingTabs,
    isSaving: save.isSaving,
    tabViewModesRef: view.tabViewModes,
    tabChartSpecsRef: view.tabChartSpecs,
    availableDatabasesRef: availableDatabases,
  });

  // Update the page title based on the active tab
  useEffect(() => {
    const baseTitle = "Mako";
    if (!activeConsoleId) {
      document.title = baseTitle;
      return;
    }
    const activeTab = consoleTabs.find(tab => tab.id === activeConsoleId);
    document.title = activeTab?.title
      ? `${activeTab.title} - ${baseTitle}`
      : baseTitle;
  }, [activeConsoleId, consoleTabs]);

  /* ------------------------ Console Actions ------------------------ */
  const closeConsole = useStableCallback((tabId: string) => {
    closeTab(tabId);
    dropConsoleRef(tabId);
    execution.dropTab(tabId);
  });

  const pinTab = useCallback(
    (tabId: string) => updateDirty(tabId, true),
    [updateDirty],
  );

  const openNewConsole = useCallback(() => {
    openTab({ title: "New Console", content: "" });
  }, [openTab]);

  const contentChange = useStableCallback((tabId: string, content: string) => {
    updateContent(tabId, content);
    if (!useConsoleStore.getState().tabs[tabId]?.isDirty) {
      updateDirty(tabId, true);
    }
    // Also refresh activeEditorContent for Chat consumers
    const ref = getConsoleRef(tabId).current;
    if (activeConsoleId === tabId && ref) {
      setActiveEditorContent(ref.getCurrentContent());
    }
  });

  const openHistory = useCallback(
    (tabId: string, anchor: HTMLElement) =>
      setConsoleHistory({ anchor, tabId }),
    [],
  );

  const consoleActions = useMemo<ConsoleTabActions>(
    () => ({
      execute: execution.execute,
      cancel: execution.cancel,
      nextPage: execution.nextPage,
      previousPage: execution.previousPage,
      download: execution.download,
      save: save.handleConsoleSave,
      saveAsCopy: save.handleSaveAsCopy,
      renameMove: save.handleRenameMove,
      contentChange,
      changeConnection: updateConnection,
      changeDatabase: updateDatabase,
      openHistory,
      openShare: setShareConsoleTabId,
      openScheduleModal: runs.openScheduleModal,
      selectBottomPanel: runs.selectBottomPanel,
      setChartSpec: view.setChartSpecForTab,
      setViewMode: view.setViewModeForTab,
      reportChartRender: view.reportChartRender,
    }),
    [
      execution.execute,
      execution.cancel,
      execution.nextPage,
      execution.previousPage,
      execution.download,
      save.handleConsoleSave,
      save.handleSaveAsCopy,
      save.handleRenameMove,
      contentChange,
      updateConnection,
      updateDatabase,
      openHistory,
      runs.openScheduleModal,
      runs.selectBottomPanel,
      view.setChartSpecForTab,
      view.setViewModeForTab,
      view.reportChartRender,
    ],
  );

  const renderConsole = (tab: ConsoleTab) => (
    <ConsoleTabPanel
      tab={tab}
      workspaceId={workspaceId}
      consoleRef={getConsoleRef(tab.id)}
      isMobile={isMobile}
      mobileResultsView={mobileResultsView}
      isExecuting={executingTabs[tab.id] || false}
      isCancelling={cancellingTabs[tab.id] || false}
      isSaving={save.isSaving}
      databases={availableDatabases}
      bottomPanel={runs.tabBottomPanel[tab.id] || "results"}
      results={tabResults[tab.id] || null}
      chartSpec={view.tabChartSpecs[tab.id] ?? null}
      viewMode={view.tabViewModes[tab.id] ?? "table"}
      actions={consoleActions}
      executions={runs.tabExecutions[tab.id] || EMPTY_LIST}
      executionsLoading={runs.tabExecutionsLoading[tab.id] || false}
      executionsError={runs.tabExecutionsError[tab.id]}
      scheduledRuns={runs.tabScheduledRuns[tab.id] || EMPTY_LIST}
      scheduledRunsLoading={runs.tabScheduledRunsLoading[tab.id] || false}
      scheduledRunsError={runs.tabScheduledRunsError[tab.id]}
    />
  );

  // The admin "Execute anyway" re-run of a PREVIEW_BLOCKED query.
  const executeAnyway = () => {
    const retry = feedback.errorPreviewRetry;
    if (!retry) return;
    feedback.closeError();
    void execution.execute(
      retry.tabId,
      retry.contentToExecute,
      retry.connectionId,
      { ...retry.options, confirmUnsafe: true },
    );
  };

  // Breadcrumb path (Cursor-style) — one consistent bar for every tab kind.
  // Views that embed their own actions in the bar (table data, dbt files and
  // runs) render EntityBreadcrumbs themselves. On a phone the window pill
  // already carries the title; a second row repeating it is the space the
  // editor needs.
  const rendersOwnBreadcrumbs =
    activeTab?.kind === "table-data" ||
    activeTab?.kind === "dbt-file" ||
    activeTab?.kind === "dbt-runs";
  const showBreadcrumbs = !!activeTab && !isMobile && !rendersOwnBreadcrumbs;

  /* ----------------------------- Render ---------------------------- */
  return (
    <Box sx={FILL_COLUMN_SX}>
      {consoleTabs.length > 0 ? (
        <Box sx={{ ...FILL_COLUMN_SX, overflow: "hidden" }}>
          {isMobile ? (
            <MobileEditorHeader
              consoleTabs={consoleTabs}
              activeTab={activeTab}
              onSelect={setActiveTab}
              onClose={closeConsole}
              onNewConsole={openNewConsole}
            />
          ) : (
            <EditorTabBar
              consoleTabs={consoleTabs}
              activeConsoleId={activeConsoleId}
              connectionIconById={connectionIconById}
              onSelect={setActiveTab}
              onReorder={reorderTabs}
              onClose={closeConsole}
              onPin={pinTab}
            />
          )}

          {showBreadcrumbs && <EntityBreadcrumbs tabId={activeTab.id} />}

          <EditorTabPanels
            consoleTabs={consoleTabs}
            activeConsoleId={activeConsoleId}
            mountedLazyTabs={mountedLazyTabs}
            isMobile={isMobile}
            workspaceId={workspaceId}
            dbFlowFormRef={dbFlowFormRef}
            onCloseTab={closeConsole}
            renderConsole={renderConsole}
          />
        </Box>
      ) : (
        <Box sx={{ ...FILL_COLUMN_SX, flexGrow: 1 }}>
          <Box
            sx={{
              flexGrow: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
            }}
          >
            <Typography>No console open</Typography>
            <Button
              variant="contained"
              disableElevation
              onClick={openNewConsole}
            >
              Open Console
            </Button>
          </Box>
        </Box>
      )}

      <EditorDialogs
        tabs={tabs}
        workspace={currentWorkspace}
        userId={user?.id}
        isWorkspaceAdmin={isWorkspaceAdmin}
        availableDatabases={availableDatabases}
        feedback={feedback}
        save={save}
        runs={runs}
        onExecuteAnyway={executeAnyway}
        consoleHistory={consoleHistory}
        onCloseHistory={() => setConsoleHistory(null)}
        onHistoryRestored={tabId => {
          if (workspaceId) void reloadConsole(workspaceId, tabId);
        }}
        shareConsoleTabId={shareConsoleTabId}
        onCloseShare={() => setShareConsoleTabId(null)}
      />
    </Box>
  );
}

export default Editor;
