/**
 * Verify the Local Agent can reach Mako `/api/mcp` with the minted Bearer
 * before handing the URL to Claude/Codex. Catches wrong hosts (preview URL the
 * machine can't reach), expired tokens, and 401s early with a clear error.
 */

export async function probeMakoMcpHttp(args: {
  mcpUrl: string;
  authorization: string;
  timeoutMs?: number;
}): Promise<void> {
  const { mcpUrl, authorization, timeoutMs = 12_000 } = args;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mako-local-agent-acp", version: "0.0.0" },
        },
      }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Mako MCP auth failed (${res.status}). Sign in to Mako in the browser and click Enable workspace tools again.`,
      );
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `Mako MCP unreachable at ${mcpUrl} (HTTP ${res.status})${
          text ? `: ${text}` : ""
        }. Local Agent must reach the same API host the browser uses.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Mako MCP timed out at ${mcpUrl}. Check that the API is reachable from this machine.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
