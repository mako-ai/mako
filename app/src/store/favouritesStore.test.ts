/**
 * The typed client is mocked at the module boundary (the consoleTreeStore /
 * flowStore idiom) rather than at `fetch`: `openapi-fetch` builds a `Request`
 * from the client's relative base url, which cannot be constructed under the
 * test runner. `importOriginal` keeps the REAL `unwrapBody`/`toErrorMessage`,
 * so the store's error handling is genuinely exercised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  PATCH: vi.fn(),
  DELETE: vi.fn(),
}));

vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: http };
});

import {
  favouriteFor,
  selectFavourites,
  starredRefs,
  useFavouritesStore,
  type Favourite,
} from "./favouritesStore";

const WS = "ws1";
const BASE = "/api/workspaces/{workspaceId}/favourites";

const ok = (body: unknown) => ({
  data: body,
  error: undefined,
  response: { ok: true, status: 200 },
});
const fail = (status: number, message: string) => ({
  data: undefined,
  error: { success: false, error: message },
  response: { ok: false, status },
});

const rows = () => selectFavourites(WS)(useFavouritesStore.getState());

beforeEach(() => {
  vi.clearAllMocks();
  useFavouritesStore.getState().reset();
});

describe("favouritesStore", () => {
  it("loads the user's rows for a workspace", async () => {
    const list: Favourite[] = [
      {
        id: "i1",
        parentId: null,
        type: "item",
        kind: "app",
        refId: "a1",
        position: 0,
      },
    ];
    http.GET.mockResolvedValueOnce(ok({ success: true, favourites: list }));
    await useFavouritesStore.getState().fetch(WS);
    expect(http.GET).toHaveBeenCalledWith(BASE, {
      params: { path: { workspaceId: WS } },
    });
    expect(rows()).toEqual(list);
    expect(starredRefs(rows(), "app")).toEqual(new Set(["a1"]));
    expect(favouriteFor(rows(), "app", "a1")?.id).toBe("i1");
  });

  it("stars optimistically, then keeps the server's row", async () => {
    const server: Favourite = {
      id: "srv",
      parentId: null,
      type: "item",
      kind: "app",
      refId: "a2",
      position: 0,
    };
    http.PUT.mockImplementationOnce(async () => {
      // While the request is in flight the row is already there.
      expect(starredRefs(rows(), "app").has("a2")).toBe(true);
      return ok({ success: true, favourite: server });
    });
    expect(
      await useFavouritesStore.getState().toggle(WS, "app", "a2", true),
    ).toBe(true);
    expect(http.PUT).toHaveBeenCalledWith(`${BASE}/items/{kind}/{refId}`, {
      params: { path: { workspaceId: WS, kind: "app", refId: "a2" } },
      body: { parentId: null },
    });
    expect(rows()).toEqual([server]);
  });

  it("rolls a failed unstar back and surfaces the error", async () => {
    useFavouritesStore.setState({
      byWorkspace: {
        [WS]: [
          {
            id: "i1",
            parentId: null,
            type: "item",
            kind: "app",
            refId: "a1",
            position: 0,
          },
        ],
      },
    });
    http.DELETE.mockResolvedValueOnce(fail(500, "boom"));
    expect(
      await useFavouritesStore.getState().toggle(WS, "app", "a1", false),
    ).toBe(false);
    expect(starredRefs(rows(), "app").has("a1")).toBe(true);
    expect(useFavouritesStore.getState().error).toMatch(/boom/);
  });

  it("moves a row into a folder optimistically and re-indexes siblings", async () => {
    useFavouritesStore.setState({
      byWorkspace: {
        [WS]: [
          {
            id: "f1",
            parentId: null,
            type: "folder",
            title: "Daily",
            position: 0,
          },
          {
            id: "i1",
            parentId: null,
            type: "item",
            kind: "app",
            refId: "a1",
            position: 1,
          },
          {
            id: "i2",
            parentId: "f1",
            type: "item",
            kind: "app",
            refId: "a2",
            position: 0,
          },
        ],
      },
    });
    http.PATCH.mockResolvedValueOnce(ok({ success: true, favourite: {} }));
    // The store re-reads after a move; the server would answer with the
    // moved rows, so echo whatever the optimistic update produced.
    http.GET.mockImplementationOnce(async () =>
      ok({ success: true, favourites: rows() }),
    );
    expect(await useFavouritesStore.getState().move(WS, "i1", "f1", 0)).toBe(
      true,
    );
    expect(http.PATCH).toHaveBeenCalledWith(`${BASE}/{id}`, {
      params: { path: { workspaceId: WS, id: "i1" } },
      body: { parentId: "f1", position: 0 },
    });
    const inFolder = rows()
      .filter(r => r.parentId === "f1")
      .sort((a, b) => a.position - b.position)
      .map(r => r.id);
    expect(inFolder).toEqual(["i1", "i2"]);
  });

  it("removes a folder with its subtree", async () => {
    useFavouritesStore.setState({
      byWorkspace: {
        [WS]: [
          {
            id: "f1",
            parentId: null,
            type: "folder",
            title: "Daily",
            position: 0,
          },
          {
            id: "f2",
            parentId: "f1",
            type: "folder",
            title: "Sub",
            position: 0,
          },
          {
            id: "i1",
            parentId: "f2",
            type: "item",
            kind: "app",
            refId: "a1",
            position: 0,
          },
          {
            id: "i2",
            parentId: null,
            type: "item",
            kind: "app",
            refId: "a2",
            position: 1,
          },
        ],
      },
    });
    http.DELETE.mockResolvedValueOnce(
      ok({ success: true, result: { removed: 3 } }),
    );
    expect(await useFavouritesStore.getState().remove(WS, "f1")).toBe(true);
    expect(rows().map(r => r.id)).toEqual(["i2"]);
  });
});
