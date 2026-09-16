/**
 * The typed client is mocked at the module boundary (the consoleTreeStore /
 * flowStore idiom) rather than at `fetch`: `openapi-fetch` builds a `Request`
 * from the client's relative base url, which cannot be constructed under the
 * test runner. `importOriginal` keeps the REAL `unwrapBody`/`toErrorMessage`,
 * so the store's error handling is genuinely exercised — only the transport is
 * faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  PATCH: vi.fn(),
  DELETE: vi.fn(),
}));

vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: http };
});

import {
  selectPersonalFolders,
  usePersonalFoldersStore,
} from "./personalFoldersStore";

const WS = "ws1";
const BASE = "/api/workspaces/{workspaceId}/personal-folders";

/** What openapi-fetch resolves for a 200 with a JSON body. */
const ok = (body: unknown) => ({
  data: body,
  error: undefined,
  response: { ok: true, status: 200 },
});

/** …and for a non-2xx, which is what makes `unwrapBody` throw. */
const fail = (status: number, message: string) => ({
  data: undefined,
  error: { success: false, error: message },
  response: { ok: false, status },
});

const folder = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  kind: "app",
  name: "Daily",
  items: [] as string[],
  ...over,
});

const itemsOf = () =>
  selectPersonalFolders(WS)(usePersonalFoldersStore.getState())[0].items;

beforeEach(() => {
  vi.clearAllMocks();
  usePersonalFoldersStore.getState().reset();
});

describe("personalFoldersStore", () => {
  it("asks for this user's folders of this kind, scoped per workspace", async () => {
    http.GET.mockResolvedValueOnce(ok({ success: true, folders: [folder()] }));

    await usePersonalFoldersStore.getState().fetchFolders(WS);

    expect(http.GET).toHaveBeenCalledWith(BASE, {
      params: { path: { workspaceId: WS }, query: { kind: "app" } },
    });
    expect(
      selectPersonalFolders(WS)(usePersonalFoldersStore.getState()),
    ).toHaveLength(1);
    expect(
      selectPersonalFolders("other")(usePersonalFoldersStore.getState()),
    ).toEqual([]);
  });

  it("creates a folder and keeps the list sorted by name", async () => {
    http.GET.mockResolvedValueOnce(
      ok({ success: true, folders: [folder({ id: "f2", name: "Zed" })] }),
    );
    http.POST.mockResolvedValueOnce(
      ok({ success: true, folder: folder({ id: "f1", name: "Alpha" }) }),
    );

    await usePersonalFoldersStore.getState().fetchFolders(WS);
    await usePersonalFoldersStore.getState().createFolder(WS, "Alpha");

    expect(http.POST).toHaveBeenCalledWith(BASE, {
      params: { path: { workspaceId: WS } },
      body: { name: "Alpha", kind: "app" },
    });
    expect(
      selectPersonalFolders(WS)(usePersonalFoldersStore.getState()).map(
        f => f.name,
      ),
    ).toEqual(["Alpha", "Zed"]);
  });

  it("shows an added item before the server answers", async () => {
    http.GET.mockResolvedValueOnce(ok({ success: true, folders: [folder()] }));
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, folder: folder({ items: ["billing"] }) }),
    );
    await usePersonalFoldersStore.getState().fetchFolders(WS);

    const pending = usePersonalFoldersStore
      .getState()
      .addItem(WS, "f1", "billing");

    // Dragging a row must feel instant, so the row is there before the round
    // trip completes.
    expect(itemsOf()).toEqual(["billing"]);

    await pending;

    expect(http.PATCH).toHaveBeenCalledWith(`${BASE}/{id}/items`, {
      params: { path: { workspaceId: WS, id: "f1" } },
      body: { add: ["billing"] },
    });
    expect(itemsOf()).toEqual(["billing"]);
  });

  it("puts the items back when the server rejects the change", async () => {
    http.GET.mockResolvedValueOnce(
      ok({ success: true, folders: [folder({ items: ["billing"] })] }),
    );
    http.PATCH.mockResolvedValueOnce(fail(409, "A folder holds at most 500"));
    await usePersonalFoldersStore.getState().fetchFolders(WS);

    const accepted = await usePersonalFoldersStore
      .getState()
      .addItem(WS, "f1", "churn");

    expect(accepted).toBe(false);
    // The sidebar must never claim a membership the server refused.
    expect(itemsOf()).toEqual(["billing"]);
    expect(usePersonalFoldersStore.getState().error).toContain("at most");
  });

  it("removes an item, then drops the folder on delete", async () => {
    http.GET.mockResolvedValueOnce(
      ok({ success: true, folders: [folder({ items: ["billing"] })] }),
    );
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, folder: folder({ items: [] }) }),
    );
    http.DELETE.mockResolvedValueOnce(ok({ success: true, id: "f1" }));
    await usePersonalFoldersStore.getState().fetchFolders(WS);

    await usePersonalFoldersStore.getState().removeItem(WS, "f1", "billing");
    expect(http.PATCH).toHaveBeenCalledWith(`${BASE}/{id}/items`, {
      params: { path: { workspaceId: WS, id: "f1" } },
      body: { remove: ["billing"] },
    });
    expect(itemsOf()).toEqual([]);

    await usePersonalFoldersStore.getState().deleteFolder(WS, "f1");
    expect(http.DELETE).toHaveBeenCalledWith(`${BASE}/{id}`, {
      params: { path: { workspaceId: WS, id: "f1" } },
    });
    expect(
      selectPersonalFolders(WS)(usePersonalFoldersStore.getState()),
    ).toEqual([]);
  });

  it("renames a folder", async () => {
    http.GET.mockResolvedValueOnce(ok({ success: true, folders: [folder()] }));
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, folder: folder({ name: "Renamed" }) }),
    );
    await usePersonalFoldersStore.getState().fetchFolders(WS);

    await usePersonalFoldersStore.getState().renameFolder(WS, "f1", "Renamed");

    expect(http.PATCH).toHaveBeenCalledWith(`${BASE}/{id}`, {
      params: { path: { workspaceId: WS, id: "f1" } },
      body: { name: "Renamed" },
    });
    expect(
      selectPersonalFolders(WS)(usePersonalFoldersStore.getState())[0].name,
    ).toBe("Renamed");
  });

  it("surfaces a load failure instead of throwing", async () => {
    http.GET.mockResolvedValueOnce(fail(500, "boom"));

    await usePersonalFoldersStore.getState().fetchFolders(WS);

    expect(usePersonalFoldersStore.getState().error).toBe("boom");
    expect(
      selectPersonalFolders(WS)(usePersonalFoldersStore.getState()),
    ).toEqual([]);
  });
});
