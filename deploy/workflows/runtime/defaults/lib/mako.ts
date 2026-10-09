// Mako access for workflow code: data tools and SQL.
// Credentials come from the worker's environment; nothing is hardcoded.
import { createMCPClient } from "@ai-sdk/mcp";

const url = process.env.MAKO_URL ?? "http://localhost:8080";
const key = process.env.MAKO_API_KEY ?? "";

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

/** Call one Mako tool by name and return its result, e.g. `call("app_materialize", { appId, name })`. */
export async function call(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tool = (await tools())[name];
  if (!tool?.execute) throw new Error(`${name} is not available to this key`);
  const result = (await tool.execute(input, {
    toolCallId: name,
    messages: [],
  } as never)) as { content?: { text?: string }[]; isError?: boolean };
  // A tool answers with text; Mako's tools put their JSON result in it.
  const text = result.content?.map(part => part.text ?? "").join("") ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Run SQL on a workspace connection. Read-only unless the key and connection allow writes. */
export function query(connection: string, sql: string): Promise<unknown> {
  return call("sql_execute_query", { connectionId: connection, query: sql });
}
