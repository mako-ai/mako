import { describe, expect, it } from "vitest";
import {
  APP_FOLDER_ENTITY,
  appRenameRights,
  buildAppTree,
  folderNodeId,
  folderPathFromNodeId,
  parentPathOf,
  resolveAppRef,
  resolveAppRefVia,
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

  it("reads a name typed in NFD as the NFC name it is stored under, as the server does", () => {
    const withCafe = [
      ...list,
      { id: "6aaaed797eb3d8d53c497fc8", slug: "café", path: "apps/café" },
    ];
    expect(resolveAppRef(withCafe, "cafe\u0301")?.path).toBe("apps/café");
    expect(resolveAppRef(withCafe, "apps/cafe\u0301")?.path).toBe("apps/café");
  });
});

describe("resolveAppRef aliases (the server's findAppInSnapshot, mirrored)", () => {
  const live = { id: "6aaaed797eb3d8d53c497fd1", slug: "y", path: "apps/y" };
  const renamed = {
    id: "6aaaed797eb3d8d53c497fd2",
    slug: "x",
    path: "apps/x",
    aliases: ["y", "old", "apps/Sales/old"],
  };
  const list = [live, renamed];

  it("lets a current name beat an alias, always", () => {
    expect(resolveAppRefVia(list, "y")).toEqual({ app: live, via: "current" });
    expect(resolveAppRef(list, "apps/y")).toBe(live);
  });

  it("resolves an alias nothing current claims, bare or with apps/", () => {
    expect(resolveAppRefVia(list, "old")).toEqual({
      app: renamed,
      via: "alias",
    });
    expect(resolveAppRef(list, "apps/old")).toBe(renamed);
    expect(resolveAppRef(list, "/old/")).toBe(renamed);
    // A path alias answers its path forms only.
    expect(resolveAppRef(list, "apps/Sales/old")).toBe(renamed);
    expect(resolveAppRef(list, "Sales/old")).toBe(renamed);
    expect(resolveAppRef(list, "nope")).toBeNull();
  });

  it("resolves an alias two apps claim to neither", () => {
    const other = {
      id: "6aaaed797eb3d8d53c497fd3",
      slug: "z",
      path: "apps/z",
      aliases: ["old"],
    };
    expect(resolveAppRef([...list, other], "old")).toBeNull();
    expect(resolveAppRef([...list, other], "apps/Sales/old")).toBe(renamed);
  });

  it("lets a renamed top-level app keep its link over a nested app that took the bare name", () => {
    const moved = {
      id: "6aaaed797eb3d8d53c497fd4",
      slug: "report-v2",
      path: "apps/report-v2",
      aliases: ["report"],
    };
    const nested = {
      id: "6aaaed797eb3d8d53c497fd5",
      slug: "report",
      path: "apps/Sales/report",
    };
    expect(resolveAppRefVia([moved, nested], "report")).toEqual({
      app: moved,
      via: "alias",
    });
    expect(resolveAppRef([moved, nested], "Sales/report")).toBe(nested);
    expect(resolveAppRef([nested], "report")).toBe(nested);
    // A nested app's path alias never answers the bare name.
    expect(
      resolveAppRef(
        [
          {
            id: "6aaaed797eb3d8d53c497fd6",
            path: "apps/x",
            aliases: ["apps/Sales/report"],
          },
        ],
        "report",
      ),
    ).toBeNull();
  });

  it("treats a bare name several nested apps share as final, with no fall-through to an alias", () => {
    const apps = [
      { id: "6aaaed797eb3d8d53c497fd7", path: "apps/Sales/kpi" },
      { id: "6aaaed797eb3d8d53c497fd8", path: "apps/Ops/kpi" },
      {
        id: "6aaaed797eb3d8d53c497fd9",
        path: "apps/Finance/kpi-v2",
        aliases: ["apps/Finance/kpi"],
      },
    ];
    expect(resolveAppRef(apps, "kpi")).toBeNull();
    expect(resolveAppRef(apps, "Finance/kpi")?.path).toBe(
      "apps/Finance/kpi-v2",
    );
  });
});

describe("appRenameRights (the rename route's rules, mirrored)", () => {
  const me = "u1";
  const member = { userId: me, role: "member" };
  const full = { kind: "full" };

  it("lets a member rename an app they OWN, even once shared with the workspace", () => {
    // createProject makes a new app private and owned by its creator; the
    // owner then shares it with the workspace as viewers.
    const own = {
      id: "a",
      path: "apps/report",
      access: "workspace" as const,
      owner_id: me,
      workspaceRole: "viewer" as const,
    };
    expect(appRenameRights(own, member)).toEqual(full);
    // …and the server, which says so in `canWrite`, agrees.
    expect(appRenameRights({ ...own, canWrite: true }, member)).toEqual(full);
    // A private app of their own too.
    expect(
      appRenameRights({ ...own, access: "private" as const }, member),
    ).toEqual(full);
  });

  it("follows the server's canWrite for a share the list cannot see", () => {
    // Someone else's private app in the WORKSPACE tree, shared with this
    // member as an editor: only the server knows the share.
    const shared = {
      id: "b",
      path: "apps/Sales/b",
      access: "private" as const,
      owner_id: "u2",
    };
    expect(appRenameRights({ ...shared, canWrite: true }, member)).toEqual(
      full,
    );
    expect(appRenameRights({ ...shared, canWrite: false }, member)).toEqual({
      kind: "none",
      reason: expect.stringMatching(/read-only/),
    });
    expect(appRenameRights(shared, member).kind).toBe("none");
  });

  it("falls back to the workspace role without canWrite", () => {
    const app = { id: "c", path: "apps/c", access: "workspace" as const };
    expect(appRenameRights(app, { userId: me, role: "admin" })).toEqual(full);
    expect(appRenameRights(app, member).kind).toBe("none");
    expect(
      appRenameRights({ ...app, workspaceRole: "editor" as const }, member),
    ).toEqual(full);
    expect(
      appRenameRights(
        { ...app, workspaceRole: "editor" as const },
        { userId: me, role: "viewer" },
      ).kind,
    ).toBe("none");
  });

  it("offers the NAME only where the tree rule locks the link: someone else's personal folder", () => {
    // u2's personal app, shared with u1 as an editor: the server renames
    // its title (canWriteResource) but refuses a folder move out of u2's
    // tree (authorizeAppMove).
    const theirs = {
      id: "e",
      path: "users/u2/apps/theirs",
      access: "private" as const,
      owner_id: "u2",
      canWrite: true,
    };
    expect(
      appRenameRights(theirs, {
        ...member,
        nameOf: id => (id === "u2" ? "ana@example.com" : undefined),
      }),
    ).toEqual({
      kind: "title",
      linkReason: "Only ana@example.com can change this app's link.",
    });
    // No name to show: still title only.
    expect(appRenameRights(theirs, member)).toEqual({
      kind: "title",
      linkReason: "Only its owner can change this app's link.",
    });
    // Shared as a viewer: nothing at all.
    expect(appRenameRights({ ...theirs, canWrite: false }, member).kind).toBe(
      "none",
    );
    // The owner, in their own folder, whatever their workspace role: all.
    expect(
      appRenameRights(
        { id: "d", path: `users/${me}/apps/scratch`, canWrite: true },
        { userId: me, role: "viewer" },
      ),
    ).toEqual(full);
  });

  it("offers the NAME only to a writer whose role does not organise the Workspace tree", () => {
    expect(
      appRenameRights(
        { id: "f", path: "apps/f", canWrite: true },
        { userId: me, role: "viewer" },
      ),
    ).toEqual({
      kind: "title",
      linkReason: "Only workspace editors can change this app's link.",
    });
  });
});
