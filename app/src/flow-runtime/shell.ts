import { useConsoleStore } from "../store/consoleStore";
import type { Flow } from "../store/flowStore";

/**
 * The title a flow row, tab and palette entry all show. Was three copies.
 *
 * A flow's stored `name` wins when it has one (RFC #904): it is what the
 * create form sent and what a rename edits. The source → destination
 * derivation below stays as the fallback for rows the backfill has not
 * reached, so nothing renders blank mid-deploy.
 */
export function getFlowTitle(flow: Flow): string {
  if (flow.name?.trim()) return flow.name.trim();
  const f = flow as Flow & {
    sourceType?: string;
    tableDestination?: { tableName?: string };
  };
  if (f.sourceType === "database") {
    return `Query -> ${f.tableDestination?.tableName || "Table"}`;
  }
  const sourceName =
    (flow.dataSourceId as { name?: string } | undefined)?.name || "Source";
  const destName =
    (flow.destinationDatabaseId as { name?: string } | undefined)?.name ||
    "Destination";
  return `${sourceName} -> ${destName}`;
}

/**
 * Open (or focus) the editor tab for a flow. The explorer, the command
 * palette and deep links used to build this tab three different ways (three
 * metadata sets); this is the one way.
 */
export function focusFlowTab(flow: Flow): string {
  const f = flow as Flow & { sourceType?: string };
  return useConsoleStore
    .getState()
    .focusOrOpenTab(
      { kind: "flow-editor", metadata: { flowId: flow._id } },
      () => ({
        title: getFlowTitle(flow),
        content: "",
        kind: "flow-editor",
        metadata: {
          flowId: flow._id,
          isNew: false,
          flowType: f.sourceType === "database" ? "db-scheduled" : flow.type,
          enabled:
            flow.type === "webhook"
              ? flow.webhookConfig?.enabled
              : flow.schedule?.enabled,
        },
      }),
    ) as string;
}

/**
 * Deep link with only an id: focus the tab if open, else open one titled
 * `title` (the resolve call's answer) or a placeholder; `healFlowTabs`
 * gives it the listed name once the flow list has it.
 */
export function focusFlowTabById(flowId: string, title = "Flow"): string {
  return useConsoleStore
    .getState()
    .focusOrOpenTab({ kind: "flow-editor", metadata: { flowId } }, () => ({
      title,
      content: "",
      kind: "flow-editor",
      metadata: { flowId },
    })) as string;
}

/** Close every editor tab open on `flowId` (a dead link's leftovers). */
export function closeFlowTabsFor(flowId: string): boolean {
  const store = useConsoleStore.getState();
  const doomed = Object.values(store.tabs).filter(
    (tab: { id: string; kind?: string; metadata?: { flowId?: unknown } }) =>
      tab.kind === "flow-editor" && tab.metadata?.flowId === flowId,
  );
  for (const tab of doomed) store.closeTab(tab.id);
  return doomed.length > 0;
}

/**
 * Keep open flow tabs titled after the flow they show. A flow keeps its id
 * through every rename (UI, agent, a laptop `git mv` the push paired), so
 * the tab — and the breadcrumb and page title, which read the tab — only
 * needs the listed name. Called after every successful list fetch (Refresh,
 * `flow.updated`, a push). Tabs of flows the list lacks are left alone: the
 * editor itself reports a flow that is gone.
 */
export function healFlowTabs(flows: readonly Flow[]): void {
  const titles = new Map(flows.map(flow => [flow._id, getFlowTitle(flow)]));
  const stale = Object.values(useConsoleStore.getState().tabs).some(
    (tab: { kind?: string; title?: string; metadata?: { flowId?: unknown } }) =>
      tab.kind === "flow-editor" &&
      typeof tab.metadata?.flowId === "string" &&
      titles.has(tab.metadata.flowId) &&
      titles.get(tab.metadata.flowId) !== tab.title,
  );
  // No write when nothing changed: every list fetch lands here, and a
  // no-op set would still persist the whole tab store.
  if (!stale) return;
  useConsoleStore.setState(state => {
    for (const tab of Object.values(state.tabs) as Array<{
      kind?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }>) {
      if (tab.kind !== "flow-editor") continue;
      const flowId = tab.metadata?.flowId;
      if (typeof flowId !== "string") continue;
      const title = titles.get(flowId);
      if (title && tab.title !== title) tab.title = title;
    }
  });
}
