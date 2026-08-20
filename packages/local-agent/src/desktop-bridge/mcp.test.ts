import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HITL_TOOL_JSON_SCHEMAS } from "@mako/agent-tools";
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

  it("serves the HITL schemas from the shared @mako/agent-tools source", async () => {
    const exchange = await handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });
    const body = exchange.body as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    for (const name of ["ask_clarifying_questions", "submit_plan"] as const) {
      const listed = body.result.tools.find(t => t.name === name);
      assert.deepEqual(
        listed?.inputSchema,
        HITL_TOOL_JSON_SCHEMAS[name],
        `${name} must serve the schema derived from the chat zod definition`,
      );
    }
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

  it("rejects submit_plan with malformed arguments as a correctable tool error", async () => {
    desktopBridgeRegistry.touchClient();
    // Missing `todos` — the exact shape that used to crash the Desktop
    // renderer ("Cannot read properties of undefined (reading 'length')").
    const exchange = await handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "submit_plan",
        arguments: { title: "Plan", planMarkdown: "# Plan" },
      },
    });
    assert.equal(exchange.status, 200);
    const body = exchange.body as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /Invalid submit_plan arguments/);
    assert.match(body.result.content[0].text, /todos/);
  });

  it("rejects ask_clarifying_questions without questions", async () => {
    desktopBridgeRegistry.touchClient();
    const exchange = await handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "ask_clarifying_questions", arguments: {} },
    });
    const body = exchange.body as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, true);
    assert.match(
      body.result.content[0].text,
      /Invalid ask_clarifying_questions arguments/,
    );
  });

  it("forwards a valid submit_plan to the bridge with parsed arguments", async () => {
    desktopBridgeRegistry.touchClient();
    const callPromise = handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "submit_plan",
        arguments: {
          title: "Plan",
          planMarkdown: "# Plan",
          todos: [{ content: "Step 1" }],
        },
      },
    });
    const job = await desktopBridgeRegistry.claim(5_000);
    assert.ok(job);
    assert.equal(job.tool, "submit_plan");
    assert.deepEqual(job.arguments.todos, [{ content: "Step 1" }]);
    desktopBridgeRegistry.complete(job.id, {
      success: true,
      decision: "approve",
    });
    const exchange = await callPromise;
    const body = exchange.body as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, undefined);
    assert.match(body.result.content[0].text, /"decision":"approve"/);
  });

  it("stamps every job with this build's delivery capabilities", async () => {
    desktopBridgeRegistry.touchClient();
    const callPromise = handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "run_app",
        arguments: { appId: "app-3", width: 390, height: 844 },
      },
    });
    const job = await desktopBridgeRegistry.claim(5_000);
    assert.ok(job);
    // The renderer keys inline screenshot delivery off this marker — an
    // older Local Agent (no marker) must keep getting text-only results.
    assert.equal(job.capabilities?.imageContent, true);
    // Viewport args flow through for the mobile-layout verify.
    assert.equal(job.arguments.width, 390);
    assert.equal(job.arguments.height, 844);
    desktopBridgeRegistry.complete(job.id, { success: true, errors: [] });
    await callPromise;
  });

  it("emits a run_app envelope screenshot as an MCP image content block", async () => {
    desktopBridgeRegistry.touchClient();
    const callPromise = handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "run_app", arguments: { appId: "app-4" } },
    });
    const job = await desktopBridgeRegistry.claim(5_000);
    assert.ok(job);
    desktopBridgeRegistry.complete(job.id, {
      success: true,
      status: "ready",
      errors: [],
      consoleLogs: [],
      source: "desktop",
      screenshot: { mimeType: "image/png", base64: "aGVsbG8=" },
    });

    const exchange = await callPromise;
    const body = exchange.body as {
      result: {
        isError?: boolean;
        content: Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
        }>;
      };
    };
    assert.equal(body.result.isError, undefined);
    assert.equal(body.result.content.length, 2);
    const [summary, image] = body.result.content;
    assert.equal(summary.type, "text");
    assert.match(summary.text ?? "", /"status":"ready"/);
    // Base64 must never leak into the text part.
    assert.doesNotMatch(summary.text ?? "", /aGVsbG8=/);
    assert.equal(image.type, "image");
    assert.equal(image.data, "aGVsbG8=");
    assert.equal(image.mimeType, "image/png");
  });

  it("legacy get_preview_errors polls without rebuild or screenshot", async () => {
    desktopBridgeRegistry.touchClient();
    const callPromise = handleDesktopMcpExchange({
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "get_preview_errors", arguments: { appId: "app-5" } },
    });
    const job = await desktopBridgeRegistry.claim(5_000);
    assert.ok(job);
    assert.equal(job.tool, "run_app");
    assert.equal(job.arguments.rebuild, false);
    // Old cheap error poll must stay cheap — no screenshot capture.
    assert.equal(job.arguments.includeScreenshot, false);
    desktopBridgeRegistry.complete(job.id, { success: true, errors: [] });
    await callPromise;
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
