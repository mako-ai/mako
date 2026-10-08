/**
 * Renaming a notebook from its editor sends ONE request.
 *
 * `updateNotebook({ name })` PATCHes the notebook, then mirrors the new
 * name into the explorer tree. It used to do that through the tree store's
 * `renameItem`, which is the REQUEST path — so every editor rename sent a
 * second, identical PATCH (and, since each PATCH is also a git checkpoint,
 * a second commit). The tree now gets a local-only `reflectRename`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  patch: vi.fn(),
  renameItem: vi.fn(),
  reflectRename: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: (...args: unknown[]) => h.patch(...args),
    delete: vi.fn(),
  },
}));
vi.mock("./notebookTreeStore", () => ({
  useNotebookTreeStore: {
    getState: () => ({
      renameItem: h.renameItem,
      reflectRename: h.reflectRename,
      refresh: h.refresh,
    }),
  },
}));
vi.mock("./uiStore", () => ({
  useUIStore: { getState: () => ({ currentWorkspaceId: "ws1" }) },
}));
vi.mock("../lib/realtime-client-id", () => ({ realtimeClientId: "client-1" }));
vi.mock("./lib/realtime-channel", () => ({ onRealtimeEvent: vi.fn() }));

import { useNotebookStore } from "./notebookStore";

describe("notebookStore.updateNotebook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends one PATCH for a rename and reflects the name locally in the tree", async () => {
    const doc = {
      id: "nb-1",
      name: "Renamed",
      blocks: [],
      version: 3,
      updatedAt: new Date().toISOString(),
    };
    h.patch.mockResolvedValue({ data: doc });

    const result = await useNotebookStore
      .getState()
      .updateNotebook("nb-1", { name: "Renamed" }, 2);

    expect(result).toEqual(doc);
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledWith(
      "/workspaces/ws1/notebooks/nb-1",
      expect.objectContaining({ name: "Renamed", expectedVersion: 2 }),
    );
    expect(h.reflectRename).toHaveBeenCalledWith("ws1", "nb-1", "Renamed");
    expect(h.renameItem).not.toHaveBeenCalled();
  });

  it("does not touch the tree when only blocks were saved", async () => {
    h.patch.mockResolvedValue({
      data: { id: "nb-1", name: "Same", blocks: [], version: 4, updatedAt: "" },
    });
    await useNotebookStore.getState().updateNotebook("nb-1", { blocks: [] }, 3);
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.reflectRename).not.toHaveBeenCalled();
    expect(h.renameItem).not.toHaveBeenCalled();
  });
});
