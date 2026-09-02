// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsoleRevisionSyncEntry } from "../lib/api-types";
import { computeConsoleStateHash } from "../utils/stateHash";
import {
  hasPendingAgentReview,
  hasUnsavedLocalEdits,
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

describe("consoleStore tabFocusSeq — every focus request counts", () => {
  beforeEach(() => {
    resetConsoleStore();
    useConsoleStore.setState({ tabFocusSeq: 0 });
  });

  it("bumps on open, on a focus of another tab, and on a re-focus of the active tab", () => {
    const store = useConsoleStore.getState();
    const a = store.openTab({ title: "A", content: "", kind: "console" });
    expect(useConsoleStore.getState().tabFocusSeq).toBe(1);
    const b = store.openTab({ title: "B", content: "", kind: "console" });
    expect(useConsoleStore.getState().tabFocusSeq).toBe(2);

    store.setActiveTab(a);
    expect(useConsoleStore.getState().activeTabId).toBe(a);
    expect(useConsoleStore.getState().tabFocusSeq).toBe(3);

    // The mobile shell relies on this: tapping the tree node that is already
    // selected leaves activeTabId alone but must still register as a focus.
    store.setActiveTab(a);
    expect(useConsoleStore.getState().activeTabId).toBe(a);
    expect(useConsoleStore.getState().tabFocusSeq).toBe(4);

    // focusOrOpenTab on an existing match goes through the same counter.
    store.focusOrOpenTab({ kind: "console", where: t => t.id === b });
    expect(useConsoleStore.getState().activeTabId).toBe(b);
    expect(useConsoleStore.getState().tabFocusSeq).toBe(5);
  });

  it("does not count clearing the selection", () => {
    const store = useConsoleStore.getState();
    store.openTab({ title: "A", content: "", kind: "console" });
    const before = useConsoleStore.getState().tabFocusSeq;
    store.setActiveTab(null);
    expect(useConsoleStore.getState().activeTabId).toBeNull();
    expect(useConsoleStore.getState().tabFocusSeq).toBe(before);
  });
});
