// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists through zustand's `persist`, which reads the global
// `localStorage` once at module load. Node 22+ defines that global but
// leaves it `undefined` without `--localstorage-file` (and it shadows
// jsdom's), so every write threw; give it an in-memory one before the store
// module is evaluated (hoisted above the imports).
vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
      key: (i: number) => [...memory.keys()][i] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
});

import type { ConsoleRevisionSyncEntry } from "../lib/api-types";
import { api } from "../api";
import { apiClient } from "../lib/api-client";
import { computeConsoleStateHash } from "../utils/stateHash";
import {
  hasPendingAgentReview,
  hasUnsavedLocalEdits,
  remoteEntryMatchesBaseline,
  useConsoleStore,
} from "./consoleStore";

function resetConsoleStore(): void {
  useConsoleStore.setState({
    tabs: {},
    tabOrder: [],
    activeTabId: null,
    loading: {},
    error: {},
  });
  localStorage.clear();
}

function openSavedConsole(params: {
  id: string;
  content: string;
  savedStateHash?: string;
  draftRevision?: number;
  version?: number;
}): void {
  useConsoleStore.getState().openTab({
    id: params.id,
    title: "Saved console",
    content: params.content,
    isSaved: true,
    filePath: "Saved console",
    savedStateHash: params.savedStateHash,
    draftRevision: params.draftRevision ?? 1,
    version: params.version ?? 1,
    kind: "console",
  });
}

function agentEntry(
  id: string,
  content: string,
  overrides: Partial<ConsoleRevisionSyncEntry> = {},
): ConsoleRevisionSyncEntry {
  return {
    id,
    content,
    draftRevision: 2,
    isSaved: true,
    version: 1,
    lastDraftOrigin: "agent",
    ...overrides,
  };
}

describe("consoleStore saved baseline reconciliation", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("keeps Save enabled after accepting an agent draft for a saved console", async () => {
    const id = "agent-accept-console";
    const baseContent = "select 1;";
    const agentContent = "select 2;";
    const savedStateHash = computeConsoleStateHash(baseContent);
    openSavedConsole({ id, content: baseContent, savedStateHash });

    useConsoleStore
      .getState()
      .beginAgentReview(agentEntry(id, agentContent, { savedStateHash }));
    await useConsoleStore
      .getState()
      .resolveAgentReview("workspace", id, "accept");

    const tab = useConsoleStore.getState().tabs[id];
    // The accepted content is adopted as the working draft...
    expect(tab.content).toBe(agentContent);
    expect(tab.draftRevision).toBe(2);
    // ...but the explicit-save baseline is NOT advanced to the agent draft.
    // (Regression guard: this used to be set to hash(agentContent), which made
    // hasUnsavedChanges false → Save disabled → no way to checkpoint into
    // version history.)
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(computeConsoleStateHash(tab.content)).not.toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("clears the pending agent review on accept", async () => {
    const id = "agent-accept-clears-review";
    const savedStateHash = computeConsoleStateHash("select 1;");
    openSavedConsole({ id, content: "select 1;", savedStateHash });

    useConsoleStore
      .getState()
      .beginAgentReview(agentEntry(id, "select 2;", { savedStateHash }));
    expect(hasPendingAgentReview(id)).toBe(true);

    await useConsoleStore
      .getState()
      .resolveAgentReview("workspace", id, "accept");
    expect(hasPendingAgentReview(id)).toBe(false);
  });

  it("does not advance the saved baseline on a same-content agent sync echo", () => {
    const id = "agent-echo-console";
    const savedContent = "select 1;";
    const agentContent = "select 2;";
    const savedStateHash = computeConsoleStateHash(savedContent);
    openSavedConsole({ id, content: agentContent, savedStateHash });

    useConsoleStore.getState().beginAgentReview(agentEntry(id, agentContent));

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.draftRevision).toBe(2);
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("keeps legacy agent drafts dirty when no saved baseline hash exists", () => {
    const id = "agent-legacy-console";
    const agentContent = "select 2;";
    openSavedConsole({
      id,
      content: agentContent,
    });
    useConsoleStore.getState().updateSavedState(id, true, undefined);

    useConsoleStore.getState().beginAgentReview(agentEntry(id, agentContent));

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.draftRevision).toBe(2);
    expect(tab.savedStateHash).toBeUndefined();
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("preserves a server-provided saved baseline when opening a saved console", () => {
    // Reload / re-open: the server returns the LAST EXPLICIT-SAVE hash, not the
    // mutable draft. An agent draft sitting on top of it must read dirty.
    const id = "agent-reload-console";
    const savedContent = "select 1;";
    const agentDraftContent = "select 2;";
    const savedStateHash = computeConsoleStateHash(savedContent);

    openSavedConsole({ id, content: agentDraftContent, savedStateHash });

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.savedStateHash).toBe(savedStateHash);
    expect(computeConsoleStateHash(tab.content)).not.toBe(savedStateHash);
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });

  it("does not synthesize a saved baseline for server-loaded legacy agent drafts", () => {
    const id = "agent-server-open-console";
    useConsoleStore.getState().openTab(
      {
        id,
        title: "Legacy agent draft",
        content: "select 2;",
        isSaved: true,
        filePath: "Legacy agent draft",
        draftRevision: 2,
        version: 1,
        kind: "console",
      },
      { preserveMissingSavedStateHash: true },
    );

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.savedStateHash).toBeUndefined();
    expect(hasUnsavedLocalEdits(id)).toBe(true);
  });
});

describe("consoleStore preview-tab invariant (kind-agnostic)", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  function openApp(id: string, appId: string): string {
    return useConsoleStore.getState().openTab({
      id,
      title: appId,
      content: "",
      kind: "app",
      metadata: { appId },
    });
  }

  it("opening a second app replaces the first app's preview tab", () => {
    openApp("a1", "app-1");
    openApp("a2", "app-2");
    expect(useConsoleStore.getState().tabOrder).toEqual(["a2"]);
    expect(useConsoleStore.getState().tabs.a1).toBeUndefined();
  });

  it("a pinned app tab is never replaced", () => {
    openApp("a1", "app-1");
    useConsoleStore.getState().updateDirty("a1", true);
    openApp("a2", "app-2");
    expect(useConsoleStore.getState().tabOrder).toEqual(["a1", "a2"]);
  });

  it("the preview tab is replaced across kinds — a console preview by an app", () => {
    useConsoleStore.getState().openTab({
      id: "c1",
      title: "Untitled",
      content: "",
      kind: "console",
    });
    openApp("a1", "app-1");
    expect(useConsoleStore.getState().tabOrder).toEqual(["a1"]);
  });

  it("replacePristine: false keeps the existing preview tab", () => {
    openApp("a1", "app-1");
    useConsoleStore
      .getState()
      .openTab(
        { id: "n1", title: "Notebook", content: "", kind: "notebook" },
        { replacePristine: false },
      );
    expect(useConsoleStore.getState().tabOrder).toEqual(["a1", "n1"]);
  });

  it("re-opening an existing tab id never counts itself as the pristine victim", () => {
    openApp("a1", "app-1");
    openApp("a1", "app-1");
    expect(useConsoleStore.getState().tabOrder).toEqual(["a1"]);
  });
});

describe("consoleStore focusOrOpenTab — the one open-or-focus primitive", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("opens when nothing matches, focuses (without reopening) when it does", () => {
    const store = useConsoleStore.getState();
    const first = store.focusOrOpenTab(
      { kind: "dashboard", metadata: { dashboardId: "d1" } },
      () => ({
        title: "Sales",
        content: "",
        kind: "dashboard",
        metadata: { dashboardId: "d1" },
      }),
    );
    expect(first).not.toBeNull();
    const again = store.focusOrOpenTab(
      { kind: "dashboard", metadata: { dashboardId: "d1" } },
      () => ({
        title: "Sales",
        content: "",
        kind: "dashboard",
        metadata: { dashboardId: "d1" },
      }),
    );
    expect(again).toBe(first);
    expect(useConsoleStore.getState().tabOrder).toEqual([first]);
    expect(useConsoleStore.getState().activeTabId).toBe(first);
  });

  it("matches on kind AND every listed metadata key", () => {
    const store = useConsoleStore.getState();
    const a = store.focusOrOpenTab(
      { kind: "app-file", metadata: { appId: "a", path: "x.ts" } },
      () => ({
        title: "x.ts",
        content: "",
        kind: "app-file",
        metadata: { appId: "a", path: "x.ts" },
      }),
    );
    useConsoleStore.getState().updateDirty(a as string, true);
    const b = store.focusOrOpenTab(
      { kind: "app-file", metadata: { appId: "a", path: "y.ts" } },
      () => ({
        title: "y.ts",
        content: "",
        kind: "app-file",
        metadata: { appId: "a", path: "y.ts" },
      }),
    );
    expect(b).not.toBe(a);
    // Same metadata, different kind: not the same entity.
    const c = store.focusOrOpenTab(
      { kind: "app-diff", metadata: { appId: "a", path: "x.ts" } },
      () => ({
        title: "x.ts (diff)",
        content: "",
        kind: "app-diff",
        metadata: { appId: "a", path: "x.ts" },
      }),
    );
    expect(c).not.toBe(a);
  });

  it("is 'focus if present' when create is omitted", () => {
    const store = useConsoleStore.getState();
    expect(
      store.focusOrOpenTab({ kind: "plan", metadata: { chatId: "c" } }),
    ).toBeNull();
    expect(useConsoleStore.getState().tabOrder).toEqual([]);
  });

  it("refreshes the title of an existing tab and can pin it", () => {
    const store = useConsoleStore.getState();
    const id = store.focusOrOpenTab(
      { kind: "app", metadata: { appId: "a" } },
      () => ({
        title: "Old",
        content: "",
        kind: "app",
        metadata: { appId: "a" },
      }),
    ) as string;
    store.focusOrOpenTab({ kind: "app", metadata: { appId: "a" } }, undefined, {
      title: "New",
      pin: true,
    });
    expect(useConsoleStore.getState().tabs[id].title).toBe("New");
    expect(useConsoleStore.getState().tabs[id].isDirty).toBe(true);
  });

  it("supports a predicate for identity that is not in metadata", () => {
    const store = useConsoleStore.getState();
    const id = store.focusOrOpenTab(
      { kind: "connectors", where: t => t.content === "cx1" },
      () => ({ title: "Connector", content: "cx1", kind: "connectors" }),
    );
    const again = store.focusOrOpenTab(
      { kind: "connectors", where: t => t.content === "cx1" },
      () => ({ title: "Connector", content: "cx1", kind: "connectors" }),
    );
    expect(again).toBe(id);
  });
});

describe("consoleStore — a rename or move retargets an open tab", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  function openRenamable(id: string, content = "select 1 as revenue") {
    useConsoleStore.getState().openTab({
      id,
      title: "Revenue Daily",
      content,
      isSaved: true,
      filePath: "Revenue Daily",
      access: "workspace",
      savedStateHash: computeConsoleStateHash("select 1 as revenue"),
      draftRevision: 4,
      version: 2,
      isDirty: true,
      kind: "console",
    });
  }

  it("takes the server's name, place and visibility — never the content, the dirty flag or the saved baseline", () => {
    const id = "c-retarget";
    openRenamable(id, "select 1 as revenue -- unsaved edit");
    const before = useConsoleStore.getState().tabs[id];

    useConsoleStore.getState().retargetConsoleTab(id, {
      name: "Revenue by Day",
      path: "finance/Revenue by Day",
      access: "workspace",
      isSaved: true,
      draftRevision: 5,
    });

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.title).toBe("Revenue by Day");
    expect(tab.filePath).toBe("finance/Revenue by Day");
    expect(tab.access).toBe("workspace");
    // The rename's own bump on top of this tab's base: adopted, so the next
    // save is not a false conflict.
    expect(tab.draftRevision).toBe(5);
    expect(tab.content).toBe("select 1 as revenue -- unsaved edit");
    expect(tab.savedStateHash).toBe(before.savedStateHash);
    expect(tab.isDirty).toBe(true);
    expect(tab.version).toBe(2);
  });

  it("leaves the revision alone when more than the rename happened since this tab's base", () => {
    const id = "c-gap";
    openRenamable(id);
    useConsoleStore.getState().retargetConsoleTab(id, {
      name: "Renamed",
      draftRevision: 9,
    });
    expect(useConsoleStore.getState().tabs[id].draftRevision).toBe(4);
    expect(useConsoleStore.getState().tabs[id].title).toBe("Renamed");
  });

  it("never gives a draft a path (its first save must still ask where)", () => {
    const id = "c-draft";
    useConsoleStore.getState().openTab({
      id,
      title: "Untitled",
      content: "select 1",
      isSaved: false,
      kind: "console",
    });
    useConsoleStore.getState().retargetConsoleTab(id, {
      name: "Renamed draft",
      path: "Renamed draft",
      isSaved: false,
    });
    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.title).toBe("Renamed draft");
    expect(tab.filePath).toBeUndefined();
  });

  it("ignores tabs of other kinds sharing nothing but an id shape", () => {
    useConsoleStore.getState().openTab({
      id: "app-tab",
      title: "My App",
      content: "",
      kind: "app",
    });
    useConsoleStore.getState().retargetConsoleTab("app-tab", { name: "x" });
    expect(useConsoleStore.getState().tabs["app-tab"].title).toBe("My App");
  });
});

describe("consoleStore — the user's own rename with unsaved edits is not a conflict", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("recognises a server copy whose content is still the tab's baseline", () => {
    const id = "c-baseline";
    const saved = "select 1 as revenue";
    useConsoleStore.getState().openTab({
      id,
      title: "Revenue Daily",
      content: `${saved} -- DRAFT TWO (never saved)`,
      isSaved: true,
      filePath: "Revenue Daily",
      savedStateHash: computeConsoleStateHash(saved),
      draftRevision: 4,
      kind: "console",
    });
    expect(hasUnsavedLocalEdits(id)).toBe(true);
    // The rename bumped the revision; the server's content did not move.
    expect(remoteEntryMatchesBaseline({ id, content: saved })).toBe(true);
    // Someone else's save did move it.
    expect(remoteEntryMatchesBaseline({ id, content: "select 2" })).toBe(false);
  });

  it("fastForwardRemoteMetadata adopts name/place/revision and keeps every local edit, with no banner", () => {
    const id = "c-meta";
    const saved = "select 1 as revenue";
    useConsoleStore.getState().openTab({
      id,
      title: "Revenue Daily",
      content: `${saved} -- unsaved`,
      isSaved: true,
      filePath: "Revenue Daily",
      access: "private",
      savedStateHash: computeConsoleStateHash(saved),
      connectionId: "conn-local-choice",
      draftRevision: 4,
      kind: "console",
    });
    useConsoleStore.getState().setRemoteUpdate(id, {
      draftRevision: 5,
      updatedBy: "me",
      kind: "updated",
    });

    useConsoleStore.getState().fastForwardRemoteMetadata({
      id,
      content: saved,
      draftRevision: 5,
      name: "Revenue by Day",
      path: "finance/Revenue by Day",
      access: "workspace",
      isSaved: true,
      version: 1,
    });

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.title).toBe("Revenue by Day");
    expect(tab.filePath).toBe("finance/Revenue by Day");
    expect(tab.access).toBe("workspace");
    expect(tab.draftRevision).toBe(5);
    expect(tab.content).toBe(`${saved} -- unsaved`);
    expect(tab.connectionId).toBe("conn-local-choice");
    expect(tab.savedStateHash).toBe(computeConsoleStateHash(saved));
    expect(tab.remoteUpdate).toBeNull();
  });

  it("a clean tab's fast-forward also takes the new place", () => {
    const id = "c-clean";
    openSavedConsole({
      id,
      content: "select 1",
      savedStateHash: computeConsoleStateHash("select 1"),
      draftRevision: 1,
    });
    useConsoleStore.getState().fastForwardRemoteConsoleEntry({
      id,
      content: "select 1",
      draftRevision: 2,
      name: "Renamed",
      path: "Team/Renamed",
      access: "workspace",
      isSaved: true,
    });
    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.title).toBe("Renamed");
    expect(tab.filePath).toBe("Team/Renamed");
    expect(tab.access).toBe("workspace");
  });
});

describe("consoleStore.saveConsole — a save is not a move", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("keepPlace sends no path and no access (a stale tab path can never move the console back)", async () => {
    const id = "c-save";
    openSavedConsole({ id, content: "select 1", draftRevision: 3 });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, version: 2, draftRevision: 4 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await useConsoleStore
        .getState()
        .saveConsole(
          "ws",
          id,
          "select 2",
          "Revenue Daily",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "",
          "workspace",
          { keepPlace: true },
        );
      expect(res.success).toBe(true);
      const body = JSON.parse(
        (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1]
          .body,
      ) as Record<string, unknown>;
      expect(body.path).toBeUndefined();
      expect(body.access).toBeUndefined();
      expect(body.isPrivate).toBeUndefined();
      expect(body.isSaved).toBe(true);
      expect(body.content).toBe("select 2");
      expect(body.expectedDraftRevision).toBe(3);

      // A first save still places it.
      await useConsoleStore
        .getState()
        .saveConsole(
          "ws",
          id,
          "select 2",
          "Team/x",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "",
          "private",
        );
      const first = JSON.parse(
        (fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1]
          .body,
      ) as Record<string, unknown>;
      expect(first.path).toBe("Team/x");
      expect(first.access).toBe("private");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("consoleStore.reloadConsoleFromServer — after a version restore", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("puts the restored text in the tab AND the editor, clean, and closes no other tab", async () => {
    const id = "c-restored";
    const before = "SELECT 1 AS a1_test, 2 AS b, 3 AS c";
    const restored = "SELECT 1 AS a1_test";
    openSavedConsole({
      id,
      content: before,
      savedStateHash: computeConsoleStateHash(before),
      draftRevision: 6,
    });
    // A pristine (preview) tab: reopening the console used to replace it.
    useConsoleStore.getState().openTab(
      {
        id: "c-other",
        title: "Ghost.sql",
        content: "select 2",
        isSaved: true,
        filePath: "New Folder/Ghost.sql",
        kind: "console",
      },
      { replacePristine: false },
    );
    useConsoleStore.getState().setActiveTab(id);

    const get = vi.spyOn(api, "GET").mockResolvedValue({
      data: {
        success: true,
        id,
        name: "Alpha Two",
        path: "finance/Alpha Two",
        content: restored,
        isSaved: true,
        access: "workspace",
        draftRevision: 8,
      },
      response: new Response(null, { status: 200 }),
    } as never);
    const shown: Array<{ consoleId: string; content: string }> = [];
    const onRemote = (e: Event) =>
      shown.push(
        (e as CustomEvent<{ consoleId: string; content: string }>).detail,
      );
    window.addEventListener("console-remote-content", onRemote);
    try {
      const ok = await useConsoleStore
        .getState()
        .reloadConsoleFromServer("ws", id);
      expect(ok).toBe(true);
    } finally {
      window.removeEventListener("console-remote-content", onRemote);
      get.mockRestore();
    }

    const tab = useConsoleStore.getState().tabs[id];
    expect(tab.content).toBe(restored);
    // Clean: the saved baseline is the restored text (Save disabled is
    // right only because the editor shows that text too).
    expect(tab.savedStateHash).toBe(computeConsoleStateHash(restored));
    expect(tab.draftRevision).toBe(8);
    expect(tab.filePath).toBe("finance/Alpha Two");
    // The mounted editor is told to show it.
    expect(shown).toEqual([{ consoleId: id, content: restored }]);
    expect(useConsoleStore.getState().tabs["c-other"]).toBeDefined();
    expect(useConsoleStore.getState().activeTabId).toBe(id);
  });
});

describe("consoleStore.autoSaveConsole — only a console id is saved through the console route", () => {
  beforeEach(() => {
    resetConsoleStore();
  });

  it("never PUTs an app binding open in the console editor (it has no tab, and its own save)", async () => {
    vi.useFakeTimers();
    const put = vi
      .spyOn(apiClient, "putWithStatus")
      .mockResolvedValue({ status: 200, body: { success: true } } as never);
    try {
      const store = useConsoleStore.getState();
      // The binding editor's id: no tab, so "not saved" — it used to
      // autosave on mount and commit a stray Workspace console.
      store.autoSaveConsole(
        "ws",
        "binding:6ac5395a545a64d5b321f871:bindings/orders.sql",
        "SELECT * FROM orders",
        "orders.sql",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(put).not.toHaveBeenCalled();

      // A new console's draft (an ObjectId) still autosaves.
      const draft = "6ac5395a545a64d5b321f872";
      store.openTab({
        id: draft,
        title: "Untitled",
        content: "",
        kind: "console",
      });
      store.autoSaveConsole("ws", draft, "SELECT 1", "Untitled");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(put).toHaveBeenCalledTimes(1);
      expect((put.mock.calls[0] as unknown[])[0]).toBe(
        `/workspaces/ws/consoles/${draft}`,
      );
    } finally {
      put.mockRestore();
      vi.useRealTimers();
    }
  });
});
