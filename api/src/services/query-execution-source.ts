/** Human-readable labels for query_executions.source (API + agent). */
export const QUERY_EXECUTION_SOURCE_LABELS: Record<string, string> = {
  console_ui: "App UI",
  console_ui_admin_override: "App UI (admin)",
  api: "API key",
  mcp: "MCP",
  agent: "AI agent",
  flow: "Flow",
  scheduled_query: "Schedule",
};

export function queryExecutionSourceLabel(source: string): string {
  return QUERY_EXECUTION_SOURCE_LABELS[source] ?? source;
}
