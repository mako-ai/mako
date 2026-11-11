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

/** A saved console open with an edit that is not saved yet. */
function openWithUnsavedEdit(): void {
  useConsoleStore.getState().openTab({
    id: ID,
    title: "Alpha",
    content: "SELECT 1",
    isSaved: true,
    filePath: "Alpha",
    access: "private",
    savedStateHash: computeConsoleStateHash("SELECT 1"),
    draftRevision: 3,
    version: 1,
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
    expect(tab.savedStateHash).toBe(computeConsoleStateHash("SELECT 1"));
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

describe("a revision that changed no content", () => {
  const entry = (overrides: Record<string, unknown>) => ({
    id: ID,
    draftRevision: 4,
    name: "Alpha one",
    content: "SELECT 1",
    version: 1,
    isSaved: true,
    ...overrides,
  });

  it("a rename of a console with unsaved edits raises no conflict banner", async () => {
    openWithUnsavedEdit();
    http.POST.mockResolvedValueOnce(
      ok({ success: true, changed: [entry({})], deleted: [] }),
    );

    await useRealtimeStore.getState().syncRevisions();

    const tab = useConsoleStore.getState().tabs[ID];
    expect(tab.remoteUpdate ?? null).toBeNull();
    expect(tab.title).toBe("Alpha one");
    expect(tab.draftRevision).toBe(4);
    expect(tab.content).toBe("SELECT 1 -- typing");
  });

  it("a real change of content still does", async () => {
    openWithUnsavedEdit();
    http.POST.mockResolvedValueOnce(
      ok({
        success: true,
        changed: [entry({ content: "SELECT 2" })],
        deleted: [],
      }),
    );
    await useRealtimeStore.getState().syncRevisions();
    const tab = useConsoleStore.getState().tabs[ID];
    expect(tab.remoteUpdate).toMatchObject({
      kind: "updated",
      draftRevision: 4,
    });
    expect(tab.content).toBe("SELECT 1 -- typing");
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
    expect(useConsoleStore.getState().tabs[ID].remoteUpdate?.kind).toBe(
      "deleted",
    );
    // Restored: the server no longer lists it as deleted.
    http.POST.mockResolvedValueOnce(
      ok({ success: true, changed: [], deleted: [] }),
    );
    await useRealtimeStore.getState().syncRevisions();
    expect(useConsoleStore.getState().tabs[ID].remoteUpdate ?? null).toBeNull();
  });
});
