// @vitest-environment jsdom
/**
 * The connector form-schema cache. One request answers every caller (a
 * second ask while the first was on its way used to get `null`, which a
 * form showed as a failure). A `ws:` form is a different connector in every
 * workspace: keyed by workspace, shown at once from cache, checked against
 * the server once per catalog load, dropped when the connector is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node 26 + jsdom has no usable localStorage; a Map-backed one is enough.
vi.hoisted(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
});
const http = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("../api", async importOriginal => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: http,
}));

import {
  cachedConnectorSchema,
  connectorSchemaKey,
  resetConnectorSchemaRequests,
  useConnectorCatalogStore,
} from "./connectorCatalogStore";

const form = (field: string) => ({ fields: [{ name: field, type: "string" }] });
/** A reply as openapi-fetch gives it. */
function reply(data: unknown, status = 200) {
  const ok = status === 200;
  return {
    data: ok ? { success: true, data } : undefined,
    error: ok ? undefined : { success: false, error: String(data) },
    response: { ok, status },
  };
}
const store = () => useConnectorCatalogStore.getState();
const cached = (type: string) => cachedConnectorSchema(store().schemas, type);
const schemaRequests = () =>
  http.GET.mock.calls.filter(([path]) => String(path).endsWith("/schema"));

beforeEach(() => {
  localStorage.setItem("activeWorkspaceId", "wsA");
  useConnectorCatalogStore.setState({
    schemas: {},
    schemaLoading: {},
    types: null,
  });
  resetConnectorSchemaRequests();
  http.GET.mockReset();
  http.POST.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("fetchSchema", () => {
  it("answers a second caller with the request already on its way: the schema, not null, and one request", async () => {
    let release = () => {};
    http.GET.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(reply(form("apiKey")));
        }),
    );
    const first = store().fetchSchema("ws:acme");
    const second = store().fetchSchema("ws:acme");
    const forced = store().fetchSchema("ws:acme", true);
    release();
    expect(await Promise.all([first, second, forced])).toEqual(
      Array(3).fill(form("apiKey")),
    );
    expect(http.GET).toHaveBeenCalledTimes(1);
    expect(store().schemaLoading).toEqual({});
  });

  it("a failed request answers null to every caller and is asked again next time", async () => {
    http.GET.mockResolvedValueOnce(reply("boom", 500));
    const both = [store().fetchSchema("stripe"), store().fetchSchema("stripe")];
    expect(await Promise.all(both)).toEqual([null, null]);
    http.GET.mockResolvedValueOnce(reply(form("stripeKey")));
    expect(await store().fetchSchema("stripe")).toEqual(form("stripeKey"));
    expect(http.GET).toHaveBeenCalledTimes(2);
  });

  it("keeps ws: forms per workspace and built-in forms shared", async () => {
    http.GET.mockResolvedValueOnce(reply(form("keyA")));
    await store().fetchSchema("ws:acme");
    http.GET.mockResolvedValueOnce(reply(form("stripeKey")));
    await store().fetchSchema("stripe");

    localStorage.setItem("activeWorkspaceId", "wsB");
    expect(cached("ws:acme")).toBeUndefined();
    expect(cached("stripe")).toEqual(form("stripeKey"));
    http.GET.mockResolvedValueOnce(reply(form("keyB")));
    expect(await store().fetchSchema("ws:acme")).toEqual(form("keyB"));
    expect(store().schemas).toEqual({
      [connectorSchemaKey("ws:acme", "wsA")]: form("keyA"),
      [connectorSchemaKey("ws:acme", "wsB")]: form("keyB"),
      stripe: form("stripeKey"),
    });
  });

  it("shows a cached form at once and checks it against the server once; a new catalog checks ws: forms again", async () => {
    useConnectorCatalogStore.setState({
      schemas: {
        [connectorSchemaKey("ws:acme", "wsA")]: form("old"),
        stripe: form("stripeKey"),
      },
    });
    http.GET.mockImplementation(async (path: string) =>
      path.endsWith("/schema")
        ? reply(form("new"))
        : reply([{ type: "ws:acme" }, { type: "stripe" }]),
    );
    expect(await store().fetchSchema("ws:acme")).toEqual(form("old"));
    await vi.waitFor(() => expect(cached("ws:acme")).toEqual(form("new")));
    await store().fetchSchema("ws:acme");
    await store().fetchSchema("stripe");
    await store().fetchSchema("stripe");
    await vi.waitFor(() => expect(schemaRequests()).toHaveLength(2));

    await store().fetchCatalog("wsA");
    await store().fetchSchema("ws:acme");
    await store().fetchSchema("stripe");
    await vi.waitFor(() => expect(schemaRequests()).toHaveLength(3));
    expect(schemaRequests()[2][1]).toEqual({
      params: { path: { type: "ws:acme" } },
    });
  });

  it("an unchanged answer keeps the cached object, so readers do not re-render", async () => {
    const before = form("same");
    useConnectorCatalogStore.setState({ schemas: { stripe: before } });
    http.GET.mockResolvedValue(reply(form("same")));
    expect(await store().fetchSchema("stripe", true)).toBe(
      store().schemas.stripe,
    );
    expect(store().schemas.stripe).toBe(before);
  });

  it("drops a ws: form whose connector is gone (404); another failure keeps it", async () => {
    const key = connectorSchemaKey("ws:acme", "wsA");
    useConnectorCatalogStore.setState({ schemas: { [key]: form("old") } });
    http.GET.mockResolvedValueOnce(reply("boom", 500));
    expect(await store().fetchSchema("ws:acme", true)).toBeNull();
    expect(cached("ws:acme")).toEqual(form("old"));
    http.GET.mockResolvedValueOnce(reply("Connector not found", 404));
    expect(await store().fetchSchema("ws:acme", true)).toBeNull();
    expect(cached("ws:acme")).toBeUndefined();
  });
});

describe("fetchCatalog", () => {
  it("drops this workspace's cached forms of connectors the catalog no longer lists; other workspaces' and built-ins stay", async () => {
    useConnectorCatalogStore.setState({
      schemas: {
        [connectorSchemaKey("ws:acme", "wsA")]: form("renamed away"),
        [connectorSchemaKey("ws:acme-crm", "wsA")]: form("current"),
        [connectorSchemaKey("ws:acme", "wsB")]: form("other workspace"),
        stripe: form("stripeKey"),
        gone_builtin: form("kept"),
      },
    });
    http.GET.mockResolvedValue(
      reply([{ type: "ws:acme-crm" }, { type: "stripe" }]),
    );
    await store().fetchCatalog("wsA");
    expect(Object.keys(store().schemas).sort()).toEqual(
      [
        connectorSchemaKey("ws:acme", "wsB"),
        connectorSchemaKey("ws:acme-crm", "wsA"),
        "gone_builtin",
        "stripe",
      ].sort(),
    );
  });

  it("a catalog that fails to load drops nothing", async () => {
    const schemas = { [connectorSchemaKey("ws:acme", "wsA")]: form("x") };
    useConnectorCatalogStore.setState({ schemas });
    http.GET.mockResolvedValue(reply("boom", 500));
    await store().fetchCatalog("wsA");
    expect(store().schemas).toEqual(schemas);
    expect(store().error).toBeTruthy();
  });
});

describe("renameWorkspaceConnector", () => {
  it("posts the rename, reloads the catalog and answers the new slug", async () => {
    useConnectorCatalogStore.setState({
      schemas: { [connectorSchemaKey("ws:acme", "wsA")]: form("old name") },
    });
    http.POST.mockResolvedValue({
      data: { success: true, result: { after: { slug: "acme-crm" } } },
      error: undefined,
      response: { ok: true, status: 200 },
    });
    http.GET.mockResolvedValue(reply([{ type: "ws:acme-crm" }]));
    expect(
      await store().renameWorkspaceConnector("wsA", "acme", " acme-crm"),
    ).toEqual({ slug: "acme-crm" });
    expect(http.POST).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/objects/{kind}/rename",
      {
        params: { path: { workspaceId: "wsA", kind: "connector" } },
        body: { ref: "acme", slug: " acme-crm" },
      },
    );
    expect(store().types).toEqual([{ type: "ws:acme-crm" }]);
    expect(store().schemas).toEqual({});
  });

  it("answers the server's sentence when it refuses, and changes nothing", async () => {
    http.POST.mockResolvedValue(reply('A connector "zed" already exists', 409));
    expect(
      await store().renameWorkspaceConnector("wsA", "acme", "zed"),
    ).toEqual({ error: 'A connector "zed" already exists' });
    expect(http.GET).not.toHaveBeenCalled();
  });
});

describe("persisted cache migration", () => {
  const migrate = (persisted: unknown, version: number) =>
    useConnectorCatalogStore.persist.getOptions().migrate?.(persisted, version);

  it("v4 → v5 drops ws: forms stored under the bare type and keeps built-ins; older caches are dropped whole", () => {
    const schemas = { "ws:acme": form("x"), stripe: form("y") };
    expect(migrate({ schemas }, 4)).toEqual({ schemas: { stripe: form("y") } });
    expect(migrate({ schemas }, 3)).toEqual({ schemas: {} });
    expect(migrate(undefined, 4)).toEqual({ schemas: {} });
    expect(useConnectorCatalogStore.persist.getOptions().version).toBe(5);
  });
});
