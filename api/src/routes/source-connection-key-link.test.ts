/**
 * Key links: an agent creates a source connection without its key, and the
 * user pastes the key into Mako through a one-time link.
 *
 * Pins, end to end on real Mongo (mongodb-memory-server):
 *   - create_connection with the secret left out stores the connection
 *     inactive, without the secret, with only the token's HASH, and returns
 *     the link; inspect_connection reports `awaiting_key`, then `ready`;
 *   - the link's routes answer only a signed-in member (not a viewer, not an
 *     API key), and only for the fields the request names;
 *   - the key is stored encrypted, the link works once, and an expired link
 *     is refused;
 *   - a key that fails the connector's check is taken back out and the same
 *     link works for the corrected key.
 *
 * Only auth, the workspace service, the connector registries and the probe
 * are mocked.
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
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const ctx = vi.hoisted(() => ({
  role: "member" as string | null,
  authType: "session" as string,
  probe: { success: true, message: "ok" } as {
    success: boolean;
    message?: string;
  },
}));

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    c.set("authType", ctx.authType);
    await next();
  },
}));

vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => ctx.role !== null),
    getMember: vi.fn(async () => (ctx.role ? { role: ctx.role } : null)),
    getOwnerIds: vi.fn(async () => []),
    isAdmin: vi.fn(async () => ctx.role === "owner" || ctx.role === "admin"),
  },
}));

vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async () => ({
      fields: [
        {
          name: "api_key",
          label: "API key",
          type: "password",
          required: true,
        },
        { name: "account", type: "string" },
      ],
    })),
    getConnectorFor: vi.fn(async () => null),
  },
}));

vi.mock("../connectors/registry", () => ({
  connectorRegistry: {
    hasConnector: () => true,
    ready: async () => {},
  },
}));

vi.mock("../connectors/probe.service", async importOriginal => ({
  ...(await importOriginal<typeof import("../connectors/probe.service")>()),
  probeConnection: vi.fn(async () => ({ check: ctx.probe })),
}));

import { sourceConnectionRoutes } from "./source-connections";
import { Connector } from "../database/workspace-schema";
import { createConnectionWriteTools } from "../agent-lib/tools/connection-write-tools";
import { createConnectorTools } from "../agent-lib/tools/connector-tools";
import { hashKeyToken } from "../connectors/connection-key-request.service";
import { decryptString } from "../services/crypto.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const SECRET = "sk_live_pasted_in_the_app";

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

function call(
  method: "GET" | "POST",
  token: string,
  body?: unknown,
  workspaceId = WS,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/workspaces/${workspaceId}/connections/sources/key-requests/${token}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
  );
}

type ToolResult = Record<string, unknown>;

async function createWithoutKey(name = "stripe_main"): Promise<{
  connectionId: string;
  token: string;
  result: ToolResult;
}> {
  const tools = createConnectionWriteTools(WS, "u1");
  const execute = tools.create_connection.execute as unknown as (
    input: unknown,
  ) => Promise<ToolResult>;
  const result = await execute({
    connector: "stripe",
    name,
    config: { account: "acct_1" },
  });
  const link = String(result.keyLink ?? "");
  return {
    connectionId: String(result.connectionId),
    token: decodeURIComponent(link.split("/").pop() ?? ""),
    result,
  };
}

async function inspect(connectionId: string): Promise<ToolResult> {
  const execute = createConnectorTools(WS).inspect_connection
    .execute as unknown as (input: unknown) => Promise<ToolResult>;
  return execute({ connectionId });
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.CLIENT_URL = "https://mako.test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  ctx.role = "member";
  ctx.authType = "session";
  ctx.probe = { success: true, message: "ok" };
  await Connector.deleteMany({});
});

describe("create_connection without the key", () => {
  it("stores a waiting connection and returns a one-time link", async () => {
    const { connectionId, token, result } = await createWithoutKey();
    expect(result.status).toBe("awaiting_key");
    expect(result.awaitingFields).toEqual(["api_key"]);
    expect(String(result.keyLink)).toMatch(
      new RegExp(`^https://mako\\.test/connection-key/${WS}/`),
    );

    const row = (await Connector.findById(connectionId).lean()) as Record<
      string,
      any
    >;
    expect(row.isActive).toBe(false);
    expect(row.config.api_key).toBeUndefined();
    expect(row.config.account).toBe("acct_1");
    expect(row.keyRequest.tokenHash).toBe(hashKeyToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const inspected = await inspect(connectionId);
    expect(inspected.status).toBe("awaiting_key");
    expect(inspected.awaitingFields).toEqual(["api_key"]);
    expect(JSON.stringify(inspected)).not.toContain(row.keyRequest.tokenHash);
  });

  it("still takes a key passed in config, checked right away", async () => {
    const execute = createConnectionWriteTools(WS, "u1").create_connection
      .execute as unknown as (input: unknown) => Promise<ToolResult>;
    const result = await execute({
      connector: "stripe",
      name: "inline",
      config: { api_key: SECRET },
    });
    expect(result.status).toBeUndefined();
    expect(result.keyLink).toBeUndefined();
    const row = (await Connector.findById(result.connectionId).lean()) as any;
    expect(row.keyRequest).toBeUndefined();
    expect(row.isActive).toBe(true);
  });
});

describe("the key link", () => {
  it("shows the requested fields and stores the key once, encrypted", async () => {
    const { connectionId, token } = await createWithoutKey();

    const shown = await call("GET", token);
    expect(shown.status).toBe(200);
    const form = (await shown.json()) as { data: Record<string, any> };
    expect(form.data.connectionId).toBe(connectionId);
    expect(form.data.fields).toEqual([
      { name: "api_key", label: "API key", type: "password", required: true },
    ]);

    const saved = await call("POST", token, { config: { api_key: SECRET } });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(SECRET);

    const row = (await Connector.findById(connectionId).lean()) as any;
    expect(row.keyRequest).toBeUndefined();
    expect(row.isActive).toBe(true);
    expect(row.config.api_key).not.toBe(SECRET);
    expect(decryptString(row.config.api_key)).toBe(SECRET);
    expect((await inspect(connectionId)).status).toBe("ready");

    // Works once.
    const again = await call("POST", token, { config: { api_key: "other" } });
    expect(again.status).toBe(404);
    expect((await call("GET", token)).status).toBe(404);
    const after = (await Connector.findById(connectionId).lean()) as any;
    expect(decryptString(after.config.api_key)).toBe(SECRET);
  });

  it("sets only the fields it asks for", async () => {
    const { token } = await createWithoutKey();
    const res = await call("POST", token, {
      config: { api_key: SECRET, account: "acct_evil" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SECRET);
    const empty = await call("POST", token, { config: { api_key: "" } });
    expect(empty.status).toBe(400);
  });

  it("is refused once expired", async () => {
    const { connectionId, token } = await createWithoutKey();
    await Connector.updateOne(
      { _id: connectionId },
      { $set: { "keyRequest.expiresAt": new Date(Date.now() - 1000) } },
    );
    expect((await call("GET", token)).status).toBe(410);
    expect(
      (await call("POST", token, { config: { api_key: SECRET } })).status,
    ).toBe(410);
    expect((await inspect(connectionId)).status).toBe("key_link_expired");
  });

  it("needs a signed-in member: not a viewer, not an API key, not another workspace", async () => {
    const { token } = await createWithoutKey();
    ctx.role = "viewer";
    expect((await call("GET", token)).status).toBe(403);
    expect(
      (await call("POST", token, { config: { api_key: SECRET } })).status,
    ).toBe(403);

    ctx.role = "member";
    ctx.authType = "api-key";
    expect((await call("GET", token)).status).toBe(403);
    expect(
      (await call("POST", token, { config: { api_key: SECRET } })).status,
    ).toBe(403);

    ctx.authType = "session";
    const other = new Types.ObjectId().toString();
    expect((await call("GET", token, undefined, other)).status).toBe(404);
  });

  it("takes a key that fails its check back out, and keeps the link", async () => {
    const { connectionId, token } = await createWithoutKey();
    ctx.probe = { success: false, message: "Invalid API key" };
    const failed = await call("POST", token, { config: { api_key: "typo" } });
    expect(failed.status).toBe(422);
    expect(((await failed.json()) as { error: string }).error).toMatch(
      /Invalid API key/,
    );
    const row = (await Connector.findById(connectionId).lean()) as any;
    expect(row.config.api_key).toBeUndefined();
    expect(row.isActive).toBe(false);
    expect(row.keyRequest.tokenHash).toBe(hashKeyToken(token));

    ctx.probe = { success: true, message: "ok" };
    const fixed = await call("POST", token, { config: { api_key: SECRET } });
    expect(fixed.status).toBe(200);
    expect((await inspect(connectionId)).status).toBe("ready");
  });
});
