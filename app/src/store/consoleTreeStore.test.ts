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
    actionError: {},
    actionNotice: {},
  });
}

/** What openapi-fetch resolves for a refusal with the server's reason. */
const refused = (status: number, error: string) => ({
  data: undefined,
  error: { success: false, error },
  response: { ok: false, status },
});

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

  it("treats HTTP 412 as an empty tree so disconnect clears the explorer", async () => {
    seed([file("a", "stale")], [file("b", "also-stale")]);
    http.GET.mockResolvedValueOnce({
      data: { success: false, error: "GitHub repository required" },
      error: { error: "GitHub repository required" },
      response: { ok: false, status: 412, statusText: "Precondition Failed" },
    });

    await useConsoleTreeStore.getState().fetchTree(WID);

    const state = useConsoleTreeStore.getState();
    expect(names(state.myItems[WID])).toEqual([]);
    expect(state.workspaceItems[WID]).toEqual([]);
    expect(state.error[WID]).toBeNull();
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

  it("coalesces concurrent refreshes for the same workspace", async () => {
    let release!: (value: ReturnType<typeof ok>) => void;
    http.GET.mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve;
      }),
    );

    const first = useConsoleTreeStore.getState().fetchTree(WID);
    const second = useConsoleTreeStore.getState().fetchTree(WID);
    const third = useConsoleTreeStore.getState().fetchTree(WID);

    expect(http.GET).toHaveBeenCalledTimes(1);
    release(ok({ success: true, myConsoles: [file("a", "alpha")] }));
    await Promise.all([first, second, third]);
    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "alpha",
    ]);
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

describe("consoleTreeStore: what the server saved, and what it refused", () => {
  it("shows the name as saved and says so when it is not what was typed", async () => {
    seed([file("a", "alpha")]);
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, data: { id: "a", name: "Q1 - revenue" } }),
    );

    expect(
      await useConsoleTreeStore
        .getState()
        .renameItem(WID, "a", "Q1: revenue", false),
    ).toBe(true);

    const state = useConsoleTreeStore.getState();
    expect(names(state.myItems[WID])).toEqual(["Q1 - revenue"]);
    expect(state.actionNotice[WID]).toBe("Saved as “Q1 - revenue”");
    expect(http.GET).not.toHaveBeenCalled();

    // An inline rename is one name: a slash in it is not a folder path.
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, data: { id: "a", name: "a-b" } }),
    );
    await useConsoleTreeStore.getState().renameItem(WID, "a", "a/b", false);
    expect(http.PATCH).toHaveBeenLastCalledWith(
      "/api/workspaces/{workspaceId}/consoles/{id}/rename",
      {
        params: { path: { workspaceId: WID, id: "a" } },
        body: { name: "a-b" },
      },
    );
    expect(useConsoleTreeStore.getState().actionNotice[WID]).toBe(
      "Saved as “a-b”",
    );
  });

  it("a new folder takes the name the server gave it", async () => {
    http.POST.mockResolvedValueOnce(
      ok({ success: true, data: { id: "f1", name: "Plans - Q1" } }),
    );
    const id = await useConsoleTreeStore
      .getState()
      .createFolder(WID, "Plans: Q1", null, "private");
    expect(id).toBe("f1");
    const state = useConsoleTreeStore.getState();
    expect(names(state.myItems[WID])).toEqual(["Plans - Q1"]);
    expect(state.actionNotice[WID]).toBe("Saved as “Plans - Q1”");
  });

  it("keeps the server's reason when a rename is refused, and puts the tree back", async () => {
    seed([file("a", "alpha"), file("b", "beta")]);
    http.PATCH.mockResolvedValueOnce(
      refused(409, "A console named “beta” already exists."),
    );
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        myConsoles: [file("a", "alpha"), file("b", "beta")],
      }),
    );

    expect(
      await useConsoleTreeStore.getState().renameItem(WID, "a", "Beta", false),
    ).toBe(false);

    const state = useConsoleTreeStore.getState();
    expect(state.actionError[WID]).toBe(
      "A console named “beta” already exists.",
    );
    expect(names(state.myItems[WID])).toEqual(["alpha", "beta"]);
    state.clearActionError(WID);
    expect(useConsoleTreeStore.getState().actionError[WID]).toBeNull();
  });

  it("moves and renames a console in one request and answers where it is", async () => {
    seed([file("a", "alpha")]);
    const location = {
      id: "a",
      name: "ours",
      path: "Team/ours",
      folderId: "f",
      access: "workspace",
    };
    http.PATCH.mockResolvedValueOnce(ok({ success: true, data: location }));
    http.GET.mockResolvedValueOnce(ok({ success: true, myConsoles: [] }));

    expect(
      await useConsoleTreeStore
        .getState()
        .moveConsole(WID, "a", "f", "workspace", "ours"),
    ).toEqual(location);
    expect(http.PATCH).toHaveBeenCalledTimes(1);
    expect(http.PATCH).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles/{id}/move",
      {
        params: { path: { workspaceId: WID, id: "a" } },
        body: { folderId: "f", access: "workspace", name: "ours" },
      },
    );

    http.PATCH.mockResolvedValueOnce(
      refused(
        403,
        "Only the console's owner or a workspace admin can change who sees it.",
      ),
    );
    expect(
      await useConsoleTreeStore.getState().moveConsole(WID, "a", null),
    ).toBeNull();
    expect(useConsoleTreeStore.getState().actionError[WID]).toMatch(
      /owner or a workspace admin/,
    );
  });
});

describe("consoleTreeStore: trash and Undo", () => {
  const trashed = {
    folders: [
      { id: "f", name: "Team", parentId: null, access: "private" as const },
    ],
    consoles: [{ id: "a", name: "alpha", folderId: "f" }],
  };

  it("a folder delete answers what went to the trash; a refused one puts the folder back", async () => {
    seed([folder("f", "Team", [file("a", "alpha")])]);
    http.DELETE.mockResolvedValueOnce(ok({ success: true, data: trashed }));
    expect(await useConsoleTreeStore.getState().trashFolder(WID, "f")).toEqual(
      trashed,
    );
    expect(useConsoleTreeStore.getState().myItems[WID]).toEqual([]);

    seed([folder("f", "Team", [file("a", "alpha")])]);
    http.DELETE.mockResolvedValueOnce(
      refused(403, "This folder holds consoles of other members."),
    );
    http.GET.mockResolvedValueOnce(
      ok({ success: true, myConsoles: [folder("f", "Team")] }),
    );
    expect(
      await useConsoleTreeStore.getState().trashFolder(WID, "f"),
    ).toBeNull();
    const state = useConsoleTreeStore.getState();
    expect(names(state.myItems[WID])).toEqual(["Team"]);
    expect(state.actionError[WID]).toMatch(/other members/);
  });

  it("Undo restores a console and answers the name it came back under", async () => {
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, data: { id: "a", name: "alpha (2)" } }),
    );
    http.GET.mockResolvedValueOnce(
      ok({ success: true, myConsoles: [file("a", "alpha (2)")] }),
    );
    const restored = await useConsoleTreeStore
      .getState()
      .restoreConsole(WID, "a");
    expect(restored?.name).toBe("alpha (2)");
    // In place: no folder is named.
    expect(http.PATCH).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles/{id}/restore",
      { params: { path: { workspaceId: WID, id: "a" } } },
    );
    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "alpha (2)",
    ]);

    http.PATCH.mockResolvedValueOnce(
      refused(
        403,
        "Only the console owner or a workspace admin can restore it",
      ),
    );
    expect(
      await useConsoleTreeStore.getState().restoreConsole(WID, "a"),
    ).toBeNull();
    expect(useConsoleTreeStore.getState().actionError[WID]).toMatch(
      /owner or a workspace admin/,
    );
  });

  it("Undo of a folder recreates it and restores its consoles into it", async () => {
    http.POST.mockResolvedValueOnce(ok({ success: true, data: { id: "f2" } }));
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, data: { id: "a", name: "alpha" } }),
    );
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        myConsoles: [folder("f2", "Team", [file("a", "alpha")])],
      }),
    );

    const outcome = await useConsoleTreeStore
      .getState()
      .restoreFolder(WID, trashed, null);

    expect(outcome).toEqual({
      folderRecreated: true,
      inPlace: 1,
      atRoot: 0,
      failed: 0,
    });
    expect(http.POST).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles/folders",
      {
        params: { path: { workspaceId: WID } },
        body: { name: "Team", parentId: undefined, access: "private" },
      },
    );
    expect(http.PATCH).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles/{id}/restore",
      {
        params: { path: { workspaceId: WID, id: "a" } },
        body: { folderId: "f2" },
      },
    );
    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "Team",
    ]);
  });
});
