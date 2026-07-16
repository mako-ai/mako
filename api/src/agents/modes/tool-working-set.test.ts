/**
 * Unit tests for the deferred-tool working set: `load_tools` replay in
 * `deriveModeState`, the budgeted `computeActiveTools` (hybrid bypass, LRU
 * eviction, provider caps, plan gate), catalog search/preload ranking, the
 * MCP schema diet, and the tier-policy completeness check (every registered
 * built-in tool must be core, mode, or deferred — never silently dead).
 *
 * Run: tsx src/agents/modes/tool-working-set.test.ts
 */
import assert from "node:assert/strict";
import { tool, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import {
  buildUnifiedModeRuntime,
  computeActiveTools,
  deriveModeState,
  buildDeferredInventoryBlock,
  type WorkingSetOptions,
} from "./runtime";
import {
  CORE_ALWAYS_TOOL_NAMES,
  DEFERRED_BUILTIN_TOOL_NAMES,
  EXPERTISE_MODE_IDS,
  toolNamesForModes,
} from "./registry";
import type { ModeState } from "./types";
import {
  effectiveToolCountLimit,
  providerToolCap,
  searchToolCatalog,
  preloadToolNames,
  MAX_ACTIVE_TOOLS,
  type ToolCatalogEntry,
} from "../../agent-lib/tool-catalog";
import {
  dietMcpDescription,
  dietMcpInputSchema,
  type McpToolCatalogInfo,
} from "../../services/mcp-client.service";
import type { AgentContext } from "../types";

type Part = Record<string, unknown>;

let idCounter = 0;
const msg = (role: "user" | "assistant", parts: Part[]): UIMessage =>
  ({ id: `m${idCounter++}`, role, parts }) as unknown as UIMessage;

const user = (text: string) => msg("user", [{ type: "text", text }]);

const loadTools = (names: string[]) =>
  msg("assistant", [
    {
      type: "tool-load_tools",
      toolCallId: `c${idCounter}`,
      state: "output-available",
      input: { names },
      output: { success: true, loaded: names },
    },
  ]);

const baseModeState = (loaded: string[] = []): ModeState => ({
  enabledModes: new Set(["query"]),
  planSubmitted: false,
  planApproved: false,
  loadedToolNames: loaded,
});

// --- deriveModeState replays load_tools, ordered, across turns ---------------
{
  const state = deriveModeState(
    [
      user("send this to slack"),
      loadTools(["mcp_slack_a", "mcp_slack_b"]),
      user("now close crm"),
      loadTools(["mcp_close_x"]),
    ],
    "query",
  );
  assert.deepEqual(state.loadedToolNames, [
    "mcp_slack_a",
    "mcp_slack_b",
    "mcp_close_x",
  ]);
}

// --- re-loading moves a tool to the newest LRU position -----------------------
{
  const state = deriveModeState(
    [user("go"), loadTools(["a", "b"]), loadTools(["a"])],
    "query",
  );
  assert.deepEqual(state.loadedToolNames, ["b", "a"]);
}

// --- hybrid bypass (paging off): all MCP tools active, like before ------------
{
  const all = new Set([
    ...toolNamesForModes(new Set(["query"])),
    "mcp_slack_send",
  ]);
  const active = computeActiveTools(baseModeState(), all, {
    toolNames: ["mcp_slack_send"],
    readOnlyToolNames: [],
  });
  assert.ok(active.includes("mcp_slack_send"), "hybrid keeps MCP active");
}

// --- paging on: MCP tools only active once loaded ------------------------------
{
  const options: WorkingSetOptions = {
    pagingActive: true,
    maxActiveTools: MAX_ACTIVE_TOOLS,
  };
  const all = new Set([
    ...toolNamesForModes(new Set(["query"])),
    "mcp_slack_send",
  ]);
  const mcp = { toolNames: ["mcp_slack_send"], readOnlyToolNames: [] };

  const inactive = computeActiveTools(baseModeState(), all, mcp, options);
  assert.ok(!inactive.includes("mcp_slack_send"), "unloaded MCP is dormant");

  const loaded = computeActiveTools(
    baseModeState(["mcp_slack_send"]),
    all,
    mcp,
    options,
  );
  assert.ok(loaded.includes("mcp_slack_send"), "loaded MCP is active");
}

// --- count budget evicts oldest loads first (LRU), never base tools -----------
{
  const modeNames = Array.from(toolNamesForModes(new Set(["query"])));
  const loadedNames = Array.from({ length: 10 }, (_, i) => `mcp_t_${i}`);
  const all = new Set([...modeNames, ...loadedNames]);
  const options: WorkingSetOptions = {
    pagingActive: true,
    // Room for base + only 3 deferred tools.
    maxActiveTools: modeNames.filter(n => all.has(n)).length + 3,
  };
  const active = computeActiveTools(
    baseModeState(loadedNames),
    all,
    { toolNames: loadedNames, readOnlyToolNames: [] },
    options,
  );
  // Newest three loads survive; oldest seven evicted.
  assert.ok(active.includes("mcp_t_9"));
  assert.ok(active.includes("mcp_t_8"));
  assert.ok(active.includes("mcp_t_7"));
  assert.ok(!active.includes("mcp_t_0"), "oldest load evicted");
  for (const name of modeNames) {
    if (all.has(name)) assert.ok(active.includes(name), `base kept: ${name}`);
  }
}

// --- token budget trims the tail, keeps base -----------------------------------
{
  const all = new Set(["enable_mode", "heavy_a", "heavy_b"]);
  const state: ModeState = {
    enabledModes: new Set(),
    planSubmitted: false,
    planApproved: false,
    loadedToolNames: ["heavy_a", "heavy_b"],
  };
  const active = computeActiveTools(state, all, undefined, {
    pagingActive: true,
    maxActiveTools: 100,
    maxActiveToolTokens: 500,
    tokenWeights: new Map([
      ["enable_mode", 100],
      ["heavy_a", 400],
      ["heavy_b", 400],
    ]),
  });
  assert.ok(active.includes("enable_mode"), "base survives token budget");
  // Only one heavy tool fits after base's 100 tokens (newest first).
  assert.deepEqual(
    active.filter(n => n.startsWith("heavy_")),
    ["heavy_b"],
  );
}

// --- plan gate: loaded MCP write tools drop, read tools + discovery survive ---
{
  const all = new Set([
    "search_tools",
    "load_tools",
    "mcp_read_tool",
    "mcp_write_tool",
  ]);
  const state: ModeState = {
    enabledModes: new Set(),
    planSubmitted: true,
    planApproved: false,
    loadedToolNames: ["mcp_read_tool", "mcp_write_tool"],
  };
  const active = computeActiveTools(
    state,
    all,
    {
      toolNames: ["mcp_read_tool", "mcp_write_tool"],
      readOnlyToolNames: ["mcp_read_tool"],
    },
    { pagingActive: true, maxActiveTools: 100 },
  );
  assert.ok(active.includes("search_tools"), "discovery allowed under gate");
  assert.ok(active.includes("load_tools"), "loading allowed under gate");
  assert.ok(active.includes("mcp_read_tool"), "read MCP allowed under gate");
  assert.ok(!active.includes("mcp_write_tool"), "write MCP gated");
}

// --- provider caps ------------------------------------------------------------
{
  assert.equal(providerToolCap("xai/grok-4.5"), 250);
  assert.equal(providerToolCap("openai/gpt-5"), 128);
  assert.equal(providerToolCap("anthropic/claude-sonnet-5"), null);
  assert.equal(effectiveToolCountLimit("xai/grok-4.5"), MAX_ACTIVE_TOOLS);
  assert.equal(effectiveToolCountLimit(undefined), MAX_ACTIVE_TOOLS);
}

// --- catalog search + preload ranking ------------------------------------------
{
  const catalog: ToolCatalogEntry[] = [
    {
      name: "mcp_slack_send_message",
      source: { kind: "mcp", serverId: "s1", serverName: "Slack" },
      description: "Send a message to a Slack channel or DM.",
      readOnly: false,
      tier: "deferred",
    },
    {
      name: "mcp_close_list_leads",
      source: { kind: "mcp", serverId: "s2", serverName: "Close CRM" },
      description: "List leads in Close CRM with filters.",
      readOnly: true,
      tier: "deferred",
    },
    {
      name: "browse_version_history",
      source: { kind: "builtin", domain: "version-history" },
      description: "Browse saved versions of a console or dashboard.",
      readOnly: true,
      tier: "deferred",
    },
  ];

  const hits = searchToolCatalog(catalog, "send slack message");
  assert.equal(hits[0]?.name, "mcp_slack_send_message");
  assert.ok((hits[0]?.score ?? 0) > 0);

  const preload = preloadToolNames(catalog, "can you send this to slack?");
  assert.deepEqual(preload, ["mcp_slack_send_message"]);

  // Generic message: nothing clears the preload threshold.
  assert.deepEqual(preloadToolNames(catalog, "hello, how are you?"), []);

  const inventory = buildDeferredInventoryBlock(catalog);
  assert.ok(inventory?.includes("Slack (1 tools via MCP)"));
  assert.ok(inventory?.includes("version-history (1)"));
  assert.ok(inventory?.includes("search_tools"));
}

// --- MCP schema diet ------------------------------------------------------------
{
  const long = "x".repeat(500);
  assert.equal(dietMcpDescription("short").length, 5);
  assert.ok(dietMcpDescription(long).length <= 200);

  const dieted = dietMcpInputSchema({
    type: "object",
    description: long,
    examples: [{ a: 1 }],
    properties: {
      channel: { type: "string", description: long },
      nested: {
        type: "object",
        properties: { deep: { type: "number", description: "keep me" } },
      },
    },
    required: ["channel"],
  });
  assert.equal(dieted.examples, undefined);
  assert.ok((dieted.description as string).length <= 160);
  const props = dieted.properties as Record<string, Record<string, unknown>>;
  assert.ok((props.channel.description as string).length <= 160);
  assert.equal(
    (props.nested.properties as Record<string, Record<string, unknown>>).deep
      .description,
    "keep me",
  );
  assert.deepEqual(dieted.required, ["channel"]);
}

// --- end-to-end runtime: paging, inventory, live load, tier policy -------------
async function endToEnd() {
  const fakeMcpTools: ToolSet = {};
  const fakeMcpCatalog: McpToolCatalogInfo[] = [];
  for (let i = 0; i < 200; i++) {
    const name = `mcp_slack_tool_${i}`;
    fakeMcpTools[name] = tool({
      description: `Slack tool ${i}: send a message variant.`,
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    fakeMcpCatalog.push({
      name,
      serverId: "s1",
      serverName: "Slack",
      description: `Slack tool ${i}: send a message variant.`,
      readOnly: i % 2 === 0,
    });
  }

  const context: AgentContext = {
    workspaceId: "000000000000000000000000",
    userId: "u1",
    consoles: [],
    databases: [],
    mcpTools: fakeMcpTools,
    mcpToolNames: Object.keys(fakeMcpTools),
    mcpReadOnlyToolNames: fakeMcpCatalog
      .filter(c => c.readOnly)
      .map(c => c.name),
    mcpToolCatalog: fakeMcpCatalog,
  } as unknown as AgentContext;

  const runtime = buildUnifiedModeRuntime({
    context,
    messages: [user("hello")],
    modelId: "xai/grok-4.5",
  });

  assert.ok(runtime.workingSet.pagingActive, "200 MCP tools engage paging");
  assert.ok(
    runtime.workingSet.activeToolCount <= runtime.workingSet.maxActiveTools,
    "active set within budget",
  );
  const step = runtime.prepareStep({ stepNumber: 0 });
  assert.ok(step);
  assert.ok(
    !step.activeTools.some(n => n.startsWith("mcp_slack_tool_")),
    "no MCP tool active before loading",
  );
  const inventoryMsg = step.system.map(m => m.content).join("\n");
  assert.ok(
    inventoryMsg.includes("Slack (200 tools via MCP)"),
    "inventory block lists the server",
  );

  // Live load via the actual tool, then the next step activates it.
  const loadTool = runtime.tools.load_tools as {
    execute: (input: { names: string[] }) => Promise<{ loaded: string[] }>;
  };
  const result = await loadTool.execute({ names: ["mcp_slack_tool_7"] });
  assert.deepEqual(result.loaded, ["mcp_slack_tool_7"]);
  const step2 = runtime.prepareStep({ stepNumber: 1 });
  assert.ok(step2?.activeTools.includes("mcp_slack_tool_7"));

  // Unknown names are rejected, not silently accepted.
  const bad = (await loadTool.execute({
    names: ["not_a_tool"],
  })) as unknown as { success: boolean; unknownNames: string[] };
  assert.equal(bad.success, false);
  assert.deepEqual(bad.unknownNames, ["not_a_tool"]);

  // Tier policy: every registered built-in tool must be classified as core,
  // mode, or deferred — an unclassified tool would be permanently dormant.
  const classified = new Set<string>([
    ...CORE_ALWAYS_TOOL_NAMES,
    ...toolNamesForModes(new Set(EXPERTISE_MODE_IDS)),
    ...DEFERRED_BUILTIN_TOOL_NAMES,
  ]);
  const unclassified = Object.keys(runtime.tools).filter(
    name => !classified.has(name) && !name.startsWith("mcp_"),
  );
  assert.deepEqual(
    unclassified,
    [],
    `Unclassified agent tools (add to a mode's toolNames, CORE_ALWAYS_TOOL_NAMES, or DEFERRED_BUILTIN_TOOL_DOMAINS): ${unclassified.join(", ")}`,
  );

  // Preload: a Slack-flavored user message pre-activates relevant tools
  // with zero search/load round-trips.
  const preloadRuntime = buildUnifiedModeRuntime({
    context,
    messages: [user("post an update to slack")],
    modelId: "xai/grok-4.5",
  });
  assert.ok(
    preloadRuntime.workingSet.preloadedToolNames.length > 0,
    "slack message preloads slack tools",
  );
}

// runtime.ts transitively imports the full agent stack (loggers, mongoose
// schemas), which keeps the event loop alive — exit explicitly like
// derive-mode-state.test.ts does.
void endToEnd()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("tool-working-set.test.ts: all assertions passed");
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
