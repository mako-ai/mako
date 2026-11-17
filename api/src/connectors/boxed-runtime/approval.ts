/**
 * What an owner/admin's approval of a boxed run is bound to. No runtime
 * imports: the flow-file apply (services/flow-definition-apply.ts) uses it
 * to void an approval when a file edit moves what it was bound to.
 */
import type { IFlow } from "../../database/workspace-schema";

/**
 * What the flow asks for. A shadow is boxed by `shadowOf` alone; its
 * `runtime:` is ignored. A live flow is boxed by `runtime: boxed`. So a
 * file cannot turn a shadow's approval into a live flow's: dropping
 * `shadow_of:` changes the kind, and the approval names its kind.
 */
export function boxedKind(
  flow: Pick<IFlow, "connectorRuntime" | "shadowOf">,
): "shadow" | "switch" | null {
  if (flow.shadowOf) return "shadow";
  return flow.connectorRuntime === "boxed" ? "switch" : null;
}

export function destinationOf(
  flow: Pick<
    IFlow,
    "destinationDatabaseId" | "destinationDatabaseName" | "tableDestination"
  >,
) {
  const table = flow.tableDestination;
  return {
    connection: String(table?.connectionId ?? flow.destinationDatabaseId ?? ""),
    database: String(table?.database ?? flow.destinationDatabaseName ?? ""),
    schema: String(table?.schema ?? ""),
    prefix: String(table?.tableName ?? ""),
  };
}

/** The destination tables as one comparable string. */
export function destinationKey(
  flow: Pick<
    IFlow,
    "destinationDatabaseId" | "destinationDatabaseName" | "tableDestination"
  >,
): string {
  const d = destinationOf(flow);
  return JSON.stringify([d.connection, d.database, d.schema, d.prefix]);
}

/** What an approval is bound to, from the flow as it stands. */
export function approvalBinding(
  flow: Pick<
    IFlow,
    | "dataSourceId"
    | "shadowOf"
    | "destinationDatabaseId"
    | "destinationDatabaseName"
    | "tableDestination"
  >,
) {
  return {
    connectionId: String(flow.dataSourceId ?? ""),
    destination: destinationKey(flow),
    shadowOf: flow.shadowOf ? String(flow.shadowOf) : undefined,
  };
}

/**
 * Everything an approval stands on, as one string: a file edit that
 * changes it voids the approval (applyDefinition).
 */
export function approvalFingerprint(
  flow: Parameters<typeof approvalBinding>[0] &
    Pick<IFlow, "connectorRuntime" | "boxedConnector">,
): string {
  return JSON.stringify([
    approvalBinding(flow),
    boxedKind(flow),
    flow.boxedConnector ?? "",
  ]);
}
