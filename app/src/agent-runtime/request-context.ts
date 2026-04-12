import type { ConsoleTab } from "../store/lib/types";
import type { Connection } from "../store/schemaStore";
import { getDashboardStateSnapshot } from "../dashboard-runtime/commands";
import { useDashboardStore } from "../store/dashboardStore";

export type ChatActiveView = "console" | "dashboard" | "flow-editor" | "empty";

export interface ActiveConsoleResultsContext {
  viewMode: "table" | "json" | "chart";
  hasResults: boolean;
  rowCount: number;
  columns: string[];
  sampleRows: Record<string, unknown>[];
  chartSpec: Record<string, unknown> | null;
}

interface BuildDashboardRequestContextOptions {
  activeView: ChatActiveView;
  pinnedDashboardId?: string | null;
  pinnedDashboardTitle?: string | null;
  workspaceConnections: Connection[];
}

interface BuildChatRequestBodyOptions {
  messages: unknown;
  workspaceId?: string;
  modelId?: string;
  chatId?: string;
  tabs: ConsoleTab[];
  activeTabId?: string | null;
  activeTab?: ConsoleTab;
  activeView: ChatActiveView;
  activeConsoleId?: string | null;
  activeConsoleResults?: ActiveConsoleResultsContext;
  flowFormState?: Record<string, unknown>;
  workspaceConnections: Connection[];
  pinnedDashboardId?: string | null;
}

function buildOpenConsoles(tabs: ConsoleTab[]) {
  return tabs
    .filter(tab => tab?.kind === undefined || tab?.kind === "console")
    .map(tab => {
      const content = tab.content || "";
      const lines = content.split("\n");
      const maxLines = 50;
      const truncated = lines.length > maxLines;
      const displayContent = truncated
        ? lines.slice(0, maxLines).join("\n")
        : content;

      return {
        id: tab.id,
        title: tab.title,
        connectionId: tab.connectionId,
        databaseId: tab.databaseId,
        databaseName: tab.databaseName,
        content: displayContent,
        contentTruncated: truncated,
        lineCount: lines.length,
      };
    });
}

function buildOpenTabs(tabs: ConsoleTab[], activeTabId?: string | null) {
  return tabs.map(tab => ({
    id: tab.id,
    kind: tab.kind || "console",
    title: tab.title,
    isActive: tab.id === activeTabId,
    dashboardId:
      tab.kind === "dashboard"
        ? (tab.metadata?.dashboardId as string | undefined)
        : undefined,
    flowId:
      tab.kind === "flow-editor"
        ? (tab.metadata?.flowId as string | undefined)
        : undefined,
    connectionId:
      tab.kind === "console" || !tab.kind ? tab.connectionId : undefined,
    databaseName:
      tab.kind === "console" || !tab.kind ? tab.databaseName : undefined,
  }));
}

export function buildDashboardRequestContext({
  activeView,
  pinnedDashboardId,
  pinnedDashboardTitle,
  workspaceConnections,
}: BuildDashboardRequestContextOptions) {
  if (activeView !== "dashboard" || !pinnedDashboardId) {
    return {};
  }

  try {
    const dashboardStore = useDashboardStore.getState();
    const connectionById = new Map(
      workspaceConnections.map(connection => [connection.id, connection]),
    );
    const SAMPLE_LIMIT = 3;

    const openDashboardsFromStore = Object.values(
      dashboardStore.openDashboards,
    ).map((dashboard: any) => ({
      id: dashboard._id,
      title: dashboard.title,
      isActive: dashboard._id === pinnedDashboardId,
    }));

    const snapshot = getDashboardStateSnapshot(pinnedDashboardId);
    const openDashboards =
      openDashboardsFromStore.length > 0
        ? openDashboardsFromStore
        : [
            {
              id: snapshot._id,
              title: snapshot.title,
              isActive: true,
            },
          ];

    return {
      openDashboards,
      activeDashboardContext: {
        dashboardId: snapshot._id,
        title: snapshot.title,
        description: snapshot.description,
        crossFilterEnabled: !!snapshot.crossFilter?.enabled,
        crossFilter: snapshot.crossFilter,
        layout: snapshot.layout,
        materializationSchedule: snapshot.materializationSchedule,
        dataSources: snapshot.dataSources.map((dataSource: any) => {
          const { _id: _dataSourceId, sampleRows, ...rest } = dataSource;
          return {
            ...rest,
            sampleRows: sampleRows?.slice(0, SAMPLE_LIMIT),
            connectionType:
              connectionById.get(dataSource.query?.connectionId)?.type ||
              undefined,
            sqlDialect:
              connectionById.get(dataSource.query?.connectionId)?.type ===
              "mongodb"
                ? undefined
                : (
                    connectionById.get(dataSource.query?.connectionId) as
                      | { sqlDialect?: string }
                      | undefined
                  )?.sqlDialect ||
                  (dataSource.query?.language === "sql" ? "duckdb" : undefined),
          };
        }),
        widgets: snapshot.widgets.map(
          ({ _id: _widgetId, ...widget }: any) => widget,
        ),
      },
    };
  } catch {
    return pinnedDashboardTitle
      ? {
          openDashboards: [
            {
              id: pinnedDashboardId,
              title: pinnedDashboardTitle,
              isActive: true,
            },
          ],
        }
      : {};
  }
}

export function buildChatRequestBody({
  messages,
  workspaceId,
  modelId,
  chatId,
  tabs,
  activeTabId,
  activeTab,
  activeView,
  activeConsoleId,
  activeConsoleResults,
  flowFormState,
  workspaceConnections,
  pinnedDashboardId,
}: BuildChatRequestBodyOptions) {
  return {
    messages,
    workspaceId,
    modelId,
    chatId,
    openConsoles: buildOpenConsoles(tabs),
    openTabs: buildOpenTabs(tabs, activeTabId),
    consoleId: activeConsoleId,
    activeConsoleResults,
    agentId: "unified",
    activeView,
    tabKind: activeTab?.kind,
    flowType: activeTab?.metadata?.flowType,
    flowFormState,
    ...buildDashboardRequestContext({
      activeView,
      pinnedDashboardId,
      pinnedDashboardTitle:
        activeTab?.kind === "dashboard" ? activeTab.title || null : null,
      workspaceConnections,
    }),
  };
}
