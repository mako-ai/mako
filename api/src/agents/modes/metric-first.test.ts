/**
 * Regression: a business question starts from the ontology and the semantic
 * layer in every mode and over MCP.
 *
 * For three fixed questions, in the Query, App, Workflow and Notebook modes
 * and over MCP, the tool set holds the metric and ontology tools, and the
 * prompt (or the MCP instructions and tool list) names them before the
 * connection-discovery tools. No LLM is called: this checks what the model
 * would be given.
 *
 * Run: tsx src/agents/modes/metric-first.test.ts
 */
import assert from "node:assert/strict";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { UIMessage } from "ai";
import { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import { buildUnifiedModeRuntime } from "./runtime";
import { METRIC_FIRST_TOOL_NAMES } from "./registry";
import type { ExpertiseModeId } from "./types";
import type { AgentContext } from "../types";
import { buildMakoMcpServer } from "../../mcp/mako-mcp-server";
import { StatelessMcpTransport } from "../../mcp/stateless-transport";

const SCENARIOS = [
  "MRR by country last month",
  "paying customers in FR",
  "renewal rate",
];

const context = {
  workspaceId: new Types.ObjectId().toString(),
  userId: "u1",
  consoles: [],
  databases: [],
} as unknown as AgentContext;

let id = 0;
const user = (text: string): UIMessage =>
  ({
    id: `m${id++}`,
    role: "user",
    parts: [{ type: "text", text }],
  }) as unknown as UIMessage;

/** An earlier enable_mode call, as a chat that switched modes replays it. */
const enabled = (mode: ExpertiseModeId): UIMessage =>
  ({
    id: `m${id++}`,
    role: "assistant",
    parts: [
      {
        type: "tool-enable_mode",
        toolCallId: `c${id}`,
        state: "output-available",
        input: { mode },
        output: { success: true },
      },
    ],
  }) as unknown as UIMessage;

/** How each mode is reached: the tab the user is on, or a mode switch. */
const MODES: Array<{
  mode: ExpertiseModeId;
  tabKind?: string;
  history: UIMessage[];
}> = [
  { mode: "query", history: [] },
  { mode: "app", tabKind: "app", history: [] },
  { mode: "notebook", tabKind: "notebook", history: [] },
  {
    mode: "workflow",
    history: [user("set up a workflow"), enabled("workflow")],
  },
];

// The ontology and metric tools lead every mode's prompt.
for (const question of SCENARIOS) {
  for (const { mode, tabKind, history } of MODES) {
    const runtime = buildUnifiedModeRuntime({
      context,
      messages: [...history, user(question)],
      tabKind,
      modelId: "anthropic/claude-sonnet-5",
    });
    const label = `${mode} mode, "${question}"`;
    assert.ok(runtime.modeState.enabledModes.has(mode), `${label}: enabled`);

    const step = runtime.prepareStep({ stepNumber: 0 });
    assert.ok(step, `${label}: a step`);
    for (const name of METRIC_FIRST_TOOL_NAMES) {
      assert.ok(step.activeTools.includes(name), `${label}: ${name} active`);
    }

    const prompt = step.instructions
      .map(message => String(message.content))
      .join("\n\n");
    const first = (name: string) => prompt.indexOf(`\`${name}`);
    assert.ok(first("lookup_term") >= 0, `${label}: prompt names lookup_term`);
    for (const later of ["list_connections", "list_tables"]) {
      assert.ok(
        first("lookup_term") < first(later) &&
          first("list_metrics") < first(later) &&
          first("query_metric") < first(later),
        `${label}: the metric path comes before ${later}`,
      );
    }
    assert.match(
      prompt,
      /Never change a metric's scope yourself/,
      `${label}: the governed-scope rule`,
    );
  }
}

// Over MCP: the tool list leads with them, and the instructions start there.
async function overMcp() {
  const server = buildMakoMcpServer({
    workspaceId: context.workspaceId,
    workspaceName: "Acme Analytics",
    memberRole: "member",
    scopes: ["mcp", "query:read"],
  });
  const transport = new StatelessMcpTransport();
  await server.connect(transport);
  try {
    const [init, list] = (await transport.handle(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ] as unknown as JSONRPCMessage[],
      5_000,
    )) as unknown as Array<{ result: Record<string, unknown> }>;
    const instructions = String(init.result.instructions ?? "");
    const tools = (list.result.tools as Array<{ name: string }>).map(
      t => t.name,
    );
    for (const question of SCENARIOS) {
      const label = `MCP, "${question}"`;
      assert.deepEqual(
        tools.slice(0, METRIC_FIRST_TOOL_NAMES.length),
        [...METRIC_FIRST_TOOL_NAMES],
        `${label}: the tool list leads with the metric path`,
      );
      for (const later of ["list_connections", "list_tables"]) {
        assert.ok(
          instructions.indexOf("lookup_term") < instructions.indexOf(later) &&
            instructions.indexOf("query_metric") < instructions.indexOf(later),
          `${label}: instructions name the metric path before ${later}`,
        );
      }
      assert.ok(instructions.length < 4_000, `${label}: instructions < 4k`);
    }
  } finally {
    await server.close();
  }
}

void overMcp()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("metric-first.test.ts: all assertions passed");
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
