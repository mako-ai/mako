import React, { useState } from "react";
import { Alert, Box } from "@mui/material";
import type { LoadError } from "../../api";
import { tabKindEntityLabel } from "../../lib/entity-labels";
import { isTabMounted } from "../../lib/tab-mount-policy";
import { useConsoleStore } from "../../store/consoleStore";
import type { HistoryEntityKind } from "../../store/entityHistoryStore";
import type { ConsoleTab } from "../../store/lib/types";
import type { DbFlowFormRef } from "../DbFlowForm";
import EntityLoadErrorState from "../EntityLoadErrorState";
import {
  AppBindingEditor,
  AppDiffTab,
  AppFileEditor,
  AppsHome,
  AppWorkspace,
  DbtConsoleView,
  DbtFileEditor,
  DbtJobView,
  DbtRunsView,
  FlowEditor,
  HistoryDiffTab,
  NotebookRenderer,
  PlanDocumentTab,
  RepoDiffTab,
  Settings,
  SourceConnectionTab,
  TableDataView,
  WorkflowView,
  WorkspaceMembers,
} from "./lazy-tabs";

// Tabs whose editing surfaces are not usable on a phone; we show a dismissible
// notice instead of the cramped desktop UI.
const DESKTOP_ONLY_KINDS = new Set(["flow-editor"]);

type MountedTabs = Parameters<typeof isTabMounted>[1];

interface EditorTabPanelsProps {
  consoleTabs: ConsoleTab[];
  activeConsoleId: string | null;
  mountedLazyTabs: MountedTabs;
  isMobile: boolean;
  workspaceId: string | undefined;
  dbFlowFormRef?: React.RefObject<DbFlowFormRef | null>;
  onCloseTab: (tabId: string) => void;
  /** The console kind (editor + results) is owned by the Editor container. */
  renderConsole: (tab: ConsoleTab) => React.ReactNode;
}

/**
 * Unified tab rendering: a mounted tab stays mounted, visibility toggled
 * with CSS. Lazy kinds mount on first show (lib/tab-mount-policy).
 */
export function EditorTabPanels({
  consoleTabs,
  activeConsoleId,
  mountedLazyTabs,
  isMobile,
  workspaceId,
  dbFlowFormRef,
  onCloseTab,
  renderConsole,
}: EditorTabPanelsProps) {
  const [dismissedDesktopOnly, setDismissedDesktopOnly] = useState<
    Record<string, boolean>
  >({});

  return (
    <Box sx={{ flexGrow: 1, overflow: "hidden" }}>
      {consoleTabs.map(tab => {
        // An unshown lazy tab keeps its slot and renders nothing.
        const panelMounted = isTabMounted(tab, mountedLazyTabs);
        const showDesktopOnlyNotice =
          isMobile &&
          !!tab.kind &&
          DESKTOP_ONLY_KINDS.has(tab.kind) &&
          !dismissedDesktopOnly[tab.id];

        return (
          <Box
            key={tab.id}
            data-mako-tab-id={tab.id}
            data-mako-tab-kind={tab.kind}
            data-mako-active-tab-content={
              activeConsoleId === tab.id ? "true" : undefined
            }
            sx={{
              height: "100%",
              display: activeConsoleId === tab.id ? "block" : "none",
              overflow: "hidden",
            }}
          >
            {!panelMounted ? null : showDesktopOnlyNotice ? (
              <Box sx={{ p: 2 }}>
                <Alert
                  severity="info"
                  onClose={() =>
                    setDismissedDesktopOnly(prev => ({
                      ...prev,
                      [tab.id]: true,
                    }))
                  }
                >
                  This view is designed for a larger screen and may be hard to
                  use on a phone. Open Mako on a desktop for the full
                  experience.
                </Alert>
              </Box>
            ) : (
              <TabBody
                tab={tab}
                workspaceId={workspaceId}
                dbFlowFormRef={dbFlowFormRef}
                onCloseTab={onCloseTab}
                renderConsole={renderConsole}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

const BINDING_FILE_PATH = /^bindings\/[^/]+\.sql$/;

type DiffMode = "working" | "index" | "commit";

/** The kind switch: which body a (mounted) tab renders. */
function TabBody({
  tab,
  workspaceId,
  dbFlowFormRef,
  onCloseTab,
  renderConsole,
}: Pick<
  EditorTabPanelsProps,
  "workspaceId" | "dbFlowFormRef" | "onCloseTab" | "renderConsole"
> & { tab: ConsoleTab }) {
  const meta = tab.metadata;

  if (meta?.loadError) {
    /* Placeholder tab for an entity that failed to load (e.g. a /c/:id deep
       link into a workspace that doesn't have that console): explicit
       not-found / no-access copy instead of a silent redirect. Any tab kind
       may carry `metadata.loadError`; the label comes from the shared
       entity-label map. */
    return (
      <EntityLoadErrorState
        error={meta.loadError as LoadError}
        entityLabel={tabKindEntityLabel(tab.kind)}
        onRetry={
          (tab.kind ?? "console") === "console"
            ? () => {
                if (workspaceId) {
                  void useConsoleStore
                    .getState()
                    .loadConsole(workspaceId, tab.id);
                }
              }
            : undefined
        }
      />
    );
  }

  switch (tab.kind) {
    case "settings":
      return <Settings section={tab.settingsSection} />;
    case "members":
      return <WorkspaceMembers />;
    case "connectors":
      return (
        <SourceConnectionTab
          tabId={tab.id}
          sourceId={typeof tab.content === "string" ? tab.content : undefined}
        />
      );
    case "flow-editor":
      return (
        <FlowEditor
          tabId={tab.id}
          flowId={meta?.flowId as string | undefined}
          isNew={meta?.isNew as boolean | undefined}
          flowType={
            meta?.flowType as
              "webhook" | "scheduled" | "db-scheduled" | "sync" | undefined
          }
          onSave={() => {
            // The FlowEditor already handles refreshing the flows list
          }}
          onCancel={() => {
            onCloseTab(tab.id);
          }}
          dbFlowFormRef={dbFlowFormRef}
        />
      );
    case "table-data":
      return <TableDataView tabId={tab.id} />;
    case "notebook":
      return (
        <NotebookRenderer
          notebookId={meta?.notebookId as string}
          tabId={tab.id}
        />
      );
    case "app":
      return <AppWorkspace tabId={tab.id} appId={meta?.appId as string} />;
    case "app-file":
      return BINDING_FILE_PATH.test((meta?.path as string) ?? "") ? (
        <AppBindingEditor
          tabId={tab.id}
          appId={meta?.appId as string}
          path={meta?.path as string}
        />
      ) : (
        <AppFileEditor
          tabId={tab.id}
          appId={meta?.appId as string}
          path={meta?.path as string}
        />
      );
    case "history-diff":
      return (
        <HistoryDiffTab
          entity={meta?.entity as HistoryEntityKind}
          id={meta?.id as string}
          path={meta?.path as string}
          sha={meta?.sha as string}
        />
      );
    case "repo-diff":
      return (
        <RepoDiffTab
          path={meta?.path as string}
          mode={(meta?.mode as DiffMode) ?? "working"}
          sha={meta?.sha as string | undefined}
        />
      );
    case "app-diff":
      return (
        <AppDiffTab
          appId={meta?.appId as string}
          path={meta?.path as string}
          mode={(meta?.mode as DiffMode) ?? "working"}
          sha={meta?.sha as string | undefined}
        />
      );
    case "plan":
      return <PlanDocumentTab toolCallId={meta?.toolCallId as string} />;
    case "dbt-file":
      return (
        <DbtFileEditor
          tabId={tab.id}
          projectId={meta?.projectId as string}
          path={meta?.path as string}
        />
      );
    case "dbt-job":
      return (
        <DbtJobView
          projectId={meta?.projectId as string}
          jobId={meta?.jobId as string}
          autoEdit={meta?.autoEdit as boolean | undefined}
        />
      );
    case "dbt-console":
      return <DbtConsoleView projectId={meta?.projectId as string} />;
    case "apps-home":
      return <AppsHome />;
    case "dbt-runs":
      return (
        <DbtRunsView
          tabId={tab.id}
          projectId={meta?.projectId as string}
          focusRunId={meta?.focusRunId as string | undefined}
        />
      );
    case "workflow":
      return (
        <WorkflowView
          tabId={tab.id}
          runId={meta?.runId as string | undefined}
          workflowId={meta?.workflowId as string | undefined}
          path={meta?.path as string | undefined}
        />
      );
    default:
      /* Console tab: editor + results split (desktop) or a single
         full-screen pane switched by the header toggle (mobile). */
      return renderConsole(tab);
  }
}
