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

type DestinationFields = Pick<
  IFlow,
  "destinationDatabaseId" | "destinationDatabaseName" | "tableDestination"
>;

/**
 * Every field that can choose where a flow's rows land. The CDC writer takes
 * the connection from `destinationDatabaseId` and the dataset from
 * `tableDestination.schema` (default `public`); the other fields are kept so
 * that any change to them voids an approval too.
 */
export function destinationOf(flow: DestinationFields) {
  const table = flow.tableDestination;
  return {
    connections: [
      String(flow.destinationDatabaseId ?? ""),
      String(table?.connectionId ?? ""),
    ],
    database: [
      String(flow.destinationDatabaseName ?? ""),
      String(table?.database ?? ""),
    ],
    schema: String(table?.schema || "public"),
    prefix: String(table?.tableName ?? ""),
  };
}

/** The destination tables as one comparable string. */
export function destinationKey(flow: DestinationFields): string {
  const d = destinationOf(flow);
  return JSON.stringify([d.connections, d.database, d.schema, d.prefix]);
}

/**
 * Whether two flows can write the same dataset: a connection either names
 * (the writer's or the table's) in common, and the same dataset. The table
 * prefix does not separate them: a shadow writes its own dataset.
 */
export function mayShareDataset(
  a: DestinationFields,
  b: DestinationFields,
): boolean {
  const x = destinationOf(a);
  const y = destinationOf(b);
  const xs = new Set(x.connections.filter(Boolean));
  const shared = y.connections.some(c => c && xs.has(c));
  return shared && x.schema === y.schema;
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
    Pick<IFlow, "connectorRuntime" | "boxedConnector" | "replaces">,
): string {
  return JSON.stringify([
    approvalBinding(flow),
    boxedKind(flow),
    flow.boxedConnector ?? "",
    flow.replaces ? String(flow.replaces) : "",
  ]);
}
