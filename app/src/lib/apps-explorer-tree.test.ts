import { describe, expect, it } from "vitest";
import {
  APP_FOLDER_ENTITY,
  buildAppTree,
  folderNodeId,
  folderPathFromNodeId,
  parentPathOf,
  resolveAppRef,
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

describe("resolveAppRef", () => {
  const list = [
    { id: "5ae23997208465e4541cd59d", slug: "report", path: "apps/report" },
    {
      id: "6aaaed797eb3d8d53c497fc3",
      slug: "report",
      path: "apps/Sales/report",
    },
    {
      id: "6aaaed797eb3d8d53c497fc4",
      slug: "daily",
      path: "apps/Sales/CH/daily",
    },
    {
      id: "6aaaed797eb3d8d53c497fc5",
      slug: "scratch",
      path: "users/u1/apps/scratch",
    },
    // A legacy row: no path yet, so it sits at apps/<slug>.
    { id: "6aaaed797eb3d8d53c497fc6", slug: "legacy" },
  ];

  it("resolves a 24-hex id regardless of case", () => {
    expect(resolveAppRef(list, "6AAAED797EB3D8D53C497FC4")?.slug).toBe("daily");
  });

  it("resolves a repo path with or without the leading apps/", () => {
    expect(resolveAppRef(list, "apps/Sales/CH/daily")?.slug).toBe("daily");
    expect(resolveAppRef(list, "Sales/CH/daily")?.slug).toBe("daily");
    expect(resolveAppRef(list, "/users/u1/apps/scratch/")?.slug).toBe(
      "scratch",
    );
  });

  it("resolves a bare slug only when it is unique, else the top-level app", () => {
    expect(resolveAppRef(list, "daily")?.path).toBe("apps/Sales/CH/daily");
    expect(resolveAppRef(list, "legacy")?.id).toBe("6aaaed797eb3d8d53c497fc6");
    // Two apps named "report": the top-level one wins, as on the server.
    expect(resolveAppRef(list, "report")?.path).toBe("apps/report");
  });

  it("refuses an ambiguous nested slug rather than guessing", () => {
    const nestedOnly = list.filter(a => a.path !== "apps/report");
    expect(
      resolveAppRef(
        [
          ...nestedOnly,
          {
            id: "6aaaed797eb3d8d53c497fc7",
            slug: "report",
            path: "apps/Ops/report",
          },
        ],
        "report",
      ),
    ).toBeNull();
    expect(resolveAppRef(list, "")).toBeNull();
    expect(resolveAppRef(list, "nope")).toBeNull();
  });
});
