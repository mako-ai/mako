import type { ConsoleTab } from "../store/lib/types";
import type { ActiveExplorer } from "../store/uiStore";

export type ChatActiveView = "console" | "flow-editor" | "empty";

export interface ActiveConsoleResultsContext {
  viewMode: "table" | "json" | "chart";
  hasResults: boolean;
  rowCount: number;
  columns: string[];
  sampleRows: Record<string, unknown>[];
  chartSpec: Record<string, unknown> | null;
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
  activeExplorer: ActiveExplorer;
  activeConsoleId?: string | null;
  activeConsoleResults?: ActiveConsoleResultsContext;
  flowFormState?: Record<string, unknown>;
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

/** Tab kinds whose metadata carries a dbt project id. */
const DBT_TAB_KINDS = new Set([
  "dbt-file",
  "dbt-job",
  "dbt-console",
  "dbt-runs",
]);

export function buildOpenTabs(tabs: ConsoleTab[], activeTabId?: string | null) {
  return tabs.map(tab => ({
    id: tab.id,
    kind: tab.kind || "console",
    title: tab.title,
    isActive: tab.id === activeTabId,
    flowId:
      tab.kind === "flow-editor"
        ? (tab.metadata?.flowId as string | undefined)
        : undefined,
    notebookId:
      tab.kind === "notebook"
        ? (tab.metadata?.notebookId as string | undefined)
        : undefined,
    // Lets the server resolve which dbt project's .makorules govern this turn.
    dbtProjectId: DBT_TAB_KINDS.has(tab.kind || "")
      ? (tab.metadata?.projectId as string | undefined)
      : undefined,
    connectionId:
      tab.kind === "console" || !tab.kind ? tab.connectionId : undefined,
    databaseName:
      tab.kind === "console" || !tab.kind ? tab.databaseName : undefined,
  }));
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
  activeExplorer,
  activeConsoleId,
  activeConsoleResults,
  flowFormState,
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
    activeExplorer,
    tabKind: activeTab?.kind,
    flowType: activeTab?.metadata?.flowType,
    flowFormState,
  };
}
