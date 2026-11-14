/**
 * Monaco completion providers are registered per *language*, so every
 * provider sees every SQL model on the page. Editors that need their own
 * completion context (the DB flow query editor completes against the flow's
 * source connection, not the active console's) give their model a path under
 * this segment, and each provider checks the model URI before answering.
 */
const DB_FLOW_QUERY_MODEL_SEGMENT = "mako-db-flow-query";

/** Model path for one DbFlowForm query editor instance. */
export function dbFlowQueryModelPath(instanceId: string): string {
  const safeId = instanceId.replace(/[^A-Za-z0-9_-]/g, "");
  return `${DB_FLOW_QUERY_MODEL_SEGMENT}/${safeId || "default"}.sql`;
}

export function isDbFlowQueryModelUri(uri: string): boolean {
  return uri.includes(`/${DB_FLOW_QUERY_MODEL_SEGMENT}/`);
}

/** True when `uri` is the model created for `path` (see dbFlowQueryModelPath). */
export function modelUriMatchesPath(uri: string, path: string): boolean {
  return uri.endsWith(`/${path}`);
}

type ModelWithUri = { uri?: { toString: () => string } };

export function modelUriOf(model: unknown): string {
  const uri = (model as ModelWithUri | null)?.uri;
  return uri ? uri.toString() : "";
}
