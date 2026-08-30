/**
 * Compact "what's on screen" block prepended to Local ACP prompts so Claude
 * Code / Codex match native Chat's request-context awareness.
 */
import {
  buildChatRequestBody,
  type ChatActiveView,
} from "../agent-runtime/request-context";
import { useConsoleStore } from "../store/consoleStore";
import { useSchemaStore } from "../store/schemaStore";
import { selectActiveExplorer, useUIStore } from "../store/uiStore";

const MAX_CONTEXT_CHARS = 6_000;
const DBT_TAB_KINDS = new Set([
  "dbt-file",
  "dbt-job",
  "dbt-console",
  "dbt-runs",
]);

export function getAcpDbtFocus(): {
  active: boolean;
  projectId?: string;
} {
  const consoleStore = useConsoleStore.getState();
  const dbtTabs = Object.values(consoleStore.tabs).filter(
    tab => tab.kind && DBT_TAB_KINDS.has(tab.kind),
  );
  if (dbtTabs.length === 0) return { active: false };
  const activeTab = consoleStore.activeTabId
    ? consoleStore.tabs[consoleStore.activeTabId]
    : undefined;
  const activeProjectId =
    activeTab?.kind && DBT_TAB_KINDS.has(activeTab.kind)
      ? activeTab.metadata?.projectId
      : undefined;
  const projectIds = new Set(
    dbtTabs
      .map(tab => tab.metadata?.projectId)
      .filter(
        (projectId): projectId is string => typeof projectId === "string",
      ),
  );
  const projectId =
    typeof activeProjectId === "string"
      ? activeProjectId
      : projectIds.size === 1
        ? [...projectIds][0]
        : undefined;
  return {
    active: true,
    projectId,
  };
}

export function buildAcpUiContextBlock(args: {
  workspaceId?: string;
  chatId?: string;
  modelId?: string;
}): string {
  const consoleStore = useConsoleStore.getState();
  const tabs = Object.values(consoleStore.tabs);
  const activeTabId = consoleStore.activeTabId;
  const activeTab = activeTabId ? consoleStore.tabs[activeTabId] : undefined;

  let activeView: ChatActiveView = "empty";
  if (activeTab?.kind === "dashboard") {
    activeView = "dashboard";
  } else if (activeTab?.kind === "flow-editor") {
    activeView = "flow-editor";
  } else if (activeTab?.kind === "console" || !activeTab?.kind) {
    activeView = "console";
  }

  const pinnedDashboardId =
    activeTab?.kind === "dashboard"
      ? ((activeTab.metadata?.dashboardId as string | undefined) ?? null)
      : null;

  const connectionsByWorkspace = useSchemaStore.getState().connections ?? {};
  const workspaceConnections = args.workspaceId
    ? (connectionsByWorkspace[args.workspaceId] ?? [])
    : [];

  const body = buildChatRequestBody({
    messages: [],
    workspaceId: args.workspaceId,
    modelId: args.modelId,
    chatId: args.chatId,
    tabs,
    activeTabId,
    activeTab,
    activeView,
    activeExplorer: selectActiveExplorer(useUIStore.getState()),
    activeConsoleId:
      activeTab?.kind === "console" || !activeTab?.kind
        ? activeTabId
        : undefined,
    workspaceConnections,
    pinnedDashboardId,
  });

  const lines: string[] = [
    "[Mako Desktop UI context — the user can see this in the app window]",
    `activeView: ${body.activeView}`,
    `activeExplorer: ${JSON.stringify(body.activeExplorer ?? null)}`,
  ];

  if (Array.isArray(body.openTabs) && body.openTabs.length > 0) {
    lines.push(
      `openTabs: ${JSON.stringify(
        body.openTabs.map(t => ({
          kind: t.kind,
          title: t.title,
          isActive: t.isActive,
          id: t.id,
          dashboardId: t.dashboardId,
          notebookId: t.notebookId,
          dbtProjectId: t.dbtProjectId,
        })),
      )}`,
    );
  }

  if (Array.isArray(body.openConsoles) && body.openConsoles.length > 0) {
    const consoles = body.openConsoles.slice(0, 4).map(c => ({
      id: c.id,
      title: c.title,
      connectionId: c.connectionId,
      databaseName: c.databaseName,
      contentPreview: String(c.content || "").slice(0, 800),
      contentTruncated: c.contentTruncated,
    }));
    lines.push(`openConsoles: ${JSON.stringify(consoles)}`);
  }

  if (body.activeDashboardContext) {
    lines.push(
      `activeDashboard: ${JSON.stringify({
        dashboardId: body.activeDashboardContext.dashboardId,
        title: body.activeDashboardContext.title,
        widgetCount: Array.isArray(body.activeDashboardContext.widgets)
          ? body.activeDashboardContext.widgets.length
          : 0,
        dataSourceCount: Array.isArray(body.activeDashboardContext.dataSources)
          ? body.activeDashboardContext.dataSources.length
          : 0,
      })}`,
    );
  }

  lines.push(
    "Use this context instead of asking the user for tab/app/console IDs when they say “this”, “the app”, or “current console”.",
    "For open apps, previewErrors (if any) are live iframe build/runtime errors — fix them with app_* tools. Prefer mako-desktop__run_app after edits when available.",
    "[End UI context]",
  );

  let text = lines.join("\n");
  if (text.length > MAX_CONTEXT_CHARS) {
    text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n…(truncated)`;
  }
  return text;
}

export function prependAcpUiContext(
  userText: string,
  contextBlock: string | undefined,
): string {
  const trimmed = userText.trim();
  const ctx = contextBlock?.trim();
  if (!ctx) return trimmed;
  return `${ctx}\n\n[User message]\n${trimmed}`;
}
