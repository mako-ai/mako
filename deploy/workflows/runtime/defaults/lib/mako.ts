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

/**
 * The gateway's requests to Mako: they name the workflow, as every call from
 * workflow code does, and a refusal by Mako (a key it does not accept) reads
 * as Mako wrote it, not as a malformed gateway error.
 */
const modelFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const workflow = workflowName();
  if (workflow) headers.set("X-Mako-Workflow", workflow);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 || res.status === 403) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as {
      error?: unknown;
    } | null;
    if (typeof body?.error === "string") {
      throw new Error(
        `Mako refused the model call (${res.status}): ${body.error}`,
      );
    }
  }
  return res;
};

/** A model, e.g. `model("anthropic/claude-sonnet-4.5")`. Counted in the workspace's usage. */
export const model = createGateway({
  baseURL: `${url}/api/workflows/runtime/ai`,
  apiKey: key,
  fetch: modelFetch,
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
  /** Fail past this many rows (1 to 100000, the default). */
  maxRows?: number;
  /** Cancel the statement after this long (default 5 minutes, at most 15). */
  timeoutMs?: number;
};

/** One statement, run once by Mako's query route. */
async function runSql(
  connection: string,
  sql: string,
  options: QueryOptions,
): Promise<{ rows: unknown[]; rowCount: number }> {
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
  const body = (await res.json().catch(() => ({}))) as {
    rows?: unknown[];
    rowCount?: number;
    error?: string;
  };
  if (!res.ok)
    throw new Error(body.error ?? `The query failed (${res.status})`);
  return { rows: body.rows ?? [], rowCount: body.rowCount ?? 0 };
}

/**
 * Run SQL on a workspace connection once and return all its rows, e.g.
 * `await query<{ id: string }>(conn, "SELECT id FROM t")`. Values come back
 * as the database returns them, never shortened. More than `maxRows` rows
 * (100000) or 50 MB, or longer than `timeoutMs`, throws: aggregate or filter
 * in SQL. A write returns the rows it returns (RETURNING), else none; it
 * needs this workflow on the connection's writers list.
 */
export async function query<Row = Record<string, unknown>>(
  connection: string,
  sql: string,
  options: QueryOptions = {},
): Promise<Row[]> {
  return (await runSql(connection, sql, options)).rows as Row[];
}

/**
 * Run a write (INSERT, UPDATE, DELETE, MERGE, DDL) once and return how many
 * rows it changed. Needs this workflow on the connection's writers list.
 */
export async function execute(
  connection: string,
  sql: string,
  options: Pick<QueryOptions, "database" | "timeoutMs"> = {},
): Promise<{ rowCount: number }> {
  const { rowCount } = await runSql(connection, sql, options);
  return { rowCount };
}
