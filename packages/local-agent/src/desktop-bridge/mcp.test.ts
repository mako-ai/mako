import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleDesktopMcpExchange } from "./mcp";
import { desktopBridgeRegistry } from "./registry";

describe("desktop-bridge MCP", () => {
  it("lists desktop + HITL tools", async () => {
    const exchange = await handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    assert.equal(exchange.status, 200);
    const body = exchange.body as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      "ask_clarifying_questions",
      "list_open_consoles",
      "run_app",
      "submit_plan",
    ]);
    const runApp = body.result.tools.find(t => t.name === "run_app") as
      | { inputSchema: { properties: Record<string, unknown> } }
      | undefined;
    assert.ok(
      runApp?.inputSchema.properties.rebuild,
      "run_app must accept rebuild (absorbs the old get_preview_errors)",
    );
  });

  it("fails run_app when Desktop Chat is not connected", async () => {
    const exchange = await handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "run_app", arguments: { appId: "x" } },
    });
    assert.equal(exchange.status, 200);
    const body = exchange.body as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /not connected/i);
  });

  it("completes run_app when a client claims the job", async () => {
    desktopBridgeRegistry.touchClient();
    const callPromise = handleDesktopMcpExchange(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "run_app", arguments: { appId: "app-1" } },
      },
      { agentSessionId: "agent-1", workspaceId: "workspace-1" },
    );

    const job = await desktopBridgeRegistry.claim(5_000);
    assert.ok(job);
    assert.equal(job.tool, "run_app");
    assert.equal(job.arguments.appId, "app-1");
    assert.equal(job.agentSessionId, "agent-1");
    assert.equal(job.workspaceId, "workspace-1");
    assert.equal(
      desktopBridgeRegistry.complete(job.id, {
        success: true,
        errors: [],
      }),
      true,
    );

    const exchange = await callPromise;
    assert.equal(exchange.status, 200);
    const body = exchange.body as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, undefined);
    assert.match(body.result.content[0].text, /"success":true/);
  });

  it("translates legacy get_preview_errors into run_app({ rebuild: false })", async () => {
    desktopBridgeRegistry.touchClient();
    const callPromise = handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_preview_errors", arguments: { appId: "app-2" } },
    });

    const job = await desktopBridgeRegistry.claim(5_000);
    assert.ok(job);
    assert.equal(job.tool, "run_app");
    assert.equal(job.arguments.appId, "app-2");
    assert.equal(job.arguments.rebuild, false);
    desktopBridgeRegistry.complete(job.id, { success: true, errors: [] });

    const exchange = await callPromise;
    const body = exchange.body as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, undefined);
    assert.match(body.result.content[0].text, /"success":true/);
  });
});
