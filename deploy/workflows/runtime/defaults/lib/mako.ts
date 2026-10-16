// Mako access for workflow code: Mako's agent, models, Mako's tools, and SQL.
// Credentials come from the worker's environment; nothing is hardcoded.
import { createGateway } from "@ai-sdk/gateway";
import { createMCPClient } from "@ai-sdk/mcp";

const url = process.env.MAKO_URL ?? "http://localhost:8080";
const key = process.env.MAKO_API_KEY ?? "";

/**
 * Mako's own agent: give it a goal, it works with Mako's tools and skills and
 * answers. `toolCalls` names what it used, in order; `chatId` is the run,
 * kept in Mako. Counted in the workspace's usage.
 */
export async function agent(
  goal: string,
  options: { model?: string; maxSteps?: number } = {},
): Promise<{ text: string; toolCalls: string[]; chatId: string }> {
  const workflow = workflowName();
  const res = await fetch(`${url}/api/workflows/runtime/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
    },
    body: JSON.stringify({ goal, ...options }),
  });
  const body = (await res.json()) as {
    text: string;
    toolCalls: string[];
    chatId: string;
    error?: string;
  };
  if (!res.ok)
    throw new Error(body.error ?? `The agent failed (${res.status})`);
  return body;
}

/** A model, e.g. `model("anthropic/claude-sonnet-4.5")`. Counted in the workspace's usage. */
export const model = createGateway({
  baseURL: `${url}/api/workflows/runtime/ai`,
  apiKey: key,
});

/**
 * Ask a decision model, e.g. `decide("typesafe-ai/jev", { text }, questions)`.
 * It answers each question about the state; `questions` are passed to the
 * model as given. Counted in the workspace's usage.
 */
export async function decide(
  modelId: string,
  state: unknown,
  questions: unknown[],
): Promise<{
  answers: unknown;
  usage?: unknown;
  warnings?: unknown[];
  providerMetadata?: unknown;
}> {
  const workflow = workflowName();
  const res = await fetch(`${url}/api/workflows/runtime/ai/decision-model`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "ai-model-id": modelId,
      "ai-decision-model-specification-version": "4",
      "ai-gateway-protocol-version": "0.0.1",
      ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
    },
    body: JSON.stringify({
      stateParts: [{ type: "json", value: state }],
      questions,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    answers?: unknown;
    usage?: unknown;
    warnings?: unknown[];
    providerMetadata?: unknown;
    error?: unknown;
  };
  if (!res.ok) {
    const error =
      typeof body.error === "string"
        ? body.error
        : (body.error as { message?: string } | undefined)?.message;
    throw new Error(error ?? `The decision model failed (${res.status})`);
  }
  return {
    answers: body.answers,
    usage: body.usage,
    warnings: body.warnings,
    providerMetadata: body.providerMetadata,
  };
}

const clients = new Map<string, ReturnType<typeof createMCPClient>>();

/** The workflow this step belongs to (set by the worker), if any. */
function workflowName(): string | undefined {
  const running = (globalThis as { makoWorkflow?: { getStore(): unknown } })
    .makoWorkflow;
  const name = running?.getStore();
  return typeof name === "string" ? name : undefined;
}

/** Mako's tools (queries, table inspection, apps, web search) for a model to use. */
export async function tools() {
  // One connection per workflow, opened on first use: Mako learns which
  // workflow writes, so a connection can allow that workflow alone.
  const workflow = workflowName() ?? "";
  let client = clients.get(workflow);
  if (!client) {
    client = createMCPClient({
      transport: {
        type: "http",
        url: `${url}/api/mcp`,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
        },
      },
    });
    clients.set(workflow, client);
  }
  return (await client).tools();
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

export type QueryOptions = {
  /** The database or dataset, when the connection has no default. */
  database?: string;
  /** Rows per page, 1 to 500 (default 500). */
  maxRows?: number;
};

/** One page of a query's result, as Mako's /query route answers. */
export type QueryPage<Row = Record<string, unknown>> = {
  rows: Row[];
  fields: { name: string; type?: string }[];
  /** Rows in this page for a read; rows changed for a write. */
  rowCount: number;
  /** Pass as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
};

/**
 * One request to Mako's query route: a page of a SELECT, or a write's result
 * (`rowCount` is the rows it changed). Values come back as the database
 * returns them, never shortened.
 */
export async function queryPage<Row = Record<string, unknown>>(
  connection: string,
  sql: string,
  options: QueryOptions & { cursor?: string } = {},
): Promise<QueryPage<Row>> {
  const workflow = workflowName();
  const res = await fetch(`${url}/api/workflows/runtime/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
    },
    body: JSON.stringify({ connectionId: connection, query: sql, ...options }),
  });
  const body = (await res.json().catch(() => ({}))) as QueryPage<Row> & {
    error?: string;
  };
  if (!res.ok)
    throw new Error(body.error ?? `The query failed (${res.status})`);
  return body;
}

/** Every page of a query's result, one request each: for results too big to hold at once. */
export async function* queryPages<Row = Record<string, unknown>>(
  connection: string,
  sql: string,
  options: QueryOptions = {},
): AsyncGenerator<QueryPage<Row>> {
  let cursor: string | undefined;
  do {
    const page: QueryPage<Row> = await queryPage<Row>(connection, sql, {
      ...options,
      cursor,
    });
    yield page;
    cursor = page.nextCursor;
  } while (cursor);
}

/**
 * Run SQL on a workspace connection and return all its rows, e.g.
 * `await query<{ id: string }>(conn, "SELECT id FROM t")`. Pages are fetched
 * until the last one; add ORDER BY so pages do not overlap. A write runs once
 * and returns the rows it returned (none without RETURNING): use `queryPage`
 * for the rows it changed. Reads work everywhere; a write needs this workflow
 * on the connection's writers list.
 */
export async function query<Row = Record<string, unknown>>(
  connection: string,
  sql: string,
  options: QueryOptions = {},
): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const page of queryPages<Row>(connection, sql, options)) {
    rows.push(...page.rows);
  }
  return rows;
}
