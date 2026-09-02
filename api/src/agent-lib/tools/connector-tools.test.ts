/**
 * Connectors (code) and connections (credentials), as an agent sees them.
 *
 * VOCABULARY — `list_connections` returns both kinds with `kind` and
 * `connector` on every row; `list_connectors` is the catalog of code and
 * links each connector to the connections configured with it;
 * `inspect_connection` describes one configured credential of either kind;
 * `inspect_connector` describes a type, and still answers an old caller that
 * hands it a connection id, telling it what to call instead.
 *
 * WIRING — `probe_connection` is registered by the in-product agent,
 * classified in the bridge policy, present in the inventory the policy tests
 * walk, deferred (loaded on demand) rather than in every prompt, and
 * read-only for the plan gate.
 *
 * GATING — the probe reads data from a platform outside the workspace, so it
 * is hidden from an MCP credential without query access, exactly like
 * `sql_execute_query`; discovery stays visible.
 *
 * EDGE — the probe tool never throws: a caller mistake comes back as
 * `{ error, code }` and an invalid `since` is refused before the service is
 * called. The service is mocked here; its own promises are pinned in
 * `connectors/probe.service.test.ts`.
 *
 * Real Mongo (mongodb-memory-server) for the listing and inspection tools;
 * no credential is ever seeded in plaintext, and the assertion that none
 * comes back is made against the serialized results.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  next: null as unknown,
}));

vi.mock("../../connectors/probe.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../connectors/probe.service")>();
  return {
    ...actual,
    probeConnection: vi.fn(async (input: unknown) => {
      state.calls.push(input);
      if (state.next instanceof Error) throw state.next;
      return state.next;
    }),
  };
});

import { ProbeError } from "../../connectors/probe.service";
import {
  Connector as SourceConnection,
  DatabaseConnection,
} from "../../database/workspace-schema";
import { encryptString } from "../../services/crypto.service";
import { createConnectorTools } from "./connector-tools";
import { createUniversalTools } from "./universal-tools";
import { buildMakoMcpToolset } from "../../mcp/mako-mcp-server";
import {
  MCP_BRIDGE_POLICY,
  assertBridgePolicyCovers,
  assertBridgePolicyNotStale,
  mcpExposedToolNames,
  mcpOpenWorldHint,
  mcpReadOnlyHint,
} from "../../mcp/bridge-policy";
import { collectLiveAgentToolNames } from "../../mcp/bridge-inventory";
import { DEFERRED_BUILTIN_TOOL_NAMES } from "../../agents/modes/registry";
import { unifiedAgentFactory } from "../../agents/unified";
import { READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";
import type { AgentContext } from "../../agents/types";

const SECRET = "sk_live_do_not_leak_0123456789";
let mongo: MongoMemoryServer;
let WS: string;
let STRIPE: Types.ObjectId;
let WAREHOUSE: Types.ObjectId;

type Executable = {
  execute: (input: unknown) => Promise<Record<string, unknown>>;
};

function toolsetFor(scopes: string[]): Record<string, unknown> {
  return buildMakoMcpToolset({
    workspaceId: WS,
    scopes,
  } as Parameters<typeof buildMakoMcpToolset>[0]);
}

const tools = () =>
  createConnectorTools(WS) as unknown as Record<string, Executable>;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    SourceConnection.deleteMany({}),
    DatabaseConnection.deleteMany({}),
  ]);
  WS = new Types.ObjectId().toString();
  STRIPE = new Types.ObjectId();
  WAREHOUSE = new Types.ObjectId();
  await SourceConnection.create({
    _id: STRIPE,
    workspaceId: new Types.ObjectId(WS),
    name: "fr_stripe",
    type: "stripe",
    config: { api_key: encryptString(SECRET) },
    isActive: true,
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: "u1",
  });
  await DatabaseConnection.create({
    _id: WAREHOUSE,
    workspaceId: new Types.ObjectId(WS),
    name: "bigquery",
    type: "bigquery",
    connection: { project_id: "realadvisor-prod", keyFilename: "k" },
    createdBy: "u1",
  });
  // A stranger's connection: must never show up in this workspace's answers.
  await SourceConnection.create({
    workspaceId: new Types.ObjectId(),
    name: "theirs",
    type: "close",
    config: { api_key: encryptString("theirs_" + SECRET) },
    isActive: true,
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: "u2",
  });
  state.calls = [];
  state.next = {
    connection: {
      id: STRIPE.toString(),
      name: "fr_stripe",
      connector: "stripe",
    },
    check: { success: true, message: "ok" },
    durationMs: 1,
  };
});

describe("vocabulary: connectors are code, connections are credentials", () => {
  it("list_connections returns both kinds, each saying which tool it belongs to", async () => {
    const { list_connections } = createUniversalTools(
      WS,
      [],
    ) as unknown as Record<string, Executable>;
    const all = (await list_connections.execute({})) as unknown as Array<
      Record<string, unknown>
    >;
    expect(all.map(r => [r.name, r.kind, r.connector, r.queryable])).toEqual([
      ["bigquery", "database", "bigquery", true],
      ["fr_stripe", "source", "stripe", false],
    ]);
    expect(JSON.stringify(all)).not.toContain(SECRET);

    const sources = (await list_connections.execute({
      kind: "source",
    })) as unknown as Array<Record<string, unknown>>;
    expect(sources.map(r => r.id)).toEqual([STRIPE.toString()]);

    const databases = (await list_connections.execute({
      kind: "database",
    })) as unknown as Array<Record<string, unknown>>;
    expect(databases.map(r => r.id)).toEqual([WAREHOUSE.toString()]);
  });

  it("list_connectors is the catalog, and links each connector to its connections", async () => {
    const result = (await tools().list_connectors.execute({})) as {
      connectors: Array<Record<string, unknown>>;
    };
    const stripe = result.connectors.find(c => c.connector === "stripe");
    expect(stripe).toBeTruthy();
    expect(stripe?.source).toBe("builtin");
    expect(stripe?.entities).toContain("customers");
    expect(stripe?.connections).toEqual([
      { id: STRIPE.toString(), name: "fr_stripe", active: true },
    ]);
    // Configured elsewhere, so unconfigured here — and the stranger's row
    // is not attached to it.
    const close = result.connectors.find(c => c.connector === "close");
    expect(close?.connections).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("inspect_connector describes a type; inspect_connection describes a credential", async () => {
    const type = await tools().inspect_connector.execute({
      connector: "stripe",
    });
    expect(type.connector).toBe("stripe");
    expect(type.entities).toContain("customers");
    const fields = type.configFields as Array<{
      name: string;
      secret: boolean;
    }>;
    expect(fields.some(f => f.name === "api_key" && f.secret)).toBe(true);

    const source = await tools().inspect_connection.execute({
      connectionId: STRIPE.toString(),
    });
    expect(source.kind).toBe("source");
    expect(source.connector).toBe("stripe");
    expect(source.entities).toContain("customers");
    expect(JSON.stringify(source)).not.toContain(SECRET);

    const database = await tools().inspect_connection.execute({
      connectionId: WAREHOUSE.toString(),
    });
    expect(database.kind).toBe("database");
    expect(database.connector).toBe("bigquery");
    expect(database.project).toBe("realadvisor-prod");
    expect(database.allowAgentWrites).toBe(false);
  });

  it("inspect_connector still answers an old caller holding a connection id, and says what to call", async () => {
    const legacy = await tools().inspect_connector.execute({
      connectorId: STRIPE.toString(),
    });
    expect(legacy.kind).toBe("source");
    expect(legacy.id).toBe(STRIPE.toString());
    expect(String(legacy.deprecated)).toMatch(/inspect_connection/);

    const unknown = await tools().inspect_connector.execute({
      connector: "salesforce",
    });
    expect(String(unknown.error)).toMatch(/No connector "salesforce"/);
  });

  it("another workspace's connection is not found, by any tool", async () => {
    const theirs = await SourceConnection.findOne({ name: "theirs" }).lean();
    const id = String(theirs?._id);
    expect(
      String(
        (await tools().inspect_connection.execute({ connectionId: id })).error,
      ),
    ).toMatch(/not found/);
    expect(
      String(
        (await tools().inspect_connector.execute({ connectorId: id })).error,
      ),
    ).toMatch(/not found/);
  });
});

describe("wiring: registered, classified, deferred, read-only", () => {
  it("is classified everywhere a built-in tool must be", () => {
    const entry = MCP_BRIDGE_POLICY.probe_connection;
    expect(entry?.status).toBe("bridge");
    expect(
      entry && "requiresQueryAccess" in entry && entry.requiresQueryAccess,
    ).toBe(true);
    expect(mcpOpenWorldHint("probe_connection")).toBe(true);
    expect(mcpExposedToolNames()).toContain("probe_connection");
    assertBridgePolicyCovers(collectLiveAgentToolNames());
    assertBridgePolicyNotStale(collectLiveAgentToolNames());
    for (const name of [
      "list_connectors",
      "inspect_connector",
      "inspect_connection",
      "probe_connection",
    ]) {
      expect(collectLiveAgentToolNames()).toContain(name);
      expect(DEFERRED_BUILTIN_TOOL_NAMES).toContain(name);
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(true);
      expect(mcpReadOnlyHint(name, "read")).toBe(true);
    }
    // The old name is gone, not aliased: it never shipped.
    expect(MCP_BRIDGE_POLICY.probe_connector).toBeUndefined();
  });

  it("is registered by the in-product agent factory, with its discovery family", () => {
    const registered = unifiedAgentFactory({
      workspaceId: WS,
      userId: "u1",
      consoles: [],
    } as unknown as AgentContext).tools;
    const names = Object.keys(registered);
    for (const name of [
      "list_connectors",
      "inspect_connector",
      "inspect_connection",
      "probe_connection",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("exposes exactly the four connector/connection tools from its factory", () => {
    expect(Object.keys(createConnectorTools(WS)).sort()).toEqual([
      "inspect_connection",
      "inspect_connector",
      "list_connectors",
      "probe_connection",
    ]);
  });
});

describe("gating: a live read needs query access", () => {
  it("is hidden from a key without query:read while discovery stays", () => {
    const without = toolsetFor(["mcp"]);
    expect(without.list_connectors).toBeTruthy();
    expect(without.inspect_connector).toBeTruthy();
    expect(without.inspect_connection).toBeTruthy();
    expect(without.probe_connection).toBeUndefined();

    const withRead = toolsetFor(["mcp", "query:read"]);
    expect(withRead.probe_connection).toBeTruthy();
  });
});

describe("edge: the probe tool never throws", () => {
  const exposed = () =>
    toolsetFor(["mcp", "query:read"]).probe_connection as Executable;

  it("hands a valid call to the service with the workspace bound", async () => {
    const result = await exposed().execute({
      connectionId: STRIPE.toString(),
      entity: "customers",
      limit: 5,
      fields: ["id"],
      since: "2026-08-01T00:00:00Z",
    });
    expect(result.check).toEqual({ success: true, message: "ok" });
    expect(state.calls).toEqual([
      {
        workspaceId: WS,
        connectionId: STRIPE.toString(),
        entity: "customers",
        limit: 5,
        fields: ["id"],
        since: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
  });

  it("refuses an unparseable `since` before calling the service", async () => {
    const result = await exposed().execute({
      connectionId: STRIPE.toString(),
      since: "last tuesday",
    });
    expect(result.error).toMatch(/not a valid ISO 8601/);
    expect(state.calls).toEqual([]);
  });

  it("returns a ProbeError as { error, code }", async () => {
    state.next = new ProbeError("unknown_entity", "no such entity");
    const result = await exposed().execute({
      connectionId: STRIPE.toString(),
      entity: "nope",
    });
    expect(result).toEqual({ error: "no such entity", code: "unknown_entity" });
  });

  it("wraps any other failure without a code", async () => {
    state.next = new Error("boom");
    const result = await exposed().execute({
      connectionId: STRIPE.toString(),
    });
    expect(result).toEqual({ error: "Probe failed: boom" });
  });
});
