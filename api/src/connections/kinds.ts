/**
 * The three kinds of source connection, read from its `type` alone (nothing
 * else is stored):
 *
 *   - custom: a Custom API (`custom_api`): an address and a key, called by
 *     workflows and agents, never synced;
 *   - builtin: a connector in this repository (`close`, `stripe`, `rest`,
 *     `graphql`, …): synced by flows;
 *   - workspace: a connector the workspace wrote (`ws:<slug>`): synced by
 *     flows, its code in the workspace repo.
 *
 * The app keeps the same rule in app/src/lib/source-connection-kind.ts.
 */
export const CUSTOM_API_TYPE = "custom_api";

export type SourceConnectionKind = "custom" | "builtin" | "workspace";

export function sourceConnectionKind(type: string): SourceConnectionKind {
  if (type === CUSTOM_API_TYPE) return "custom";
  if (type.startsWith("ws:")) return "workspace";
  return "builtin";
}

/** Whether a flow may sync from a connection of `type`. */
export function isSyncSource(type: string): boolean {
  return sourceConnectionKind(type) !== "custom";
}
