import type { IFlow } from "../database/workspace-schema";
import { hasCdcDestinationAdapter } from "./adapters/registry";

export function isCdcEnabledForFlow(
  flow: Pick<IFlow, "tableDestination" | "syncEngine">,
  destinationType?: string,
): boolean {
  if (!flow?.tableDestination?.connectionId) return false;
  if (flow.syncEngine !== "cdc") return false;
  return hasCdcDestinationAdapter(destinationType);
}
