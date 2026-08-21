/**
 * MCP connector agent-tool tests, against in-memory Mongo: admin gating,
 * preset resolution (fixed vs. custom URLs), SSRF rejection, duplicate names,
 * listing, the missing-credential test path, and removal cleanup.
 *
 * Run: tsx src/agent-lib/tools/mcp-connector-tools.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.MCP_ALLOW_PRIVATE_URLS = "false";

import { createMcpConnectorTools } from "./mcp-connector-tools";
import {
  McpConnectionConfig,
  McpServer,
  McpToolGrant,
  WorkspaceMember,
} from "../../database/workspace-schema";

type ToolResult = Record<string, unknown> & { success: boolean };

async function run(
  tools: ReturnType<typeof createMcpConnectorTools>,
  name: keyof ReturnType<typeof createMcpConnectorTools>,
  input: unknown,
): Promise<ToolResult> {
  const t = tools[name] as unknown as {
    execute: (input: unknown, opts: unknown) => Promise<ToolResult>;
  };
  return t.execute(input, { toolCallId: "t", messages: [] });
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri("mako-test-mcp-connector-tools"));
  // The duplicate-name test depends on the (workspaceId, name) unique index.
  await McpServer.init();

  try {
    const workspaceId = new Types.ObjectId().toString();
    const adminId = "user-admin";
    const memberId = "user-member";
    await WorkspaceMember.create([
      { workspaceId, userId: adminId, role: "admin" },
      { workspaceId, userId: memberId, role: "member" },
    ]);

    const adminTools = createMcpConnectorTools({
      workspaceId,
      userId: adminId,
    });
    const memberTools = createMcpConnectorTools({
      workspaceId,
      userId: memberId,
    });

    // Non-admins cannot add or remove.
    const denied = await run(memberTools, "add_mcp_connector", {
      name: "GitHub",
      connectorType: "github",
    });
    assert.equal(denied.success, false);
    assert.match(String(denied.error), /admin/i);

    // Preset creation: fixed URL comes from the preset, OAuth is the default,
    // and the next steps point at Settings (never ask for secrets in chat).
    const created = await run(adminTools, "add_mcp_connector", {
      name: "GitHub",
      connectorType: "github",
    });
    assert.equal(created.success, true, String(created.error));
    assert.equal(created.url, "https://api.githubcopilot.com/mcp/");
    assert.equal(created.authType, "oauth");
    assert.equal(created.writeScope, "read");
    assert.match(String(created.nextSteps), /Settings → MCP Servers/);
    const serverId = String(created.serverId);

    const stored = await McpServer.findById(serverId).lean();
    assert.equal(stored?.authPerformer, "user");
    assert.equal(stored?.status, "awaiting_auth");
    assert.equal(stored?.createdBy, adminId);

    // Duplicate names surface a clear error (unique index per workspace).
    const dup = await run(adminTools, "add_mcp_connector", {
      name: "GitHub",
      connectorType: "github",
    });
    assert.equal(dup.success, false);
    assert.match(String(dup.error), /already exists/);

    // Custom servers require a URL, and private targets are SSRF-blocked.
    const noUrl = await run(adminTools, "add_mcp_connector", {
      name: "Internal",
      connectorType: "custom",
    });
    assert.equal(noUrl.success, false);
    assert.match(String(noUrl.error), /URL is required/);
    const ssrf = await run(adminTools, "add_mcp_connector", {
      name: "Internal",
      connectorType: "custom",
      url: "http://localhost:8080/mcp",
    });
    assert.equal(ssrf.success, false);

    // Unsupported auth for a preset is rejected (Slack is OAuth-only).
    const badAuth = await run(adminTools, "add_mcp_connector", {
      name: "Slack",
      connectorType: "slack",
      authType: "api_key",
    });
    assert.equal(badAuth.success, false);
    assert.match(String(badAuth.error), /supports auth/);

    // Listing shows presets and the created server; members can list too.
    const listed = await run(memberTools, "list_mcp_connectors", {});
    assert.equal(listed.success, true);
    const presets = listed.presets as Array<{ type: string }>;
    for (const type of ["close", "slack", "github", "custom"]) {
      assert.ok(
        presets.some(p => p.type === type),
        `preset ${type} listed`,
      );
    }
    const servers = listed.servers as Array<Record<string, unknown>>;
    assert.equal(servers.length, 1);
    assert.equal(servers[0].id, serverId);
    assert.equal(servers[0].userHasCredential, false);
    assert.ok(servers[0].nextSteps, "unconnected server carries next steps");

    // Testing an OAuth server before connecting explains what's missing
    // instead of attempting a doomed network call.
    const untested = await run(memberTools, "test_mcp_connector", {
      serverId,
    });
    assert.equal(untested.success, false);
    assert.match(String(untested.error), /No usable credential/);

    // Unknown ids and cross-workspace ids are NOT FOUND.
    const missing = await run(adminTools, "test_mcp_connector", {
      serverId: new Types.ObjectId().toString(),
    });
    assert.equal(missing.success, false);
    assert.equal(missing.error, "SERVER_NOT_FOUND");

    // Removal is admin-only and cleans up configs + grants.
    await McpConnectionConfig.create({
      workspaceId: new Types.ObjectId(workspaceId),
      serverId: new Types.ObjectId(serverId),
      userId: memberId,
      headers: {},
    });
    await McpToolGrant.create({
      workspaceId: new Types.ObjectId(workspaceId),
      serverId: new Types.ObjectId(serverId),
      userId: memberId,
      toolName: "x",
      decision: "always_allow",
    });
    const removeDenied = await run(memberTools, "remove_mcp_connector", {
      serverId,
    });
    assert.equal(removeDenied.success, false);
    const removed = await run(adminTools, "remove_mcp_connector", { serverId });
    assert.equal(removed.success, true);
    assert.equal(await McpServer.countDocuments({}), 0);
    assert.equal(await McpConnectionConfig.countDocuments({}), 0);
    assert.equal(await McpToolGrant.countDocuments({}), 0);

    // eslint-disable-next-line no-console
    console.log("✓ mcp-connector-tools tests passed");
  } finally {
    await mongoose.disconnect();
    await replSet.stop();
  }
}

main().catch((error: unknown) => {
  throw error;
});
