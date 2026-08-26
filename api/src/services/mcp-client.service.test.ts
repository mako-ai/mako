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
  normalizeMcpToolOutput,
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
import {
  CLOSE_MCP_PRESET,
  CUSTOM_MCP_PRESET,
  GITHUB_MCP_PRESET,
  SLACK_MCP_PRESET,
  getMcpPreset,
  mcpPresetEnvOAuthClient,
  mcpPresetOAuthScope,
} from "../mcp/presets";
import {
  hasMcpOAuthClient,
  mcpOAuthClientSource,
  saveMcpOAuthClient,
  startMcpOAuthFlow,
} from "./mcp-oauth.service";

function testServerSlugAndPrefix() {
  assert.equal(mcpServerSlug("Close CRM"), "close_crm");
  assert.equal(mcpServerSlug("  Wild -- Name!! "), "wild_name");
  assert.equal(mcpServerSlug("!!!"), "server");
  assert.equal(
    mcpPrefixedToolName("Close CRM", "lead_search"),
    "mcp_close_crm_lead_search",
  );

  // Provider constraint: ^[a-zA-Z0-9_-]{1,64}$ — freeform MCP names are
  // sanitized, long names truncated with a deterministic disambiguator.
  const dotted = mcpPrefixedToolName("Close CRM", "leads.search.v2");
  assert.match(dotted, /^[a-zA-Z0-9_-]{1,64}$/);
  const longA = mcpPrefixedToolName(
    "Some Very Long Server Name Here",
    "extremely_long_tool_name_that_goes_on_and_on_forever_variant_alpha",
  );
  const longB = mcpPrefixedToolName(
    "Some Very Long Server Name Here",
    "extremely_long_tool_name_that_goes_on_and_on_forever_variant_beta",
  );
  assert.ok(longA.length <= 64);
  assert.ok(longB.length <= 64);
  assert.match(longA, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.notEqual(longA, longB);
  // Deterministic across calls (continuation requests must rebuild the
  // exact same names or approved calls could not resume).
  assert.equal(
    longA,
    mcpPrefixedToolName(
      "Some Very Long Server Name Here",
      "extremely_long_tool_name_that_goes_on_and_on_forever_variant_alpha",
    ),
  );
}

function testOutputNormalization() {
  // Text blocks are flattened to a plain string.
  assert.equal(
    normalizeMcpToolOutput({
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      isError: false,
    }),
    "line one\nline two",
  );
  // Error results keep an explicit error envelope.
  assert.deepEqual(
    normalizeMcpToolOutput({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }),
    { success: false, error: "boom" },
  );
  // Image blocks are summarized instead of dumping base64 into context.
  const withImage = normalizeMcpToolOutput({
    content: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
  }) as string;
  assert.match(withImage, /image content .*omitted/);
  assert.ok(!withImage.includes("aGk="));
  // Oversized output is truncated with an explicit marker.
  const huge = normalizeMcpToolOutput({
    content: [{ type: "text", text: "x".repeat(50_000) }],
  }) as string;
  assert.ok(huge.length < 20_000);
  assert.match(huge, /truncated \d+ characters/);
  // Non-content-shaped outputs pass through untouched.
  assert.deepEqual(normalizeMcpToolOutput({ plain: true }), { plain: true });
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

function testPresetsAndOAuthScopes() {
  // Registry lookups: known presets resolve, unknown types fall back to
  // custom (any Streamable-HTTP server).
  assert.equal(getMcpPreset("close"), CLOSE_MCP_PRESET);
  assert.equal(getMcpPreset("slack"), SLACK_MCP_PRESET);
  assert.equal(getMcpPreset("github"), GITHUB_MCP_PRESET);
  assert.equal(getMcpPreset("nope"), CUSTOM_MCP_PRESET);

  // GitHub: official hosted endpoint, OAuth (manual pre-registered app —
  // GitHub has no DCR) or a personal access token whose "Bearer " prefix is
  // applied server-side. Read-only is enforced by the X-MCP-Readonly header
  // (empty values for write scopes = header omitted), not OAuth scopes.
  assert.equal(GITHUB_MCP_PRESET.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(GITHUB_MCP_PRESET.urlEditable, false);
  assert.deepEqual(GITHUB_MCP_PRESET.authOptions, ["oauth", "api_key"]);
  assert.equal(GITHUB_MCP_PRESET.oauth?.clientMode, "manual");
  const patField = GITHUB_MCP_PRESET.headerFields.find(
    f => f.name === "Authorization",
  );
  assert.equal(patField?.valuePrefix, "Bearer ");
  assert.equal(GITHUB_MCP_PRESET.scopeHeader?.name, "X-MCP-Readonly");
  assert.equal(GITHUB_MCP_PRESET.scopeHeader?.scopeValues.read, "true");
  assert.equal(GITHUB_MCP_PRESET.scopeHeader?.scopeValues.write_safe, "");
  assert.equal(
    GITHUB_MCP_PRESET.scopeHeader?.scopeValues.write_destructive,
    "",
  );
  assert.equal(mcpPresetOAuthScope(GITHUB_MCP_PRESET, "read"), undefined);

  // Slack: official hosted endpoint, OAuth-only, manual (pre-registered
  // confidential app) client mode — Slack does not support DCR.
  assert.equal(SLACK_MCP_PRESET.url, "https://mcp.slack.com/mcp");
  assert.equal(SLACK_MCP_PRESET.urlEditable, false);
  assert.deepEqual(SLACK_MCP_PRESET.authOptions, ["oauth"]);
  assert.equal(SLACK_MCP_PRESET.oauth?.clientMode, "manual");

  // Least-privilege scope sets: read never holds write scopes; each tier is
  // a superset of the previous one.
  const readScope = mcpPresetOAuthScope(SLACK_MCP_PRESET, "read");
  const safeScope = mcpPresetOAuthScope(SLACK_MCP_PRESET, "write_safe");
  const destructiveScope = mcpPresetOAuthScope(
    SLACK_MCP_PRESET,
    "write_destructive",
  );
  assert.ok(readScope && safeScope && destructiveScope);
  assert.ok(readScope.includes("search:read.public"));
  assert.ok(!readScope.includes("chat:write"));
  assert.ok(safeScope.includes("chat:write"));
  assert.ok(!safeScope.includes("channels:write"));
  assert.ok(destructiveScope.includes("channels:write"));
  const asSet = (s: string) => new Set(s.split(" "));
  for (const scope of asSet(readScope)) {
    assert.ok(asSet(safeScope).has(scope), `write_safe missing ${scope}`);
  }
  for (const scope of asSet(safeScope)) {
    assert.ok(
      asSet(destructiveScope).has(scope),
      `write_destructive missing ${scope}`,
    );
  }

  // Close scopes via the Close-Scope header, not OAuth scopes — the SDK
  // falls back to the provider's advertised scopes_supported.
  assert.equal(mcpPresetOAuthScope(CLOSE_MCP_PRESET, "read"), undefined);
  assert.equal(mcpPresetOAuthScope(CUSTOM_MCP_PRESET, "read"), undefined);
}

/**
 * Deployment-wide OAuth client from env (Claude-connectors model): with
 * SLACK_MCP_CLIENT_ID/SECRET set, workspaces need no per-workspace app —
 * connect is one click. Workspace-saved clients still take precedence.
 */
function testEnvOAuthClient() {
  const slackServer = (oauth?: { clientInformation?: string }) =>
    ({ connectorType: "slack", oauth }) as Parameters<
      typeof mcpOAuthClientSource
    >[0];

  delete process.env.SLACK_MCP_CLIENT_ID;
  delete process.env.SLACK_MCP_CLIENT_SECRET;
  assert.equal(mcpPresetEnvOAuthClient(SLACK_MCP_PRESET), undefined);
  assert.equal(mcpOAuthClientSource(slackServer()), null);

  process.env.SLACK_MCP_CLIENT_ID = "env-client-id";
  process.env.SLACK_MCP_CLIENT_SECRET = "env-client-secret";
  try {
    assert.deepEqual(mcpPresetEnvOAuthClient(SLACK_MCP_PRESET), {
      client_id: "env-client-id",
      client_secret: "env-client-secret",
    });
    // No workspace client → the env client is the effective source.
    assert.equal(mcpOAuthClientSource(slackServer()), "environment");
    // A workspace-saved client overrides the shared env app.
    assert.equal(
      mcpOAuthClientSource(slackServer({ clientInformation: "encrypted…" })),
      "workspace",
    );
    // Presets without clientEnvVars are unaffected.
    assert.equal(mcpPresetEnvOAuthClient(CLOSE_MCP_PRESET), undefined);
    assert.equal(
      mcpOAuthClientSource({ connectorType: "close" } as Parameters<
        typeof mcpOAuthClientSource
      >[0]),
      null,
    );
  } finally {
    delete process.env.SLACK_MCP_CLIENT_ID;
    delete process.env.SLACK_MCP_CLIENT_SECRET;
  }
}

/**
 * Manual OAuth client registration (Slack model), against in-memory Mongo:
 * connect is blocked with a setup message until an admin saves the app,
 * saving stores the client encrypted (retrievable), and re-saving clears
 * previously issued tokens (they belonged to the old client).
 */
async function testManualOAuthClient() {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
  });
  await mongoose.connect(replSet.getUri("mako-test-oauth"));

  try {
    const workspaceId = new Types.ObjectId();
    const server = await McpServer.create({
      workspaceId,
      name: "Slack",
      connectorType: "slack",
      transport: { type: "http", url: "https://mcp.slack.com/mcp" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "read",
      status: "awaiting_auth",
      createdBy: "user-1",
    });

    // No app saved and no env client → the flow refuses with an actionable
    // message instead of attempting DCR (which Slack rejects).
    delete process.env.SLACK_MCP_CLIENT_ID;
    delete process.env.SLACK_MCP_CLIENT_SECRET;
    assert.equal(await hasMcpOAuthClient(server), false);
    await assert.rejects(
      () =>
        startMcpOAuthFlow({
          server,
          configUserId: "user-1",
          startedByUserId: "user-1",
        }),
      /pre-registered OAuth app/,
    );

    // A deployment-wide env client unblocks connect without any saved app.
    process.env.SLACK_MCP_CLIENT_ID = "env-client-id";
    try {
      assert.equal(await hasMcpOAuthClient(server), true);
    } finally {
      delete process.env.SLACK_MCP_CLIENT_ID;
    }
    assert.equal(await hasMcpOAuthClient(server), false);

    // Simulate a stale token from a previous app registration.
    await McpConnectionConfig.create({
      workspaceId,
      serverId: server._id,
      userId: "user-1",
      headers: {},
      oauthTokens: encryptString(
        JSON.stringify({ access_token: "old", token_type: "Bearer" }),
      ),
      oauthExpiresAt: Date.now() + 60_000,
    });

    await saveMcpOAuthClient({
      server,
      clientId: "1234.5678",
      clientSecret: "shhh",
    });
    assert.equal(await hasMcpOAuthClient(server), true);

    // Stored encrypted, decrypts back to the exact client information.
    const saved = await McpServer.findById(server._id).select("oauth").lean();
    const encrypted = saved?.oauth?.clientInformation;
    assert.ok(encrypted);
    assert.ok(!encrypted.includes("shhh"));
    assert.deepEqual(JSON.parse(decryptString(encrypted)), {
      client_id: "1234.5678",
      client_secret: "shhh",
    });

    // Old tokens were invalidated — members must reconnect.
    const config = await McpConnectionConfig.findOne({
      serverId: server._id,
      userId: "user-1",
    }).lean();
    assert.equal(config?.oauthTokens, undefined);
    assert.equal(config?.oauthExpiresAt, undefined);
  } finally {
    await mongoose.disconnect();
    await replSet.stop();
  }
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

    // A tool captured earlier in the turn must not execute after the server is
    // disconnected or removed from availability.
    await McpServer.updateOne(
      { _id: server._id },
      { $set: { status: "error" } },
    );
    const staleReadTool = chatTools.tools["mcp_close_crm_lead_search"];
    assert.ok(staleReadTool.execute);
    const disconnected = (await staleReadTool.execute(
      {},
      { toolCallId: "t", messages: [], experimental_context: undefined },
    )) as { success: boolean; error?: string };
    assert.equal(disconnected.success, false);
    assert.match(disconnected.error ?? "", /no longer connected/i);
    await McpServer.updateOne(
      { _id: server._id },
      { $set: { status: "connected" } },
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
  testOutputNormalization();
  testRiskTiers();
  testAllowlistFiltering();
  testCryptoRoundTrip();
  testPresetsAndOAuthScopes();
  testEnvOAuthClient();
  await testUrlSafety();
  await testGrantsAndNeedsApproval();
  await testManualOAuthClient();
  // eslint-disable-next-line no-console
  console.log("✓ mcp-client.service tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
