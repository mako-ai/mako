/**
 * The three kinds of source connection, read from its `type` alone. Same
 * rule as the API's api/src/connections/kinds.ts:
 *
 *   - custom: a Custom API (`custom_api`), called by workflows and agents,
 *     never synced;
 *   - builtin: a connector shipped with Mako (`close`, `stripe`, …);
 *   - workspace: a connector the workspace wrote (`ws:<slug>`).
 */
export type SourceConnectionKind = "custom" | "builtin" | "workspace";

export function sourceConnectionKind(type: string): SourceConnectionKind {
  if (type === "custom_api") return "custom";
  if (type.startsWith("ws:")) return "workspace";
  return "builtin";
}

/** Whether a flow may sync from a connection of `type`. */
export function isSyncSource(type: string): boolean {
  return sourceConnectionKind(type) !== "custom";
}

export const SOURCE_CONNECTION_KIND_LABEL: Record<
  SourceConnectionKind,
  string
> = {
  custom: "Custom API",
  builtin: "Built-in",
  workspace: "Workspace",
};
