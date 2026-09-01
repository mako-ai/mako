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
 * Deep link with only an id: focus the tab if open, else open a placeholder
 * the FlowEditor fills in once the flow loads.
 */
export function focusFlowTabById(flowId: string): string {
  return useConsoleStore
    .getState()
    .focusOrOpenTab({ kind: "flow-editor", metadata: { flowId } }, () => ({
      title: "Flow",
      content: "",
      kind: "flow-editor",
      metadata: { flowId },
    })) as string;
}
