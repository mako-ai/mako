// @vitest-environment jsdom
/**
 * The connector form-schema cache: one request answers every caller (a
 * second ask while the first is on its way used to get `null`, which the
 * form showed as "Failed to load connector schema"), and a `ws:` form is
 * a different connector in every workspace — keyed by workspace, checked
 * against the server once, dropped when the connector is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Node 26 + jsdom: a real Storage is not wired up; a Map-backed one is.
vi.hoisted(() => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
});
const http = vi.hoisted(() => ({
  GET: vi.fn(),
}));
vi.mock("../api", async importOriginal => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: { GET: http.GET },
}));

import { ApiError } from "../api";
import {
  cachedConnectorSchema,
  connectorSchemaKey,
  resetConnectorSchemaRequests,
  useConnectorCatalogStore,
} from "./connectorCatalogStore";

const form = (field: string) => ({ fields: [{ name: field, type: "string" }] });
/** A reply openapi-fetch would give; `release` lets a test hold it in flight. */
function reply(data: unknown, status = 200) {
  return {
    data: status === 200 ? { success: true, data } : undefined,
    error: status === 200 ? undefined : { error: "Connector not found" },
    response: { ok: status === 200, status },
  };
}

beforeEach(() => {
  localStorage.setItem("activeWorkspaceId", "wsA");
  useConnectorCatalogStore.setState({
    schemas: {},
    schemaLoading: {},
    types: null,
  });
  resetConnectorSchemaRequests();
  http.GET.mockReset();
});
afterEach(() => localStorage.clear());

describe("fetchSchema", () => {
  it("a second caller while the first request is on its way gets the schema, not null — one request", async () => {
    let release!: () => void;
    http.GET.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(reply(form("apiKey")));
        }),
    );
    const { fetchSchema } = useConnectorCatalogStore.getState();
    const first = fetchSchema("ws:acme");
    const second = fetchSchema("ws:acme");
    release();
    expect(await first).toEqual(form("apiKey"));
    expect(await second).toEqual(form("apiKey"));
    expect(http.GET).toHaveBeenCalledTimes(1);
  });

  it("ws: forms are per workspace; built-in forms are shared", async () => {
    http.GET.mockResolvedValueOnce(reply(form("keyA")));
    await useConnectorCatalogStore.getState().fetchSchema("ws:acme");
    http.GET.mockResolvedValueOnce(reply(form("stripeKey")));
    await useConnectorCatalogStore.getState().fetchSchema("stripe");

    localStorage.setItem("activeWorkspaceId", "wsB");
    const { schemas } = useConnectorCatalogStore.getState();
    expect(cachedConnectorSchema(schemas, "ws:acme")).toBeUndefined();
    expect(cachedConnectorSchema(schemas, "stripe")).toEqual(form("stripeKey"));
    http.GET.mockResolvedValueOnce(reply(form("keyB")));
    expect(
      await useConnectorCatalogStore.getState().fetchSchema("ws:acme"),
    ).toEqual(form("keyB"));
    const after = useConnectorCatalogStore.getState().schemas;
    expect(after[connectorSchemaKey("ws:acme", "wsA")]).toEqual(form("keyA"));
    expect(after[connectorSchemaKey("ws:acme", "wsB")]).toEqual(form("keyB"));
  });

  it("a cached ws: form answers at once and is checked against the server ONCE; a built-in is not re-fetched", async () => {
    useConnectorCatalogStore.setState({
      schemas: {
        [connectorSchemaKey("ws:acme", "wsA")]: form("old"),
        stripe: form("stripeKey"),
      },
    });
    http.GET.mockResolvedValue(reply(form("new")));
    const { fetchSchema } = useConnectorCatalogStore.getState();
    expect(await fetchSchema("ws:acme")).toEqual(form("old"));
    await vi.waitFor(() =>
      expect(
        cachedConnectorSchema(
          useConnectorCatalogStore.getState().schemas,
          "ws:acme",
        ),
      ).toEqual(form("new")),
    );
    await fetchSchema("ws:acme");
    await fetchSchema("ws:acme");
    expect(await fetchSchema("stripe")).toEqual(form("stripeKey"));
    expect(http.GET).toHaveBeenCalledTimes(1);
  });

  it("a ws: connector that is gone (404) loses its cached form", async () => {
    useConnectorCatalogStore.setState({
      schemas: { [connectorSchemaKey("ws:acme", "wsA")]: form("old") },
    });
    http.GET.mockResolvedValue(reply(null, 404));
    await useConnectorCatalogStore.getState().fetchSchema("ws:acme");
    await vi.waitFor(() =>
      expect(
        cachedConnectorSchema(
          useConnectorCatalogStore.getState().schemas,
          "ws:acme",
        ),
      ).toBeUndefined(),
    );
    expect(ApiError).toBeTruthy();
  });
});

describe("fetchCatalog", () => {
  it("drops this workspace's cached forms of connectors renamed away or deleted; keeps other workspaces'", async () => {
    useConnectorCatalogStore.setState({
      schemas: {
        [connectorSchemaKey("ws:acme", "wsA")]: form("renamed away"),
        [connectorSchemaKey("ws:acme-crm", "wsA")]: form("current"),
        [connectorSchemaKey("ws:acme", "wsB")]: form("other workspace"),
        stripe: form("stripeKey"),
      },
    });
    http.GET.mockResolvedValue({
      data: {
        success: true,
        data: [{ type: "ws:acme-crm" }, { type: "stripe" }],
      },
      error: undefined,
      response: { ok: true, status: 200 },
    });
    await useConnectorCatalogStore.getState().fetchCatalog("wsA");
    expect(
      Object.keys(useConnectorCatalogStore.getState().schemas).sort(),
    ).toEqual(
      [
        connectorSchemaKey("ws:acme", "wsB"),
        connectorSchemaKey("ws:acme-crm", "wsA"),
        "stripe",
      ].sort(),
    );
  });
});

describe("persisted cache migration", () => {
  it("v3 → v4 drops ws: forms that were not keyed by workspace; keeps built-ins", () => {
    const migrate = useConnectorCatalogStore.persist.getOptions().migrate!;
    expect(
      migrate({ schemas: { "ws:acme": form("x"), stripe: form("y") } }, 3),
    ).toEqual({ schemas: { stripe: form("y") } });
  });
});
