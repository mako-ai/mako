// Mako access for workflow code: models, data tools, and SQL.
// Credentials come from the worker's environment; nothing is hardcoded.
import { createGateway } from "@ai-sdk/gateway";
import { createMCPClient } from "@ai-sdk/mcp";

const url = process.env.MAKO_URL ?? "http://localhost:8080";
const key = process.env.MAKO_API_KEY ?? "";

/** A model through Mako's AI gateway, billed to the workspace. */
export const model = createGateway({
  baseURL: `${url}/api/workflows/runtime/ai`,
  apiKey: key,
});

/** Mako MCP tools (queries, table inspection, skills, web search) as AI SDK tools. */
export async function tools() {
  const mcp = await createMCPClient({
    transport: {
      type: "http",
      url: `${url}/api/mcp`,
      headers: { Authorization: `Bearer ${key}` },
    },
  });
  return mcp.tools();
}

/** Run SQL on a workspace connection. Read-only unless the key and connection allow writes. */
export async function query(connection: string, sql: string): Promise<unknown> {
  const t = await tools();
  const tool = t.sql_execute_query;
  if (!tool?.execute)
    throw new Error("sql_execute_query is not available to this key");
  return tool.execute({ connectionId: connection, query: sql }, {
    toolCallId: "query",
    messages: [],
  } as never);
}
