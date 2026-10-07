import { describe, expect, it } from "vitest";
import type { ConsoleEntry } from "../store/consoleTreeStore";
import {
  consoleNameProblem,
  consoleNameTakenBy,
  consoleCopiedNotice,
  consoleNameTakenMessage,
  consolePlacement,
  consoleRestoredNotice,
  consoleSavedNotice,
  consoleSectionLabel,
  renameMoveNotice,
  renameMoveRequest,
  treeMoveNotice,
  locateInConsoleTree,
  relocationScope,
} from "./console-relocation";

const file = (id: string, name: string): ConsoleEntry => ({
  id,
  name,
  path: name,
  isDirectory: false,
});
const folder = (
  id: string,
  name: string,
  children: ConsoleEntry[],
): ConsoleEntry => ({ id, name, path: name, isDirectory: true, children });

const my = [folder("f-mine", "Drafts", [file("c-draft", "Draft")])];
const workspace = [
  folder("f-fin", "finance", [
    folder("f-q", "Quarterly", [file("c-q", "Q3")]),
    file("c-rev", "Revenue Daily"),
  ]),
  file("c-root", "Revenue Final"),
];

describe("locateInConsoleTree — the dialog opens on the console's real place", () => {
  it("finds a Workspace console at the root (the dialog used to preselect My Consoles)", () => {
    expect(locateInConsoleTree(my, workspace, "c-root")).toEqual({
      section: "workspace",
      folderId: null,
    });
  });

  it("finds its parent folder at any depth, in either section", () => {
    expect(locateInConsoleTree(my, workspace, "c-q")).toEqual({
      section: "workspace",
      folderId: "f-q",
    });
    expect(locateInConsoleTree(my, workspace, "c-rev")).toEqual({
      section: "workspace",
      folderId: "f-fin",
    });
    expect(locateInConsoleTree(my, workspace, "c-draft")).toEqual({
      section: "my",
      folderId: "f-mine",
    });
  });

  it("says nothing for a console the tree does not list", () => {
    expect(locateInConsoleTree(my, workspace, "nope")).toBeNull();
  });
});

describe("consoleNameTakenBy — a clash is refused, never 'replaced'", () => {
  const tree = { my, workspace };

  it("sees a console of that name in the chosen folder, case-insensitively", () => {
    expect(
      consoleNameTakenBy(tree, "workspace", "f-fin", "revenue daily")?.id,
    ).toBe("c-rev");
    expect(
      consoleNameTakenBy(tree, "workspace", null, "Revenue Final")?.id,
    ).toBe("c-root");
  });

  it("is not a clash with itself (a rename in place, a no-op move)", () => {
    expect(
      consoleNameTakenBy(tree, "workspace", "f-fin", "Revenue Daily", "c-rev"),
    ).toBeNull();
  });

  it("only looks in the chosen section: a private root and the workspace root are different folders", () => {
    expect(consoleNameTakenBy(tree, "my", null, "Revenue Final")).toBeNull();
  });

  it("ignores folders of that name", () => {
    expect(consoleNameTakenBy(tree, "workspace", null, "finance")).toBeNull();
  });
});

describe("relocationScope — the server's visibility rule, as the dialog applies it", () => {
  it("the owner or an admin may move it anywhere", () => {
    const spot = { section: "workspace" as const, folderId: null };
    expect(relocationScope({ isOwner: true, isAdmin: false, spot }).kind).toBe(
      "anywhere",
    );
    expect(relocationScope({ isOwner: false, isAdmin: true, spot }).kind).toBe(
      "anywhere",
    );
  });

  it("a shared editor of a Workspace console stays in Workspace, and is told why", () => {
    const scope = relocationScope({
      isOwner: false,
      isAdmin: false,
      access: "workspace",
      spot: { section: "workspace", folderId: "f-fin" },
    });
    expect(scope).toMatchObject({ kind: "section", section: "workspace" });
    expect(scope.kind === "section" && scope.reason).toMatch(
      /owner or a workspace admin/,
    );
  });

  it("a private console shared with them is renamed in place (its folder may not even be visible)", () => {
    const scope = relocationScope({
      isOwner: false,
      isAdmin: false,
      access: "private",
      spot: { section: "workspace", folderId: null },
    });
    expect(scope.kind).toBe("in-place");
  });

  it("a console the tree lists under neither My Consoles nor Workspace (Shared with me) is renamed in place — an admin's too", () => {
    for (const who of [
      { isOwner: false, isAdmin: true },
      { isOwner: false, isAdmin: false },
    ]) {
      const scope = relocationScope({ ...who, access: "private", spot: null });
      expect(scope.kind).toBe("in-place");
      expect(scope.kind === "in-place" && scope.reason).toMatch(
        /stays in its owner's folder/,
      );
    }
  });
});

describe("renameMoveRequest — a name-only change never moves the console", () => {
  const shared = relocationScope({
    isOwner: false,
    isAdmin: true,
    access: "private",
    spot: null,
  });

  it("an admin renaming a Shared-with-me console sends a rename, not a move to their own root", () => {
    // The dialog opens on the admin's My Consoles root (folder null): the
    // old confirm sent PATCH /move {folderId: null, name}, and the server
    // moved the console out of its owner's "Team Drafts".
    expect(
      renameMoveRequest({
        scope: shared,
        from: null,
        to: { section: "my", folderId: null },
        renamedTo: "Q2",
      }),
    ).toEqual({ route: "rename", name: "Q2" });
  });

  it("the owner or an admin renaming in the same folder and section sends a rename (it keeps its folder)", () => {
    const anywhere = relocationScope({
      isOwner: true,
      isAdmin: false,
      spot: { section: "my", folderId: "f-drafts" },
    });
    expect(
      renameMoveRequest({
        scope: anywhere,
        from: { section: "my", folderId: "f-drafts" },
        to: { section: "my", folderId: "f-drafts" },
        renamedTo: "Renamed",
      }),
    ).toEqual({ route: "rename", name: "Renamed" });
  });

  it("a changed folder or section is a move, with the new name when there is one", () => {
    const anywhere = relocationScope({
      isOwner: true,
      isAdmin: false,
      spot: { section: "my", folderId: "f-drafts" },
    });
    expect(
      renameMoveRequest({
        scope: anywhere,
        from: { section: "my", folderId: "f-drafts" },
        to: { section: "my", folderId: null },
      }),
    ).toEqual({ route: "move", folderId: null, section: "my" });
    expect(
      renameMoveRequest({
        scope: anywhere,
        from: { section: "my", folderId: null },
        to: { section: "workspace", folderId: null },
        renamedTo: "Shared",
      }),
    ).toEqual({
      route: "move",
      folderId: null,
      section: "workspace",
      name: "Shared",
    });
  });

  it("nothing changed: nothing is sent", () => {
    expect(
      renameMoveRequest({
        scope: shared,
        from: null,
        to: { section: "workspace", folderId: "f-x" },
      }),
    ).toBeNull();
  });
});

describe("consoleNameProblem — the name field is a name, the folder has its picker", () => {
  it("refuses a slash and an empty name", () => {
    expect(consoleNameProblem("New Folder/Revenue (copy)")).toMatch(/“\/”/);
    expect(consoleNameProblem("   ")).toBeTruthy();
    expect(consoleNameProblem("Revenue per Day")).toBeNull();
  });
});

describe("consoleSectionLabel — the breadcrumb's section", () => {
  it("is Workspace for what the workspace sees, My Consoles for one's own", () => {
    expect(consoleSectionLabel("workspace", "u1", "u2")).toBe("Workspace");
    expect(consoleSectionLabel("private", "u1", "u1")).toBe("My Consoles");
  });

  it("never calls someone else's private console 'My Consoles'", () => {
    expect(consoleSectionLabel("private", "owner", "editor2")).toBe(
      "Shared with me",
    );
  });
});

describe("consolePlacement — one rule for the tree and the breadcrumb", () => {
  it("lists another member's private console under Shared with me, flat", () => {
    // The tree lists it at the root of "Shared with me" (its folder is its
    // owner's); the breadcrumb must not name that folder.
    expect(
      consolePlacement({
        access: "private",
        ownerId: "tester",
        currentUserId: "editor2",
        folders: ["Team Drafts"],
      }),
    ).toEqual({ section: "Shared with me", folders: [] });
  });

  it("keeps the folder trail in My Consoles and Workspace", () => {
    expect(
      consolePlacement({
        access: "private",
        ownerId: "editor2",
        currentUserId: "editor2",
        folders: ["Team Drafts"],
      }),
    ).toEqual({ section: "My Consoles", folders: ["Team Drafts"] });
    expect(
      consolePlacement({
        access: "workspace",
        ownerId: "tester",
        currentUserId: "editor2",
        folders: ["finance"],
      }),
    ).toEqual({ section: "Workspace", folders: ["finance"] });
  });
});

describe("renameMoveNotice — renamed is not moved", () => {
  it("says Renamed for a name-only change inside a folder", () => {
    expect(
      renameMoveNotice({
        renamedTo: "Alpha Two",
        moved: false,
        section: "Workspace",
        folders: ["finance"],
        name: "Alpha Two",
      }),
    ).toBe("Renamed to 'Alpha Two'");
  });

  it("says Moved, with the place, when the folder or section changed", () => {
    expect(
      renameMoveNotice({
        moved: true,
        section: "Workspace",
        folders: ["finance"],
        name: "Alpha",
      }),
    ).toBe("Moved to Workspace › finance");
    expect(
      renameMoveNotice({
        renamedTo: "Alpha Two",
        moved: true,
        section: "My Consoles",
        folders: [],
        name: "Alpha Two",
      }),
    ).toBe("Moved to My Consoles as 'Alpha Two'");
  });
});

describe("consoleSavedNotice — a save says where, in the breadcrumb's words", () => {
  it("a console shared with me is saved to 'Shared with me' — never its owner's folder", () => {
    expect(
      consoleSavedNotice({
        access: "private",
        ownerId: "owner",
        currentUserId: "editor2",
        filePath: "Team Drafts/Secret Margin ed2",
        name: "Secret Margin ed2",
      }),
    ).toBe("Console saved to Shared with me › Secret Margin ed2");
  });

  it("my own console and a Workspace console keep their folder trail", () => {
    expect(
      consoleSavedNotice({
        access: "private",
        ownerId: "me",
        currentUserId: "me",
        filePath: "Team Drafts/Revenue",
      }),
    ).toBe("Console saved to My Consoles › Team Drafts › Revenue");
    expect(
      consoleSavedNotice({
        access: "workspace",
        ownerId: "someone",
        currentUserId: "me",
        filePath: "finance/Alpha Four",
        name: "Alpha Four",
      }),
    ).toBe("Console saved to Workspace › finance › Alpha Four");
  });
});

describe("consoleCopiedNotice — a Duplicate says where the copy went", () => {
  it("My Consoles, with the copier's folder when there is one", () => {
    expect(
      consoleCopiedNotice({ path: "Ghost copy", name: "Ghost copy" }),
    ).toBe("Copied to My Consoles as 'Ghost copy'");
    expect(
      consoleCopiedNotice({
        path: "Team Drafts/Ghost copy",
        name: "Ghost copy",
      }),
    ).toBe("Copied to My Consoles › Team Drafts as 'Ghost copy'");
  });
});

describe("Save a Copy and the tree's Move to… say where", () => {
  it("a copy saved into a Workspace folder", () => {
    expect(
      consoleCopiedNotice({
        section: "Workspace",
        path: "finance/Q copy",
        name: "Q copy",
      }),
    ).toBe("Copied to Workspace › finance as 'Q copy'");
  });

  it("Move to… names the place, a name-only change says Renamed, nothing changed says nothing", () => {
    expect(
      treeMoveNotice({
        moved: true,
        name: "Alpha",
        section: "workspace",
        folderPath: "finance/Q3",
      }),
    ).toBe("Moved to Workspace › finance › Q3");
    expect(
      treeMoveNotice({
        moved: true,
        renamedTo: "Beta",
        name: "Alpha",
        section: "my",
      }),
    ).toBe("Moved to My Consoles as 'Beta'");
    expect(
      treeMoveNotice({
        moved: false,
        renamedTo: "Beta",
        name: "Alpha",
        section: "my",
      }),
    ).toBe("Renamed to 'Beta'");
    expect(
      treeMoveNotice({ moved: false, name: "Alpha", section: "my" }),
    ).toBeNull();
  });
});

describe("names taken and restores, in words", () => {
  it("a case twin names the EXISTING console and says why it counts", () => {
    expect(consoleNameTakenMessage("alpha four", "Alpha Four")).toBe(
      "A console named “Alpha Four” already exists here — names that differ only in upper/lower case count as the same. Choose another name.",
    );
    expect(consoleNameTakenMessage("Alpha Four", "Alpha Four")).toBe(
      "A console named “Alpha Four” already exists here. Choose another name.",
    );
  });

  it("an undone delete says it is back — under which name", () => {
    expect(consoleRestoredNotice("Weekly", "Weekly")).toBe("Restored 'Weekly'");
    expect(consoleRestoredNotice("Weekly", undefined)).toBe(
      "Restored 'Weekly'",
    );
    expect(consoleRestoredNotice("Weekly", "Weekly (2)")).toBe(
      "Restored as 'Weekly (2)'",
    );
  });
});
