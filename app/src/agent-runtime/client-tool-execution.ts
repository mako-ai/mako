import { getAgentToolManifestEntry } from "./client-tool-manifest";

/**
 * Dashboard tools always execute detached from the UI stream reader.
 * Even very fast client-side calls can arrive at the end of a streamed step;
 * awaiting them inside useChat.onToolCall can block the finish chunk and keep
 * the chat stuck in a streaming state until the HTTP request times out.
 */
export function shouldDetachDashboardToolExecution(toolName: string): boolean {
  const manifestEntry = getAgentToolManifestEntry(toolName);
  return (
    manifestEntry?.execution === "client" &&
    manifestEntry.clientExecutor === "dashboard"
  );
}
