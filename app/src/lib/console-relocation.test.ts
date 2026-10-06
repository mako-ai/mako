import { describe, expect, it } from "vitest";
import type { ConsoleEntry } from "../store/consoleTreeStore";
import {
  consoleNameProblem,
  consoleNameTakenBy,
  consolePlacement,
  consoleSectionLabel,
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
