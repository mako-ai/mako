/**
 * A connection is stored with its connector's CURRENT slug, never an old
 * one. `connectorTypeExists` accepts an alias (so the form keeps working
 * for old links), but a NEW connection created as `ws:<old>` would be
 * keyed on a name a future `connectors/<old>/` could claim — and then its
 * credentials would start going to the new connector. The create and
 * update routes canonicalize `ws:<alias>` → `ws:<current>`.
 *
 * Real routes + real Mongo; auth, the workspace service and the config
 * schema lookup are mocked, as in source-connection-secrets.test.ts.
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

vi.mock("../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "member" })),
    isAdmin: vi.fn(async () => false),
  },
}));
vi.mock("../sync/connector-registry", () => ({
  syncConnectorRegistry: {
    getConfigSchemaForType: vi.fn(async () => ({
      fields: [{ name: "apiKey", type: "password", encrypted: true }],
    })),
    getConnectorFor: vi.fn(async () => null),
  },
}));
vi.mock("../connectors/registry", () => ({
  connectorRegistry: { hasConnector: vi.fn(() => true) },
}));

import { sourceConnectionRoutes } from "./source-connections";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { Connector, ConnectorDefinition } from "../database/workspace-schema";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();

const app = new Hono();
app.route(
  "/api/workspaces/:workspaceId/connections/sources",
  sourceConnectionRoutes,
);

function req(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/workspaces/${WS}/connections/sources${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Connector.deleteMany({});
  await ConnectorDefinition.deleteMany({});
  // `acme` was renamed to `acme-crm`; `acme` is now only an alias.
  await ConnectorDefinition.create({
    workspaceId: WS,
    slug: "acme-crm",
    sha: "a",
    sourceSha: "s",
    status: "indexed",
    entities: [],
    aliases: ["acme"],
  });
});

describe("ws:<alias> is stored as ws:<current slug>", () => {
  it("POST canonicalizes the type", async () => {
    const res = await req("POST", "", {
      name: "Acme",
      type: "ws:acme",
      config: { apiKey: "k" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { data: { _id: string; type: string } };
    expect(body.data.type).toBe("ws:acme-crm");
    expect((await Connector.findById(body.data._id))?.type).toBe("ws:acme-crm");
  });

  it("PUT canonicalizes the type; a current slug and a built-in type pass through", async () => {
    const created = await req("POST", "", {
      name: "Acme",
      type: "ws:acme-crm",
      config: { apiKey: "k" },
    });
    const { data } = (await created.json()) as { data: { _id: string } };
    const res = await req("PUT", `/${data._id}`, { type: "ws:acme" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await Connector.findById(data._id))?.type).toBe("ws:acme-crm");

    const builtin = await req("POST", "", {
      name: "Stripe",
      type: "stripe",
      config: { apiKey: "k" },
    });
    expect(builtin.status).toBe(201);
    expect(
      ((await builtin.json()) as { data: { type: string } }).data.type,
    ).toBe("stripe");
  });

  it("POST binds the connection to the definition by id and asks for the schema through that binding", async () => {
    const def = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "acme-crm",
    });
    const res = await req("POST", "", {
      name: "Acme",
      type: "ws:acme",
      config: { apiKey: "k" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { data } = (await res.json()) as { data: { _id: string } };
    expect(
      String((await Connector.findById(data._id))?.connectorDefinitionId),
    ).toBe(String(def!._id));
    const lastCall = vi
      .mocked(syncConnectorRegistry.getConfigSchemaForType)
      .mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("ws:acme-crm");
    expect(
      String(
        (lastCall?.[2] as { connectorDefinitionId?: unknown })
          ?.connectorDefinitionId,
      ),
    ).toBe(String(def!._id));
  });

  it("PUT re-binds when the type is re-pointed; a config edit resolves the schema through the row's binding", async () => {
    const other = await ConnectorDefinition.create({
      workspaceId: WS,
      slug: "zed",
      sha: "b",
      sourceSha: "t",
      status: "indexed",
      entities: [],
      aliases: [],
    });
    const created = await req("POST", "", {
      name: "Acme",
      type: "ws:acme-crm",
      config: { apiKey: "k" },
    });
    const { data } = (await created.json()) as { data: { _id: string } };
    expect((await req("PUT", `/${data._id}`, { type: "ws:zed" })).status).toBe(
      200,
    );
    expect(
      String((await Connector.findById(data._id))?.connectorDefinitionId),
    ).toBe(String(other._id));
    expect(
      (await req("PUT", `/${data._id}`, { config: { apiKey: "k2" } })).status,
    ).toBe(200);
    const lastCall = vi
      .mocked(syncConnectorRegistry.getConfigSchemaForType)
      .mock.calls.at(-1);
    expect(
      String(
        (lastCall?.[2] as { connectorDefinitionId?: unknown })
          ?.connectorDefinitionId,
      ),
    ).toBe(String(other._id));
  });

  it("an unknown ws: slug is still refused", async () => {
    const res = await req("POST", "", {
      name: "Nope",
      type: "ws:nope",
      config: {},
    });
    expect(res.status).toBe(400);
  });
});
