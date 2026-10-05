/**
 * `create_source_connection` / `update_source_connection`: a credential goes
 * in over MCP and never comes back out.
 *
 * GATING — hidden from any credential without `sources:write`; hidden (with
 * a reason) below the admin role; and, because a key outlives the membership
 * that justified it, refused at CALL time when the acting user's live role is
 * no longer owner/admin — even when the session still believes it is.
 *
 * SECRETS — a sentinel API key is passed in, and every surface it could leak
 * through is checked: the tool result, a validation error that names the
 * field, a vendor error thrown by the credential check, and the raw JSON-RPC
 * response of the MCP server. In Mongo it is ciphertext that decrypts back.
 *
 * UPDATE — a patch that omits a secret (or echoes `__mako_secret_kept__`)
 * keeps the stored one; a new value rotates it.
 *
 * Real Mongo (mongodb-memory-server) and the real Stripe connector schema;
 * the live credential check and the workspace role lookup are mocked.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const state = vi.hoisted(() => ({
  role: "admin" as string | null,
  probeCalls: [] as unknown[],
  probeNext: null as unknown,
}));

vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasRole: vi.fn(
      async (_ws: string, _user: string, roles: string[]) =>
        state.role !== null && roles.includes(state.role),
    ),
    getMember: vi.fn(async () => (state.role ? { role: state.role } : null)),
  },
}));

vi.mock("../../connectors/probe.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connectors/probe.service")>();
  return {
    ...actual,
    probeConnection: vi.fn(async (input: unknown) => {
      state.probeCalls.push(input);
      if (state.probeNext instanceof Error) throw state.probeNext;
      return state.probeNext;
    }),
  };
});

import { Connector as SourceConnection } from "../../database/workspace-schema";
import { connectorRegistry } from "../../connectors/registry";
import { decryptString, isEncryptedValue } from "../../services/crypto.service";
import { SECRET_KEPT } from "../../utils/connection-secrets";
import {
  buildMakoMcpServer,
  buildMakoMcpToolset,
} from "../../mcp/mako-mcp-server";
import { StatelessMcpTransport } from "../../mcp/stateless-transport";
import { mcpReadOnlyHint } from "../../mcp/bridge-policy";
import {
  capabilityGrantsFromScopes,
  type WorkspaceApiKeyScope,
} from "../../auth/api-key-scopes";
import { createSourceConnectionTools } from "./source-connection-tools";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import {
  containsSecretSentinel,
  mergeSourceConnectionConfig,
} from "../../services/source-connection.service";

const SENTINEL = "sk_live_SENTINEL_never_echo_0123456789";
const ROTATED = "sk_live_ROTATED_never_echo_9876543210";
const USER = "user-1";
let mongo: MongoMemoryServer;
let WS: string;

type Executable = {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
};

const tools = () =>
  createSourceConnectionTools(WS, USER) as unknown as Record<
    string,
    Executable
  >;

function toolsetFor(
  scopes: WorkspaceApiKeyScope[],
  memberRole = "admin",
): Record<string, Executable> {
  return buildMakoMcpToolset({
    workspaceId: WS,
    userId: USER,
    memberRole,
    scopes,
  }) as unknown as Record<string, Executable>;
}

async function callOverMcp(
  name: string,
  args: Record<string, unknown>,
  scopes: WorkspaceApiKeyScope[],
  memberRole = "admin",
): Promise<string> {
  const server = buildMakoMcpServer({
    workspaceId: WS,
    userId: USER,
    memberRole,
    scopes,
  });
  const transport = new StatelessMcpTransport();
  await server.connect(transport);
  try {
    const responses = await transport.handle(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
      ] as unknown as JSONRPCMessage[],
      20_000,
    );
    return JSON.stringify(responses);
  } finally {
    await server.close();
  }
}

const WRITE_TOOLS = ["create_source_connection", "update_source_connection"];
const WITH_SOURCES: WorkspaceApiKeyScope[] = [
  "mcp",
  "query:read",
  "sources:write",
];

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await connectorRegistry.ready();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await SourceConnection.deleteMany({});
  WS = new Types.ObjectId().toString();
  state.role = "admin";
  state.probeCalls = [];
  state.probeNext = {
    connection: { id: "x", name: "x", connector: "stripe" },
    check: { success: true, message: "Connected" },
    durationMs: 1,
  };
});

async function storedConfig(id: string): Promise<Record<string, unknown>> {
  const row = await SourceConnection.findById(id).lean();
  return (row?.config ?? {}) as Record<string, unknown>;
}

describe("scope: sources:write maps to the sources-write grant only", () => {
  it("is opt-in and maps to exactly one grant", () => {
    expect(capabilityGrantsFromScopes(["mcp", "query:read"])).toEqual([]);
    expect(capabilityGrantsFromScopes(["mcp", "sources:write"])).toEqual([
      "sources-write",
    ]);
  });
});

describe("gating", () => {
  it("hides the write tools from a credential without sources:write", () => {
    const toolset = toolsetFor(["mcp", "query:read"]);
    for (const name of WRITE_TOOLS) expect(toolset[name]).toBeUndefined();
    // Discovery stays.
    expect(toolset.inspect_connector).toBeTruthy();
  });

  it("exposes them with sources:write to an owner or admin", () => {
    for (const role of ["admin", "owner"]) {
      const toolset = toolsetFor(WITH_SOURCES, role);
      for (const name of WRITE_TOOLS) expect(toolset[name]).toBeTruthy();
    }
    expect(mcpReadOnlyHint("create_source_connection", "read")).toBe(false);
  });

  it("hides them below admin even with the scope, and says why", async () => {
    const toolset = toolsetFor(WITH_SOURCES, "member");
    for (const name of WRITE_TOOLS) expect(toolset[name]).toBeUndefined();
    const report = (await toolset.get_mcp_capabilities.execute({})) as {
      unavailableTools: Array<{ name: string; requiredWorkspaceRole?: string }>;
    };
    expect(
      report.unavailableTools.find(t => t.name === "create_source_connection")
        ?.requiredWorkspaceRole,
    ).toBe("admin");
  });

  it("is never swept into the blanket Desktop ACP grant set", async () => {
    const desktop = buildMakoMcpToolset({
      workspaceId: WS,
      userId: USER,
      memberRole: "owner",
      scopes: ["mcp", "query:read"],
      acpDesktop: true,
      capabilityGrants: ["sources-write"],
    }) as unknown as Record<string, Executable>;
    for (const name of WRITE_TOOLS) expect(desktop[name]).toBeUndefined();
    const report = (await desktop.get_mcp_capabilities.execute({})) as {
      grants: string[];
    };
    expect(report.grants).not.toContain("sources-write");
    expect(report.grants).not.toContain("members-write");
  });

  it("a call without the scope is refused as an unknown tool", async () => {
    const text = await callOverMcp(
      "create_source_connection",
      { connector: "stripe", name: "x", config: { api_key: SENTINEL } },
      ["mcp", "query:read"],
    );
    expect(text).toMatch(/Unknown tool/);
    expect(text).not.toContain(SENTINEL);
    expect(await SourceConnection.countDocuments({})).toBe(0);
  });

  it("refuses at CALL time when the live role is no longer admin, scope notwithstanding", async () => {
    // The session was resolved as admin; membership changed since.
    state.role = "member";
    const text = await callOverMcp(
      "create_source_connection",
      { connector: "stripe", name: "x", config: { api_key: SENTINEL } },
      WITH_SOURCES,
      "admin",
    );
    expect(text).toMatch(/owner or admin/);
    expect(text).not.toContain(SENTINEL);
    expect(await SourceConnection.countDocuments({})).toBe(0);

    state.role = null; // removed from the workspace entirely
    const direct = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_key: SENTINEL },
    });
    expect(String(direct.error)).toMatch(/owner or admin/);
    expect(await SourceConnection.countDocuments({})).toBe(0);
  });

  it("refuses a credential with no acting user", async () => {
    const anonymous = createSourceConnectionTools(WS) as unknown as Record<
      string,
      Executable
    >;
    const result = await anonymous.create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_key: SENTINEL },
    });
    expect(String(result.error)).toMatch(/no acting user/);
  });
});

describe("create_source_connection: write-only credentials", () => {
  it("stores the secret encrypted and never returns it", async () => {
    const result = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "fr_stripe",
      config: { api_key: SENTINEL },
    });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(result.connector).toBe("stripe");
    expect(result.check).toEqual({ success: true, message: "Connected" });
    expect(result.configFields).toEqual(
      expect.arrayContaining([{ name: "api_key", secret: true, set: true }]),
    );

    const id = String(result.id);
    const stored = await storedConfig(id);
    expect(isEncryptedValue(String(stored.api_key))).toBe(true);
    expect(decryptString(String(stored.api_key))).toBe(SENTINEL);
    const row = await SourceConnection.findById(id).lean();
    expect(row?.createdBy).toBe(USER);
    expect(String(row?.workspaceId)).toBe(WS);
    // The check ran against the saved connection, check-only (no entity).
    expect(state.probeCalls).toEqual([{ workspaceId: WS, connectionId: id }]);
  });

  it("never echoes the secret through the MCP JSON-RPC response", async () => {
    const text = await callOverMcp(
      "create_source_connection",
      { connector: "stripe", name: "fr_stripe", config: { api_key: SENTINEL } },
      WITH_SOURCES,
    );
    expect(text).toContain("fr_stripe");
    expect(text).not.toContain(SENTINEL);
  });

  it("scrubs the secret out of a failing credential check", async () => {
    state.probeNext = new Error(`Invalid API Key provided: ${SENTINEL}`);
    const result = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "fr_stripe",
      config: { api_key: SENTINEL },
    });
    expect(result.id).toBeTruthy();
    expect((result.check as { success: boolean }).success).toBe(false);
    expect(JSON.stringify(result)).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("validates against the connector's schema, naming fields, never values", async () => {
    const unknown = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_key: SENTINEL, apiKey: SENTINEL },
    });
    expect(String(unknown.error)).toMatch(/Unknown config field\(s\): apiKey/);
    expect(JSON.stringify(unknown)).not.toContain(SENTINEL);

    const missing = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_base_url: "https://api.stripe.com" },
    });
    expect(String(missing.error)).toMatch(
      /Missing required config field: api_key/,
    );

    const wrongType = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_key: 12345678 },
    });
    expect(String(wrongType.error)).toMatch(
      /api_key is a secret and must be a string/,
    );

    const kept = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_key: SECRET_KEPT },
    });
    expect(String(kept.error)).toMatch(/has none to keep/);

    const badType = await tools().create_source_connection.execute({
      connector: "salesforce_nope",
      name: "x",
      config: { api_key: SENTINEL },
    });
    expect(String(badType.error)).toMatch(/Unsupported source type/);
    expect(JSON.stringify(badType)).not.toContain(SENTINEL);

    expect(await SourceConnection.countDocuments({})).toBe(0);
    expect(state.probeCalls).toEqual([]);
  });

  it("skips the check when asked", async () => {
    const result = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "x",
      config: { api_key: SENTINEL },
      check: false,
    });
    expect(result.id).toBeTruthy();
    expect(result.check).toBeUndefined();
    expect(state.probeCalls).toEqual([]);
  });
});

describe("update_source_connection: a patch, secrets kept unless replaced", () => {
  async function seed(): Promise<string> {
    const created = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "fr_stripe",
      config: { api_key: SENTINEL, api_base_url: "https://api.stripe.com" },
      check: false,
    });
    return String(created.id);
  }

  it("keeps an omitted secret", async () => {
    const id = await seed();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { api_base_url: "https://eu.stripe.example" },
      check: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.updated).toBe(true);
    expect(result.updatedFields).toEqual(["api_base_url"]);
    const stored = await storedConfig(id);
    expect(decryptString(String(stored.api_key))).toBe(SENTINEL);
    expect(stored.api_base_url).toBe("https://eu.stripe.example");
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("keeps a secret echoed as __mako_secret_kept__", async () => {
    const id = await seed();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { api_key: SECRET_KEPT },
      check: false,
    });
    expect(result.updated).toBe(false);
    const stored = await storedConfig(id);
    expect(decryptString(String(stored.api_key))).toBe(SENTINEL);
  });

  it("rotates a secret that is replaced, without echoing either value", async () => {
    const id = await seed();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { api_key: ROTATED },
    });
    expect(result.updated).toBe(true);
    expect(result.updatedFields).toEqual(["api_key"]);
    const stored = await storedConfig(id);
    expect(isEncryptedValue(String(stored.api_key))).toBe(true);
    expect(decryptString(String(stored.api_key))).toBe(ROTATED);
    const text = JSON.stringify(result);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain(ROTATED);
    expect(state.probeCalls).toEqual([{ workspaceId: WS, connectionId: id }]);
  });

  it("refuses to clear a required field and unknown fields", async () => {
    const id = await seed();
    const cleared = await tools().update_source_connection.execute({
      connectionId: id,
      config: { api_key: "" },
      check: false,
    });
    expect(String(cleared.error)).toMatch(
      /Missing required config field: api_key/,
    );
    const unknown = await tools().update_source_connection.execute({
      connectionId: id,
      config: { token: ROTATED },
      check: false,
    });
    expect(String(unknown.error)).toMatch(/Unknown config field\(s\): token/);
    expect(JSON.stringify(unknown)).not.toContain(ROTATED);
    const stored = await storedConfig(id);
    expect(decryptString(String(stored.api_key))).toBe(SENTINEL);
  });

  it("does not reach another workspace's connection", async () => {
    const theirs = await SourceConnection.create({
      workspaceId: new Types.ObjectId(),
      name: "theirs",
      type: "stripe",
      config: { api_key: "x" },
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: "u2",
    });
    const result = await tools().update_source_connection.execute({
      connectionId: theirs._id.toString(),
      config: { api_key: ROTATED },
    });
    expect(String(result.error)).toMatch(/not found/);
    const row = await SourceConnection.findById(theirs._id).lean();
    expect((row?.config as { api_key: string }).api_key).toBe("x");
  });

  it("refuses a non-admin at call time", async () => {
    const id = await seed();
    state.role = "member";
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { api_key: ROTATED },
    });
    expect(String(result.error)).toMatch(/owner or admin/);
    const stored = await storedConfig(id);
    expect(decryptString(String(stored.api_key))).toBe(SENTINEL);
  });
});

describe("the sentinel inside object_array items is never stored", () => {
  const ITEM_SECRET = "tok_item_SENTINEL_never_echo_1234";
  // A connector whose secret lives INSIDE array items (the shape the REST and
  // BigQuery connectors use for their entity/query lists).
  const nestedSchema = {
    fields: [
      { name: "api_key", type: "password", required: true },
      {
        name: "accounts",
        type: "object_array",
        itemFields: [
          { name: "label", type: "string", required: true },
          { name: "token", type: "password" },
        ],
      },
    ],
  };

  let schemaSpy: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    schemaSpy = vi
      .spyOn(syncConnectorRegistry, "getConfigSchemaForType")
      .mockResolvedValue(nestedSchema);
  });
  afterEach(() => schemaSpy?.mockRestore());

  async function storedAccounts(id: string) {
    return (await storedConfig(id)).accounts as Array<Record<string, string>>;
  }

  const T_EU = "stored-token-eu-0001";
  const T_US = "stored-token-us-0002";
  const stored = () => ({
    api_key: "k",
    accounts: [
      { label: "eu", token: T_EU },
      { label: "us", token: T_US },
    ],
  });

  it("merge matches a kept item secret by content, never by position (remove(0))", () => {
    // The edit form removed the first item and saved the rest.
    const merged = mergeSourceConnectionConfig(
      stored(),
      { accounts: [{ label: "us", token: SECRET_KEPT }] },
      nestedSchema,
    );
    expect(merged.unresolved).toEqual([]);
    expect(merged.config.accounts).toEqual([{ label: "us", token: T_US }]);
  });

  it("merge survives a reorder", () => {
    const merged = mergeSourceConnectionConfig(
      stored(),
      {
        accounts: [
          { label: "us", token: SECRET_KEPT },
          { label: "eu", token: SECRET_KEPT },
        ],
      },
      nestedSchema,
    );
    expect(merged.unresolved).toEqual([]);
    expect(merged.config.accounts).toEqual([
      { label: "us", token: T_US },
      { label: "eu", token: T_EU },
    ]);
  });

  it("merge refuses an ambiguous match and a changed item, dropping the sentinel", () => {
    const twins = {
      accounts: [
        { label: "eu", token: T_EU },
        { label: "eu", token: T_US },
      ],
    };
    const ambiguous = mergeSourceConnectionConfig(
      twins,
      { accounts: [{ label: "eu", token: SECRET_KEPT }] },
      nestedSchema,
    );
    expect(ambiguous.unresolved).toEqual(["accounts[0].token"]);
    expect(ambiguous.config.accounts).toEqual([{ label: "eu" }]);
    expect(containsSecretSentinel(ambiguous.config)).toBe(false);

    const renamed = mergeSourceConnectionConfig(
      stored(),
      { accounts: [{ label: "eu-renamed", token: SECRET_KEPT }] },
      nestedSchema,
    );
    expect(renamed.unresolved).toEqual(["accounts[0].token"]);
    expect(containsSecretSentinel(renamed.config)).toBe(false);
  });

  it("merge keeps an OMITTED item secret only on a unique content match", () => {
    const merged = mergeSourceConnectionConfig(
      stored(),
      { accounts: [{ label: "us" }, { label: "new" }] },
      nestedSchema,
    );
    expect(merged.unresolved).toEqual([]);
    expect(merged.config.accounts).toEqual([
      { label: "us", token: T_US },
      { label: "new" },
    ]);
  });

  it("merge reports a top-level sentinel over an empty or absent secret", () => {
    for (const current of [{}, { api_key: "" }]) {
      const merged = mergeSourceConnectionConfig(
        current,
        { api_key: SECRET_KEPT },
        nestedSchema,
      );
      expect(merged.unresolved).toEqual(["api_key"]);
      expect(containsSecretSentinel(merged.config)).toBe(false);
    }
  });

  it("create refuses a sentinel inside an item and stores nothing", async () => {
    const result = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "nested",
      config: {
        api_key: SENTINEL,
        accounts: [{ label: "eu", token: SECRET_KEPT }],
      },
      check: false,
    });
    expect(String(result.error)).toMatch(/has none to keep/);
    expect(await SourceConnection.countDocuments({})).toBe(0);
  });

  it("validation recurses into item fields", async () => {
    const result = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "nested",
      config: {
        api_key: SENTINEL,
        accounts: [{ token: 42, secret_tokn: ITEM_SECRET }],
      },
      check: false,
    });
    const error = String(result.error);
    expect(error).toMatch(
      /Unknown config field\(s\): accounts\[0\]\.secret_tokn/,
    );
    expect(error).toMatch(
      /Missing required config field: accounts\[0\]\.label/,
    );
    expect(error).toMatch(
      /accounts\[0\]\.token is a secret and must be a string/,
    );
    expect(error).not.toContain(ITEM_SECRET);
    expect(await SourceConnection.countDocuments({})).toBe(0);
  });

  async function seedNested(): Promise<string> {
    const created = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "nested",
      config: {
        api_key: SENTINEL,
        accounts: [
          { label: "eu", token: T_EU },
          { label: "us", token: T_US },
        ],
      },
      check: false,
    });
    return String(created.id);
  }

  it("update after remove(0) keeps the remaining item's OWN secret", async () => {
    const id = await seedNested();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { accounts: [{ label: "us", token: SECRET_KEPT }] },
      check: false,
    });
    expect(result.error).toBeUndefined();
    const accounts = await storedAccounts(id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe("us");
    expect(decryptString(accounts[0].token)).toBe(T_US);
    expect(JSON.stringify(await storedConfig(id))).not.toContain(SECRET_KEPT);
  });

  it("update keeps an omitted item secret on a unique match", async () => {
    const id = await seedNested();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: {
        accounts: [{ label: "eu" }, { label: "us", token: ITEM_SECRET }],
      },
      check: false,
    });
    expect(result.error).toBeUndefined();
    const accounts = await storedAccounts(id);
    expect(decryptString(accounts[0].token)).toBe(T_EU);
    expect(decryptString(accounts[1].token)).toBe(ITEM_SECRET);
    expect(JSON.stringify(result)).not.toContain(ITEM_SECRET);
  });

  it("update refuses a sentinel it cannot match, and saves nothing", async () => {
    const id = await seedNested();
    const before = JSON.stringify(await storedConfig(id));
    const renamed = await tools().update_source_connection.execute({
      connectionId: id,
      config: { accounts: [{ label: "eu-renamed", token: SECRET_KEPT }] },
      check: false,
    });
    expect(String(renamed.error)).toMatch(
      /accounts\[0\]\.token has no stored secret to keep/,
    );
    expect(JSON.stringify(await storedConfig(id))).toBe(before);
    expect(JSON.stringify(renamed)).not.toMatch(/stored-token/);
  });

  it("update refuses an omitted secret that is required and has no match", async () => {
    schemaSpy?.mockRestore();
    schemaSpy = vi
      .spyOn(syncConnectorRegistry, "getConfigSchemaForType")
      .mockResolvedValue({
        fields: [
          nestedSchema.fields[0],
          {
            ...nestedSchema.fields[1],
            itemFields: [
              { name: "label", type: "string", required: true },
              { name: "token", type: "password", required: true },
            ],
          },
        ],
      });
    const id = await seedNested();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { accounts: [{ label: "brand-new" }] },
      check: false,
    });
    expect(String(result.error)).toMatch(
      /Missing required config field: accounts\[0\]\.token/,
    );
    expect(await storedAccounts(id)).toHaveLength(2);
  });

  it("update refuses a top-level sentinel over a secret that is not stored", async () => {
    const created = await tools().create_source_connection.execute({
      connector: "stripe",
      name: "nested",
      config: { api_key: SENTINEL },
      check: false,
    });
    const id = String(created.id);
    await SourceConnection.updateOne(
      { _id: id },
      { $set: { "config.api_key": "" } },
    );
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { api_key: SECRET_KEPT },
      check: false,
    });
    expect(String(result.error)).toMatch(/at api_key has no stored secret/);
    expect((await storedConfig(id)).api_key).toBe("");
  });
  it("matches the edit form's shape: empty optional fields and stringified primitives", () => {
    const schema = {
      fields: [
        {
          name: "accounts",
          type: "object_array",
          itemFields: [
            { name: "region", type: "string" },
            { name: "label", type: "string" },
            { name: "enabled", type: "select" },
            { name: "token", type: "password" },
          ],
        },
      ],
    };
    const merged = mergeSourceConnectionConfig(
      { accounts: [{ region: "eu", enabled: true, token: "AAA-stored" }] },
      {
        accounts: [
          { region: "eu", label: "", enabled: "true", token: SECRET_KEPT },
        ],
      },
      schema,
    );
    expect(merged.unresolved).toEqual([]);
    expect(merged.config.accounts).toEqual([
      { region: "eu", label: "", enabled: "true", token: "AAA-stored" },
    ]);
  });

  it("update saves an omitted, unmatched, optional item secret without it — and warns", async () => {
    const id = await seedNested();
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: {
        accounts: [{ label: "eu", token: SECRET_KEPT }, { label: "brand-new" }],
      },
      check: false,
    });
    expect(result.error).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringMatching(/^accounts\[1\]\.token: no value sent/),
    ]);
    const accounts = await storedAccounts(id);
    expect(decryptString(accounts[0].token)).toBe(T_EU);
    expect(accounts[1]).toEqual({ label: "brand-new" });
  });

  it("update error messages keep the sentinel and field paths intact", async () => {
    const id = await seedNested();
    // A non-secret value ("accounts") equal to a word of the path: only
    // secret VALUES are scrubbed, never the sentinel or a non-secret value.
    const result = await tools().update_source_connection.execute({
      connectionId: id,
      config: { accounts: [{ label: "accounts", token: SECRET_KEPT }] },
      check: false,
    });
    expect(String(result.error)).toContain(
      `${SECRET_KEPT} at accounts[0].token has no stored secret to keep`,
    );
    expect(String(result.error)).not.toContain("[redacted]");
  });
});
