/* eslint-disable no-console, no-process-exit */
/**
 * Tests for the server-side read tools (Phase 1 of the server-side port).
 *
 * - Wiring: the unified agent registers the 6 read tools with a server
 *   `execute` (so the AI SDK runs them server-side, no browser).
 * - Chart tools: pure static lookups against `@mako/schemas`.
 *
 * No DB required — `unifiedAgentFactory` only builds tool definitions, and the
 * chart tools are pure. Safe to run in CI.
 */
import assert from "node:assert/strict";
import { unifiedAgentFactory } from "../../agents/unified/index";
import { createServerChartTools } from "./server-chart-tools";

const SERVER_READ_TOOLS = [
  "get_chart_templates",
  "get_chart_template",
  "get_app_state",
  "app_read_file",
  "read_dbt_project_tree",
  "read_dbt_file",
];

type ExecutableTool = {
  execute?: (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
};

function runTool(tool: ExecutableTool, args: unknown) {
  if (typeof tool.execute !== "function") {
    throw new Error("tool has no execute");
  }
  return tool.execute(args, { toolCallId: "t", messages: [] });
}

function testWiring() {
  console.log("  wiring: read tools registered server-side with execute");
  const cfg = unifiedAgentFactory({
    workspaceId: "000000000000000000000000",
  } as never);
  const tools = cfg.tools as Record<string, ExecutableTool | undefined>;
  for (const name of SERVER_READ_TOOLS) {
    assert.equal(
      typeof tools[name]?.execute,
      "function",
      `${name} must have a server execute`,
    );
  }
  console.log("    ✓ all 6 read tools are server-executed");
}

async function testChartTools() {
  console.log("  chart tools: static template lookups");
  const chart = createServerChartTools() as Record<string, ExecutableTool>;

  const list = await runTool(chart.get_chart_templates, {});
  assert.equal(list.success, true);
  assert.ok(
    Array.isArray(list.templates) && list.templates.length > 0,
    "expected at least one template",
  );

  const donut = await runTool(chart.get_chart_template, { templateId: "donut" });
  assert.equal(donut.success, true);
  assert.equal((donut.template as { id?: string })?.id, "donut");

  const missing = await runTool(chart.get_chart_template, {
    templateId: "does-not-exist",
  });
  assert.equal(missing.success, false);
  console.log("    ✓ list + donut lookup + unknown-id rejection");
}

async function main() {
  console.log("server-read-tools tests");
  testWiring();
  await testChartTools();
  console.log("✓ server-read-tools tests passed");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
