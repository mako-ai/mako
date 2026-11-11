// @vitest-environment jsdom
/**
 * An open console tab against what happens to its console elsewhere: a
 * rename or a move in the tree (the tab follows, unsaved edits kept), a
 * revision bump that changed no content (no conflict banner), and a
 * console that is back from the trash (no "deleted" banner).
 */
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

import { computeConsoleStateHash } from "../utils/stateHash";
import { useConsoleStore } from "./consoleStore";
import { useConsoleTreeStore, type ConsoleEntry } from "./consoleTreeStore";
import { dispatchRealtimeEvent } from "./lib/realtime-channel";
import { useRealtimeStore } from "./realtimeStore";

const WID = "ws-1";
const ID = "a".repeat(24);
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

/**
 * The tab's saved-state hash, as the app takes it at a save: from the
 * tab's own fields. The server takes its hash from the committed file,
 * where the database id is filled in from the connection — so the two
 * differ for the very same saved content (`SERVER_HASH` below).
 */
const TAB_HASH = computeConsoleStateHash("SELECT 1", "conn-1");
const SERVER_HASH = computeConsoleStateHash("SELECT 1", "conn-1", "conn-1");

/** A saved console (version 3) open with an edit that is not saved yet. */
function openWithUnsavedEdit(): void {
  useConsoleStore.getState().openTab({
    id: ID,
    title: "Alpha",
    content: "SELECT 1",
    connectionId: "conn-1",
    isSaved: true,
    filePath: "Alpha",
    access: "private",
    savedStateHash: TAB_HASH,
    draftRevision: 3,
    version: 3,
    kind: "console",
  });
  useConsoleStore.getState().updateContent(ID, "SELECT 1 -- typing");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
  useConsoleTreeStore.setState({
    myItems: { [WID]: [file(ID, "Alpha")] },
    workspaceItems: { [WID]: [] },
    actionError: {},
    actionNotice: {},
  });
  useRealtimeStore.setState({ workspaceId: WID, currentUserId: "me" });
});

describe("a tab follows its console in the tree", () => {
  it("takes the new name and path after an inline rename, and keeps the unsaved edit", async () => {
    openWithUnsavedEdit();
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, data: { id: ID, name: "Alpha one" } }),
    );

    await useConsoleTreeStore
      .getState()
      .renameItem(WID, ID, "Alpha one", false);

    const tab = useConsoleStore.getState().tabs[ID];
    expect(tab.title).toBe("Alpha one");
    // Not "Alpha/Alpha one": the old name is not a folder.
    expect(tab.filePath).toBe("Alpha one");
    expect(tab.content).toBe("SELECT 1 -- typing");
    expect(tab.savedStateHash).toBe(TAB_HASH);
  });

  it("takes the folder and the section after a move, and goes back when the move is refused", async () => {
    openWithUnsavedEdit();
    const team: ConsoleEntry = {
      id: "f",
      name: "Team",
      path: "Team",
      isDirectory: true,
      children: [],
    };
    useConsoleTreeStore.setState({
      myItems: { [WID]: [file(ID, "Alpha")] },
      workspaceItems: { [WID]: [team] },
    });
    http.PATCH.mockResolvedValueOnce(ok({ success: true }));
    await useConsoleTreeStore.getState().moveItem(WID, ID, "f", "workspace");
    expect(useConsoleStore.getState().tabs[ID]).toMatchObject({
      title: "Alpha",
      filePath: "Team/Alpha",
      access: "workspace",
      content: "SELECT 1 -- typing",
    });

    http.PATCH.mockResolvedValueOnce({
      data: undefined,
      error: {
        success: false,
        error: "You have read-only access to this console.",
      },
      response: { ok: false, status: 403 },
    });
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        myConsoles: [],
        sharedWithWorkspace: [{ ...team, children: [file(ID, "Alpha")] }],
      }),
    );
    await useConsoleTreeStore.getState().moveItem(WID, ID, null, "private");
    expect(useConsoleStore.getState().tabs[ID]).toMatchObject({
      filePath: "Team/Alpha",
      access: "workspace",
    });
    expect(useConsoleTreeStore.getState().actionError[WID]).toBe(
      "You have read-only access to this console.",
    );
  });
});

describe("the conflict banner is about content, not about a rename or a move", () => {
  /** What revisions-sync answers for the console, as the server builds it. */
  const entry = (overrides: Record<string, unknown> = {}) => ({
    id: ID,
    draftRevision: 4,
    name: "Alpha",
    content: "SELECT 1",
    connectionId: "conn-1",
    databaseId: "conn-1",
    version: 3,
    isSaved: true,
    contentIsSaved: true,
    savedStateHash: SERVER_HASH,
    ...overrides,
  });
  const treeWith = (my: ConsoleEntry[], workspace: ConsoleEntry[] = []) =>
    ok({ success: true, myConsoles: my, sharedWithWorkspace: workspace });

  /**
   * The server's poke for a change, through the realtime channel, and the
   * revision pull it schedules — the path a real rename takes.
   */
  async function serverSays(
    changed: ReturnType<typeof entry>,
    updatedBy = "me",
  ): Promise<void> {
    http.POST.mockResolvedValueOnce(
      ok({ success: true, changed: [changed], deleted: [] }),
    );
    dispatchRealtimeEvent(
      {
        type: "console.updated",
        consoleId: ID,
        draftRevision: changed.draftRevision,
        name: changed.name,
        updatedBy,
        origin: "save",
      },
      { workspaceId: WID, currentUserId: "me" },
    );
    await vi.waitFor(() => expect(http.POST).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const tab = () => useConsoleStore.getState().tabs[ID];
  const expectEditKept = () => {
    expect(tab().content).toBe("SELECT 1 -- typing");
    expect(tab().savedStateHash).toBe(TAB_HASH);
    expect(tab().connectionId).toBe("conn-1");
  };

  it("renaming your own console in the tree with an unsaved edit raises no banner", async () => {
    openWithUnsavedEdit();
    http.PATCH.mockResolvedValueOnce(
      ok({ success: true, data: { id: ID, name: "Alpha one" } }),
    );
    http.GET.mockResolvedValue(treeWith([file(ID, "Alpha one")]));
    await useConsoleTreeStore
      .getState()
      .renameItem(WID, ID, "Alpha one", false);

    await serverSays(entry({ name: "Alpha one" }));

    expect(tab().remoteUpdate ?? null).toBeNull();
    expect(tab()).toMatchObject({
      title: "Alpha one",
      filePath: "Alpha one",
      draftRevision: 4,
      version: 3,
    });
    expectEditKept();
  });

  it("moving your own console with an unsaved edit raises no banner", async () => {
    openWithUnsavedEdit();
    const team: ConsoleEntry = {
      id: "f",
      name: "Team",
      path: "Team",
      isDirectory: true,
      children: [file(ID, "Alpha")],
    };
    http.PATCH.mockResolvedValueOnce(
      ok({
        success: true,
        data: {
          id: ID,
          name: "Alpha",
          path: "Team/Alpha",
          folderId: "f",
          access: "workspace",
        },
      }),
    );
    http.GET.mockResolvedValue(treeWith([], [team]));
    await useConsoleTreeStore.getState().moveConsole(WID, ID, "f", "workspace");

    await serverSays(entry());

    expect(tab().remoteUpdate ?? null).toBeNull();
    expect(tab()).toMatchObject({
      filePath: "Team/Alpha",
      access: "workspace",
      draftRevision: 4,
    });
    expectEditKept();
  });

  it("a reload with the unsaved edit restored, after a rename, raises none — and drops one raised before", async () => {
    // The tab as the browser kept it: the edit, the revision from before
    // the rename, and a banner an earlier build raised for that rename.
    useConsoleStore.setState({
      tabs: {
        [ID]: {
          id: ID,
          title: "Alpha",
          content: "SELECT 1 -- typing",
          connectionId: "conn-1",
          isSaved: true,
          filePath: "Alpha",
          access: "private",
          savedStateHash: TAB_HASH,
          draftRevision: 3,
          version: 3,
          kind: "console",
          remoteUpdate: { draftRevision: 4, kind: "updated" },
        } as never,
      },
      tabOrder: [ID],
      activeTabId: ID,
    });
    http.POST.mockResolvedValueOnce(
      ok({
        success: true,
        changed: [entry({ name: "Alpha one" })],
        deleted: [],
      }),
    );

    // What the reconnect after a reload runs.
    await useRealtimeStore.getState().syncRevisions();

    expect(tab().remoteUpdate ?? null).toBeNull();
    expect(tab()).toMatchObject({ title: "Alpha one", draftRevision: 4 });
    expectEditKept();
  });

  it("a real change of the saved content by someone else still raises it", async () => {
    openWithUnsavedEdit();
    http.GET.mockResolvedValue(treeWith([file(ID, "Alpha")]));

    await serverSays(
      entry({
        content: "SELECT 2",
        version: 4,
        savedStateHash: computeConsoleStateHash("SELECT 2", "conn-1", "conn-1"),
      }),
      "someone-else",
    );

    expect(tab().remoteUpdate).toMatchObject({
      kind: "updated",
      draftRevision: 4,
      updatedBy: "someone-else",
    });
    expect(tab().draftRevision).toBe(3);
    expectEditKept();
  });

  it("so does a draft written over the saved content from another window", async () => {
    openWithUnsavedEdit();
    http.GET.mockResolvedValue(treeWith([file(ID, "Alpha")]));

    // Same saved version, but the server's working copy is not it any more.
    await serverSays(
      entry({ content: "SELECT 1 -- other window", contentIsSaved: false }),
    );

    // One's own other window: "elsewhere", not "another collaborator".
    expect(tab().remoteUpdate).toMatchObject({ kind: "updated" });
    expect(tab().remoteUpdate?.updatedBy).toBeUndefined();
    expectEditKept();
  });

  it("a console that is back from the trash loses its “deleted” banner", async () => {
    openWithUnsavedEdit();
    useConsoleStore.getState().setRemoteUpdate(ID, {
      draftRevision: Number.MAX_SAFE_INTEGER,
      kind: "deleted",
    });
    // Still in the trash: the banner stays.
    http.POST.mockResolvedValueOnce(
      ok({ success: true, changed: [], deleted: [ID] }),
    );
    await useRealtimeStore.getState().syncRevisions();
    expect(tab().remoteUpdate?.kind).toBe("deleted");
    // Restored: the server no longer lists it as deleted.
    http.POST.mockResolvedValueOnce(
      ok({ success: true, changed: [], deleted: [] }),
    );
    await useRealtimeStore.getState().syncRevisions();
    expect(tab().remoteUpdate ?? null).toBeNull();
  });
});
