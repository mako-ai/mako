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
// The schema is stubbed; the binding is not. A `ws:` lookup made through a
// connection's binding resolves it for real, so a broken binding refuses
// exactly as the real registry would (resolver.ts ConnectorBindingError).
vi.mock("../sync/connector-registry", async () => {
  const { loadConnectorDefinitionFor } = await vi.importActual<
    typeof import("../connectors/workspace/resolver")
  >("../connectors/workspace/resolver");
  return {
    syncConnectorRegistry: {
      getConfigSchemaForType: vi.fn(
        async (
          type: string,
          workspaceId?: string,
          binding?: { type: string; connectorDefinitionId?: unknown },
        ) => {
          if (binding && workspaceId && type.startsWith("ws:")) {
            await loadConnectorDefinitionFor(workspaceId, binding);
          }
          return {
            fields: [{ name: "apiKey", type: "password", encrypted: true }],
          };
        },
      ),
      getConnectorFor: vi.fn(async () => null),
    },
  };
});
vi.mock("../connectors/registry", () => ({
  connectorRegistry: { hasConnector: vi.fn(() => true) },
}));

import { sourceConnectionRoutes } from "./source-connections";
import { syncConnectorRegistry } from "../sync/connector-registry";
import { Connector, ConnectorDefinition } from "../database/workspace-schema";
import { findConnectorDefinitionFor } from "../connectors/workspace/resolver";

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

describe("a connection whose connector was removed is re-bound only by a person", () => {
  const def = (slug: string) =>
    ConnectorDefinition.create({
      workspaceId: WS,
      slug,
      sha: "a",
      sourceSha: "s",
      status: "indexed",
      entities: [],
      aliases: [],
    });
  const create = async (type: string) => {
    const res = await req("POST", "", {
      name: "Acme",
      type,
      config: { apiKey: "k" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { data: { _id: string } }).data._id;
  };
  const resolved = async (id: string) => {
    const row = (await Connector.findById(id).lean())!;
    const found = await findConnectorDefinitionFor(WS, {
      type: row.type,
      connectorDefinitionId: row.connectorDefinitionId,
    });
    return found ? String(found.row._id) : null;
  };

  it("delete + restore: a config edit is a 409 that says how to re-bind; PUT naming the same type re-binds to the restored row", async () => {
    const r1 = await def("zeta");
    const id = await create("ws:zeta");
    const stored = (await Connector.findById(id).lean())!.config;

    // A push deletes connectors/zeta/, a revert restores it: a NEW row.
    await ConnectorDefinition.deleteOne({ _id: r1._id });
    const r2 = await def("zeta");
    expect(await resolved(id)).toBeNull(); // fail closed

    // The edit form is told, and why.
    const got = await req("GET", `/${id}`);
    const shown = (
      (await got.json()) as {
        data: { connectorBinding?: { problem: string; message: string } };
      }
    ).data.connectorBinding;
    expect(shown?.problem).toBe("definition-gone");

    // A config edit before the re-bind: 409, not 500, and nothing written.
    const edit = await req("PUT", `/${id}`, {
      name: "renamed too",
      config: { apiKey: "k2" },
    });
    expect(edit.status, await edit.clone().text()).toBe(409);
    const refusal = (await edit.json()) as {
      error: string;
      code: string;
      problem: string;
    };
    expect(refusal.code).toBe("connector_binding");
    expect(refusal.problem).toBe("definition-gone");
    expect(refusal.error).toMatch(/no longer exists/);
    expect(refusal.error).toMatch(/re-bind/);
    expect(refusal.error).toContain('{"type": "ws:zeta"}');
    const untouched = (await Connector.findById(id).lean())!;
    expect(untouched.name).toBe("Acme");
    expect(untouched.config).toEqual(stored);
    expect(String(untouched.connectorDefinitionId)).toBe(String(r1._id));

    // The deliberate act: name the type, even the same one.
    const rebind = await req("PUT", `/${id}`, { type: "ws:zeta" });
    expect(rebind.status, await rebind.clone().text()).toBe(200);
    const after = (await rebind.json()) as {
      data: { connectorBinding?: unknown };
    };
    expect(after.data.connectorBinding).toBeUndefined();
    expect(String((await Connector.findById(id))?.connectorDefinitionId)).toBe(
      String(r2._id),
    );
    expect(await resolved(id)).toBe(String(r2._id));

    // ...and the config edit now goes through, against the new binding.
    expect(
      (await req("PUT", `/${id}`, { config: { apiKey: "k2" } })).status,
    ).toBe(200);
  });

  it("re-bind and config edit in ONE save: the type is applied first", async () => {
    const r1 = await def("zeta");
    const id = await create("ws:zeta");
    await ConnectorDefinition.deleteOne({ _id: r1._id });
    const r2 = await def("zeta");
    const res = await req("PUT", `/${id}`, {
      type: "ws:zeta",
      config: { apiKey: "k2" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await resolved(id)).toBe(String(r2._id));
  });

  it("nothing to re-bind to: the stamp stays and the connection still fails closed", async () => {
    const r1 = await def("zeta");
    const id = await create("ws:zeta");
    await ConnectorDefinition.deleteOne({ _id: r1._id });
    const res = await req("PUT", `/${id}`, { type: "ws:zeta" });
    expect(res.status).toBe(200);
    expect(String((await Connector.findById(id))?.connectorDefinitionId)).toBe(
      String(r1._id),
    );
    expect(await resolved(id)).toBeNull();
  });

  it("a stamp on a LIVE definition is never moved by naming the same type, even when that type now names another connector", async () => {
    const mine = await def("zeta");
    const id = await create("ws:zeta");
    // `zeta` is renamed away to `zeta-old` (the id stays), and a NEW
    // connector takes the name `zeta`. The connection still says ws:zeta.
    await ConnectorDefinition.updateOne(
      { _id: mine._id },
      { $set: { slug: "zeta-old" } },
    );
    const squatter = await def("zeta");
    expect(await resolved(id)).toBeNull(); // fail closed

    const same = await req("PUT", `/${id}`, { type: "ws:zeta" });
    expect(same.status).toBe(200);
    expect(String((await Connector.findById(id))?.connectorDefinitionId)).toBe(
      String(mine._id),
    );
    expect(await resolved(id)).toBeNull();

    const edit = await req("PUT", `/${id}`, { config: { apiKey: "k2" } });
    expect(edit.status).toBe(409);
    const refusal = (await edit.json()) as { problem: string; error: string };
    expect(refusal.problem).toBe("name-moved");
    expect(refusal.error).toContain('{"type": "ws:zeta-old"}');

    // A type CHANGE is the way to move it: here, back onto its own row.
    expect((await req("PUT", `/${id}`, { type: "ws:zeta-old" })).status).toBe(
      200,
    );
    expect(await resolved(id)).toBe(String(mine._id));
    expect(String(squatter._id)).not.toBe(String(mine._id));
  });

  it("an unstamped connection is bound by naming its type", async () => {
    const r = await def("zeta");
    const id = await create("ws:zeta");
    await Connector.updateOne(
      { _id: id },
      { $unset: { connectorDefinitionId: "" } },
    );
    expect(await resolved(id)).toBe(String(r._id)); // by current slug
    expect((await req("PUT", `/${id}`, { type: "ws:zeta" })).status).toBe(200);
    expect(String((await Connector.findById(id))?.connectorDefinitionId)).toBe(
      String(r._id),
    );
  });
});
