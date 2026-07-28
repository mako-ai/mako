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
import {
  AGENT_CAPABILITIES,
  CAPABILITY_GRANTS,
  DBT_CAPABILITY_NAMES,
  type CapabilityGrant,
} from "@mako/agent-tools";
import { buildMakoMcpServer } from "./mako-mcp-server";
import { StatelessMcpTransport } from "./stateless-transport";
import {
  parseWorkspaceApiKeyScopes,
  restQueryAccessFromStoredScopes,
  resolveWorkspaceApiKeyScopes,
  type WorkspaceApiKeyScope,
} from "../auth/api-key-scopes";
import { sqlReadOnlyAccessError } from "../services/read-only-query.service";
import {
  assertBridgePolicyCovers,
  assertBridgePolicyNotStale,
  MCP_BRIDGE_POLICY,
  mcpExposedToolNames,
  summarizeBridgeGaps,
} from "./bridge-policy";
import { collectLiveAgentToolNames } from "./bridge-inventory";

const WORKSPACE_ID = new Types.ObjectId().toString();

/** One stateless HTTP exchange: fresh server + transport per call. */
async function exchange(
  messages: Record<string, unknown>[],
  scopes: WorkspaceApiKeyScope[] = ["mcp", "query:read"],
  acpDesktop = false,
  capabilityGrants?: CapabilityGrant[],
): Promise<Record<string, unknown>[]> {
  const server = buildMakoMcpServer({
    workspaceId: WORKSPACE_ID,
    scopes,
    acpDesktop,
    ...(capabilityGrants ? { capabilityGrants } : {}),
  });
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
  // 1. Legacy keys receive the safe default; unknown scopes cannot be
  //    granted, and stored unknown scopes (e.g. since-removed ones) are
  //    dropped without killing the key's remaining grants.
  assert.deepEqual(parseWorkspaceApiKeyScopes(undefined), [
    "mcp",
    "query:read",
  ]);
  assert.deepEqual(resolveWorkspaceApiKeyScopes(undefined), []);
  assert.equal(restQueryAccessFromStoredScopes(undefined), "write");
  assert.deepEqual(resolveWorkspaceApiKeyScopes(["mcp", "unknown"]), ["mcp"]);
  assert.throws(
    () => parseWorkspaceApiKeyScopes(["mcp", "unknown"]),
    /Unsupported API key scope/,
  );
  // MCP is read-only by design: query:write is not a grantable scope.
  assert.throws(
    () => parseWorkspaceApiKeyScopes(["mcp", "query:write"]),
    /Unsupported API key scope/,
  );
  assert.equal(
    sqlReadOnlyAccessError("SELECT 'UPDATE is text' AS value"),
    null,
  );
  assert.equal(
    sqlReadOnlyAccessError("SELECT system, settings FROM metrics"),
    null,
  );
  assert.equal(
    sqlReadOnlyAccessError("SELECT nextval('invoice_sequence')"),
    null,
  );
  assert.equal(
    sqlReadOnlyAccessError(
      "WITH active AS (SELECT id FROM users) SELECT * FROM active",
    ),
    null,
  );
  for (const query of [
    "UPDATE customers SET plan = 'free'",
    "WITH active AS (SELECT id FROM users) DELETE FROM users",
    "SELECT * INTO archived_customers FROM customers",
    "SELECT 1; DROP TABLE customers",
    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/customers.csv' */",
  ]) {
    assert.ok(sqlReadOnlyAccessError(query), `unsafe query accepted: ${query}`);
  }

  // 2. initialize handshake identifies the server.
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
      instructions?: string;
    };
    assert.equal(result.serverInfo.name, "mako");
    assert.ok(result.capabilities.tools);
    assert.ok(result.capabilities.resources);
    assert.match(
      result.instructions ?? "",
      /Verify with run_app/,
      "initialize should ship the workflow instructions",
    );
  }

  // 2b. ACP Desktop Chat: no headless preview workflow in instructions.
  {
    const server = buildMakoMcpServer({
      workspaceId: WORKSPACE_ID,
      scopes: ["mcp", "query:read"],
      acpDesktop: true,
    });
    const transport = new StatelessMcpTransport();
    await server.connect(transport);
    try {
      const [res] = (await transport.handle(
        [
          {
            jsonrpc: "2.0",
            id: 11,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "acp-test", version: "0.0.0" },
            },
          },
        ] as unknown as JSONRPCMessage[],
        5_000,
      )) as Record<string, unknown>[];
      const result = res.result as { instructions?: string };
      assert.match(result.instructions ?? "", /mako-desktop|Desktop Chat/i);
      assert.doesNotMatch(
        result.instructions ?? "",
        /Verify with run_app|Verify with render_app/,
        "ACP Desktop must not steer agents toward the headless renderer",
      );
    } finally {
      await server.close().catch(() => undefined);
    }
  }

  // 3. Stateless: tools/list works on a fresh exchange WITHOUT initialize
  //    (each HTTP POST builds a new Server; clients only initialize once).
  {
    const [res] = await exchange([
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const { tools } = res.result as {
      tools: {
        name: string;
        inputSchema: { type?: string };
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
        };
      }[];
    };
    const names = new Set(tools.map(t => t.name));
    const byName = new Map(tools.map(t => [t.name, t]));

    // Annotations drive client-side auto-approval: pure reads must say so,
    // and under a query:read key the enforced-read-only query loop too.
    for (const readOnlyTool of [
      "sql_list_tables",
      "sql_inspect_table",
      "sql_execute_query",
      "run_console",
      "read_console",
      "check_query_status",
      "list_console_executions",
      "cancel_query",
      "open_console",
      "read_notebook",
      "search_notebook",
      "read_notebook_cell",
      "read_dbt_project_tree",
      "read_dbt_file",
      "dbt_get_run",
    ]) {
      assert.equal(
        byName.get(readOnlyTool)?.annotations?.readOnlyHint,
        true,
        `${readOnlyTool} should be annotated read-only for a query:read key`,
      );
    }
    assert.equal(
      byName.get("app_write_file")?.annotations?.readOnlyHint,
      false,
    );
    assert.equal(
      byName.get("app_write_file")?.annotations?.destructiveHint,
      false,
    );
    assert.equal(
      byName.get("app_delete_file")?.annotations?.destructiveHint,
      true,
    );
    for (const expected of [
      "create_app",
      "get_app_state",
      "app_search",
      "app_read_resource",
      "app_read_file",
      "app_write_file",
      "app_edit_file",
      "app_add_dependency",
      "app_create_data_binding",
      "app_update_data_binding",
      "materialize_binding",
      "app_save_version",
      "app_restore_version",
      "list_connections",
      "sql_list_connections",
      "sql_list_databases",
      "sql_list_tables",
      "sql_inspect_table",
      "sql_execute_query",
      "mongo_list_connections",
      "search_consoles",
      "search_dashboards",
      "search_skills",
      "list_skills",
      "get_relevant_skills",
      "read_console",
      "create_console",
      "open_console",
      "run_console",
      "create_notebook",
      "read_notebook",
      "search_notebook",
      "read_notebook_cell",
      "list_open_notebooks",
      "check_query_status",
      "cancel_query",
      "browse_version_history",
      "get_version_snapshot",
      "load_skill",
      "read_self_directive",
      "update_self_directive",
      "read_skill_resource",
      "fetch_url",
      "read_dbt_project_tree",
      "read_dbt_file",
      "create_dbt_file",
      "edit_dbt_file",
      "modify_dbt_file",
      "delete_dbt_file",
      "dbt_get_run",
      "dbt_list_recoverable_files",
      "dbt_restore_file",
    ]) {
      assert.ok(names.has(expected), `missing tool: ${expected}`);
    }
    assert.equal(
      names.has("app_get_data_binding"),
      false,
      "redundant app_get_data_binding must not be exposed over MCP",
    );
    for (const tool of tools) {
      assert.equal(
        tool.inputSchema.type,
        "object",
        `tool ${tool.name} should expose an object JSON Schema`,
      );
    }
    assert.equal(
      names.has("mongo_execute_query"),
      false,
      "read-only keys must not expose arbitrary MongoDB JavaScript execution",
    );
    if (names.has("web_search")) {
      assert.equal(
        byName.get("web_search")?.annotations?.openWorldHint,
        true,
        "web_search should be annotated open-world",
      );
    }
    assert.equal(
      byName.get("fetch_url")?.annotations?.openWorldHint,
      true,
      "fetch_url should be annotated open-world",
    );
    assert.equal(
      names.has("save_skill"),
      false,
      "skill writes stay in-product",
    );
    assert.equal(
      names.has("open_app"),
      false,
      "client-only app tools must not be bridged",
    );
    // Canonical verify capability: external MCP gets run_app (headless
    // renderer adapter), annotated read-only like the render it performs.
    assert.ok(names.has("run_app"), "run_app must be bridged for external MCP");
    assert.equal(
      byName.get("run_app")?.annotations?.readOnlyHint,
      true,
      "run_app renders a draft and mutates nothing",
    );
    for (const desktopOnlyTool of [
      "dbt_parse",
      "dbt_compile_model",
      "dbt_show",
      "dbt_run_model",
      "dbt_cancel_run",
    ]) {
      assert.equal(
        names.has(desktopOnlyTool),
        false,
        `${desktopOnlyTool} must stay off general MCP`,
      );
    }
  }

  // 3b. Bridge policy covers the live agent inventory — this is how we stay
  //     smart about gaps when someone adds a new agent tool.
  {
    const live = collectLiveAgentToolNames();
    assertBridgePolicyCovers(live);
    assertBridgePolicyNotStale(live);

    const [res] = await exchange([
      { jsonrpc: "2.0", id: "policy", method: "tools/list" },
    ]);
    const { tools } = res.result as { tools: { name: string }[] };
    const exposed = new Set(tools.map(t => t.name));
    for (const [name, entry] of Object.entries(MCP_BRIDGE_POLICY)) {
      if (entry.status !== "bridge") continue;
      // Conditional tools (e.g. web_search) only appear when optional
      // providers are configured.
      if (entry.conditional || entry.acpDesktopOnly) continue;
      assert.ok(
        exposed.has(name),
        `policy says bridge ${name} but tools/list omitted it`,
      );
    }
    for (const name of exposed) {
      const entry = MCP_BRIDGE_POLICY[name];
      assert.ok(
        entry && (entry.status === "bridge" || entry.status === "mcp-only"),
        `tools/list exposed ${name} without a bridge/mcp-only policy entry`,
      );
    }
    // Sanity: gaps summary is non-empty and includes the security exclusion.
    const gaps = summarizeBridgeGaps();
    assert.ok(gaps.some(g => g.why === "security"));
    assert.ok(mcpExposedToolNames().includes("create_app"));
  }

  // 3c. Desktop ACP warehouse execution: plan-grant gating is DISABLED
  //     pending product review (see the grants comment in mako-mcp-server.ts
  //     and PLAN_GRANT_GATING_ENABLED in agents/modes/runtime.ts) — calls
  //     pass authorization without any AcpPlanGrant; the zod schema then
  //     rejects the empty arguments, proving no grant gate blocked the call.
  {
    const [unapprovedList] = await exchange(
      [{ jsonrpc: "2.0", id: "acp-dbt-list", method: "tools/list" }],
      ["mcp", "query:read"],
      true,
    );
    const unapprovedTools = (
      unapprovedList.result as { tools: { name: string }[] }
    ).tools;
    assert.ok(
      unapprovedTools.some(tool => tool.name === "dbt_run_model"),
      "Desktop should discover warehouse tools",
    );
    const [ungatedCall] = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: "acp-dbt-ungated",
          method: "tools/call",
          params: { name: "dbt_run_model", arguments: {} },
        },
      ],
      ["mcp", "query:read"],
      true,
    );
    assert.match(
      (ungatedCall.result as { content: { text: string }[] }).content[0].text,
      /Invalid arguments/,
      "ACP gating disabled: no plan grant required to reach the tool",
    );

    const [res] = await exchange(
      [{ jsonrpc: "2.0", id: "acp-dbt", method: "tools/list" }],
      ["mcp", "query:read"],
      true,
      [...CAPABILITY_GRANTS],
    );
    const { tools } = res.result as {
      tools: {
        name: string;
        annotations?: {
          destructiveHint?: boolean;
        };
      }[];
    };
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const capabilityName of DBT_CAPABILITY_NAMES) {
      assert.ok(
        byName.has(capabilityName),
        `Desktop ACP missing registered dbt capability: ${capabilityName}`,
      );
    }
    assert.ok(byName.has("dbt_run_model"));
    assert.ok(byName.has("dbt_cancel_run"));
    assert.equal(
      byName.get("dbt_run_model")?.annotations?.destructiveHint,
      true,
    );
  }

  // 3d. Run logs / dbt show output require query scope.
  {
    const [res] = await exchange(
      [{ jsonrpc: "2.0", id: "dbt-no-query", method: "tools/list" }],
      ["mcp"],
    );
    const { tools } = res.result as { tools: { name: string }[] };
    assert.equal(
      tools.some(tool => tool.name === "dbt_get_run"),
      false,
      "dbt run output must stay hidden without query:read",
    );
    // Warehouse-executing tools from the other migrated domains carry the
    // same query envelope.
    for (const queryTool of ["run_notebook_sql_cell", "materialize_binding"]) {
      assert.equal(
        tools.some(tool => tool.name === queryTool),
        false,
        `${queryTool} must stay hidden without query:read`,
      );
    }
  }

  // 3e. Schedule mutations: implicit for external MCP (existing headless
  //     authoring authority); Desktop ACP plan-grant gating is DISABLED
  //     pending review, so ACP passes authorization without a grant too.
  {
    const registryNames = new Set(
      AGENT_CAPABILITIES.map(capability => capability.name),
    );
    assert.equal(
      registryNames.size,
      AGENT_CAPABILITIES.length,
      "capability registry must not contain duplicate tool names",
    );

    // External MCP: authorization passes, so the zod schema rejects the
    // bogus arguments (proves the call was not blocked by a grant).
    const [externalCall] = await exchange([
      {
        jsonrpc: "2.0",
        id: "schedule-external",
        method: "tools/call",
        params: { name: "app_set_binding_schedule", arguments: { appId: 42 } },
      },
    ]);
    assert.match(
      (externalCall.result as { content: { text: string }[] }).content[0].text,
      /Invalid arguments/,
      "external MCP keeps implicit schedule authority",
    );

    // Desktop ACP without any plan grant: gating disabled, authorization
    // passes and the zod schema rejects the bogus arguments.
    const [desktopUngated] = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: "schedule-acp-ungated",
          method: "tools/call",
          params: {
            name: "app_set_binding_schedule",
            arguments: { appId: 42 },
          },
        },
      ],
      ["mcp", "query:read"],
      true,
    );
    assert.match(
      (desktopUngated.result as { content: { text: string }[] }).content[0]
        .text,
      /Invalid arguments/,
      "ACP gating disabled: no schedule-write grant required",
    );
  }

  // 3f. run_app delivery per surface: external MCP gets the headless
  //     adapter from the Mako server (asserted in section 3); Desktop ACP
  //     gets run_app from the mako-desktop loopback server against the live
  //     tab, so the Mako bridge must omit it there — one name, one provider.
  {
    const [desktopList] = await exchange(
      [{ jsonrpc: "2.0", id: "run-app-acp", method: "tools/list" }],
      ["mcp", "query:read"],
      true,
    );
    const desktopTools = (desktopList.result as { tools: { name: string }[] })
      .tools;
    assert.equal(
      desktopTools.some(tool => tool.name === "run_app"),
      false,
      "Desktop ACP must get run_app from mako-desktop, not the Mako bridge",
    );
    assert.equal(
      desktopTools.some(tool => tool.name === "list_open_consoles"),
      false,
      "Desktop ACP must get list_open_consoles from mako-desktop, not the Mako bridge",
    );
  }

  // 4. Arbitrary MongoDB JavaScript execution is never bridged over MCP.
  {
    const [res] = await exchange(
      [{ jsonrpc: "2.0", id: 3, method: "tools/list" }],
      ["mcp", "query:read"],
    );
    const { tools } = res.result as { tools: { name: string }[] };
    assert.equal(
      tools.some(tool => tool.name === "mongo_execute_query"),
      false,
      "mongo_execute_query must not be exposed over MCP",
    );
  }

  // 5. Unsafe SQL is rejected before any database lookup/execution.
  {
    const [res] = await exchange([
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "sql_execute_query",
          arguments: {
            connectionId: new Types.ObjectId().toString(),
            query: "UPDATE customers SET plan = 'free'",
          },
        },
      },
    ]);
    const result = res.result as { content: { text: string }[] };
    assert.match(result.content[0].text, /read-only/);
    assert.match(result.content[0].text, /UPDATE/);
  }

  // 6. Unknown tool → in-band tool error, not a protocol error.
  {
    const [res] = await exchange([
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "does_not_exist", arguments: {} },
      },
    ]);
    const result = res.result as { isError?: boolean };
    assert.equal(result.isError, true);
  }

  // 7. Invalid arguments are rejected by the bridged zod schema.
  {
    const [res] = await exchange([
      {
        jsonrpc: "2.0",
        id: 6,
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

  // 8. System skills are exposed as resources; the apps playbook reads back.
  {
    const [listRes] = await exchange([
      { jsonrpc: "2.0", id: 7, method: "resources/list" },
    ]);
    const { resources } = listRes.result as { resources: { uri: string }[] };
    const uris = new Set(resources.map(r => r.uri));
    assert.ok(uris.has("mako://skills/apps"), "apps skill resource missing");

    const [readRes] = await exchange([
      {
        jsonrpc: "2.0",
        id: 8,
        method: "resources/read",
        params: { uri: "mako://skills/apps" },
      },
    ]);
    const { contents } = readRes.result as {
      contents: { mimeType: string; text: string }[];
    };
    assert.equal(contents[0].mimeType, "text/markdown");
    assert.ok(
      contents[0].text.length > 500,
      "skill body should be substantial",
    );
  }

  // 9. Notification-only exchange produces no responses (HTTP layer → 202).
  {
    const responses = await exchange([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
    assert.equal(responses.length, 0);
  }

  // eslint-disable-next-line no-console
  console.log("mako-mcp-server tests passed");
  // Imported tool modules hold live handles (driver pools/timers); an
  // explicit exit keeps the tsx test chain moving.
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
