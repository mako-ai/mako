import type { IFlow } from "../database/workspace-schema";

export function isBigQueryCdcEnabledForFlow(
  flow: Pick<IFlow, "_id" | "tableDestination" | "syncEngine">,
  destinationType?: string,
): boolean {
  if (!flow?.tableDestination?.connectionId) return false;
  if (flow.syncEngine !== "cdc") return false;
  return destinationType === "bigquery";
}
