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
  userId: "u1",
  role: "member" as string | null,
  /** Runs inside the probe: a write that lands during the check window. */
  duringProbe: null as null | (() => Promise<void>),
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
    c.set("user", { id: ctx.userId });
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
    getConfigSchemaForType: vi.fn(async (type: string) =>
      type === "custom_api"
        ? {
            fields: [
              {
                name: "base_url",
                label: "Address",
                type: "string",
                required: true,
              },
              { name: "auth_type", label: "Credential type", type: "select" },
              {
                name: "token",
                label: "Key",
                type: "password",
                required: false,
                showIf: { field: "auth_type", equals: ["bearer"] },
              },
            ],
          }
        : {
            fields: [
              {
                name: "api_key",
                label: "API key",
                type: "password",
                required: true,
              },
              { name: "account", label: "Account", type: "string" },
            ],
          },
    ),
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
  probeConnection: vi.fn(async () => {
    await ctx.duringProbe?.();
    return { check: ctx.probe };
  }),
}));

import { sourceConnectionRoutes } from "./source-connections";
import { Connector } from "../database/workspace-schema";
import { createConnectionWriteTools } from "../agent-lib/tools/connection-write-tools";
import { createConnectorTools } from "../agent-lib/tools/connector-tools";
import { hashKeyToken } from "../connectors/connection-key-request.service";
import { decryptString, encryptString } from "../services/crypto.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const SECRET = "sk_live_pasted_in_the_app";

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

function post(
  workspaceId: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${workspaceId}/connections/sources${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The page's two calls: look the link up, or submit a key through it. */
function call(
  method: "GET" | "POST",
  token: string,
  body?: Record<string, unknown>,
  workspaceId = WS,
): Promise<Response> {
  return method === "GET"
    ? post(workspaceId, "/key-requests/lookup", { token })
    : post(workspaceId, "/key-requests/submit", {
        token,
        confirmedDestination: true,
        ...body,
      });
}

type ToolResult = Record<string, unknown>;

async function createWithoutKey(
  name = "stripe_main",
  connector = "stripe",
  config: Record<string, unknown> = { account: "acct_1" },
): Promise<{
  connectionId: string;
  token: string;
  result: ToolResult;
}> {
  const tools = createConnectionWriteTools(WS, "u1");
  const execute = tools.create_connection.execute as unknown as (
    input: unknown,
  ) => Promise<ToolResult>;
  const result = await execute({ connector, name, config });
  const link = String(result.keyLink ?? "");
  return {
    connectionId: String(result.connectionId),
    token: decodeURIComponent(link.split("#")[1] ?? ""),
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
  ctx.userId = "u1";
  ctx.role = "member";
  ctx.authType = "session";
  ctx.duringProbe = null;
  ctx.probe = { success: true, message: "ok" };
  await Connector.deleteMany({});
});

describe("create_connection without the key", () => {
  it("stores a waiting connection and returns a one-time link", async () => {
    const { connectionId, token, result } = await createWithoutKey();
    expect(result.status).toBe("awaiting_key");
    expect(result.awaitingFields).toEqual(["api_key"]);
    // The token is in the fragment only: no server path carries it.
    const link = new URL(String(result.keyLink));
    expect(link.origin + link.pathname).toBe(
      `https://mako.test/connection-key/${WS}`,
    );
    expect(link.hash.slice(1)).toBe(token);

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
    // What the agent chose is shown, so the person confirms where the key goes.
    expect(form.data.destination.settings).toEqual([
      { name: "account", label: "Account", value: "acct_1" },
    ]);

    const unconfirmed = await call("POST", token, {
      config: { api_key: SECRET },
      confirmedDestination: false,
    });
    expect(unconfirmed.status).toBe(400);
    expect(
      ((await Connector.findById(connectionId).lean()) as any).keyRequest,
    ).toBeDefined();

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

  it("is for the connection's managers, not any member", async () => {
    const { token } = await createWithoutKey();
    ctx.userId = "u2";
    ctx.role = "member";
    expect((await call("GET", token)).status).toBe(403);
    expect(
      (await call("POST", token, { config: { api_key: SECRET } })).status,
    ).toBe(403);
  });

  it("keeps a key a manager saved in the form while the link's key was checked", async () => {
    const { connectionId, token } = await createWithoutKey();
    const theirs = encryptString("sk_live_saved_in_the_form");
    ctx.probe = { success: false, message: "Invalid API key" };
    ctx.duringProbe = async () => {
      await Connector.updateOne(
        { _id: connectionId },
        { $set: { "config.api_key": theirs } },
      );
    };
    const res = await call("POST", token, { config: { api_key: "typo" } });
    expect(res.status).toBe(422);
    const row = (await Connector.findById(connectionId).lean()) as any;
    expect(row.config.api_key).toBe(theirs);
  });
});

describe("a Custom API connection", () => {
  it("gets a link when its key is left out, showing the address it goes to", async () => {
    const { connectionId, token, result } = await createWithoutKey(
      "probo",
      "custom_api",
      { base_url: "https://api.example.com/v1", auth_type: "bearer" },
    );
    expect(result.status).toBe("awaiting_key");
    expect(result.awaitingFields).toEqual(["token"]);
    const form = (await (await call("GET", token)).json()) as {
      data: Record<string, any>;
    };
    expect(form.data.destination.address).toBe("https://api.example.com/v1");
    expect(form.data.destination.settings).toEqual([
      {
        name: "base_url",
        label: "Address",
        value: "https://api.example.com/v1",
      },
      { name: "auth_type", label: "Credential type", value: "bearer" },
    ]);
    expect(
      ((await Connector.findById(connectionId).lean()) as any).isActive,
    ).toBe(false);
  });
});

describe("enabling a connection that waits for its key", () => {
  it("is refused until the key is set", async () => {
    const { connectionId, token } = await createWithoutKey();
    const refused = await Promise.resolve(
      app.request(
        `/api/workspaces/${WS}/connections/sources/${connectionId}/enable`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      ),
    );
    expect(refused.status).toBe(409);
    expect(
      ((await Connector.findById(connectionId).lean()) as any).isActive,
    ).toBe(false);

    expect(
      (await call("POST", token, { config: { api_key: SECRET } })).status,
    ).toBe(200);
  });
});
