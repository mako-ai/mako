import { beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  PATCH: vi.fn(),
  POST: vi.fn(),
  DELETE: vi.fn(),
}));

vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: http };
});

import { useConsoleTreeStore, type ConsoleEntry } from "./consoleTreeStore";

const WID = "ws-1";

/** What openapi-fetch resolves for a 200 with a JSON body. */
const ok = (body: unknown) => ({
  data: body,
  error: undefined,
  response: { ok: true, status: 200 },
});

const file = (id: string, name: string): ConsoleEntry => ({
  id,
  name,
  path: name,
  isDirectory: false,
});

const folder = (
  id: string,
  name: string,
  children: ConsoleEntry[] = [],
): ConsoleEntry => ({ id, name, path: name, isDirectory: true, children });

const names = (nodes: ConsoleEntry[]) => nodes.map(n => n.name);

function seed(my: ConsoleEntry[], workspace: ConsoleEntry[] = []) {
  useConsoleTreeStore.setState({
    myItems: { [WID]: my },
    workspaceItems: { [WID]: workspace },
    loading: {},
    error: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seed([], []);
});

describe("consoleTreeStore fetchTree", () => {
  it("maps the API sections onto the shared my/workspace slots", async () => {
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        myConsoles: [file("a", "alpha")],
        sharedWithWorkspace: [folder("f", "shared", [file("b", "beta")])],
      }),
    );

    await useConsoleTreeStore.getState().fetchTree(WID);

    const state = useConsoleTreeStore.getState();
    expect(names(state.myItems[WID])).toEqual(["alpha"]);
    expect(names(state.workspaceItems[WID])).toEqual(["shared"]);
    expect(state.loading[WID]).toBeUndefined();
    expect(state.error[WID]).toBeNull();
    expect(http.GET).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles",
      { params: { path: { workspaceId: WID } } },
    );
  });

  it("falls back to the legacy `tree` field for the my section", async () => {
    http.GET.mockResolvedValueOnce(
      ok({ success: true, tree: [file("a", "x")] }),
    );

    await useConsoleTreeStore.getState().fetchTree(WID);

    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual(["x"]);
    expect(useConsoleTreeStore.getState().workspaceItems[WID]).toEqual([]);
  });

  it("records the error and clears loading when the request fails", async () => {
    http.GET.mockRejectedValueOnce(new Error("boom"));

    await useConsoleTreeStore.getState().fetchTree(WID);

    const state = useConsoleTreeStore.getState();
    expect(state.error[WID]).toBe("boom");
    expect(state.loading[WID]).toBeUndefined();
  });
});

describe("consoleTreeStore renameItem", () => {
  it("renames and re-sorts optimistically, before the server answers", async () => {
    seed([file("a", "alpha"), file("c", "charlie")]);
    let release!: (value: unknown) => void;
    http.PATCH.mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve;
      }),
    );

    const pending = useConsoleTreeStore
      .getState()
      .renameItem(WID, "a", "zulu", false);

    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "charlie",
      "zulu",
    ]);
    expect(http.PATCH).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles/{id}/rename",
      {
        params: { path: { workspaceId: WID, id: "a" } },
        body: { name: "zulu" },
      },
    );

    release(ok({ success: true }));
    await expect(pending).resolves.toBe(true);
    expect(http.GET).not.toHaveBeenCalled();
  });

  it("refetches the tree when the server reports success: false", async () => {
    seed([file("a", "alpha")]);
    http.PATCH.mockResolvedValueOnce(ok({ success: false }));
    http.GET.mockResolvedValueOnce(
      ok({ success: true, myConsoles: [file("a", "alpha")] }),
    );

    const result = await useConsoleTreeStore
      .getState()
      .renameItem(WID, "a", "zulu", false);

    expect(result).toBe(false);
    expect(http.GET).toHaveBeenCalledTimes(1);
    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "alpha",
    ]);
  });
});

describe("consoleTreeStore extras", () => {
  it("applyRemoteRename patches the node in place without a request", () => {
    seed([], [folder("f", "shared", [file("a", "alpha"), file("b", "bravo")])]);

    useConsoleTreeStore.getState().applyRemoteRename(WID, "a", "zulu");

    const shared = useConsoleTreeStore.getState().workspaceItems[WID][0];
    expect(names(shared.children ?? [])).toEqual(["bravo", "zulu"]);
    expect(http.PATCH).not.toHaveBeenCalled();
    expect(http.GET).not.toHaveBeenCalled();
  });

  it("addConsole files a saved console under its folder path", () => {
    seed([folder("f", "reports", [file("z", "zeta")])]);

    useConsoleTreeStore.getState().addConsole(WID, "reports/monthly", "m");

    const reports = useConsoleTreeStore.getState().myItems[WID][0];
    expect(names(reports.children ?? [])).toEqual(["monthly", "zeta"]);
    expect(reports.children?.[0]).toMatchObject({
      id: "m",
      path: "reports/monthly",
      isDirectory: false,
    });
  });
});
