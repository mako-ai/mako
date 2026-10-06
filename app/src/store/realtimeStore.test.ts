// @vitest-environment jsdom
/**
 * The revision sync, for a tab with unsaved edits whose console was
 * renamed on a laptop (git mv + push): the edits are not merged (the
 * banner asks), but the tab follows the console's new name and place —
 * it kept the old one while the tree showed the new one, and its next
 * save's snackbar named the old one too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// zustand's `persist` reads `localStorage` at module load (Node 22+ leaves
// the global undefined): give it an in-memory one first.
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

import { api } from "../api";
import { useConsoleStore } from "./consoleStore";
import { useRealtimeStore } from "./realtimeStore";
import { computeConsoleStateHash } from "../utils/stateHash";

const ID = "6ac5395a545a64d5b321f871";
const SAVED = "select 404 as p4_new";
const MINE = "select 404 as p4_new -- NET_DRAFT";

afterEach(() => {
  vi.restoreAllMocks();
  useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
});

describe("revision sync — a laptop rename of a console with unsaved edits", () => {
  it("retargets the tab's name, place and visibility; keeps the edits, the dirty state and the revision base", async () => {
    useConsoleStore.getState().openTab({
      id: ID,
      title: "P4 Draft Rename",
      content: MINE,
      isSaved: true,
      filePath: "P4 Draft Rename",
      access: "private",
      savedStateHash: computeConsoleStateHash(SAVED),
      draftRevision: 3,
      version: 2,
      kind: "console",
    });
    vi.spyOn(api, "POST").mockResolvedValue({
      data: {
        success: true,
        deleted: [],
        changed: [
          {
            id: ID,
            draftRevision: 5,
            name: "P4 Laptop Moved",
            path: "Team/P4 Laptop Moved",
            access: "workspace",
            // The push changed the content too: a real conflict, so the
            // banner, not a silent merge.
            content: "select 404 as p4_new -- LAPTOP",
            isSaved: true,
            version: 3,
          },
        ],
      },
      response: { ok: true, status: 200 },
    } as never);
    useRealtimeStore.setState({ workspaceId: "ws" });

    await useRealtimeStore.getState().syncRevisions();

    const tab = useConsoleStore.getState().tabs[ID];
    expect(tab.title).toBe("P4 Laptop Moved");
    expect(tab.filePath).toBe("Team/P4 Laptop Moved");
    expect(tab.access).toBe("workspace");
    // Mine stays mine, and still unsaved; the banner decides the rest.
    expect(tab.content).toBe(MINE);
    expect(tab.savedStateHash).toBe(computeConsoleStateHash(SAVED));
    expect(tab.draftRevision).toBe(3);
    expect(tab.remoteUpdate).toMatchObject({ draftRevision: 5 });
  });
});

describe("revision sync — a console restored from the trash elsewhere", () => {
  it("drops the tab's 'deleted' banner and takes the restored name and place", async () => {
    useConsoleStore.getState().openTab({
      id: ID,
      title: "Weekly",
      content: SAVED,
      isSaved: true,
      filePath: "Weekly",
      access: "workspace",
      savedStateHash: computeConsoleStateHash(SAVED),
      draftRevision: 3,
      version: 2,
      kind: "console",
    });
    useConsoleStore.getState().setRemoteUpdate(ID, {
      draftRevision: Number.MAX_SAFE_INTEGER,
      kind: "deleted",
    });
    vi.spyOn(api, "POST").mockResolvedValue({
      data: {
        success: true,
        deleted: [],
        changed: [
          {
            id: ID,
            draftRevision: 4,
            name: "Weekly (2)",
            path: "Weekly (2)",
            access: "workspace",
            content: SAVED,
            isSaved: true,
            version: 2,
          },
        ],
      },
      response: { ok: true, status: 200 },
    } as never);
    useRealtimeStore.setState({ workspaceId: "ws" });

    await useRealtimeStore.getState().syncRevisions();

    const tab = useConsoleStore.getState().tabs[ID];
    expect(tab.remoteUpdate ?? null).toBeNull();
    expect(tab.title).toBe("Weekly (2)");
    expect(tab.filePath).toBe("Weekly (2)");
    expect(tab.draftRevision).toBe(4);
  });
});
