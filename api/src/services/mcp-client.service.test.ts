/**
 * MCP client service tests.
 *
 * Pure-logic coverage (risk tiers, tool-name prefixing, allowlist filtering,
 * URL safety) plus crypto round-trips. DB-dependent behavior (grants →
 * needsApproval) is covered by the in-memory-Mongo test below.
 *
 * Run: tsx src/services/mcp-client.service.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.MCP_ALLOW_PRIVATE_URLS = "false";

import {
  assertSafeMcpUrl,
  buildMcpToolsForChat,
  mcpAllowedCachedTools,
  mcpPrefixedToolName,
  mcpServerSlug,
  mcpToolRestriction,
  mcpToolRiskTier,
} from "./mcp-client.service";
import {
  decryptRecord,
  decryptString,
  encryptRecord,
  encryptString,
} from "./crypto.service";
import {
  type IMcpServer,
  McpConnectionConfig,
  McpServer,
  McpToolGrant,
} from "../database/workspace-schema";

function testServerSlugAndPrefix() {
  assert.equal(mcpServerSlug("Close CRM"), "close_crm");
  assert.equal(mcpServerSlug("  Wild -- Name!! "), "wild_name");
  assert.equal(mcpServerSlug("!!!"), "server");
  assert.equal(
    mcpPrefixedToolName("Close CRM", "lead_search"),
    "mcp_close_crm_lead_search",
  );
}

function testRiskTiers() {
  const readServer = { writeScope: "read" } as Pick<IMcpServer, "writeScope">;
  const writeServer = {
    writeScope: "write_safe",
  } as Pick<IMcpServer, "writeScope">;
  const destroyServer = {
    writeScope: "write_destructive",
  } as Pick<IMcpServer, "writeScope">;

  // Read-scope connection: everything is read-tier (provider enforces too).
  assert.equal(mcpToolRiskTier(readServer, {}), "read");
  assert.equal(
    mcpToolRiskTier(readServer, { annotations: { destructiveHint: true } }),
    "read",
  );

  // Annotation-driven tiers on write connections.
  assert.equal(
    mcpToolRiskTier(writeServer, { annotations: { readOnlyHint: true } }),
    "read",
  );
  assert.equal(
    mcpToolRiskTier(writeServer, { annotations: { readOnlyHint: false } }),
    "write",
  );
  assert.equal(
    mcpToolRiskTier(destroyServer, { annotations: { destructiveHint: true } }),
    "destructive",
  );
  // Unannotated tools default to plain write (approval required, grantable).
  assert.equal(mcpToolRiskTier(destroyServer, {}), "write");
}

function testAllowlistFiltering() {
  const base = {
    writeScope: "write_safe",
    cachedTools: [{ name: "a" }, { name: "b" }, { name: "c" }],
  };
  const all = {
    ...base,
    toolPolicy: { defaultRestriction: "always", restrictions: {} },
  } as unknown as IMcpServer;
  const blocked = {
    ...base,
    toolPolicy: {
      defaultRestriction: "always",
      restrictions: { b: "block" },
    },
  } as unknown as IMcpServer;
  const blockByDefault = {
    ...base,
    toolPolicy: {
      defaultRestriction: "block",
      restrictions: { a: "always", c: "ask" },
    },
  } as unknown as IMcpServer;

  assert.equal(mcpAllowedCachedTools(all).length, 3);
  assert.deepEqual(
    mcpAllowedCachedTools(blocked).map(t => t.name),
    ["a", "c"],
  );
  // Default restriction applies to unconfigured tools ("b" here) — including
  // tools the server adds later.
  assert.deepEqual(
    mcpAllowedCachedTools(blockByDefault).map(t => t.name),
    ["a", "c"],
  );

  // Ceiling resolution: explicit > destructive-tier default > server default.
  assert.equal(mcpToolRestriction(all, { name: "a" }), "always");
  assert.equal(mcpToolRestriction(blocked, { name: "b" }), "block");
  assert.equal(
    mcpToolRestriction(all, {
      name: "z",
      annotations: { destructiveHint: true },
    }),
    "ask",
  );
  assert.equal(
    mcpToolRestriction(
      {
        ...all,
        toolPolicy: {
          defaultRestriction: "always",
          restrictions: { z: "always" },
        },
      } as unknown as IMcpServer,
      { name: "z", annotations: { destructiveHint: true } },
    ),
    "always",
  );
}

async function testUrlSafety() {
  await assert.rejects(() => assertSafeMcpUrl("ftp://mcp.close.com/mcp"));
  await assert.rejects(() => assertSafeMcpUrl("http://localhost:9999/mcp"));
  await assert.rejects(() => assertSafeMcpUrl("http://127.0.0.1:9999/mcp"));
  await assert.rejects(() => assertSafeMcpUrl("not a url"));
  await assert.doesNotReject(() =>
    assertSafeMcpUrl("https://mcp.close.com/mcp"),
  );
}

function testCryptoRoundTrip() {
  const value = "sk_live_super_secret";
  const encrypted = encryptString(value);
  assert.notEqual(encrypted, value);
  assert.match(encrypted, /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/);
  assert.equal(decryptString(encrypted), value);
  // Idempotent: encrypting an encrypted value is a no-op.
  assert.equal(encryptString(encrypted), encrypted);

  const record = { "Close-API-Key": "key123", "X-Other": "v" };
  const enc = encryptRecord(record);
  assert.notEqual(enc["Close-API-Key"], "key123");
  assert.deepEqual(decryptRecord(enc), record);
}

/**
 * Grants → approval flow, against in-memory Mongo:
 * read tools never need approval; write tools need approval until an
 * always_allow grant exists; always_deny tools skip the prompt and refuse
 * at execute time; destructive tools stay prompt-only unless the admin
 * unlocked grants.
 */
async function testGrantsAndNeedsApproval() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
  });
  await mongoose.connect(replSet.getUri("mako-test"));

  try {
    const workspaceId = new Types.ObjectId();
    const userId = "user-1";

    const server = await McpServer.create({
      workspaceId,
      name: "Close CRM",
      connectorType: "close",
      transport: { type: "http", url: "https://mcp.close.com/mcp" },
      authType: "api_key",
      authPerformer: "workspace",
      writeScope: "write_destructive",
      status: "connected",
      createdBy: userId,
      cachedTools: [
        {
          name: "lead_search",
          description: "Search leads",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "lead_create",
          description: "Create a lead",
          annotations: { readOnlyHint: false, destructiveHint: false },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "lead_delete",
          description: "Delete a lead",
          annotations: { destructiveHint: true },
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    await McpConnectionConfig.create({
      workspaceId,
      serverId: server._id,
      userId: "",
      headers: encryptRecord({ "Close-API-Key": "test" }),
    });

    const loadTools = () =>
      buildMcpToolsForChat({
        workspaceId: workspaceId.toString(),
        userId,
      });

    let chatTools = await loadTools();
    assert.equal(chatTools.allToolNames.length, 3);
    assert.deepEqual(chatTools.readOnlyToolNames, [
      "mcp_close_crm_lead_search",
    ]);

    const needsApproval = async (prefixed: string): Promise<boolean> => {
      const tool = chatTools.tools[prefixed];
      assert.ok(tool, `tool ${prefixed} missing`);
      const fn = tool.needsApproval;
      if (typeof fn === "function") {
        return await fn(
          {},
          { toolCallId: "t", messages: [], experimental_context: undefined },
        );
      }
      return fn === true;
    };

    // Claude model: EVERY tool prompts on first use — reads included —
    // until the user chooses a permission.
    assert.equal(await needsApproval("mcp_close_crm_lead_search"), true);
    assert.equal(await needsApproval("mcp_close_crm_lead_create"), true);
    assert.equal(await needsApproval("mcp_close_crm_lead_delete"), true);

    // "Always allow" grant on the read tool: no more prompts.
    await McpToolGrant.create({
      workspaceId,
      serverId: server._id,
      userId,
      toolName: "lead_search",
      decision: "always_allow",
    });
    assert.equal(await needsApproval("mcp_close_crm_lead_search"), false);

    // "Always allow" grant on the write tool: no more prompts.
    await McpToolGrant.create({
      workspaceId,
      serverId: server._id,
      userId,
      toolName: "lead_create",
      decision: "always_allow",
    });
    assert.equal(await needsApproval("mcp_close_crm_lead_create"), false);

    // Destructive tool: defaults to an "ask" ceiling, so an always_allow
    // grant is IGNORED until an admin explicitly relaxes that tool.
    await McpToolGrant.create({
      workspaceId,
      serverId: server._id,
      userId,
      toolName: "lead_delete",
      decision: "always_allow",
    });
    assert.equal(await needsApproval("mcp_close_crm_lead_delete"), true);

    // Admin relaxes the ceiling for lead_delete: the grant now applies.
    await McpServer.updateOne(
      { _id: server._id },
      { $set: { "toolPolicy.restrictions": { lead_delete: "always" } } },
    );
    chatTools = await loadTools();
    assert.equal(await needsApproval("mcp_close_crm_lead_delete"), false);

    // Admin "ask" restriction caps the user's Always allow on any tool.
    await McpServer.updateOne(
      { _id: server._id },
      {
        $set: {
          "toolPolicy.restrictions": {
            lead_delete: "always",
            lead_create: "ask",
          },
        },
      },
    );
    chatTools = await loadTools();
    assert.equal(await needsApproval("mcp_close_crm_lead_create"), true);

    // Admin "block" removes the tool from the agent entirely.
    await McpServer.updateOne(
      { _id: server._id },
      {
        $set: {
          "toolPolicy.restrictions": {
            lead_delete: "always",
            lead_create: "block",
          },
        },
      },
    );
    chatTools = await loadTools();
    assert.equal(chatTools.tools["mcp_close_crm_lead_create"], undefined);

    // Restore an open ceiling for the remaining assertions.
    await McpServer.updateOne(
      { _id: server._id },
      { $set: { "toolPolicy.restrictions": { lead_delete: "always" } } },
    );
    chatTools = await loadTools();

    // "Always deny": no prompt, and execute refuses without contacting the
    // MCP server.
    await McpToolGrant.updateOne(
      { serverId: server._id, userId, toolName: "lead_create" },
      { $set: { decision: "always_deny" } },
    );
    chatTools = await loadTools();
    assert.equal(await needsApproval("mcp_close_crm_lead_create"), false);
    const createTool = chatTools.tools["mcp_close_crm_lead_create"];
    assert.ok(createTool.execute);
    const denied = (await createTool.execute(
      {},
      { toolCallId: "t", messages: [], experimental_context: undefined },
    )) as { success: boolean; denied?: boolean };
    assert.equal(denied.success, false);
    assert.equal(denied.denied, true);

    // Grants are per-user: a different user still gets prompted.
    const otherUserTools = await buildMcpToolsForChat({
      workspaceId: workspaceId.toString(),
      userId: "user-2",
    });
    const otherCreate = otherUserTools.tools["mcp_close_crm_lead_create"];
    const otherFn = otherCreate.needsApproval;
    assert.equal(
      typeof otherFn === "function"
        ? await otherFn(
            {},
            { toolCallId: "t", messages: [], experimental_context: undefined },
          )
        : otherFn,
      true,
    );

    // User-performer servers without the user's credential are skipped.
    await McpServer.updateOne(
      { _id: server._id },
      { $set: { authPerformer: "user" } },
    );
    const noCred = await buildMcpToolsForChat({
      workspaceId: workspaceId.toString(),
      userId,
    });
    assert.equal(noCred.allToolNames.length, 0);
  } finally {
    await mongoose.disconnect();
    await replSet.stop();
  }
}

async function main() {
  testServerSlugAndPrefix();
  testRiskTiers();
  testAllowlistFiltering();
  testCryptoRoundTrip();
  await testUrlSafety();
  await testGrantsAndNeedsApproval();
  // eslint-disable-next-line no-console
  console.log("✓ mcp-client.service tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
