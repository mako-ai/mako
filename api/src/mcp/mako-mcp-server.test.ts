/**
 * Mako MCP server tests.
 *
 * Pure-logic coverage of the stateless JSON-RPC exchange: initialize
 * handshake, tools/list bridging (AI SDK zod schemas → JSON Schema),
 * unknown-tool errors, skill resources, and notification-only exchanges.
 * Tool *execution* is DB-backed and covered by route-level usage, not here.
 *
 * Run: tsx src/mcp/mako-mcp-server.test.ts
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { buildMakoMcpServer } from "./mako-mcp-server";
import { StatelessMcpTransport } from "./stateless-transport";

const WORKSPACE_ID = new Types.ObjectId().toString();

/** One stateless HTTP exchange: fresh server + transport per call. */
async function exchange(
  messages: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const server = buildMakoMcpServer({ workspaceId: WORKSPACE_ID });
  const transport = new StatelessMcpTransport();
  await server.connect(transport);
  try {
    return (await transport.handle(
      messages as unknown as JSONRPCMessage[],
      5_000,
    )) as unknown as Record<string, unknown>[];
  } finally {
    await server.close();
  }
}

async function main() {
  // 1. initialize handshake identifies the server.
  {
    const [res] = await exchange([
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
    ]);
    const result = res.result as {
      serverInfo: { name: string };
      capabilities: Record<string, unknown>;
    };
    assert.equal(result.serverInfo.name, "mako");
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.resources);
  }

  // 2. Stateless: tools/list works on a fresh exchange WITHOUT initialize
  //    (each HTTP POST builds a new Server; clients only initialize once).
  {
    const [res] = await exchange([
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const { tools } = res.result as {
      tools: { name: string; inputSchema: { type?: string } }[];
    };
    const names = new Set(tools.map(t => t.name));
    for (const expected of [
      "create_app",
      "get_app_state",
      "app_write_file",
      "app_create_data_binding",
      "app_save_version",
      "sql_list_connections",
      "sql_execute_query",
      "mongo_list_connections",
      "mongo_execute_query",
    ]) {
      assert.ok(names.has(expected), `missing tool: ${expected}`);
    }
    for (const tool of tools) {
      assert.equal(
        tool.inputSchema.type,
        "object",
        `tool ${tool.name} should expose an object JSON Schema`,
      );
    }
  }

  // 3. Unknown tool → in-band tool error, not a protocol error.
  {
    const [res] = await exchange([
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "does_not_exist", arguments: {} },
      },
    ]);
    const result = res.result as { isError?: boolean };
    assert.equal(result.isError, true);
  }

  // 4. Invalid arguments are rejected by the bridged zod schema.
  {
    const [res] = await exchange([
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "app_write_file", arguments: { appId: 42 } },
      },
    ]);
    const result = res.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Invalid arguments/);
  }

  // 5. System skills are exposed as resources; the apps playbook reads back.
  {
    const [listRes] = await exchange([
      { jsonrpc: "2.0", id: 5, method: "resources/list" },
    ]);
    const { resources } = listRes.result as { resources: { uri: string }[] };
    const uris = new Set(resources.map(r => r.uri));
    assert.ok(uris.has("mako://skills/apps"), "apps skill resource missing");

    const [readRes] = await exchange([
      {
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: { uri: "mako://skills/apps" },
      },
    ]);
    const { contents } = readRes.result as {
      contents: { mimeType: string; text: string }[];
    };
    assert.equal(contents[0].mimeType, "text/markdown");
    assert.ok(contents[0].text.length > 500, "skill body should be substantial");
  }

  // 6. Notification-only exchange produces no responses (HTTP layer → 202).
  {
    const responses = await exchange([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    assert.equal(responses.length, 0);
  }

  console.log("mako-mcp-server tests passed");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
