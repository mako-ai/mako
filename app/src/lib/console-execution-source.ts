/** Human-readable labels for query_executions.source */
export const CONSOLE_EXECUTION_SOURCE_LABELS: Record<string, string> = {
  console_ui: "App UI",
  console_ui_admin_override: "App UI (admin)",
  api: "API key",
  mcp: "MCP",
  agent: "AI agent",
  flow: "Flow",
  scheduled_query: "Schedule",
};

export function consoleExecutionSourceLabel(source: string): string {
  return CONSOLE_EXECUTION_SOURCE_LABELS[source] ?? source;
}

/** External integration surfaces (vs in-product). */
export function isExternalConsoleExecutionSource(source: string): boolean {
  return source === "api" || source === "mcp";
}
