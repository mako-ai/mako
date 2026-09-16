import { describe, expect, it } from "vitest";
import {
  APP_FOLDER_ENTITY,
  buildAppTree,
  folderNodeId,
  folderPathFromNodeId,
  parentPathOf,
} from "./apps-explorer-tree";

const apps = [
  { id: "a1", title: "Zeta", path: "apps/zeta" },
  { id: "a2", title: "Daily tracker", path: "apps/Sales/CH/daily" },
  { id: "a3", title: "Alpha", path: "apps/alpha" },
  { id: "a4", title: "Scratch", path: "users/u1/apps/scratch" },
  { id: "a5", title: "Report", path: "apps/Sales/report" },
];

describe("buildAppTree", () => {
  it("nests apps under their folders, folders first, both alphabetical", () => {
    const tree = buildAppTree({
      root: "apps",
      folders: ["apps/Sales", "apps/Sales/CH", "apps/Empty"],
      apps,
    });
    expect(tree.map(n => [n.name, n.entityType ?? "app"])).toEqual([
      ["Empty", APP_FOLDER_ENTITY],
      ["Sales", APP_FOLDER_ENTITY],
      ["Alpha", "app"],
      ["Zeta", "app"],
    ]);
    const sales = tree[1];
    expect(sales.id).toBe(folderNodeId("apps/Sales"));
    expect(sales.children?.map(n => n.name)).toEqual(["CH", "Report"]);
    expect(sales.children?.[0].children?.map(n => n.id)).toEqual(["a2"]);
    // Nothing from the other tree leaks in.
    expect(JSON.stringify(tree)).not.toContain("a4");
  });

  it("creates a folder an app implies even when the folder list lags", () => {
    const tree = buildAppTree({
      root: "apps",
      folders: [],
      apps: [{ id: "x", title: "X", path: "apps/Ops/Late/x" }],
    });
    expect(tree[0].name).toBe("Ops");
    expect(tree[0].children?.[0].name).toBe("Late");
    expect(tree[0].children?.[0].children?.[0].id).toBe("x");
  });

  it("builds a personal tree from users/<id>/apps", () => {
    const tree = buildAppTree({
      root: "users/u1/apps",
      folders: ["users/u1/apps/Drafts"],
      apps,
      appChildren: id => (id === "a4" ? [] : undefined),
    });
    expect(tree.map(n => n.name)).toEqual(["Drafts", "Scratch"]);
    expect(tree[1].children).toEqual([]);
    expect(tree[1].isDirectory).toBe(true);
  });

  it("round-trips folder node ids and knows parents", () => {
    expect(folderPathFromNodeId(folderNodeId("apps/Sales/CH"))).toBe(
      "apps/Sales/CH",
    );
    expect(folderPathFromNodeId("a1")).toBeNull();
    expect(parentPathOf("apps/Sales/CH")).toBe("apps/Sales");
    expect(parentPathOf("apps")).toBe("");
  });
});
