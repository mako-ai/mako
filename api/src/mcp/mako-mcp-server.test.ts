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
  AGENT_CAPABILITY_BY_NAME,
  CAPABILITY_GRANTS,
  DBT_CAPABILITY_NAMES,
  type CapabilityGrant,
} from "@mako/agent-tools";
import { buildMakoMcpServer } from "./mako-mcp-server";
import { createChatGptConnectorTools } from "./chatgpt-connector-tools";
import { StatelessMcpTransport } from "./stateless-transport";
import {
  capabilityGrantsFromScopes,
  parseWorkspaceApiKeyScopes,
  queryAccessFromScopes,
  restQueryAccessFromStoredScopes,
  resolveWorkspaceApiKeyScopes,
  type WorkspaceApiKeyScope,
} from "../auth/api-key-scopes";
import { effectiveSqlQueryAccess } from "../agent-lib/tools/sql-tools";
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
  // query:write is double-gated: the scope alone yields "write-opt-in",
  // which resolves to write ONLY against connections a workspace admin
  // marked allowAgentWrites — and can never upgrade a plain query:read key.
  assert.deepEqual(parseWorkspaceApiKeyScopes(["mcp", "query:write"]), [
    "mcp",
    "query:write",
  ]);
  assert.equal(
    queryAccessFromScopes(["mcp", "query:read", "query:write"]),
    "write-opt-in",
  );
  assert.equal(queryAccessFromScopes(["mcp", "query:read"]), "read");
  assert.equal(
    effectiveSqlQueryAccess("write-opt-in", { allowAgentWrites: true }),
    "write",
  );
  assert.equal(
    effectiveSqlQueryAccess("write-opt-in", { allowAgentWrites: false }),
    "read",
  );
  assert.equal(effectiveSqlQueryAccess("write-opt-in", {}), "read");
  assert.equal(
    effectiveSqlQueryAccess("read", { allowAgentWrites: true }),
    "read",
    "the connection flag must never upgrade a read-only key",
  );
  assert.equal(
    effectiveSqlQueryAccess("none", { allowAgentWrites: true }),
    "none",
  );
  // REST endpoints have not adopted per-connection resolution: a
  // query:write key stays read there.
  assert.equal(
    restQueryAccessFromStoredScopes(["mcp", "query:read", "query:write"]),
    "read",
  );
  // warehouse:write is grantable (opt-in, never default) and maps to the
  // warehouse-write capability grant only.
  assert.deepEqual(
    parseWorkspaceApiKeyScopes(["mcp", "query:read", "warehouse:write"]),
    ["mcp", "query:read", "warehouse:write"],
  );
  assert.deepEqual(
    capabilityGrantsFromScopes(["mcp", "query:read", "warehouse:write"]),
    ["warehouse-write"],
  );
  assert.deepEqual(capabilityGrantsFromScopes(["mcp", "query:read"]), []);
  assert.deepEqual(
    capabilityGrantsFromScopes(["mcp", "query:read", "git:write"]),
    ["git-write"],
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
      /Verify with app_open_app/,
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
      "list_databases",
      "list_tables",
      "inspect_table",
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
    for (const expected of [
      "list_connections",
      "list_databases",
      "list_tables",
      "inspect_table",
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
      // Async validation runs (queue + poll dbt_get_run) — read-risk, so
      // they bridge for every query:read key: author AND validate headlessly.
      "dbt_parse",
      "dbt_compile_model",
      "dbt_show",
      // Git reads bridge unconditionally so headless agents can see that
      // their edits are uncommitted working-tree drafts.
      "dbt_git_status",
      "dbt_list_branches",
      "dbt_compare_branches",
      "dbt_list_pull_requests",
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
    // Generic version save/restore is client-side; MCP keeps the server-side
    // app_save_version / app_restore_version pair instead.
    assert.equal(names.has("save_version"), false);
    assert.equal(names.has("restore_version"), false);
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
    // Warehouse-mutating dbt runs require the explicit warehouse:write
    // scope; a default query:read key must not see them.
    for (const warehouseGatedTool of [
      "dbt_run_model",
      "dbt_run_job",
      "dbt_cancel_run",
    ]) {
      assert.equal(
        names.has(warehouseGatedTool),
        false,
        `${warehouseGatedTool} must stay hidden without warehouse:write`,
      );
    }
    // Git mutations require the explicit git:write scope.
    for (const gitGatedTool of [
      "dbt_sync_from_repo",
      "dbt_commit_and_push",
      "dbt_commit_to_branch",
      "dbt_create_branch",
      "dbt_switch_branch",
      "dbt_delete_branch",
      "dbt_open_pull_request",
      "dbt_merge_pull_request",
      "dbt_update_pull_request",
      "dbt_close_pull_request",
    ]) {
      assert.equal(
        names.has(gitGatedTool),
        false,
        `${gitGatedTool} must stay hidden without git:write`,
      );
    }
  }

  // 3a. warehouse:write opt-in: run tools appear (destructive-annotated) and
  //     authorize; without the scope the call fails as an unknown tool and
  //     the capability runtime would refuse it regardless.
  {
    const [res] = await exchange(
      [{ jsonrpc: "2.0", id: "wh-list", method: "tools/list" }],
      ["mcp", "query:read", "warehouse:write"],
    );
    const { tools } = res.result as {
      tools: {
        name: string;
        annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
      }[];
    };
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const runTool of ["dbt_run_model", "dbt_run_job", "dbt_cancel_run"]) {
      assert.ok(
        byName.has(runTool),
        `${runTool} must be exposed with warehouse:write`,
      );
    }
    assert.equal(
      byName.get("dbt_run_model")?.annotations?.destructiveHint,
      true,
    );
    assert.equal(byName.get("dbt_run_job")?.annotations?.destructiveHint, true);
    // Validation stays read-annotated so clients can auto-approve it.
    assert.equal(byName.get("dbt_parse")?.annotations?.readOnlyHint, true);
    assert.equal(byName.get("dbt_show")?.annotations?.readOnlyHint, true);

    const [ungated] = await exchange([
      {
        jsonrpc: "2.0",
        id: "wh-call",
        method: "tools/call",
        params: { name: "dbt_run_model", arguments: {} },
      },
    ]);
    const ungatedResult = ungated.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(
      ungatedResult.isError,
      true,
      "dbt_run_model without warehouse:write must fail",
    );
    assert.match(ungatedResult.content[0].text, /Unknown tool/);

    // With the scope, authorization passes and the zod schema rejects the
    // empty arguments (proves no grant gate blocked the call).
    const [gatedCall] = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: "wh-call-scoped",
          method: "tools/call",
          params: { name: "dbt_run_model", arguments: {} },
        },
      ],
      ["mcp", "query:read", "warehouse:write"],
    );
    assert.match(
      (gatedCall.result as { content: { text: string }[] }).content[0].text,
      /Invalid arguments/,
      "warehouse:write key reaches dbt_run_model",
    );
  }

  // 3a2. git:write opt-in: Git mutations appear (risk-annotated) and
  //      authorize, independently of warehouse:write.
  {
    const [res] = await exchange(
      [{ jsonrpc: "2.0", id: "git-list", method: "tools/list" }],
      ["mcp", "query:read", "git:write"],
    );
    const { tools } = res.result as {
      tools: {
        name: string;
        annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
      }[];
    };
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const gitTool of [
      "dbt_commit_to_branch",
      "dbt_create_branch",
      "dbt_open_pull_request",
      "dbt_switch_branch",
      "dbt_merge_pull_request",
    ]) {
      assert.ok(byName.has(gitTool), `${gitTool} must appear with git:write`);
    }
    assert.equal(
      byName.get("dbt_switch_branch")?.annotations?.destructiveHint,
      true,
    );
    assert.equal(
      byName.get("dbt_commit_to_branch")?.annotations?.destructiveHint,
      false,
    );
    // git:write alone does not surface warehouse runs.
    assert.equal(
      byName.has("dbt_run_model"),
      false,
      "git:write must not imply warehouse:write",
    );
    assert.equal(byName.get("dbt_git_status")?.annotations?.readOnlyHint, true);

    const [gatedCall] = await exchange(
      [
        {
          jsonrpc: "2.0",
          id: "git-call-scoped",
          method: "tools/call",
          params: { name: "dbt_commit_to_branch", arguments: {} },
        },
      ],
      ["mcp", "query:read", "git:write"],
    );
    assert.match(
      (gatedCall.result as { content: { text: string }[] }).content[0].text,
      /Invalid arguments/,
      "git:write key reaches dbt_commit_to_branch",
    );
  }

  // 3a3. query:write annotations: sql_execute_query may write (per-connection
  //      resolution happens at execution), so it must NOT be annotated
  //      read-only; console runs fail closed to read and stay annotated so.
  {
    const [res] = await exchange(
      [{ jsonrpc: "2.0", id: "qw-list", method: "tools/list" }],
      ["mcp", "query:read", "query:write"],
    );
    const { tools } = res.result as {
      tools: { name: string; annotations?: { readOnlyHint?: boolean } }[];
    };
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    assert.equal(
      byName.get("sql_execute_query")?.annotations?.readOnlyHint,
      false,
      "sql_execute_query may write under query:write — no read-only hint",
    );
    assert.equal(
      byName.get("run_console")?.annotations?.readOnlyHint,
      true,
      "run_console fails closed to read under query:write",
    );
    assert.equal(byName.get("cancel_query")?.annotations?.readOnlyHint, true);
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
      // Grant-gated tools only appear when the key's scopes opt into the
      // grant (e.g. warehouse:write); this exchange used the default scopes.
      const requiredGrant = AGENT_CAPABILITY_BY_NAME.get(name)?.requiredGrant;
      if (
        requiredGrant &&
        requiredGrant !== "artifact-write" &&
        requiredGrant !== "schedule-write"
      ) {
        continue;
      }
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
    assert.ok(mcpExposedToolNames().includes("create_console"));
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
        params: { name: "create_console", arguments: { appId: 42 } },
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
            name: "create_console",
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

  // 3g. ChatGPT connector contract: the route layer registers search/fetch
  //     as extraTools for external clients (ChatGPT refuses a connector
  //     without exactly this pair). Both are read-only and policy-classified.
  {
    const context = {
      workspaceId: WORKSPACE_ID,
      scopes: ["mcp", "query:read"] as WorkspaceApiKeyScope[],
    };
    const chatGptExchange = async (messages: Record<string, unknown>[]) => {
      const server = buildMakoMcpServer(
        context,
        createChatGptConnectorTools(context),
      );
      const transport = new StatelessMcpTransport();
      await server.connect(transport);
      try {
        return (await transport.handle(
          messages as unknown as JSONRPCMessage[],
          5_000,
        )) as unknown as Record<string, unknown>[];
      } finally {
        await server.close().catch(() => undefined);
      }
    };

    const [listRes] = await chatGptExchange([
      { jsonrpc: "2.0", id: "chatgpt-list", method: "tools/list" },
    ]);
    const { tools } = listRes.result as {
      tools: {
        name: string;
        inputSchema: { type?: string };
        annotations?: { readOnlyHint?: boolean };
      }[];
    };
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const name of ["search", "fetch"]) {
      const entry = byName.get(name);
      assert.ok(entry, `ChatGPT connector tool missing: ${name}`);
      assert.equal(entry?.inputSchema.type, "object");
      assert.equal(
        entry?.annotations?.readOnlyHint,
        true,
        `${name} must be annotated read-only`,
      );
      const policy = MCP_BRIDGE_POLICY[name];
      assert.equal(
        policy?.status,
        "mcp-only",
        `${name} must be classified mcp-only in the bridge policy`,
      );
    }

    // Malformed / unknown document ids fail in-band before any DB access.
    const [badId] = await chatGptExchange([
      {
        jsonrpc: "2.0",
        id: "chatgpt-bad-id",
        method: "tools/call",
        params: { name: "fetch", arguments: { id: "bogus" } },
      },
    ]);
    const badIdResult = badId.result as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(badIdResult.isError, true);
    assert.match(badIdResult.content[0].text, /console, dashboard, app/);

    const [badKind] = await chatGptExchange([
      {
        jsonrpc: "2.0",
        id: "chatgpt-bad-kind",
        method: "tools/call",
        params: { name: "fetch", arguments: { id: "widget:123" } },
      },
    ]);
    assert.match(
      (badKind.result as { content: { text: string }[] }).content[0].text,
      /Unknown document kind/,
    );

    // Zod schema validation applies like every other bridged tool.
    const [missingQuery] = await chatGptExchange([
      {
        jsonrpc: "2.0",
        id: "chatgpt-no-query",
        method: "tools/call",
        params: { name: "search", arguments: {} },
      },
    ]);
    assert.match(
      (missingQuery.result as { content: { text: string }[] }).content[0].text,
      /Invalid arguments/,
    );

    // ACP Desktop must NOT get the pair (route passes no extraTools there).
    const [acpList] = await exchange(
      [{ jsonrpc: "2.0", id: "chatgpt-acp", method: "tools/list" }],
      ["mcp", "query:read"],
      true,
    );
    const acpNames = new Set(
      (acpList.result as { tools: { name: string }[] }).tools.map(t => t.name),
    );
    assert.equal(acpNames.has("search"), false);
    assert.equal(acpNames.has("fetch"), false);
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
        params: { name: "create_console", arguments: { appId: 42 } },
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
