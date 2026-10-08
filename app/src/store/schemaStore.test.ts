// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Databases sidebar reads `connections[workspaceId]`, a copy the store
 * persists across reloads. A connection renamed anywhere else (REST, the
 * agent, another window) kept its old name there until it was edited in
 * this window: the copy was never fetched again.
 */

// The persisted copy lives in IndexedDB, which jsdom does not have.
const idb = vi.hoisted(() => ({
  get: vi.fn(async (_key: string): Promise<string | undefined> => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));
vi.mock("idb-keyval", () => idb);

vi.mock("../lib/local-agent-client", () => ({
  isLocalConnectionId: () => false,
  localAgentClient: { get: vi.fn(async () => ({ success: true, data: [] })) },
}));

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  PATCH: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  DELETE: vi.fn(),
}));

vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: http };
});

import { useSchemaStore, type Connection } from "./schemaStore";
import { dispatchRealtimeEvent } from "./lib/realtime-channel";

/** What openapi-fetch resolves for a 200 with a JSON body. */
const ok = (body: unknown) => ({
  data: body,
  error: undefined,
  response: { ok: true, status: 200 },
});

const connection = (id: string, name: string) =>
  ({
    id,
    name,
    description: "",
    type: "bigquery",
  }) as unknown as Connection;

const listing = (...connections: Connection[]) =>
  ok({ success: true, data: connections });

/** Let the background revalidation settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useSchemaStore.setState({
    connections: {},
    treeNodes: {},
    loading: {},
    error: {},
  });
});

describe("schemaStore keeps connection names current", () => {
  it("shows a copy from an earlier page load, then revalidates it once", async () => {
    const WID = "ws-reload";
    useSchemaStore.setState({
      connections: { [WID]: [connection("c1", "Old name")] },
      treeNodes: { c1: { root: [] } },
    });
    http.GET.mockResolvedValueOnce(listing(connection("c1", "New name")));

    const shown = await useSchemaStore.getState().ensureConnections(WID);
    expect(shown.map(c => c.name)).toEqual(["Old name"]);
    await settle();

    const state = useSchemaStore.getState();
    expect(state.connections[WID]?.map(c => c.name)).toEqual(["New name"]);
    // Revalidating the names does not throw away the expanded trees.
    expect(state.treeNodes.c1).toEqual({ root: [] });
    // Once per page load: later callers get the fresh copy, no refetch.
    await useSchemaStore.getState().ensureConnections(WID);
    expect(http.GET).toHaveBeenCalledTimes(1);
  });

  it("refetches the list when a database connection is renamed elsewhere", async () => {
    const WID = "ws-realtime";
    http.GET.mockResolvedValueOnce(listing(connection("c2", "Warehouse")));
    await useSchemaStore.getState().ensureConnections(WID);
    expect(http.GET).toHaveBeenCalledTimes(1);

    // A source connection is not in this list: nothing to refetch.
    dispatchRealtimeEvent(
      {
        type: "connection.updated",
        connectionId: "s1",
        connectionKind: "source",
      },
      { workspaceId: WID, currentUserId: null },
    );
    await settle();
    expect(http.GET).toHaveBeenCalledTimes(1);

    http.GET.mockResolvedValueOnce(listing(connection("c2", "Warehouse EU")));
    dispatchRealtimeEvent(
      {
        type: "connection.updated",
        connectionId: "c2",
        connectionKind: "database",
      },
      { workspaceId: WID, currentUserId: null },
    );
    await settle();

    expect(http.GET).toHaveBeenCalledTimes(2);
    expect(
      useSchemaStore.getState().connections[WID]?.map(c => c.name),
    ).toEqual(["Warehouse EU"]);
  });

  it("does not let the copy, loading late, overwrite a list fetched in this page load", async () => {
    const WID = "ws-late-copy";
    http.GET.mockResolvedValueOnce(listing(connection("c4", "Fresh")));
    await useSchemaStore.getState().ensureConnections(WID);
    idb.get.mockResolvedValueOnce(
      JSON.stringify({
        state: {
          connections: {
            [WID]: [connection("c4", "Stale")],
            other: [connection("c5", "Other workspace")],
          },
          treeNodes: {},
          autocompleteSchemas: {},
          columns: {},
        },
        version: 3,
      }),
    );

    await useSchemaStore.persist.rehydrate();

    const connections = useSchemaStore.getState().connections;
    expect(connections[WID]?.map(c => c.name)).toEqual(["Fresh"]);
    expect(connections.other?.map(c => c.name)).toEqual(["Other workspace"]);
  });

  it("keeps the copy it has when the revalidation fails", async () => {
    const WID = "ws-offline";
    useSchemaStore.setState({
      connections: { [WID]: [connection("c3", "Kept")] },
    });
    http.GET.mockRejectedValueOnce(new Error("offline"));

    await useSchemaStore.getState().ensureConnections(WID);
    await settle();

    expect(
      useSchemaStore.getState().connections[WID]?.map(c => c.name),
    ).toEqual(["Kept"]);
  });
});
