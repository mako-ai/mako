import { describe, expect, it } from "vitest";
import { computeDashboardStateHash } from "../utils/stateHash";
import type { Dashboard } from "../dashboard-runtime/types";
import { foldRemoteRename } from "./dashboard-remote-merge";

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    _id: "d1",
    workspaceId: "w1",
    title: "Untitled Dashboard",
    dataSources: [],
    widgets: [],
    relationships: [],
    globalFilters: [],
    crossFilter: { enabled: true, resolution: "intersect", engine: "mosaic" },
    materializationSchedule: { enabled: false, cron: null },
    layout: { columns: 12, rowHeight: 100 },
    version: 3,
    access: "private",
    createdBy: "u1",
    createdAt: "",
    updatedAt: "",
    ...over,
  } as unknown as Dashboard;
}

describe("foldRemoteRename — a rename reaches an open, edited dashboard", () => {
  const base = dashboard();
  const baseHash = computeDashboardStateHash(base);

  it("takes the server's title and version, keeps the user's unsaved edits", () => {
    // The user edited the draft (a description) without saving…
    const local = dashboard({ description: "my unsaved edit" });
    // …and the dashboard was renamed in the tree (version +1).
    const server = dashboard({ title: "Ops Overview v2", version: 4 });
    const fold = foldRemoteRename(local, server, baseHash);
    expect(fold).toEqual({
      title: "Ops Overview v2",
      version: 4,
      savedHash: computeDashboardStateHash(server),
    });
    // Folded in, the draft is still dirty against the new baseline (its own
    // edit), and carries the NEW title — the next save writes both.
    if (!fold) throw new Error("expected a fold");
    const merged = { ...local, title: fold.title, version: fold.version };
    expect(computeDashboardStateHash(merged)).not.toBe(fold.savedHash);
    expect(merged.title).toBe("Ops Overview v2");
    expect(merged.description).toBe("my unsaved edit");
  });

  it("works for a clean tab in edit mode too", () => {
    const server = dashboard({ title: "Renamed", version: 4 });
    expect(foldRemoteRename(base, server, baseHash)?.title).toBe("Renamed");
  });

  it("refuses when the server changed more than the title (a real concurrent edit: the save's conflict dialog)", () => {
    const local = dashboard({ description: "mine" });
    const server = dashboard({
      title: "Renamed",
      version: 4,
      relationships: [{ id: "r" }] as unknown as Dashboard["relationships"],
    });
    expect(foldRemoteRename(local, server, baseHash)).toBeNull();
  });

  it("refuses when the user renamed it locally too (both renamed: a conflict)", () => {
    const local = dashboard({ title: "My local title" });
    const server = dashboard({ title: "Their title", version: 4 });
    expect(foldRemoteRename(local, server, baseHash)).toBeNull();
  });

  it("ignores a stale or same-version copy, and a tab with no baseline", () => {
    const server = dashboard({ title: "Renamed", version: 3 });
    expect(foldRemoteRename(base, server, baseHash)).toBeNull();
    expect(
      foldRemoteRename(base, dashboard({ title: "x", version: 9 }), undefined),
    ).toBeNull();
  });
});
