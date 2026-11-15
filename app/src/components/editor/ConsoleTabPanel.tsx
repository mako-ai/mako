import React, { memo, useCallback } from "react";
import { Box } from "@mui/material";
import { Group, Panel } from "react-resizable-panels";
import Console, { type ConsoleRef } from "../Console";
import ConsoleRemoteUpdateBanner from "../ConsoleRemoteUpdateBanner";
import { useConsoleStore } from "../../store/consoleStore";
import type { ConsoleTab } from "../../store/lib/types";
import type { Connection } from "../../store/schemaStore";
import { separatorDragRef } from "../../lib/iframe-drag-guard";
import {
  logRenderDebug,
  onRenderDebug,
  renderDebugEnabled,
} from "../../utils/renderDebug";
import {
  ConsoleResultsPane,
  type ConsoleResultsActions,
  type ConsoleRunsData,
} from "./ConsoleResultsPane";
import { FILL_COLUMN_SX, StyledVerticalResizeHandle } from "./styles";
import type {
  BottomPanel,
  ExecuteOptions,
  QueryResult,
  ResultsViewMode,
} from "./types";
import type { MakoChartSpec } from "../../lib/chart-spec";

// Makes iframes ignore the pointer while a divider is dragged (a cross-
// origin preview would otherwise swallow the drag). Stable: see separatorDragRef.
const guardSeparatorDrag = separatorDragRef();

/** Stable, tab-id-keyed handlers shared by every console tab panel. */
export interface ConsoleTabActions extends ConsoleResultsActions {
  execute: (
    tabId: string,
    content: string,
    connectionId?: string,
    options?: ExecuteOptions,
  ) => Promise<void>;
  cancel: (tabId: string) => void;
  save: (
    tabId: string,
    content: string,
    currentPath?: string,
  ) => Promise<boolean>;
  saveAsCopy: (tabId: string, content: string) => void;
  renameMove: (tabId: string, content: string, currentPath?: string) => void;
  contentChange: (tabId: string, content: string) => void;
  changeConnection: (tabId: string, connectionId: string) => void;
  changeDatabase: (
    tabId: string,
    databaseId: string | undefined,
    databaseName: string | undefined,
  ) => void;
  openHistory: (tabId: string, anchor: HTMLElement) => void;
  openShare: (tabId: string) => void;
  openScheduleModal: (tabId: string, mode: "create" | "update") => void;
}

interface ConsoleTabPanelProps extends ConsoleRunsData {
  tab: ConsoleTab;
  workspaceId: string | undefined;
  consoleRef: React.RefObject<ConsoleRef | null>;
  isMobile: boolean;
  mobileResultsView: boolean;
  isExecuting: boolean;
  isCancelling: boolean;
  isSaving: boolean;
  databases: Connection[];
  bottomPanel: BottomPanel;
  results: QueryResult | null;
  chartSpec: MakoChartSpec | null;
  viewMode: ResultsViewMode;
  actions: ConsoleTabActions;
}

const handlePanelLayout = (tabId: string, layout: unknown) => {
  logRenderDebug("Editor.panel-layout", { tabId, layout });
};

/**
 * A console tab: editor on top, results / runs below (desktop vertical
 * split), or a single full-screen pane switched by the header toggle (mobile).
 */
export const ConsoleTabPanel = memo(function ConsoleTabPanel({
  tab,
  workspaceId,
  consoleRef,
  isMobile,
  mobileResultsView,
  isExecuting,
  isCancelling,
  isSaving,
  databases,
  bottomPanel,
  results,
  chartSpec,
  viewMode,
  actions,
  ...runs
}: ConsoleTabPanelProps) {
  const tabId = tab.id;
  const { databaseId: tabDatabaseId, databaseName: tabDatabaseName } = tab;
  const {
    execute,
    cancel,
    save,
    saveAsCopy,
    renameMove,
    contentChange,
    changeConnection,
    changeDatabase,
    openHistory,
    openShare,
    openScheduleModal,
  } = actions;

  const onExecute = useCallback(
    (content: string, connectionId?: string, databaseId?: string) =>
      execute(tabId, content, connectionId, {
        databaseId: databaseId || tabDatabaseId,
        databaseName: tabDatabaseName,
      }),
    [execute, tabId, tabDatabaseId, tabDatabaseName],
  );
  const onCancel = useCallback(() => cancel(tabId), [cancel, tabId]);
  const onSave = useCallback(
    (content: string, currentPath?: string) =>
      save(tabId, content, currentPath),
    [save, tabId],
  );
  const onSaveAsCopy = useCallback(
    (content: string) => saveAsCopy(tabId, content),
    [saveAsCopy, tabId],
  );
  const onRenameMove = useCallback(
    (content: string, currentPath?: string) =>
      renameMove(tabId, content, currentPath),
    [renameMove, tabId],
  );
  const onContentChange = useCallback(
    (content: string) => contentChange(tabId, content),
    [contentChange, tabId],
  );
  const onDatabaseChange = useCallback(
    (connId: string) => changeConnection(tabId, connId),
    [changeConnection, tabId],
  );
  const onDatabaseNameChange = useCallback(
    (dbId: string | undefined, dbName: string | undefined) =>
      changeDatabase(tabId, dbId, dbName),
    [changeDatabase, tabId],
  );
  const onHistoryClick = useCallback(
    (anchor: HTMLElement) => openHistory(tabId, anchor),
    [openHistory, tabId],
  );
  const onShareClick = useCallback(() => openShare(tabId), [openShare, tabId]);
  const onCreateSchedule = useCallback(
    () => openScheduleModal(tabId, "create"),
    [openScheduleModal, tabId],
  );
  const onUpdateSchedule = useCallback(
    () => openScheduleModal(tabId, "update"),
    [openScheduleModal, tabId],
  );

  // Top (editor) and bottom (results) panes, shared by the desktop vertical
  // split and the mobile single-pane view.
  const consolePane = (
    <Box sx={FILL_COLUMN_SX}>
      {tab.remoteUpdate && (
        <ConsoleRemoteUpdateBanner
          remoteUpdate={tab.remoteUpdate}
          onLoadLatest={() => {
            if (!workspaceId) return;
            void useConsoleStore
              .getState()
              .applyRemoteConsoleUpdate(workspaceId, tabId);
          }}
          onKeepMine={() => {
            if (!workspaceId) return;
            // Use the LIVE Monaco buffer, not the store
            // copy — it may lag keystrokes by a debounce.
            const live = consoleRef.current?.getCurrentContent().content;
            void useConsoleStore
              .getState()
              .resolveRemoteUpdateKeepMine(
                workspaceId,
                tabId,
                live ?? tab.content,
              );
          }}
          onDismiss={() =>
            useConsoleStore.getState().dismissRemoteUpdate(tabId)
          }
          onCloseTab={() => useConsoleStore.getState().closeTab(tabId)}
        />
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Console
          ref={consoleRef}
          consoleId={tabId}
          initialContent={tab.content}
          title={tab.title}
          onExecute={onExecute}
          onCancel={onCancel}
          onSave={onSave}
          onSaveAsCopy={onSaveAsCopy}
          onRenameMove={onRenameMove}
          isExecuting={isExecuting}
          isCancelling={isCancelling}
          isSaving={isSaving}
          onContentChange={onContentChange}
          connectionId={tab.connectionId}
          databaseId={tab.databaseId}
          databaseName={tab.databaseName}
          databases={databases}
          onDatabaseChange={onDatabaseChange}
          onDatabaseNameChange={onDatabaseNameChange}
          filePath={tab.filePath}
          enableVersionControl={true}
          onHistoryClick={onHistoryClick}
          historyAvailable={tab.isSaved}
          onShareClick={onShareClick}
          shareAvailable={tab.isSaved}
          schedule={tab.schedule}
          onCreateSchedule={onCreateSchedule}
          onUpdateSchedule={onUpdateSchedule}
        />
      </Box>
    </Box>
  );

  const resultsPane = (
    <ConsoleResultsPane
      tabId={tabId}
      isSaved={tab.isSaved}
      hasSchedule={Boolean(tab.schedule)}
      bottomPanel={bottomPanel}
      results={results}
      chartSpec={chartSpec}
      viewMode={viewMode}
      actions={actions}
      {...runs}
    />
  );

  return (
    <React.Profiler
      id={`Editor.console-panels.${tabId}`}
      onRender={onRenderDebug}
    >
      {isMobile ? (
        <Box sx={{ height: "100%" }}>
          {mobileResultsView ? resultsPane : consolePane}
        </Box>
      ) : (
        <Group
          orientation="vertical"
          style={{ height: "100%", width: "100%" }}
          onLayoutChange={
            renderDebugEnabled
              ? layout => handlePanelLayout(tabId, layout)
              : undefined
          }
        >
          <Panel defaultSize="60%" minSize="1%">
            {consolePane}
          </Panel>

          <StyledVerticalResizeHandle elementRef={guardSeparatorDrag} />

          <Panel defaultSize="40%" minSize="1%">
            {resultsPane}
          </Panel>
        </Group>
      )}
    </React.Profiler>
  );
});
