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

// The tab store the tree retargets after a rename/move (imported lazily
// by the tree store): which tabs are open, and what they were told.
const tabs = vi.hoisted(() => ({
  open: {} as Record<string, unknown>,
  retargetConsoleTab: vi.fn(),
}));
vi.mock("./consoleStore", () => ({
  useConsoleStore: {
    getState: () => ({
      tabs: tabs.open,
      retargetConsoleTab: tabs.retargetConsoleTab,
    }),
  },
}));

import { useConsoleTreeStore, type ConsoleEntry } from "./consoleTreeStore";
import { accessForMove } from "./lib/createResourceTreeStore";

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

function seed(
  my: ConsoleEntry[],
  workspace: ConsoleEntry[] = [],
  shared: ConsoleEntry[] = [],
) {
  useConsoleTreeStore.setState({
    myItems: { [WID]: my },
    workspaceItems: { [WID]: workspace },
    sharedItems: { [WID]: shared },
    loading: {},
    error: {},
    actionError: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tabs.open = {};
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

describe("consoleTreeStore — an open tab follows every rename and move", () => {
  const location = (over: Record<string, unknown> = {}) => ({
    id: "a",
    name: "Revenue by Day",
    path: "finance/Revenue by Day",
    folderId: "f",
    access: "workspace",
    draftRevision: 5,
    isSaved: true,
    ...over,
  });

  it("an inline rename retargets the tab (and the row's path) from the server's answer", async () => {
    seed([], [folder("f", "finance", [file("a", "Revenue Daily")])]);
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, console: location() }),
    );

    await expect(
      useConsoleTreeStore
        .getState()
        .renameItem(WID, "a", "Revenue by Day", false),
    ).resolves.toBe(true);

    expect(tabs.retargetConsoleTab).toHaveBeenCalledWith("a", location());
    const row =
      useConsoleTreeStore.getState().workspaceItems[WID][0].children?.[0];
    expect(row?.name).toBe("Revenue by Day");
    expect(row?.path).toBe("finance/Revenue by Day");
  });

  it("a move (drag, Move to…, the editor's dialog) retargets the tab from the server's answer", async () => {
    seed([], [file("a", "Revenue Daily"), folder("f", "finance")]);
    http.PATCH.mockResolvedValueOnce(ok({ success: true, data: location() }));

    await expect(
      useConsoleTreeStore
        .getState()
        .moveItem(WID, "a", "f", undefined, "Revenue by Day"),
    ).resolves.toBe(true);

    expect(http.PATCH).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/consoles/{id}/move",
      {
        params: { path: { workspaceId: WID, id: "a" } },
        body: { folderId: "f", access: undefined, name: "Revenue by Day" },
      },
    );
    expect(tabs.retargetConsoleTab).toHaveBeenCalledWith("a", location());
  });

  it("a refused rename says why (the row used to just snap back)", async () => {
    seed([file("a", "mine"), file("b", "taken")]);
    http.PATCH.mockResolvedValueOnce({
      data: undefined,
      error: {
        success: false,
        error: "A console already exists at consoles/taken.sql",
      },
      response: { ok: false, status: 409, statusText: "Conflict" },
    });
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        myConsoles: [file("a", "mine"), file("b", "taken")],
      }),
    );

    await expect(
      useConsoleTreeStore.getState().renameItem(WID, "a", "taken", false),
    ).resolves.toBe(false);

    expect(useConsoleTreeStore.getState().actionError[WID]).toBe(
      "A console already exists at consoles/taken.sql",
    );
    expect(tabs.retargetConsoleTab).not.toHaveBeenCalled();
    useConsoleTreeStore.getState().clearActionError(WID);
    expect(useConsoleTreeStore.getState().actionError[WID]).toBeNull();
  });

  it("a folder rename re-reads where its open consoles are (location only)", async () => {
    seed(
      [],
      [
        folder("f", "New Folder", [
          file("a", "Revenue"),
          folder("g", "Deep", [file("b", "Deeper")]),
        ]),
        file("c", "Outside"),
      ],
    );
    tabs.open = { a: {}, b: {} };
    http.PATCH.mockResolvedValueOnce(ok({ success: true }));
    http.GET.mockImplementation(async (_url: string, init: unknown) => {
      const id = (init as { params: { query: { id: string } } }).params.query
        .id;
      return ok({
        success: true,
        id,
        name: id === "a" ? "Revenue" : "Deeper",
        path: id === "a" ? "finance/Revenue" : "finance/Deep/Deeper",
        access: "workspace",
        isSaved: true,
        content: "SHOULD NOT BE APPLIED",
      });
    });

    await useConsoleTreeStore.getState().renameItem(WID, "f", "finance", true);
    await vi.waitFor(() =>
      expect(tabs.retargetConsoleTab).toHaveBeenCalledTimes(2),
    );

    expect(tabs.retargetConsoleTab).toHaveBeenCalledWith("a", {
      name: "Revenue",
      path: "finance/Revenue",
      access: "workspace",
      isSaved: true,
    });
    expect(tabs.retargetConsoleTab).toHaveBeenCalledWith("b", {
      name: "Deeper",
      path: "finance/Deep/Deeper",
      access: "workspace",
      isSaved: true,
    });
    // "c" is outside the folder; nothing else was fetched.
    expect(http.GET).toHaveBeenCalledTimes(2);
    http.GET.mockReset();
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

describe("Move to…", () => {
  it("sends access only when the user changed section", () => {
    expect(accessForMove("my", "my")).toBeUndefined();
    expect(accessForMove("workspace", "workspace")).toBeUndefined();
    expect(accessForMove("my", "workspace")).toBe("workspace");
    expect(accessForMove("workspace", "my")).toBe("private");
  });

  it("a refused move snaps the tree back AND keeps the server's reason for the UI", async () => {
    seed([folder("f", "mine", [file("a", "alpha")])], [folder("g", "team")]);
    http.PATCH.mockResolvedValueOnce({
      data: undefined,
      error: {
        success: false,
        error:
          "Only the owner can move a console between private and workspace",
      },
      response: { ok: false, status: 403 },
    });
    http.GET.mockResolvedValueOnce(
      ok({
        myConsoles: [folder("f", "mine", [file("a", "alpha")])],
        sharedWithWorkspace: [folder("g", "team")],
      }),
    );

    const moved = await useConsoleTreeStore
      .getState()
      .moveItem(WID, "a", "g", "workspace");

    expect(moved).toBe(false);
    expect(useConsoleTreeStore.getState().actionError[WID]).toBe(
      "Only the owner can move a console between private and workspace",
    );
    // Snapped back: alpha is in "mine" again, not under "team".
    const mine = useConsoleTreeStore.getState().myItems[WID][0];
    expect(names(mine.children ?? [])).toEqual(["alpha"]);
    expect(http.PATCH).toHaveBeenCalledWith(
      expect.stringContaining("/{id}/move"),
      expect.objectContaining({
        body: { folderId: "g", access: "workspace" },
      }),
    );
  });
});

describe("consoleTreeStore — Shared with me and Duplicate", () => {
  it("lists another member's console shared with me in its own section", async () => {
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        myConsoles: [file("m", "mine")],
        sharedWithWorkspace: [folder("f", "finance", [file("w", "team")])],
        sharedWithMe: [file("s", "Secret Margin")],
      }),
    );
    await useConsoleTreeStore.getState().fetchTree(WID);
    const state = useConsoleTreeStore.getState();
    expect(names(state.sharedItems[WID])).toEqual(["Secret Margin"]);
    // Not under Workspace (the breadcrumb says "Shared with me").
    expect(names(state.workspaceItems[WID])).toEqual(["finance"]);
  });

  it("files a copy of a shared console in My Consoles, in the folder the server chose", async () => {
    seed(
      [folder("mine-td", "Team Drafts")],
      [folder("f", "finance")],
      [file("s", "Secret Margin")],
    );
    http.POST.mockResolvedValueOnce(
      ok({
        success: true,
        data: {
          id: "copy",
          name: "Secret Margin copy",
          folderId: "mine-td",
          owner_id: "editor2",
        },
      }),
    );

    const res = await useConsoleTreeStore.getState().duplicateConsole(WID, "s");

    expect(res).toEqual({ id: "copy", name: "Secret Margin copy" });
    const state = useConsoleTreeStore.getState();
    const teamDrafts = state.myItems[WID][0];
    expect(names(teamDrafts.children ?? [])).toEqual(["Secret Margin copy"]);
    expect(teamDrafts.children?.[0]).toMatchObject({
      path: "Team Drafts/Secret Margin copy",
      access: "private",
      owner_id: "editor2",
    });
    // Never next to the original (Shared with me) nor under Workspace.
    expect(names(state.sharedItems[WID])).toEqual(["Secret Margin"]);
    expect(names(state.workspaceItems[WID])).toEqual(["finance"]);
  });

  it("files a copy at the root of My Consoles when the server says so", async () => {
    seed([], [folder("f", "finance", [file("a", "Alpha")])]);
    http.POST.mockResolvedValueOnce(
      ok({
        success: true,
        data: { id: "copy", name: "Alpha copy", folderId: null },
      }),
    );
    await useConsoleTreeStore.getState().duplicateConsole(WID, "a");
    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "Alpha copy",
    ]);
  });

  it("a failed copy says why (it used to fail silently)", async () => {
    seed([file("a", "Alpha")]);
    http.POST.mockResolvedValueOnce({
      data: undefined,
      error: { success: false, error: "Could not save the copy" },
      response: { ok: false, status: 500 },
    });
    const res = await useConsoleTreeStore.getState().duplicateConsole(WID, "a");
    expect(res).toBeNull();
    expect(useConsoleTreeStore.getState().actionError[WID]).toBe(
      "Could not save the copy",
    );
    expect(names(useConsoleTreeStore.getState().myItems[WID])).toEqual([
      "Alpha",
    ]);
  });
});
