interface ClientToolFailureReport {
  workspaceId?: string;
  chatId: string;
  toolName: string;
  toolCallId: string;
  output: Record<string, unknown>;
}

const reportedToolCallIds = new Set<string>();
const MAX_REPORTED_TOOL_CALL_IDS = 1_000;

/** Report browser-executed tool failures to the API's structured log sink. */
export function reportClientToolFailure({
  workspaceId,
  chatId,
  toolName,
  toolCallId,
  output,
}: ClientToolFailureReport): void {
  if (
    output.success !== false ||
    !workspaceId ||
    !chatId ||
    reportedToolCallIds.has(toolCallId)
  ) {
    return;
  }

  if (reportedToolCallIds.size >= MAX_REPORTED_TOOL_CALL_IDS) {
    const oldestToolCallId = reportedToolCallIds.values().next().value;
    if (oldestToolCallId) reportedToolCallIds.delete(oldestToolCallId);
  }
  reportedToolCallIds.add(toolCallId);

  const error =
    typeof output.error === "string"
      ? output.error
      : typeof output.message === "string"
        ? output.message
        : "Client-side tool execution failed";
  const code = typeof output.code === "string" ? output.code : undefined;

  void fetch("/api/agent/client-tool-failure", {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: {
      "content-type": "application/json",
      "x-workspace-id": workspaceId,
    },
    body: JSON.stringify({
      workspaceId,
      chatId,
      toolName,
      toolCallId,
      error: error.slice(0, 2_000),
      code,
    }),
  }).catch(() => {
    // Observability must never interfere with settling the tool call.
  });
}
